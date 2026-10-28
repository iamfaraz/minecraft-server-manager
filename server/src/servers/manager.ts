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
import { pingBedrock, pingJava } from './status.js';
import type { CreateServerInput, ServerRecord, ServerSummary, ServerType, JavaSettings } from './types.js';
import { JAVA_TYPES } from './types.js';
import { applyRetention, backupFile, createBackup, extractWorld, listBackups, worldDirs } from '../backups.js';

const ALL_TYPES: ServerType[] = [...JAVA_TYPES, 'BEDROCK'];

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
        inst.start().catch((e) => inst.pushLog(`[Blockhost] Auto-start failed: ${e.message}`));
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
      const r = inst.rec.edition === 'java' ? await pingJava('127.0.0.1', inst.rec.port) : await pingBedrock('127.0.0.1', inst.rec.port, 3000, inst.rec.transport === 'nethernet');
      inst.ping = r.ok ? r : inst.ping && !r.ok ? { ok: false } : r;
      if (r.ok && inst.state === 'starting') inst.setState('running');
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

  usedPorts(exceptId?: string): Set<number> {
    const used = new Set<number>();
    for (const i of this.instances.values()) {
      if (i.id === exceptId) continue;
      used.add(i.rec.port);
      if (i.rec.portV6) used.add(i.rec.portV6);
      if (i.rec.geyser && i.rec.geyserPort) used.add(i.rec.geyserPort);
    }
    return used;
  }

  allocatePort(kind: 'java' | 'bedrock' | 'udp', exceptId?: string, span = 1): number {
    const [lo, hi] = kind === 'java' ? config.javaPorts : config.bedrockPorts;
    const used = this.usedPorts(exceptId);
    for (let p = lo; p + span - 1 <= hi; p++) {
      let ok = true;
      for (let k = 0; k < span; k++) if (used.has(p + k)) ok = false;
      if (ok) return p;
    }
    throw conflict(`No free ${kind === 'java' ? 'TCP' : 'UDP'} ports left in the published range ${lo}-${hi}. Stop or delete a server, or widen MCSM_${kind === 'java' ? 'JAVA' : 'BEDROCK'}_PORTS.`);
  }

  /* ---------------------------- create ---------------------------- */

  async create(input: CreateServerInput): Promise<ServerSummary> {
    if (!input.name?.trim()) throw bad('Name is required');
    if (!ALL_TYPES.includes(input.type)) throw bad('Invalid server type');
    const edition = input.type === 'BEDROCK' ? 'bedrock' : 'java';
    if (input.edition && input.edition !== edition) throw bad('Edition does not match type');
    if (!input.version?.trim()) throw bad('Version is required');

    let source: ServerInstance | null = null;
    if (input.importWorld?.sourceServerId) {
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

    const levelName = (input.levelName?.trim() || (source ? source.rec.levelName : edition === 'bedrock' ? 'Bedrock level' : 'world')).replace(/[\\/:*?"<>|]/g, '_');
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
      transport: edition === 'bedrock' ? (input.transport === 'nethernet' ? 'nethernet' : 'raknet') : undefined,
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
    if (geyser) rec.geyserPort = this.allocatePort('udp', undefined, 1);

    await fsp.mkdir(serverRoot(id), { recursive: true });
    await fsp.mkdir(serverBackupsDir(id), { recursive: true });
    await writeJson(serverRecordFile(id), rec);
    const inst = new ServerInstance(rec);
    this.instances.set(id, inst);
    bus.publish({ type: 'server.changed', id });

    // Install asynchronously; the UI follows progress over the websocket.
    this.installAndMaybeStart(inst, input.properties, source, input.importWorld?.backupId, !!input.startAfterInstall).catch(() => {});
    return inst.summary();
  }

  private async installAndMaybeStart(inst: ServerInstance, props: Record<string, string> | undefined, source: ServerInstance | null, backupId: string | undefined, startAfter: boolean) {
    inst.setState('installing');
    inst.setProgress(null, 'Preparing');
    try {
      await this.doInstall(inst, props);
      if (source) await this.importWorld(inst, source, backupId);
      inst.rec.installed = true;
      await inst.save();
      inst.install = null;
      bus.publish({ type: 'server.progress', id: inst.id, pct: 100, message: 'Ready', done: true });
      inst.setState('stopped');
      if (startAfter) await inst.start();
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
    if (patch.port !== undefined && patch.port !== rec.port) {
      const p = Number(patch.port);
      if (!Number.isInteger(p) || p < 1024 || p > 65535) throw bad('Invalid port');
      const used = this.usedPorts(id);
      if (used.has(p) || (rec.edition === 'bedrock' && used.has(p + 1))) throw conflict('Port already assigned to another server');
      rec.port = p;
      if (rec.edition === 'bedrock') rec.portV6 = p + 1;
      needsRestart.push('port');
    }
    if (patch.levelName !== undefined && patch.levelName !== rec.levelName) {
      rec.levelName = String(patch.levelName).replace(/[\\/:*?"<>|]/g, '_') || rec.levelName;
      needsRestart.push('level');
    }
    if (rec.edition === 'bedrock' && patch.transport !== undefined && patch.transport !== rec.transport) {
      if (!['raknet', 'nethernet'].includes(patch.transport)) throw bad('transport must be raknet or nethernet');
      rec.transport = patch.transport;
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
        rec.geyserPort = patch.geyserPort || rec.geyserPort || this.allocatePort('udp', id);
        if (rec.installed) await installGeyser(rec, inst.root, (p, m) => inst.pushLog(`[Blockhost] ${m}`));
      } else {
        await removeGeyser(rec, inst.root);
        rec.geyserPort = undefined;
      }
      needsRestart.push('geyser');
    } else if (rec.geyser && patch.geyserPort !== undefined && patch.geyserPort !== rec.geyserPort) {
      const p = Number(patch.geyserPort);
      if (this.usedPorts(id).has(p) || p === rec.port) throw conflict('Port already assigned');
      rec.geyserPort = p;
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
        if (wasRunning) await inst.start();
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
