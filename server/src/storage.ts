/** What takes up space in the data folder, and the parts that can be cleared safely. */
import fsp from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';
import { manager } from './servers/manager.js';
import { serverBackupsDir, serverDir, serverRoot } from './store.js';
import { listImports } from './imports.js';
import { listBackups, deleteBackup } from './backups.js';
import { dirSize, exists, rmrf, safeJoin, HttpError } from './util.js';

const sizeOf = async (p: string) => ((await exists(p)) ? dirSize(p) : 0);

export async function storageOverview() {
  const servers = [];
  for (const inst of manager.instances.values()) {
    const [files, backups, other] = await Promise.all([sizeOf(serverRoot(inst.id)), sizeOf(serverBackupsDir(inst.id)), sizeOf(serverDir(inst.id))]);
    servers.push({ id: inst.id, name: inst.rec.name, edition: inst.rec.edition, state: inst.state, files, backups, other: Math.max(0, other - files - backups), backupCount: (await listBackups(inst.id)).length });
  }
  const cacheFiles = [];
  for (const e of await fsp.readdir(config.cacheDir, { withFileTypes: true })) {
    if (!e.isFile()) continue;
    const st = await fsp.stat(path.join(config.cacheDir, e.name));
    cacheFiles.push({ name: e.name, bytes: st.size, modifiedAt: st.mtime.toISOString() });
  }
  cacheFiles.sort((a, b) => b.bytes - a.bytes);
  const runtimes = [];
  const javaDir = path.join(config.runtimesDir, 'java');
  const inUse = new Set<string>();
  for (const inst of manager.instances.values()) if (inst.isActive && inst.rec.java?.major && inst.rec.java.major !== 'auto') inUse.add(String(inst.rec.java.major));
  if (await exists(javaDir)) for (const e of await fsp.readdir(javaDir)) runtimes.push({ name: `Java ${e}`, key: `java/${e}`, bytes: await dirSize(path.join(javaDir, e)), inUse: inUse.has(e) });
  const mcxb = path.join(config.runtimesDir, 'mcxboxbroadcast');
  if (await exists(mcxb)) runtimes.push({ name: 'MCXboxBroadcast (console broadcast)', key: 'mcxboxbroadcast', bytes: await dirSize(mcxb), inUse: [...manager.instances.values()].some((i) => i.rec.broadcast?.enabled) });
  const imports = (await listImports()).map((i) => ({ id: i.id, name: i.name, edition: i.edition, bytes: i.bytes, createdAt: i.createdAt }));
  const icons = await sizeOf(path.join(config.cacheDir, 'icons'));
  const playit = await sizeOf(config.playitDir);
  let disk: { free: number; total: number } | null = null;
  try {
    const st = await fsp.statfs(config.dataDir);
    disk = { free: st.bavail * st.bsize, total: st.blocks * st.bsize };
  } catch {
    /* not supported here */
  }
  return {
    disk,
    dataDir: config.dataDir,
    servers,
    cache: { bytes: cacheFiles.reduce((n, f) => n + f.bytes, 0), files: cacheFiles },
    icons,
    runtimes,
    imports,
    playit,
    total: await dirSize(config.dataDir),
  };
}

/** Downloaded server files (jars, Bedrock zips, Java archives). They are fetched again when needed. */
export async function clearCache(name?: string): Promise<void> {
  if (name) return rmrf(safeJoin(config.cacheDir, name));
  for (const e of await fsp.readdir(config.cacheDir, { withFileTypes: true })) if (e.isFile()) await rmrf(path.join(config.cacheDir, e.name));
}

export const clearIcons = () => rmrf(path.join(config.cacheDir, 'icons'));

/** A downloaded Java runtime or the console broadcaster. Refused while a running server needs it. */
export async function removeRuntime(key: string): Promise<void> {
  const dir = safeJoin(config.runtimesDir, key);
  if (!(await exists(dir))) throw new HttpError(404, 'No such runtime');
  const major = /^java\/(\d+)$/.exec(key)?.[1];
  for (const inst of manager.instances.values()) {
    if (!inst.isActive) continue;
    if (major && inst.rec.edition === 'java') throw new HttpError(409, `Stop the Java servers first; "${inst.rec.name}" may be using Java ${major}`);
    if (key === 'mcxboxbroadcast' && inst.rec.broadcast?.enabled) throw new HttpError(409, `"${inst.rec.name}" uses the console broadcaster; turn it off first`);
  }
  await rmrf(dir);
}

/** Every backup of one server. */
export async function deleteAllBackups(id: string): Promise<number> {
  const backups = await listBackups(id);
  for (const b of backups) await deleteBackup(id, b.id);
  return backups.length;
}
