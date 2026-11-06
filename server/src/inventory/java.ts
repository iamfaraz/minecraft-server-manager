/**
 * Java inventories.
 *   Player online:  ask the running server with `data get` and change things with `give`, `item replace` and `xp`.
 *   Player offline: read and edit the player's data file directly. The server only loads that file when the
 *                   player logs in, so editing it while they are away is safe, also with the server running.
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { exists, HttpError } from '../util.js';
import { resolveJavaUuid } from '../players.js';
import type { ServerInstance } from '../servers/instance.js';
import { applyOp, emptyInventory, WORN_SLOTS, type InvItem, type InvOp, type PlayerInventory, type SlotRef, type WornSlot } from './model.js';
import { T, byte, compound, float, int, readNbt, string, toPlain, writeNbt, type Compound, type Tag } from './nbt.js';
import { parseSnbt } from './snbt.js';

const isOnline = (inst: ServerInstance, player: string) => inst.state === 'running' && inst.players.has(player.toLowerCase());

/* ---------------- one item, from either form of NBT ---------------- */

/** Old saves keep armour and the off hand in the Inventory list under these slot numbers. */
const LEGACY_WORN: Record<number, WornSlot> = { 100: 'feet', 101: 'legs', 102: 'chest', 103: 'head', [-106]: 'offhand', 150: 'offhand' };
const KNOWN_COMPONENTS = new Set(['minecraft:damage', 'minecraft:enchantments', 'minecraft:custom_name']);

function textOf(component: any): string | undefined {
  if (typeof component === 'string') {
    // Older versions store the name as JSON text.
    try {
      const parsed = JSON.parse(component);
      return typeof parsed === 'string' ? parsed : (parsed?.text ?? component);
    } catch {
      return component;
    }
  }
  return component?.text ?? undefined;
}

/** `o` is an item compound as plain values: 1.20.5+ uses count/components, older versions Count/tag. */
function toItem(o: any): InvItem | null {
  if (!o || typeof o.id !== 'string') return null;
  const item: InvItem = { id: o.id, count: Number(o.count ?? o.Count ?? 1) };
  const comps = o.components ?? {};
  const legacy = o.tag ?? {};
  const damage = comps['minecraft:damage'] ?? legacy.Damage;
  if (damage) item.damage = Number(damage);
  const name = textOf(comps['minecraft:custom_name'] ?? legacy.display?.Name);
  if (name) item.name = name;
  const ench = comps['minecraft:enchantments'];
  const levels = ench?.levels ?? ench; // 1.20.5-1.21.4 wrap the map in {levels}
  const list: { id: string; level: number }[] = [];
  if (levels && typeof levels === 'object' && !Array.isArray(levels)) for (const [id, level] of Object.entries(levels)) if (typeof level === 'number') list.push({ id, level });
  for (const e of legacy.Enchantments ?? []) list.push({ id: String(e.id), level: Number(e.lvl) });
  if (list.length) item.enchants = list;
  if (Object.keys(comps).some((k) => !KNOWN_COMPONENTS.has(k)) || Object.keys(legacy).some((k) => !['Damage', 'Enchantments', 'display'].includes(k))) item.extra = true;
  return item;
}

/* ---------------- online: console commands ---------------- */

const DATA_REPLY = /has the following entity data: (.*)$/;
const DATA_MISS = /Found no elements matching|No entity was found|No player was found/;

/** One `data get`. Undefined when the player has no such tag (e.g. `equipment` before 1.21.5). */
async function dataGet(inst: ServerInstance, player: string, tag: string): Promise<any> {
  inst.muteOutput(/has the following entity data|Found no elements matching|No entity was found|No player was found/, 3000);
  const wait = inst.waitFor((_ev, line) => DATA_REPLY.test(line) || DATA_MISS.test(line), 3000);
  inst.sendSilent(`data get entity ${player} ${tag}`);
  const { line } = await wait.catch(() => {
    throw new HttpError(504, 'The server did not answer');
  });
  const m = DATA_REPLY.exec(line);
  if (!m) {
    if (/No entity was found|No player was found/.test(line)) throw new HttpError(404, `${player} is not online`);
    return undefined;
  }
  return parseSnbt(m[1]);
}

async function readLive(inst: ServerInstance, player: string): Promise<PlayerInventory> {
  const inv = emptyInventory();
  for (const entry of (await dataGet(inst, player, 'Inventory')) ?? []) {
    const slot = Number(entry.Slot);
    if (slot >= 0 && slot < 36) inv.slots[slot] = toItem(entry);
    else if (LEGACY_WORN[slot]) inv.equipment[LEGACY_WORN[slot]] = toItem(entry);
  }
  const equipment = await dataGet(inst, player, 'equipment');
  if (equipment) for (const key of WORN_SLOTS) if (equipment[key]) inv.equipment[key] = toItem(equipment[key]);
  inv.xp = { level: Number((await dataGet(inst, player, 'XpLevel')) ?? 0), progress: Number((await dataGet(inst, player, 'XpP')) ?? 0) };
  return { player, online: true, source: 'live', at: new Date().toISOString(), ...inv };
}

const slotName = (slot: SlotRef): string =>
  typeof slot === 'number' ? (slot < 9 ? `hotbar.${slot}` : `inventory.${slot - 9}`) : slot === 'offhand' ? 'weapon.offhand' : `armor.${slot}`;

const COMMAND_ERROR = /Unknown item|Unknown or incomplete command|Incorrect argument|No player was found|No entity was found|<--\[HERE\]|Invalid|Could not|Unable to|Expected/;

/** Run a command the admin can see in the console, and turn the server's complaint (if any) into an error. */
async function run(inst: ServerInstance, command: string): Promise<void> {
  const complaints: string[] = [];
  const untap = inst.tap((line) => {
    if (COMMAND_ERROR.test(line)) complaints.push(line.replace(/^\[[^\]]*\]:?\s*(\[[^\]]*\]:?\s*)?/, '').replace(/^System chat: /, ''));
  });
  inst.send(command);
  await new Promise((r) => setTimeout(r, 700));
  untap();
  if (complaints.length) throw new HttpError(400, complaints[0]);
}

async function applyLive(inst: ServerInstance, player: string, op: InvOp): Promise<PlayerInventory> {
  switch (op.op) {
    case 'give':
      await run(inst, `give ${player} ${op.item} ${op.count}`);
      break;
    case 'set':
      await run(inst, `item replace entity ${player} ${slotName(op.slot)} with ${op.item} ${op.count}`);
      break;
    case 'clear':
      await run(inst, `item replace entity ${player} ${slotName(op.slot)} with minecraft:air`);
      break;
    case 'count': {
      const now = await readLive(inst, player);
      const item = typeof op.slot === 'number' ? now.slots[op.slot] : now.equipment[op.slot];
      if (!item) throw new HttpError(400, 'That slot is empty');
      // Replacing the stack would drop enchantments and other data, so only plain items can be recounted this way.
      if (item.extra || item.enchants || item.name || item.damage) throw new HttpError(400, 'This item carries extra data (enchantments, a name or wear). Remove it or give a new one instead of changing its count.');
      await run(inst, `item replace entity ${player} ${slotName(op.slot)} with ${item.id} ${op.count}`);
      break;
    }
    case 'xp':
      await run(inst, `xp set ${player} ${op.level} levels`);
      await run(inst, `xp set ${player} 0 points`);
      break;
  }
  return readLive(inst, player);
}

/* ---------------- offline: the player's data file ---------------- */

async function playerFile(inst: ServerInstance, player: string): Promise<string> {
  const uuid = await resolveJavaUuid(inst, player);
  const world = path.join(inst.root, inst.rec.levelName);
  // 26.x keeps player files under players/data; earlier versions under playerdata.
  for (const file of [path.join(world, 'players', 'data', `${uuid}.dat`), path.join(world, 'playerdata', `${uuid}.dat`)]) if (await exists(file)) return file;
  throw new HttpError(404, `${player} has no saved data on this server yet. It appears after their first visit.`);
}

interface Loaded {
  file: string;
  name: string;
  root: Compound;
  inv: ReturnType<typeof emptyInventory>;
  /** The original tag behind each item we show, so untouched items are written back exactly as they were. */
  origin: WeakMap<InvItem, Compound>;
  at: string;
}

async function loadFile(inst: ServerInstance, player: string): Promise<Loaded> {
  const file = await playerFile(inst, player);
  const { name, root } = readNbt(zlib.gunzipSync(await fsp.readFile(file)));
  const inv = emptyInventory();
  const origin = new WeakMap<InvItem, Compound>();
  const take = (tag: Tag | undefined): InvItem | null => {
    if (tag?.type !== T.Compound) return null;
    const item = toItem(toPlain(tag));
    if (item) origin.set(item, tag);
    return item;
  };
  const list = root.value.get('Inventory');
  if (list?.type === T.List) {
    for (const tag of list.value) {
      if (tag.type !== T.Compound) continue;
      const slot = Number((tag.value.get('Slot') as any)?.value);
      if (slot >= 0 && slot < 36) inv.slots[slot] = take(tag);
      else if (LEGACY_WORN[slot]) inv.equipment[LEGACY_WORN[slot]] = take(tag);
    }
  }
  const equipment = root.value.get('equipment');
  if (equipment?.type === T.Compound) for (const key of WORN_SLOTS) if (equipment.value.has(key)) inv.equipment[key] = take(equipment.value.get(key));
  inv.xp = { level: Number((root.value.get('XpLevel') as any)?.value ?? 0), progress: Number((root.value.get('XpP') as any)?.value ?? 0) };
  return { file, name, root, inv, origin, at: (await fsp.stat(file)).mtime.toISOString() };
}

/** Total experience points a player has on reaching `level` (Java's own formula). */
function pointsAtLevel(level: number): number {
  if (level <= 16) return level * level + 6 * level;
  if (level <= 31) return Math.floor(2.5 * level * level - 40.5 * level + 360);
  return Math.floor(4.5 * level * level - 162.5 * level + 2220);
}

async function applyFile(inst: ServerInstance, player: string, op: InvOp): Promise<PlayerInventory> {
  const loaded = await loadFile(inst, player);
  const { root, inv, origin } = loaded;
  const { overflow } = applyOp(inv, op);
  const version = Number((root.value.get('DataVersion') as any)?.value ?? 0);
  const modern = version >= 3837; // 1.20.5: lower-case int `count`, components instead of `tag`
  const wornSeparately = root.value.has('equipment') || version >= 4325; // 1.21.5: armour and off hand moved out of Inventory

  /** The tag to write for an item: its original with the count updated, or a fresh one for a new item. */
  const tagFor = (item: InvItem, slot?: number): Compound => {
    const before = origin.get(item);
    const tag: Compound = before ? { type: T.Compound, value: new Map(before.value) } : compound({ id: string(item.id) });
    tag.value.delete('Count');
    tag.value.delete('count');
    tag.value.set(modern ? 'count' : 'Count', modern ? int(item.count) : byte(item.count));
    if (slot === undefined) tag.value.delete('Slot');
    else tag.value.set('Slot', byte(slot));
    return tag;
  };

  const entries: Tag[] = [];
  inv.slots.forEach((item, slot) => item && entries.push(tagFor(item, slot)));
  if (wornSeparately) {
    const equipment = root.value.get('equipment');
    const worn: Compound = equipment?.type === T.Compound ? equipment : compound({});
    for (const key of WORN_SLOTS) {
      const item = inv.equipment[key];
      if (item) worn.value.set(key, tagFor(item));
      else worn.value.delete(key);
    }
    if (worn.value.size) root.value.set('equipment', worn);
    else root.value.delete('equipment');
  } else {
    const legacySlot: Record<WornSlot, number> = { feet: 100, legs: 101, chest: 102, head: 103, offhand: -106 };
    for (const key of WORN_SLOTS) if (inv.equipment[key]) entries.push(tagFor(inv.equipment[key]!, legacySlot[key]));
  }
  root.value.set('Inventory', { type: T.List, elementType: T.Compound, value: entries });
  if (op.op === 'xp') {
    root.value.set('XpLevel', int(op.level));
    root.value.set('XpP', float(0));
    root.value.set('XpTotal', int(pointsAtLevel(op.level)));
  }

  // Keep the previous file next to it, then replace it in one step so the server never sees half a file.
  await fsp.copyFile(loaded.file, `${loaded.file}.blockhost-bak`);
  const tmp = `${loaded.file}.blockhost-tmp`;
  await fsp.writeFile(tmp, zlib.gzipSync(writeNbt(loaded.name, root)));
  await fsp.rename(tmp, loaded.file);
  inst.pushLog(`[Blockhost] Edited ${player}'s saved inventory (${op.op}); they will see it when they join.`);
  const view = await getInventory(inst, player);
  return overflow ? { ...view, note: `${overflow} did not fit in the inventory` } : view;
}

/* ---------------- entry points ---------------- */

export async function getInventory(inst: ServerInstance, player: string): Promise<PlayerInventory> {
  if (isOnline(inst, player)) return readLive(inst, player);
  const { inv, at } = await loadFile(inst, player);
  return { player, online: false, source: 'file', at, ...inv };
}

export async function applyInventoryOp(inst: ServerInstance, player: string, op: InvOp): Promise<PlayerInventory> {
  return isOnline(inst, player) ? applyLive(inst, player, op) : applyFile(inst, player, op);
}
