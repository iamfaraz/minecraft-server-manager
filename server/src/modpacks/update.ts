/**
 * Pack updates. Everything new is downloaded and checked before the server is touched; then the server stops,
 * a full backup is taken, and the plan is applied. If anything fails after that, the backup and the previous
 * record are restored, so the server is never left half-updated.
 */
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { downloads, withTask, type DownloadCtx, type DownloadManager } from '../downloads.js';
import { downloadTo, rmrf } from '../util.js';
import { decideSkips, jarIsClientOnly } from './clientOnly.js';
import { downloadPackFile, type ManifestFile, type ManifestOverride, type ModpackRecord } from './install.js';
import { classifyOverride, loaderFromDeps, readMrpack, readOverride } from './mrpack.js';
import { defaultVersion, packVersion, packVersions, projectSides, type Fetcher } from './modrinth.js';
import { hashOrNull } from './ownership.js';
import { planPackUpdate, type NextFile, type NextOverride, type UpdatePlan } from './plan.js';

/** The parts of a ServerInstance this module needs (kept narrow so it can be tested without a real server). */
export interface PackServer {
  id: string;
  root: string;
  dir: string;
  state: string;
  rec: {
    name: string;
    type: string;
    version: string;
    edition: string;
    build?: { pinnedLoaderVersion?: string; [k: string]: unknown };
    modpack?: ModpackRecord;
  };
  readonly isActive: boolean;
  stop(): Promise<void>;
  save(): Promise<void>;
  setState(s: any, detail?: string): void;
  setProgress(pct: number | null, message: string): void;
  pushLog(line: string): void;
}

export interface UpdateDeps {
  fetcher?: Fetcher;
  manager?: DownloadManager;
  /** Download the new .mrpack (default: through the download manager). */
  fetchPack?: (url: string, dest: string, sha1: string, ctx: DownloadCtx) => Promise<void>;
  backup: (inst: PackServer, label: string) => Promise<string>;
  restore: (inst: PackServer, backupId: string) => Promise<void>;
  /** Install the loader/Minecraft version now in inst.rec (Java install). */
  reinstall: (inst: PackServer, ctx: DownloadCtx) => Promise<void>;
  start: (inst: PackServer) => Promise<void>;
  hits?: () => number;
}

const LOADER_KEY: Record<string, string> = { FABRIC: 'fabric', QUILT: 'quilt', FORGE: 'forge', NEOFORGE: 'neoforge' };
const sha1 = (b: Buffer) => crypto.createHash('sha1').update(b).digest('hex');
export const packArchivePath = (inst: { dir: string }) => path.join(inst.dir, '.modpack', 'pack.mrpack');

export interface PackUpdateInfo {
  available: boolean;
  latest?: { versionId: string; versionNumber: string; mc: string; loaders: string[] };
  changesMcVersion: boolean;
}

export async function checkPackUpdate(inst: PackServer, f?: Fetcher): Promise<PackUpdateInfo | null> {
  const mp = inst.rec.modpack;
  if (!mp?.projectId || mp.updates.mode === 'ignore') return null;
  const all = await packVersions(mp.projectId, f);
  const loader = LOADER_KEY[inst.rec.type];
  const compatible = loader ? all.filter((v) => v.loaders.includes(loader)) : all;
  const list = compatible.length ? compatible : all;
  if (!list.length) return { available: false, changesMcVersion: false };
  const latest = list[defaultVersion(list)];
  const current = all.find((v) => v.id === mp.versionId);
  const newer = latest.id !== mp.versionId && (!current || latest.date > current.date);
  const mc = latest.mc.includes(inst.rec.version) ? inst.rec.version : latest.mc[0];
  return {
    available: newer && latest.id !== mp.updates.skippedVersionId,
    latest: { versionId: latest.id, versionNumber: latest.versionNumber, mc, loaders: latest.loaders },
    changesMcVersion: mc !== inst.rec.version,
  };
}

export async function setPackUpdateMode(inst: PackServer, mode: 'notify' | 'ignore'): Promise<void> {
  if (!inst.rec.modpack) throw new Error('This server is not following a modpack');
  inst.rec.modpack.updates.mode = mode;
  await inst.save();
}

export async function skipPackVersion(inst: PackServer, versionId: string): Promise<void> {
  if (!inst.rec.modpack) throw new Error('This server is not following a modpack');
  inst.rec.modpack.updates.skippedVersionId = versionId;
  await inst.save();
}

/** Turn a modpack server into a normal modded server: no pack updates, no pinned loader. */
export async function detachPack(inst: PackServer): Promise<void> {
  delete inst.rec.modpack;
  if (inst.rec.build) delete inst.rec.build.pinnedLoaderVersion;
  await inst.save();
}

export type PackUpdateResult = UpdatePlan['summary'] & { mcChanged: boolean; from: string; to: string };

export async function applyPackUpdate(inst: PackServer, versionId: string, deps: UpdateDeps): Promise<PackUpdateResult> {
  const mp = inst.rec.modpack;
  if (!mp) throw new Error('This server is not following a modpack');
  if (inst.state === 'installing') throw new Error('Already installing');
  const m = deps.manager ?? downloads;
  const staging = path.join(inst.dir, '.pack-staging');
  const { version } = await packVersion(versionId, deps.fetcher);
  const from = mp.versionNumber;

  return withTask({ label: `Update modpack ${mp.title} ${from}→${version.versionNumber} · ${inst.rec.name}`, serverId: inst.id, kind: 'modpack' }, async (ctx) => {
    /* ---- 1. Stage: download and verify everything while the server keeps running ---- */
    await rmrf(staging);
    await fsp.mkdir(path.join(staging, 'files'), { recursive: true });
    const packFile = path.join(staging, 'pack.mrpack');
    try {
      inst.setProgress(null, `Downloading ${mp.title} ${version.versionNumber}`);
      await (deps.fetchPack ?? ((url, dest, h, c) => downloadTo(url, dest, undefined, { ...c, sha1: h })))(version.fileUrl, packFile, version.fileSha1, ctx);
      const { index, overrides } = readMrpack(packFile);
      const loader = loaderFromDeps(index.dependencies);
      const sides = await projectSides(index.files.map((f) => f.hashes.sha1), deps.fetcher).catch(() => ({}) as Record<string, { projectId: string; serverSide: string }>);
      const decisions = decideSkips(index.files.map((f) => ({ path: f.path, env: f.env, projectServerSide: sides[f.hashes.sha1]?.serverSide })), mp.skips);
      const nextFiles: NextFile[] = index.files.map((f, i) => ({ ...f, projectId: sides[f.hashes.sha1]?.projectId, skip: decisions[i].skip }));
      const overrideData = new Map(overrides.map((o) => [o.path, readOverride(packFile, o.entry)]));
      const nextOverrides: NextOverride[] = overrides.map((o) => ({ path: o.path, sha1: sha1(overrideData.get(o.path)!), cls: classifyOverride(o.path) }));

      const paths = new Set([...mp.files.map((f) => f.path), ...mp.overrides.map((o) => o.path), ...nextOverrides.map((o) => o.path), ...nextFiles.map((f) => f.path)]);
      const disk: Record<string, string | null> = {};
      for (const p of paths) disk[p] = await hashOrNull(path.join(inst.root, p));
      const plan = planPackUpdate(mp, { files: nextFiles, overrides: nextOverrides }, disk);

      const toFetch = plan.actions.filter((a): a is Extract<typeof a, { kind: 'add' | 'replace' }> => (a.kind === 'add' || a.kind === 'replace') && !('override' in a.file));
      await Promise.all(toFetch.map((a) => downloadPackFile(a.file as NextFile, path.join(staging, 'files', a.path), ctx, m)));

      /* ---- 2. Stop, back up, apply ---- */
      const wasRunning = inst.isActive;
      if (wasRunning) {
        inst.pushLog('[Blockhost] Stopping for modpack update');
        await inst.stop();
      }
      inst.setProgress(null, 'Creating safety backup');
      const backupId = await deps.backup(inst, `pre-modpack-${from}→${version.versionNumber}`);
      const snapshot = JSON.parse(JSON.stringify(inst.rec));
      const written: string[] = [];
      const mcChanged = loader.mc !== inst.rec.version;
      try {
        inst.setState('installing');
        if (mcChanged || loader.type !== inst.rec.type || (loader.loaderVersion ?? undefined) !== inst.rec.build?.pinnedLoaderVersion) {
          inst.rec.type = loader.type;
          inst.rec.version = loader.mc;
          inst.rec.build = { ...(inst.rec.build || {}), pinnedLoaderVersion: loader.loaderVersion };
          inst.setProgress(null, `Installing ${loader.type} for Minecraft ${loader.mc}`);
          await deps.reinstall(inst, ctx);
        }

        inst.setProgress(null, 'Applying modpack update');
        const files = new Map<string, ManifestFile>(mp.files.map((f) => [f.path, f]));
        const overridesOut = new Map<string, ManifestOverride>(mp.overrides.map((o) => [o.path, o]));
        const place = async (rel: string, data: Buffer | string) => {
          const full = path.join(inst.root, rel);
          await fsp.mkdir(path.dirname(full), { recursive: true });
          if (typeof data === 'string') await fsp.copyFile(data, full);
          else await fsp.writeFile(full, data);
          written.push(rel);
        };
        for (const a of plan.actions) {
          switch (a.kind) {
            case 'remove':
              await fsp.rm(path.join(inst.root, a.path), { force: true });
              files.delete(a.path);
              break;
            case 'add':
            case 'replace': {
              if (a.kind === 'replace' && a.from) {
                await fsp.rm(path.join(inst.root, a.from), { force: true });
                files.delete(a.from);
              }
              const src = 'override' in a.file ? overrideData.get(a.file.override)! : path.join(staging, 'files', a.path);
              await place(a.path, src);
              const full = path.join(inst.root, a.path);
              if (/\.jar$/i.test(a.path) && mp.skips[a.path] !== false && jarIsClientOnly(await fsp.readFile(full))) {
                await fsp.rm(full, { force: true });
                files.delete(a.path);
                inst.pushLog(`[Blockhost] Skipped client-only mod ${a.path}`);
                break;
              }
              files.set(a.path, { path: a.path, sha1: a.sha1, projectId: a.projectId });
              break;
            }
            case 'keep-changed-file': {
              const e = files.get(a.path);
              if (e) e.adminOwned = true;
              break;
            }
            case 'write-config':
              await place(a.path, overrideData.get(a.path)!);
              overridesOut.set(a.path, { path: a.path, packSha1: a.sha1 });
              break;
            case 'keep-config': {
              const e = overridesOut.get(a.path);
              if (e) e.adminOwned = true;
              break;
            }
            case 'keep-admin-file':
              break;
          }
        }
        mp.files = [...files.values()].sort((a, b) => a.path.localeCompare(b.path));
        mp.overrides = [...overridesOut.values()].sort((a, b) => a.path.localeCompare(b.path));
        mp.versionId = version.id;
        mp.versionNumber = version.versionNumber;
        mp.baselinePending = true;
        delete mp.updates.skippedVersionId;
        await fsp.mkdir(path.dirname(packArchivePath(inst)), { recursive: true });
        await fsp.copyFile(packFile, packArchivePath(inst));
        await inst.save();
        inst.setState('stopped');
        inst.pushLog(`[Blockhost] Modpack updated: ${mp.title} ${from} → ${version.versionNumber}`);
        if (wasRunning) await deps.start(inst);
        return { ...plan.summary, mcChanged, from, to: version.versionNumber };
      } catch (e) {
        inst.pushLog(`[Blockhost] Modpack update failed, rolling back: ${(e as Error).message}`);
        inst.setState('stopped');
        for (const rel of written) await fsp.rm(path.join(inst.root, rel), { force: true }).catch(() => {});
        await deps.restore(inst, backupId);
        for (const k of Object.keys(inst.rec)) delete (inst.rec as any)[k];
        Object.assign(inst.rec, snapshot);
        await inst.save();
        if (wasRunning) await deps.start(inst).catch(() => {});
        throw new Error(`Update failed and was rolled back: ${(e as Error).message}`);
      }
    } finally {
      await rmrf(staging);
    }
  }, m);
}
