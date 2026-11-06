import fsp from 'node:fs/promises';
import path from 'node:path';
import pidusage from 'pidusage';
import { config } from '../config.js';
import { bus } from '../events.js';
import { listServerIds, serverBackupsDir, serverDir, serverRecordFile, serverRoot } from '../store.js';
import { bad, conflict, dirSize, exists, notFound, readJson, rmrf, slugify, uid, writeJson, HttpError } from '../util.js';
import { installJava, installGeyser, removeGeyser } from '../install/java.js';
import { installBedrock } from '../install/bedrock.js';
import { recommendedJavaMajor } from '../versions/java.js';
import { ServerInstance } from './instance.js';
import { pingBedrock, pingJava, probeNetherNet } from './status.js';
import { heldPorts, portNeeds, slotSpan, type PortConflict, type PortNeed, type PortSlot } from './ports.js';
import type { CreateServerInput, ServerRecord, ServerSummary, ServerType, JavaSettings } from './types.js';
import { JAVA_TYPES } from './types.js';
import { applyRetention, backupFile, createBackup, extractWorld, listBackups, worldDirs } from '../backups.js';
import { applyImport, getImport } from '../imports.js';

const ALL_TYPES: ServerType[] = [...JAVA_TYPES, 'BEDROCK'];

/** How to get past a port conflict when starting a server. */
export type StartResolve = { mode: 'stop-others' } | { mode: 'auto' } | { mode: 'custom'; port?: number; geyserPort?: number };

interface PortUse {
  serverId: string;
  name: string;
  edition: string;
  state: string;
  slot: PortSlot;
  /** The number the setting itself holds, as opposed to the second of a pair. */
  primary: boolean;
  role: string;
  protos: string[];
  /** Bound by a running server right now. */
  inUse: boolean;
  /** Its server gave the port up; shown so the admin can see where it went. */
  released: boolean;
}

export class ServerManager {
  instances = new Map<string, ServerInstance>();
  private timers: NodeJS.Timeout[] = [];
  private lastBackupCheck = new Map<string, number>();

  list(): ServerSummary[] {
    return [...this.instances.values()].map((i) => i.summary()).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  get(id: string): ServerInstance {
    const i = this.instances.get(id);
    if (!i) throw notFound('Server not found');
    return i;
  }

  async init(): Promise<void> {
    for (const id of await listServerIds()) {
      const rec = await readJson<ServerRecord | null>(serverRecordFile(id), null);
      if (!rec) continue;
      const inst = new ServerInstance(rec);
      await inst.load();
      this.instances.set(id, inst);
    }
    // Resume servers that should be running
    for (const inst of this.instances.values()) {
      if (inst.rec.installed && (inst.rec.autoStart || inst.rec.lastRunning)) {
        this.startServer(inst.id).catch((e) => inst.pushLog(`[Blockhost] Auto-start failed: ${e.message}`));
      }
    }
    this.timers.push(setInterval(() => this.pollStats(), 5000));
    this.timers.push(setInterval(() => this.pollPings(), 10_000));
    this.timers.push(setInterval(() => this.pollDisk(), 60_000));
    this.timers.push(setInterval(() => this.runScheduledBackups(), 60_000));
    setTimeout(() => this.pollDisk(), 2000);
  }

  async shutdown(): Promise<void> {
    for (const t of this.timers) clearInterval(t);
    await Promise.all(
      [...this.instances.values()].map(async (i) => {
        if (i.isActive) {
          const wasRunning = i.state !== 'stopping';
          await i.stop();
          // Preserve "was running" so it resumes after the manager restarts
          i.rec.lastRunning = wasRunning;
          await i.save();
        }
      }),
    );
  }

  /* ---------------------------- pollers ---------------------------- */

  private async pollStats() {
    for (const inst of this.instances.values()) {
      const pid = inst.proc?.pid;
      if (!pid || !inst.isActive) continue;
      try {
        const s = await pidusage(pid);
        inst.pushStats({
          t: Date.now(),
          cpu: Math.round(s.cpu * 10) / 10,
          memMb: Math.round(s.memory / 1024 / 1024),
          players: inst.players.size,
          latencyMs: inst.ping?.latencyMs ?? null,
        });
      } catch {
        /* process gone */
      }
    }
  }

  private async pollPings() {
    for (const inst of this.instances.values()) {
      if (inst.state !== 'running' && inst.state !== 'starting') continue;
      const r =
        inst.rec.edition === 'java'
          ? await pingJava('127.0.0.1', inst.rec.port)
          : inst.rec.transport === 'nethernet'
            ? await probeNetherNet('127.0.0.1', inst.rec.port)
            : await pingBedrock('127.0.0.1', inst.rec.port);
      inst.ping = r.ok ? r : inst.ping && !r.ok ? { ok: false } : r;
      if (r.ok && inst.state === 'starting') inst.setState('running');
      if (inst.rec.edition === 'java' && inst.rec.geyser && inst.rec.geyserPort) inst.geyserPing = await pingBedrock('127.0.0.1', inst.rec.geyserPort, 2000);
    }
  }

  private async pollDisk() {
    for (const inst of this.instances.values()) {
      inst.diskBytes = await dirSize(serverDir(inst.id));
    }
  }

  private async runScheduledBackups() {
    const now = Date.now();
    for (const inst of this.instances.values()) {
      const sched = inst.rec.backup?.schedule;
      if (!sched || sched === 'off' || inst.state !== 'running') continue;
      const every = sched === 'hourly' ? 3600_000 : sched === '6h' ? 6 * 3600_000 : 24 * 3600_000;
      let last = this.lastBackupCheck.get(inst.id);
      if (last === undefined) {
        const backups = await listBackups(inst.id);
        const lastAuto = backups.find((b) => b.auto);
        last = lastAuto ? Date.parse(lastAuto.createdAt) : now; // don't fire immediately on boot
        this.lastBackupCheck.set(inst.id, last);
      }
      if (now - last < every) continue;
      this.lastBackupCheck.set(inst.id, now);
      try {
        await createBackup(inst, { scope: inst.rec.backup.scope || 'world', auto: true, label: 'Scheduled' });
        await applyRetention(inst.id, inst.rec.backup.keep || 7);
        inst.pushLog('[Blockhost] Scheduled backup complete');
      } catch (e) {
        inst.pushLog(`[Blockhost] Scheduled backup failed: ${(e as Error).message}`);
      }
    }
  }

  /* ---------------------------- ports ---------------------------- */

  /**
   * Port numbers that are spoken for: everything a server holds, plus what a running server actually bound if its
   * record was edited since. A stopped server that released its ports does not count.
   */
  usedPorts(exceptId?: string): Set<number> {
    const used = new Set<number>();
    for (const i of this.instances.values()) {
      if (i.id === exceptId) continue;
      if (i.isActive) for (const n of i.liveNeeds ?? []) used.add(n.port);
      if (i.rec.portsReleased && !i.isActive) continue;
      for (const h of heldPorts(i.rec)) used.add(h.port);
    }
    return used;
  }

  allocatePort(kind: 'java' | 'bedrock' | 'udp', exceptId?: string, span = 1, avoid?: Set<number>): number {
    const [lo, hi] = kind === 'java' ? config.javaPorts : config.bedrockPorts;
    const used = this.usedPorts(exceptId);
    for (let p = lo; p + span - 1 <= hi; p++) {
      let ok = true;
      for (let k = 0; k < span; k++) if (used.has(p + k) || avoid?.has(p + k)) ok = false;
      if (ok) return p;
    }
    throw conflict(`No free ${kind === 'java' ? 'TCP' : 'UDP'} ports left in the published range ${lo}-${hi}. Release or delete a server, or widen MCSM_${kind === 'java' ? 'JAVA' : 'BEDROCK'}_PORTS.`);
  }

  /**
   * Point one of a server's port settings at `value` (a number, or 'auto' for the next free one in the range).
   * A number another server holds is refused unless `share` is set. Sharing is allowed on purpose, for servers that
   * take turns on a well-known port; the check at start makes sure only one of them runs at a time.
   */
  private setPort(inst: ServerInstance, slot: PortSlot, value: number | 'auto', share: boolean, avoid?: Set<number>): void {
    const rec = inst.rec;
    if (slot === 'geyserPort' && !(rec.edition === 'java' && rec.geyser)) throw bad('This server has no cross-play (Geyser) port');
    const span = slotSpan(rec, slot);
    // The server's other setting must not overlap with this one.
    const own = new Set(heldPorts(rec).filter((h) => h.slot !== slot).map((h) => h.port));
    let port: number;
    if (value === 'auto') {
      port = this.allocatePort(slot === 'geyserPort' ? 'udp' : rec.edition, inst.id, span, new Set([...own, ...(avoid ?? [])]));
    } else {
      port = Number(value);
      if (!Number.isInteger(port) || port < 1024 || port + span - 1 > 65535) throw bad('Ports must be whole numbers from 1024 to 65535');
      const wanted = Array.from({ length: span }, (_, k) => port + k);
      if (wanted.some((p) => own.has(p))) throw bad(`Port ${port} overlaps with this server's other port`);
      if (!share) {
        const holders = [...this.instances.values()].filter(
          (o) => o.id !== inst.id && !(o.rec.portsReleased && !o.isActive) && heldPorts(o.rec).some((h) => wanted.includes(h.port)),
        );
        if (holders.length) {
          throw new HttpError(409, `Port ${port} is assigned to ${holders.map((h) => `"${h.rec.name}"`).join(' and ')}`, {
            code: 'PORT_ASSIGNED',
            port,
            slot,
            holders: holders.map((h) => ({ id: h.id, name: h.rec.name, state: h.state })),
          });
        }
      }
    }
    if (slot === 'geyserPort') rec.geyserPort = port;
    else {
      rec.port = port;
      rec.portV6 = rec.edition === 'bedrock' ? port + 1 : undefined;
    }
  }

  async assignPorts(id: string, patch: { port?: number | 'auto'; geyserPort?: number | 'auto'; share?: boolean }): Promise<ServerSummary> {
    const inst = this.get(id);
    if (patch.port === undefined && patch.geyserPort === undefined) throw bad('Nothing to assign');
    const before = JSON.stringify(heldPorts(inst.rec));
    if (patch.port !== undefined) this.setPort(inst, 'port', patch.port, !!patch.share);
    if (patch.geyserPort !== undefined) this.setPort(inst, 'geyserPort', patch.geyserPort, !!patch.share);
    delete inst.rec.portsReleased;
    await inst.save();
    if (inst.isActive && before !== JSON.stringify(heldPorts(inst.rec))) inst.pushLog('[Blockhost] Ports changed; restart to apply.');
    return inst.summary();
  }

  /** Let other servers have this (stopped) server's ports. It gets ports again when it is started or assigned. */
  async releasePorts(id: string): Promise<ServerSummary> {
    const inst = this.get(id);
    if (inst.isActive) throw conflict('Stop the server before releasing its ports');
    inst.rec.portsReleased = true;
    await inst.save();
    return inst.summary();
  }

  /** A server that released its ports gets the old numbers back if nobody took them, and new ones otherwise. */
  private reclaimPorts(inst: ServerInstance): boolean {
    const rec = inst.rec;
    if (!rec.portsReleased) return false;
    const used = this.usedPorts(inst.id);
    for (const slot of ['port', 'geyserPort'] as PortSlot[]) {
      const held = heldPorts(rec).filter((h) => h.slot === slot);
      if (!held.length || !held.some((h) => used.has(h.port))) continue;
      const old = held[0].port;
      this.setPort(inst, slot, 'auto', false);
      inst.pushLog(`[Blockhost] Port ${old} went to another server while this one was stopped; now using ${slot === 'port' ? rec.port : rec.geyserPort}.`);
    }
    delete rec.portsReleased;
    return true;
  }

  /** Ports this server needs that a running Blockhost server is using right now. */
  portConflicts(inst: ServerInstance): PortConflict[] {
    const out: PortConflict[] = [];
    for (const need of portNeeds(inst.rec)) {
      for (const other of this.instances.values()) {
        if (other.id === inst.id || !other.isActive) continue;
        const theirs = other.liveNeeds ?? portNeeds(other.rec);
        if (theirs.some((t) => t.port === need.port && t.proto === need.proto)) out.push({ ...need, holder: { id: other.id, name: other.rec.name, state: other.state } });
      }
    }
    return out;
  }

  private portConflictError(inst: ServerInstance, conflicts: PortConflict[]): HttpError {
    const first = conflicts[0];
    const message = first.holder ? `Port ${first.port} is in use by "${first.holder.name}"` : `Port ${first.port} is in use by another program on this machine`;
    // What "pick one for me" would choose, per affected setting; absent when the range is full.
    const suggestion: Partial<Record<PortSlot, number>> = {};
    for (const slot of new Set(conflicts.map((c) => c.slot))) {
      try {
        suggestion[slot] = this.allocatePort(slot === 'geyserPort' ? 'udp' : inst.rec.edition, inst.id, slotSpan(inst.rec, slot), new Set(conflicts.map((c) => c.port)));
      } catch {
        /* no free port */
      }
    }
    return new HttpError(409, message, { code: 'PORT_CONFLICT', server: { id: inst.id, name: inst.rec.name }, conflicts, suggestion });
  }

  /**
   * Start a server, making sure its ports are free first. If another running server (or another program) has one
   * of them, this fails with a PORT_CONFLICT error describing who and offering a free port, and the caller can
   * retry with `resolve`: stop the servers in the way, let Blockhost pick new ports, or name the ports to use.
   */
  async startServer(id: string, resolve?: StartResolve): Promise<void> {
    const inst = this.get(id);
    if (inst.isActive) throw conflict('Server is already running');
    if (inst.state === 'installing') throw conflict('Server is installing');
    let changed = this.reclaimPorts(inst);
    if (resolve?.mode === 'custom') {
      if (resolve.port !== undefined) this.setPort(inst, 'port', resolve.port, true);
      if (resolve.geyserPort !== undefined) this.setPort(inst, 'geyserPort', resolve.geyserPort, true);
      changed = true;
    }
    const avoid = new Set<number>();
    const moveAway = (conflicts: PortConflict[]) => {
      for (const c of conflicts) avoid.add(c.port);
      for (const slot of new Set(conflicts.map((c) => c.slot))) this.setPort(inst, slot, 'auto', false, avoid);
      changed = true;
    };
    let conflicts = this.portConflicts(inst);
    if (conflicts.length && resolve?.mode === 'auto') {
      moveAway(conflicts);
      conflicts = this.portConflicts(inst);
    }
    if (conflicts.length && resolve?.mode === 'stop-others') {
      for (const holderId of new Set(conflicts.map((c) => c.holder!.id))) await this.get(holderId).stop();
      conflicts = this.portConflicts(inst);
    }
    if (changed) await inst.save();
    if (conflicts.length) throw this.portConflictError(inst, conflicts);

    // The instance itself checks for programs outside Blockhost. With "auto", keep moving until a start succeeds.
    for (let attempt = 0; ; attempt++) {
      try {
        await inst.start();
        return;
      } catch (e) {
        const external = e instanceof HttpError && e.data?.code === 'PORT_CONFLICT' ? (e.data.conflicts as PortConflict[]) : null;
        if (!external) throw e;
        inst.setState('stopped'); // a question for the user, not a failed server
        if (resolve?.mode === 'auto' && attempt < 5) {
          moveAway(external);
          await inst.save();
          continue;
        }
        throw this.portConflictError(inst, external);
      }
    }
  }

  /** Everything the port manager page shows: the published ranges and who holds or uses each port number. */
  portMap() {
    const ports = new Map<number, PortUse[]>();
    const add = (port: number, use: PortUse) => ports.set(port, [...(ports.get(port) ?? []), use]);
    for (const inst of this.instances.values()) {
      const rec = inst.rec;
      const base = { serverId: inst.id, name: rec.name, edition: rec.edition, state: inst.state };
      const released = !!rec.portsReleased && !inst.isActive;
      const needs = portNeeds(rec);
      const live = inst.isActive ? (inst.liveNeeds ?? needs) : [];
      const describe = (list: PortNeed[], port: number) => {
        const mine = list.filter((n) => n.port === port);
        return { role: mine.map((n) => n.role).join(', '), protos: [...new Set(mine.map((n) => n.proto))] };
      };
      const held = heldPorts(rec);
      for (const h of held) {
        const d = describe(needs, h.port);
        add(h.port, { ...base, slot: h.slot, primary: h.port === (h.slot === 'port' ? rec.port : rec.geyserPort), role: d.role || 'Held as this server\'s second port', protos: d.protos, inUse: live.some((n) => n.port === h.port), released });
      }
      // A running server whose ports were changed still occupies the old ones until it restarts.
      for (const port of new Set(live.map((n) => n.port))) {
        if (held.some((h) => h.port === port)) continue;
        const d = describe(live, port);
        add(port, { ...base, slot: live.find((n) => n.port === port)!.slot, primary: false, role: `${d.role} (until restart)`, protos: d.protos, inUse: true, released: false });
      }
    }
    return {
      hostNetwork: config.hostNetwork,
      ranges: { java: config.javaPorts, bedrock: config.bedrockPorts },
      ports: [...ports.entries()].sort((a, b) => a[0] - b[0]).map(([port, uses]) => ({ port, uses })),
    };
  }

  /* ---------------------------- create ---------------------------- */

  async create(input: CreateServerInput): Promise<ServerSummary> {
    if (!input.name?.trim()) throw bad('Name is required');
    if (!ALL_TYPES.includes(input.type)) throw bad('Invalid server type');
    const edition = input.type === 'BEDROCK' ? 'bedrock' : 'java';
    if (input.edition && input.edition !== edition) throw bad('Edition does not match type');
    if (!input.version?.trim()) throw bad('Version is required');

    let source: ServerInstance | null = null;
    let importMeta: Awaited<ReturnType<typeof getImport>> | null = null;
    if (input.importWorld?.importId) {
      importMeta = await getImport(input.importWorld.importId);
      if (importMeta.edition !== edition) throw bad(`That import is a ${importMeta.edition} world; pick a ${importMeta.edition === 'java' ? 'Java' : 'Bedrock'} server type or another world`);
    } else if (input.importWorld?.sourceServerId) {
      source = this.get(input.importWorld.sourceServerId);
      if (source.rec.edition !== edition) throw bad('Worlds can only be imported between servers of the same edition');
    }

    const id = `${slugify(input.name)}-${uid(4)}`;
    const used = this.usedPorts();
    let port: number;
    if (input.port) {
      if (used.has(input.port) || (edition === 'bedrock' && used.has(input.port + 1))) throw conflict(`Port ${input.port} is already assigned`);
      port = input.port;
    } else port = this.allocatePort(edition, undefined, edition === 'bedrock' ? 2 : 1);

    const levelName = (input.levelName?.trim() || (importMeta ? importMeta.levelName : source ? source.rec.levelName : edition === 'bedrock' ? 'Bedrock level' : 'world')).replace(/[\\/:*?"<>|]/g, '_');
    const now = new Date().toISOString();
    const java: JavaSettings | undefined =
      edition === 'java'
        ? {
            major: input.java?.major ?? 'auto',
            xmxMb: Math.max(512, Math.round(input.java?.xmxMb ?? 2048)),
            xmsMb: Math.max(256, Math.round(input.java?.xmsMb ?? input.java?.xmxMb ?? 2048)),
            preset: input.java?.preset ?? 'aikar',
            extraArgs: input.java?.extraArgs ?? '',
          }
        : undefined;
    const geyser = edition === 'java' && !!input.geyser && ['PAPER', 'PURPUR', 'FABRIC', 'NEOFORGE'].includes(input.type);
    const rec: ServerRecord = {
      id,
      name: input.name.trim(),
      edition,
      type: input.type,
      version: input.version.trim(),
      port,
      portV6: edition === 'bedrock' ? port + 1 : undefined,
      // NetherNet unless RakNet is asked for: current Bedrock servers (seen on 1.26.62) refuse players over RakNet.
      transport: edition === 'bedrock' ? (input.transport === 'raknet' ? 'raknet' : 'nethernet') : undefined,
      levelName,
      java,
      autoStart: !!input.autoStart,
      restartOnCrash: input.restartOnCrash ?? true,
      geyser,
      geyserPort: undefined,
      backup: { schedule: 'off', keep: 7, scope: 'world' },
      installed: false,
      lastRunning: false,
      createdAt: now,
      updatedAt: now,
    };
    if (geyser) rec.geyserPort = this.allocatePort('udp', undefined, 2);

    await fsp.mkdir(serverRoot(id), { recursive: true });
    await fsp.mkdir(serverBackupsDir(id), { recursive: true });
    await writeJson(serverRecordFile(id), rec);
    const inst = new ServerInstance(rec);
    this.instances.set(id, inst);
    bus.publish({ type: 'server.changed', id });

    // Install asynchronously; the UI follows progress over the websocket.
    this.installAndMaybeStart(inst, input.properties, source, input.importWorld?.backupId, !!input.startAfterInstall, importMeta?.id).catch(() => {});
    return inst.summary();
  }

  private async installAndMaybeStart(inst: ServerInstance, props: Record<string, string> | undefined, source: ServerInstance | null, backupId: string | undefined, startAfter: boolean, importId?: string) {
    inst.setState('installing');
    inst.setProgress(null, 'Preparing');
    try {
      await this.doInstall(inst, props);
      if (importId) {
        inst.setProgress(null, 'Copying imported world');
        await applyImport(importId, inst.root, inst.rec.edition, inst.rec.levelName);
      } else if (source) await this.importWorld(inst, source, backupId);
      inst.rec.installed = true;
      await inst.save();
      inst.install = null;
      bus.publish({ type: 'server.progress', id: inst.id, pct: 100, message: 'Ready', done: true });
      inst.setState('stopped');
      if (startAfter) await this.startServer(inst.id);
    } catch (e) {
      const msg = (e as Error).message;
      inst.pushLog(`[Blockhost] Install failed: ${msg}`);
      bus.publish({ type: 'server.progress', id: inst.id, pct: null, message: msg, done: true, error: msg });
      inst.setState('error', msg);
    }
  }

  private async doInstall(inst: ServerInstance, props?: Record<string, string>) {
    const onProgress = (p: number | null, m: string) => inst.setProgress(p, m);
    if (inst.rec.edition === 'java') {
      const r = await installJava(inst.rec, inst.root, onProgress, props);
      inst.rec.build = r.build;
    } else {
      const r = await installBedrock(inst.rec, inst.root, onProgress, props);
      inst.rec.build = r.build;
      inst.rec.version = r.version;
    }
  }

  private async importWorld(target: ServerInstance, source: ServerInstance, backupId?: string) {
    target.setProgress(null, `Importing world from ${source.rec.name}`);
    if (backupId) {
      const metas = await listBackups(source.id);
      const meta = metas.find((b) => b.id === backupId);
      if (!meta) throw new Error('Selected backup not found');
      await extractWorld(backupFile(source.id, backupId), meta, target.root, target.rec.levelName);
      return;
    }
    if (source.state === 'running') {
      // Hot snapshot through the safe pipeline, then extract.
      const meta = await createBackup(source, { label: `pre-import-${target.rec.name}`, scope: 'world' });
      await extractWorld(backupFile(source.id, meta.id), meta, target.root, target.rec.levelName);
      return;
    }
    const src = worldDirs(source.rec);
    const dst = worldDirs(target.rec);
    let copied = 0;
    for (let i = 0; i < src.length; i++) {
      const s = path.join(source.root, src[i]);
      if (!(await exists(s))) continue;
      const d = path.join(target.root, dst[i]);
      await rmrf(d);
      await fsp.mkdir(path.dirname(d), { recursive: true });
      await fsp.cp(s, d, { recursive: true });
      copied++;
    }
    if (!copied) throw new Error(`Source server has no world directory (${src[0]})`);
  }

  /* ---------------------------- update ---------------------------- */

  async updateSettings(id: string, patch: Partial<ServerRecord>): Promise<ServerSummary> {
    const inst = this.get(id);
    const rec = inst.rec;
    const needsRestart: string[] = [];
    if (patch.name !== undefined) rec.name = String(patch.name).trim() || rec.name;
    if (patch.autoStart !== undefined) rec.autoStart = !!patch.autoStart;
    if (patch.restartOnCrash !== undefined) rec.restartOnCrash = !!patch.restartOnCrash;
    if (patch.backup) rec.backup = { ...rec.backup, ...patch.backup };
    if (patch.port !== undefined && Number(patch.port) !== rec.port) {
      this.setPort(inst, 'port', Number(patch.port), false);
      delete rec.portsReleased;
      needsRestart.push('port');
    }
    if (patch.levelName !== undefined && patch.levelName !== rec.levelName) {
      rec.levelName = String(patch.levelName).replace(/[\\/:*?"<>|]/g, '_') || rec.levelName;
      needsRestart.push('level');
    }
    if (rec.edition === 'bedrock' && patch.advertiseIp !== undefined && (patch.advertiseIp || undefined) !== rec.advertiseIp) {
      const ip = String(patch.advertiseIp || '').trim();
      if (ip && ip.toLowerCase() !== 'public' && !/^[0-9a-fA-F.:]+$/.test(ip)) throw bad('Advertised IP must be an IPv4/IPv6 literal or "public"');
      rec.advertiseIp = ip || undefined;
      needsRestart.push('advertiseIp');
    }
    if (rec.edition === 'bedrock' && patch.transport !== undefined && patch.transport !== rec.transport) {
      if (!['raknet', 'nethernet'].includes(patch.transport)) throw bad('transport must be raknet or nethernet');
      rec.transport = patch.transport;
      if (patch.transport !== 'nethernet' && rec.broadcast?.enabled) rec.broadcast = { enabled: false }; // console broadcast needs NetherNet
      needsRestart.push('transport');
    }
    if (rec.edition === 'java' && patch.java) {
      const j = rec.java!;
      if (patch.java.xmxMb !== undefined) j.xmxMb = Math.max(512, Math.round(Number(patch.java.xmxMb)));
      if (patch.java.xmsMb !== undefined) j.xmsMb = Math.max(256, Math.min(j.xmxMb, Math.round(Number(patch.java.xmsMb))));
      if (j.xmsMb > j.xmxMb) j.xmsMb = j.xmxMb;
      if (patch.java.preset !== undefined) j.preset = patch.java.preset;
      if (patch.java.extraArgs !== undefined) j.extraArgs = String(patch.java.extraArgs);
      if (patch.java.major !== undefined) j.major = patch.java.major === 'auto' ? 'auto' : Number(patch.java.major);
      needsRestart.push('java');
    }
    if (rec.edition === 'java' && patch.geyser !== undefined && !!patch.geyser !== rec.geyser) {
      if (!['PAPER', 'PURPUR', 'FABRIC', 'NEOFORGE'].includes(rec.type)) throw bad('Geyser requires Paper, Purpur, Fabric or NeoForge');
      rec.geyser = !!patch.geyser;
      if (rec.geyser) {
        rec.geyserPort = patch.geyserPort || rec.geyserPort || this.allocatePort('udp', id, 2);
        if (rec.installed) await installGeyser(rec, inst.root, (p, m) => inst.pushLog(`[Blockhost] ${m}`));
      } else {
        await removeGeyser(rec, inst.root);
        rec.geyserPort = undefined;
        if (rec.broadcast?.enabled) rec.broadcast = { enabled: false };
      }
      needsRestart.push('geyser');
    } else if (rec.geyser && patch.geyserPort !== undefined && Number(patch.geyserPort) !== rec.geyserPort) {
      this.setPort(inst, 'geyserPort', Number(patch.geyserPort), false);
      needsRestart.push('geyser');
    }
    await inst.save();
    if (needsRestart.length && inst.isActive) inst.pushLog(`[Blockhost] Settings changed (${needsRestart.join(', ')}); restart to apply.`);
    return inst.summary();
  }

  /** Change version and/or type in place. Worlds, configs, plugins and mods are kept. */
  async changeVersion(id: string, opts: { version: string; type?: ServerType; javaMajor?: number | 'auto'; backupFirst?: boolean }): Promise<void> {
    const inst = this.get(id);
    if (inst.state === 'installing') throw conflict('Already installing');
    const rec = inst.rec;
    const newType = opts.type || rec.type;
    if ((newType === 'BEDROCK') !== (rec.edition === 'bedrock')) throw bad('Cannot switch between Java and Bedrock in place; create a new server and import the world.');
    const wasRunning = inst.isActive;
    (async () => {
      try {
        if (wasRunning) {
          inst.pushLog('[Blockhost] Stopping for update');
          await inst.stop();
        }
        inst.setState('installing');
        if (opts.backupFirst !== false) {
          inst.setProgress(null, 'Creating safety backup');
          try {
            await createBackup(inst, { label: `pre-update-${rec.version}`, scope: 'world' });
          } catch (e) {
            inst.pushLog(`[Blockhost] Pre-update backup skipped: ${(e as Error).message}`);
          }
        }
        const prev = { version: rec.version, type: rec.type, build: rec.build };
        rec.version = opts.version.trim();
        rec.type = newType;
        if (rec.java && opts.javaMajor !== undefined) rec.java.major = opts.javaMajor;
        if (rec.java && rec.java.major !== 'auto' && opts.javaMajor === undefined) {
          // Re-evaluate auto-ness: if user had auto before keep auto; otherwise keep their explicit choice
        }
        try {
          await this.doInstall(inst);
        } catch (e) {
          rec.version = prev.version;
          rec.type = prev.type;
          rec.build = prev.build;
          throw e;
        }
        rec.installed = true;
        await inst.save();
        inst.install = null;
        bus.publish({ type: 'server.progress', id: inst.id, pct: 100, message: 'Updated', done: true });
        inst.setState('stopped');
        inst.pushLog(`[Blockhost] Now on ${rec.type} ${rec.version}`);
        if (wasRunning) await this.startServer(inst.id);
      } catch (e) {
        const msg = (e as Error).message;
        inst.pushLog(`[Blockhost] Update failed: ${msg}`);
        bus.publish({ type: 'server.progress', id: inst.id, pct: null, message: msg, done: true, error: msg });
        inst.setState(rec.installed ? 'stopped' : 'error', msg);
        inst.errorDetail = msg;
      }
    })().catch(() => {});
  }

  /** Re-run the installer for the current version (repair). */
  async reinstall(id: string): Promise<void> {
    const inst = this.get(id);
    await this.changeVersion(id, { version: inst.rec.version, backupFirst: false });
  }

  async remove(id: string, deleteFiles: boolean): Promise<void> {
    const inst = this.get(id);
    if (inst.isActive) await inst.stop(30_000);
    this.instances.delete(id);
    if (deleteFiles) await rmrf(serverDir(id));
    else await fsp.rename(serverDir(id), path.join(config.serversDir, `.deleted-${id}-${Date.now()}`)).catch(() => {});
    bus.publish({ type: 'server.changed' });
  }

  totalXmxMb(): number {
    let t = 0;
    for (const i of this.instances.values()) if (i.rec.java && i.isActive) t += i.rec.java.xmxMb;
    return t;
  }
}

export const manager = new ServerManager();
export { recommendedJavaMajor, HttpError };
