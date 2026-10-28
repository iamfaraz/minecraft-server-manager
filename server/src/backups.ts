import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import * as tar from 'tar';
import { bus } from './events.js';
import { serverBackupsDir } from './store.js';
import { exists, readJson, rmrf, slugify, writeJson, HttpError, sleep } from './util.js';
import type { ServerInstance } from './servers/instance.js';
import type { BackupScope, ServerRecord } from './servers/types.js';

export interface BackupMeta {
  id: string;
  label: string;
  scope: BackupScope;
  createdAt: string;
  bytes: number;
  edition: ServerRecord['edition'];
  type: ServerRecord['type'];
  version: string;
  levelName: string;
  auto: boolean;
  hot: boolean;
  consistent: boolean;
  note?: string;
}

const stamp = (d = new Date()) =>
  d.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, '').replace('T', '-');

export function worldDirs(rec: ServerRecord): string[] {
  if (rec.edition === 'bedrock') return [path.join('worlds', rec.levelName)];
  return [rec.levelName, `${rec.levelName}_nether`, `${rec.levelName}_the_end`];
}

export async function listBackups(id: string): Promise<BackupMeta[]> {
  const dir = serverBackupsDir(id);
  let entries: string[] = [];
  try {
    entries = await fsp.readdir(dir);
  } catch {
    return [];
  }
  const out: BackupMeta[] = [];
  for (const e of entries) {
    if (!e.endsWith('.json')) continue;
    const meta = await readJson<BackupMeta | null>(path.join(dir, e), null);
    if (meta && (await exists(path.join(dir, `${meta.id}.tar.gz`)))) out.push(meta);
  }
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export const backupFile = (id: string, backupId: string) => path.join(serverBackupsDir(id), `${backupId}.tar.gz`);

/**
 * Create a backup. When the server is running the world is frozen first:
 *   Java:    save-off -> save-all flush -> wait "Saved the game" -> copy -> save-on
 *   Bedrock: save hold -> poll save query until file list -> copy+truncate -> save resume
 */
export async function createBackup(inst: ServerInstance, opts: { label?: string; scope?: BackupScope; auto?: boolean }): Promise<BackupMeta> {
  const rec = inst.rec;
  const scope = opts.scope || 'world';
  const dir = serverBackupsDir(rec.id);
  await fsp.mkdir(dir, { recursive: true });
  const id = `${stamp()}-${slugify(opts.label || scope)}`;
  const file = path.join(dir, `${id}.tar.gz`);
  const running = inst.state === 'running';
  let consistent = true;
  let note: string | undefined;

  let stagingDir: string | null = null;
  const cleanup = async () => {
    if (stagingDir) await rmrf(stagingDir);
  };

  try {
    let worldSource = inst.root; // directory that contains the world dirs
    if (running && rec.edition === 'java') {
      inst.send('save-off');
      const saved = inst.waitFor((ev) => ev?.kind === 'saved', 90_000);
      inst.send('save-all flush');
      try {
        await saved;
      } catch {
        consistent = false;
        note = 'Server did not confirm the save; backup may be slightly stale';
      }
    } else if (running && rec.edition === 'bedrock') {
      inst.send('save hold');
      let files: { path: string; length: number }[] | null = null;
      for (let i = 0; i < 40 && !files; i++) {
        await sleep(500);
        const p = inst.waitFor((ev) => ev?.kind === 'bedrock-save-files', 1500);
        inst.send('save query');
        try {
          const { ev } = await p;
          if (ev?.kind === 'bedrock-save-files') files = ev.files;
        } catch {
          /* retry */
        }
      }
      if (files) {
        // Copy exactly the bytes the server told us are consistent.
        stagingDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'mcsm-bds-'));
        const worldsStage = path.join(stagingDir, 'worlds');
        for (const f of files) {
          const rel = f.path.replace(/\\/g, '/');
          const src = (await exists(path.join(inst.root, 'worlds', rel))) ? path.join(inst.root, 'worlds', rel) : path.join(inst.root, rel);
          const dst = path.join(worldsStage, rel);
          await fsp.mkdir(path.dirname(dst), { recursive: true });
          try {
            await fsp.copyFile(src, dst);
            await fsp.truncate(dst, f.length);
          } catch {
            /* file vanished between query and copy */
          }
        }
        worldSource = stagingDir;
      } else {
        consistent = false;
        note = 'Bedrock did not report a frozen file list; copied live files';
      }
    }

    // Build the archive
    const entries: { cwd: string; paths: string[] }[] = [];
    const worlds = worldDirs(rec);
    const existingWorlds: string[] = [];
    for (const w of worlds) if (await exists(path.join(worldSource, w))) existingWorlds.push(w);
    if (scope === 'world') {
      if (!existingWorlds.length) throw new HttpError(409, 'No world directory found to back up');
      entries.push({ cwd: worldSource, paths: existingWorlds });
    } else {
      const rootEntries = (await fsp.readdir(inst.root)).filter(
        (e) => !['logs', 'cache', 'crash-reports', '.console_history'].includes(e) && !worlds.includes(e) && !(rec.edition === 'bedrock' && e === 'worlds'),
      );
      entries.push({ cwd: inst.root, paths: rootEntries });
      if (existingWorlds.length) entries.push({ cwd: worldSource, paths: existingWorlds });
    }

    // tar supports a single cwd; stage world + root into one tree when they differ.
    if (entries.length === 1) {
      await tar.c({ gzip: true, file, cwd: entries[0].cwd, portable: true }, entries[0].paths);
    } else {
      const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'mcsm-full-'));
      try {
        for (const e of entries) for (const p of e.paths) await fsp.cp(path.join(e.cwd, p), path.join(tmp, p), { recursive: true, force: true });
        await tar.c({ gzip: true, file, cwd: tmp, portable: true }, await fsp.readdir(tmp));
      } finally {
        await rmrf(tmp);
      }
    }
  } finally {
    if (running && inst.state === 'running') {
      try {
        inst.send(rec.edition === 'java' ? 'save-on' : 'save resume');
      } catch {
        /* server went away */
      }
    }
    await cleanup();
  }

  const st = await fsp.stat(file);
  const meta: BackupMeta = {
    id,
    label: opts.label || (opts.auto ? 'Scheduled' : scope === 'world' ? 'World' : 'Full'),
    scope,
    createdAt: new Date().toISOString(),
    bytes: st.size,
    edition: rec.edition,
    type: rec.type,
    version: rec.version,
    levelName: rec.levelName,
    auto: !!opts.auto,
    hot: running,
    consistent,
    note,
  };
  await writeJson(path.join(dir, `${id}.json`), meta);
  bus.publish({ type: 'backup.changed', id: rec.id });
  return meta;
}

export async function deleteBackup(id: string, backupId: string): Promise<void> {
  const dir = serverBackupsDir(id);
  await fsp.rm(path.join(dir, `${backupId}.tar.gz`), { force: true });
  await fsp.rm(path.join(dir, `${backupId}.json`), { force: true });
  bus.publish({ type: 'backup.changed', id });
}

/** Extract a backup's world directories into `targetRoot`, renaming the level if needed. */
export async function extractWorld(archive: string, meta: BackupMeta, targetRoot: string, targetLevel: string): Promise<void> {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'mcsm-restore-'));
  try {
    await tar.x({ file: archive, cwd: tmp });
    const srcDirs = worldDirs({ edition: meta.edition, levelName: meta.levelName } as ServerRecord);
    const dstDirs = worldDirs({ edition: meta.edition, levelName: targetLevel } as ServerRecord);
    for (let i = 0; i < srcDirs.length; i++) {
      const src = path.join(tmp, srcDirs[i]);
      if (!(await exists(src))) continue;
      const dst = path.join(targetRoot, dstDirs[i]);
      await rmrf(dst);
      await fsp.mkdir(path.dirname(dst), { recursive: true });
      await fsp.cp(src, dst, { recursive: true });
    }
  } finally {
    await rmrf(tmp);
  }
}

export async function restoreBackup(inst: ServerInstance, backupId: string): Promise<void> {
  if (inst.isActive || inst.state === 'installing') throw new HttpError(409, 'Stop the server before restoring');
  const dir = serverBackupsDir(inst.id);
  const meta = await readJson<BackupMeta | null>(path.join(dir, `${backupId}.json`), null);
  const archive = path.join(dir, `${backupId}.tar.gz`);
  if (!meta || !(await exists(archive))) throw new HttpError(404, 'Backup not found');
  if (meta.scope === 'world') {
    await extractWorld(archive, meta, inst.root, inst.rec.levelName);
  } else {
    await tar.x({ file: archive, cwd: inst.root });
    if (meta.levelName !== inst.rec.levelName) {
      inst.rec.levelName = meta.levelName;
      await inst.save();
    }
  }
  inst.pushLog(`[Blockhost] Restored backup ${meta.label} (${meta.createdAt})`);
}

export async function applyRetention(id: string, keep: number): Promise<void> {
  if (!keep || keep < 1) return;
  const autos = (await listBackups(id)).filter((b) => b.auto);
  for (const b of autos.slice(keep)) await deleteBackup(id, b.id);
}
