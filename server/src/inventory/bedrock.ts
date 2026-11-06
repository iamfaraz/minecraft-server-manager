/**
 * Bedrock inventories. Bedrock has no console command that prints an inventory, so a small script inside the
 * server (addons/blockhost-bridge) does the reading and writing, and we talk to it over the console:
 * requests go in as `scriptevent` commands, replies come back as log lines (see the script for the format).
 *
 * Offline players cannot be reached that way, and their data sits in the world database the running server has
 * locked. So for them we show the inventory as it was when they left (the script reports it) and queue changes,
 * which are applied the moment they join again.
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { bridgeBus, bus } from '../events.js';
import { serverDir } from '../store.js';
import { exists, readJson, rmrf, uid, writeJson, HttpError, PropertiesFile } from '../util.js';
import { setPackActive } from '../addons.js';
import type { ServerInstance } from '../servers/instance.js';
import { applyOp, emptyInventory, type InvOp, type PlayerInventory } from './model.js';

const PACK_DIR = 'Blockhost Bridge';
const RPC_TIMEOUT_MS = 5000;

type Raw = Pick<PlayerInventory, 'slots' | 'equipment' | 'xp'> & { player: string };
interface Stored {
  inventory: Raw;
  at: string;
}

interface Channel {
  ready: boolean;
  waiting: Map<string, { parts: string[]; resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>;
  eventParts: string[];
}
const channels = new Map<string, Channel>();
const channel = (id: string): Channel => {
  let c = channels.get(id);
  if (!c) channels.set(id, (c = { ready: false, waiting: new Map(), eventParts: [] }));
  return c;
};

let lookup: (id: string) => ServerInstance | undefined = () => undefined;

const fileKey = (player: string) => player.toLowerCase().replace(/[^a-z0-9_.-]/g, '_');
const snapshotFile = (inst: ServerInstance, player: string) => path.join(serverDir(inst.id), 'inventories', `${fileKey(player)}.json`);
const queueFile = (inst: ServerInstance, player: string) => path.join(serverDir(inst.id), 'inventories', `${fileKey(player)}.queue.json`);

async function saveSnapshot(inst: ServerInstance, inventory: Raw): Promise<void> {
  const file = snapshotFile(inst, inventory.player);
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await writeJson(file, { inventory, at: new Date().toISOString() } satisfies Stored);
}

export function init(find: (id: string) => ServerInstance | undefined): void {
  lookup = find;
  bridgeBus.on('line', (serverId: string, tag: string, id: string, part: number, parts: number, text: string) => {
    const c = channel(serverId);
    if (tag === 'BHRPC') {
      const w = c.waiting.get(id);
      if (!w) return;
      w.parts.push(text);
      if (part < parts) return;
      c.waiting.delete(id);
      clearTimeout(w.timer);
      try {
        w.resolve(JSON.parse(w.parts.join('')));
      } catch {
        w.reject(new Error('The bridge sent a reply that could not be read'));
      }
      return;
    }
    c.eventParts.push(text);
    if (part < parts) return;
    const raw = c.eventParts.join('');
    c.eventParts = [];
    let event: any;
    try {
      event = JSON.parse(raw);
    } catch {
      return;
    }
    const inst = lookup(serverId);
    if (!inst) return;
    if (event.event === 'ready') c.ready = true;
    else if (event.event === 'snapshot' && event.inventory?.player) saveSnapshot(inst, event.inventory).catch(() => {});
    else if (event.event === 'spawn' && event.player) flushQueue(inst, event.player).catch(() => {});
  });
  // A stopped server has no bridge; anything still waiting for it will not get an answer.
  bus.on('event', (ev: any) => {
    if (ev.type !== 'server.state' || ev.state === 'running' || ev.state === 'starting') return;
    const c = channels.get(ev.id);
    if (!c) return;
    c.ready = false;
    for (const w of c.waiting.values()) {
      clearTimeout(w.timer);
      w.reject(new Error('The server stopped'));
    }
    c.waiting.clear();
  });
}

function rpc(inst: ServerInstance, request: Record<string, unknown>): Promise<any> {
  const c = channel(inst.id);
  if (inst.state !== 'running' || !c.ready) throw new HttpError(409, 'The inventory bridge is not running on this server');
  const id = uid(6);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      c.waiting.delete(id);
      reject(new HttpError(504, 'The inventory bridge did not answer'));
    }, RPC_TIMEOUT_MS);
    c.waiting.set(id, { parts: [], resolve, reject, timer });
    try {
      inst.sendSilent(`scriptevent blockhost:rpc ${JSON.stringify({ id, ...request })}`);
    } catch (e) {
      clearTimeout(timer);
      c.waiting.delete(id);
      reject(e as Error);
    }
  });
}

const isOnline = (inst: ServerInstance, player: string) => inst.state === 'running' && [...inst.players.keys()].some((k) => k === player.toLowerCase());

/* ---------------- bridge install / status ---------------- */

async function bundledVersion(): Promise<number[] | null> {
  const m = await readJson<{ header?: { version?: number[]; uuid?: string } } | null>(path.join(config.addonsDir, 'blockhost-bridge', 'manifest.json'), null);
  return m?.header?.version ?? null;
}

export async function bridgeStatus(inst: ServerInstance) {
  const installed = await readJson<{ header?: { version?: number[]; uuid?: string } } | null>(path.join(inst.root, 'behavior_packs', PACK_DIR, 'manifest.json'), null);
  const active = installed?.header?.uuid
    ? (await readJson<{ pack_id: string }[]>(path.join(inst.root, 'worlds', inst.rec.levelName, 'world_behavior_packs.json'), [])).some((p) => p.pack_id === installed.header!.uuid)
    : false;
  const bundled = await bundledVersion();
  return {
    /** The helper script is in the server and enabled for the world. */
    installed: !!installed && active,
    /** It has reported in on the running server. */
    ready: inst.state === 'running' && channel(inst.id).ready,
    /** A newer helper ships with this Blockhost than the one in the server. */
    outdated: !!installed && !!bundled && JSON.stringify(installed.header?.version) !== JSON.stringify(bundled),
    running: inst.state === 'running',
  };
}

/** Put the helper script into the server and make its output visible to us. Takes effect at the next start. */
export async function installBridge(inst: ServerInstance): Promise<void> {
  const src = path.join(config.addonsDir, 'blockhost-bridge');
  const manifest = await readJson<{ header: { uuid: string; version: number[] } } | null>(path.join(src, 'manifest.json'), null);
  if (!manifest) throw new HttpError(500, 'The inventory bridge is missing from this Blockhost install');
  if (!(await exists(path.join(inst.root, 'worlds', inst.rec.levelName)))) throw new HttpError(409, 'Start the server once so its world exists, then install the bridge');
  const dest = path.join(inst.root, 'behavior_packs', PACK_DIR);
  await rmrf(dest);
  await fsp.cp(src, dest, { recursive: true });
  await setPackActive(inst, 'behavior', manifest.header.uuid, manifest.header.version, true);
  // The script answers through the content log, which Bedrock only prints to the console when asked to.
  const props = await PropertiesFile.load(path.join(inst.root, 'server.properties'));
  props.set('content-log-console-output-enabled', 'true');
  await props.save();
  inst.pushLog(`[Blockhost] Inventory bridge installed.${inst.isActive ? ' Restart the server to turn it on.' : ''}`);
}

/* ---------------- reading and changing ---------------- */

async function loadSnapshot(inst: ServerInstance, player: string): Promise<Stored | null> {
  return readJson<Stored | null>(snapshotFile(inst, player), null);
}
const loadQueue = (inst: ServerInstance, player: string) => readJson<InvOp[]>(queueFile(inst, player), []);

function toView(raw: Raw, extra: Pick<PlayerInventory, 'online' | 'source' | 'at'> & Partial<PlayerInventory>): PlayerInventory {
  return { ...extra, player: raw.player, slots: raw.slots, equipment: raw.equipment, xp: raw.xp };
}

export async function getInventory(inst: ServerInstance, player: string): Promise<PlayerInventory> {
  if (isOnline(inst, player) && channel(inst.id).ready) {
    const res = await rpc(inst, { op: 'get', player });
    if (res.ok) {
      saveSnapshot(inst, res.inventory).catch(() => {});
      return toView(res.inventory, { online: true, source: 'live', at: new Date().toISOString() });
    }
    if (!res.offline) throw new HttpError(502, res.error || 'The bridge could not read the inventory');
  }
  const queue = await loadQueue(inst, player);
  // With changes queued but nothing on record yet, show the changes on an empty inventory.
  const stored = (await loadSnapshot(inst, player)) ?? (queue.length ? { inventory: { player, ...emptyInventory() }, at: new Date().toISOString() } : null);
  if (!stored) {
    throw new HttpError(404, isOnline(inst, player) ? 'The inventory bridge is not running yet. Install it and restart the server.' : `Nothing is on record for ${player} yet. Their inventory is saved when they leave, once the bridge is installed.`);
  }
  // Show what the player will have once the queued changes are applied.
  for (const op of queue) {
    try {
      applyOp(stored.inventory, op);
    } catch {
      /* e.g. changing the count of a slot emptied since */
    }
  }
  return toView(stored.inventory, { online: false, source: 'snapshot', at: stored.at, pending: queue.length });
}

export async function applyInventoryOp(inst: ServerInstance, player: string, op: InvOp): Promise<PlayerInventory> {
  if (isOnline(inst, player)) {
    const res = await rpc(inst, { ...op, player });
    if (res.ok) {
      saveSnapshot(inst, res.inventory).catch(() => {});
      return toView(res.inventory, { online: true, source: 'live', at: new Date().toISOString(), note: res.note });
    }
    if (!res.offline) throw new HttpError(400, res.error || 'The server refused that change');
  }
  if (!(await bridgeStatus(inst)).installed) throw new HttpError(409, 'Install the inventory bridge first');
  // Offline: remember the change and apply it when they join.
  const stored = (await loadSnapshot(inst, player)) ?? { inventory: { player, ...emptyInventory() }, at: new Date().toISOString() };
  const queue = await loadQueue(inst, player);
  const preview: Raw = JSON.parse(JSON.stringify(stored.inventory));
  for (const queued of queue) {
    try {
      applyOp(preview, queued);
    } catch {
      /* ignore */
    }
  }
  applyOp(preview, op); // throws on a change that makes no sense, before anything is queued
  queue.push(op);
  await fsp.mkdir(path.dirname(queueFile(inst, player)), { recursive: true });
  await writeJson(queueFile(inst, player), queue);
  return toView(preview, { online: false, source: 'snapshot', at: stored.at, pending: queue.length, note: `Queued. It is applied when ${player} joins.` });
}

/** Drop the changes waiting for an offline player. */
export async function clearQueue(inst: ServerInstance, player: string): Promise<void> {
  await rmrf(queueFile(inst, player));
}

async function flushQueue(inst: ServerInstance, player: string): Promise<void> {
  const queue = await loadQueue(inst, player);
  if (!queue.length) return;
  await rmrf(queueFile(inst, player));
  await new Promise((r) => setTimeout(r, 1500)); // let the player finish loading in
  let done = 0;
  const failed: string[] = [];
  for (const op of queue) {
    try {
      const res = await rpc(inst, { ...op, player });
      if (res.ok) done++;
      else failed.push(res.error || op.op);
    } catch (e) {
      failed.push((e as Error).message);
    }
  }
  inst.pushLog(`[Blockhost] Applied ${done} queued inventory change${done === 1 ? '' : 's'} to ${player}${failed.length ? `; ${failed.length} failed (${failed[0]})` : ''}.`);
}
