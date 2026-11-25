/** Put a modpack's server files and overrides into a server folder, and record what came from the pack. */
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { CancelledError, downloads, type DownloadCtx, type DownloadManager, type Progress } from '../downloads.js';
import { PropertiesFile } from '../util.js';
import { jarIsClientOnly } from './clientOnly.js';
import { classifyOverride, readMrpack, safeTarget, type MrpackFile } from './mrpack.js';

export interface ManifestFile {
  path: string;
  sha1: string;
  projectId?: string;
  /** The admin changed or removed this file by hand; pack updates leave it alone. */
  adminOwned?: boolean;
}

export interface ManifestOverride {
  path: string;
  /** Hash as the pack wrote it. */
  packSha1: string;
  /** Hash after the first successful start (mods often rewrite their configs then). */
  baselineSha1?: string;
  adminOwned?: boolean;
}

export interface ModpackRecord {
  source: 'modrinth' | 'upload';
  projectId?: string;
  slug?: string;
  title: string;
  icon?: string;
  versionId?: string;
  versionNumber: string;
  files: ManifestFile[];
  overrides: ManifestOverride[];
  /** Admin choices from the preview: true = skip this pack file, false = install it even if flagged. */
  skips: Record<string, boolean>;
  updates: { mode: 'notify' | 'ignore'; skippedVersionId?: string };
  /** The staged pack this server is installed from, until that install has finished. */
  stagedId?: string;
  /** Config baselines still need to be recorded at the next successful start. */
  baselinePending?: boolean;
}

export interface InstallOptions {
  projectIds?: Record<string, string>;
  manager?: DownloadManager;
  log?: (m: string) => void;
  /** server.properties values the admin chose when creating the server; they win over the pack's file. */
  properties?: Record<string, string>;
}

const sha1 = (b: Buffer) => crypto.createHash('sha1').update(b).digest('hex');
const isJar = (p: string) => /\.jar$/i.test(p);

/** Download one pack file, trying each listed URL in turn (one job in the downloads panel). */
export async function downloadPackFile(f: MrpackFile, dest: string, ctx: DownloadCtx, m: DownloadManager): Promise<void> {
  const [url, ...mirrors] = f.downloads;
  if (!url) throw new Error(`No download URL for ${f.path}`);
  await m.download(url, dest, { ...ctx, mirrors, label: path.basename(f.path), sha512: f.hashes.sha512, sha1: f.hashes.sha512 ? undefined : f.hashes.sha1, expectedSize: f.fileSize || undefined });
}

/** True when a pack file should be dropped because its own metadata says client-only and the admin did not insist. */
async function droppedAsClientOnly(full: string, rel: string, skips: Record<string, boolean>, log?: (m: string) => void): Promise<boolean> {
  if (!isJar(rel) || skips[rel] === false) return false;
  if (!jarIsClientOnly(await fsp.readFile(full))) return false;
  await fsp.rm(full, { force: true });
  log?.(`[Blockhost] Skipped client-only mod ${rel}`);
  return true;
}

export async function installPackFiles(
  root: string,
  mrpack: string,
  skips: Record<string, boolean>,
  ctx: DownloadCtx,
  onProgress: Progress,
  opts: InstallOptions = {},
): Promise<Pick<ModpackRecord, 'files' | 'overrides'>> {
  const m = opts.manager ?? downloads;
  // Validates every path before anything is written.
  const { index, overrides, read } = readMrpack(mrpack);
  const wanted = index.files.filter((f) => {
    if (skips[f.path] === true) return false;
    if (skips[f.path] === false) return true;
    return f.env?.server !== 'unsupported';
  });

  const files: ManifestFile[] = [];
  let done = 0;
  const total = wanted.length + overrides.length;
  const tick = (what: string) => onProgress(total ? Math.round((++done / total) * 100) : 100, what);

  await Promise.all(
    wanted.map(async (f) => {
      const full = await safeTarget(root, f.path);
      await downloadPackFile(f, full, ctx, m);
      if (!(await droppedAsClientOnly(full, f.path, skips, opts.log))) files.push({ path: f.path, sha1: f.hashes.sha1 || sha1(await fsp.readFile(full)), projectId: opts.projectIds?.[f.path] });
      tick(`Downloaded ${path.basename(f.path)}`);
    }),
  );

  const outOverrides: ManifestOverride[] = [];
  for (const o of overrides) {
    if (ctx.signal?.aborted) throw new CancelledError();
    const data = read(o.entry);
    const full = await safeTarget(root, o.path);
    await fsp.mkdir(path.dirname(full), { recursive: true });
    await fsp.writeFile(full, data);
    if (o.path === 'server.properties' && opts.properties && Object.keys(opts.properties).length) {
      const pf = await PropertiesFile.load(full);
      for (const [k, v] of Object.entries(opts.properties)) pf.set(k, v);
      await pf.save();
    }
    if (classifyOverride(o.path) === 'file') {
      if (!(await droppedAsClientOnly(full, o.path, skips, opts.log))) files.push({ path: o.path, sha1: sha1(data) });
    } else outOverrides.push({ path: o.path, packSha1: sha1(data) });
    tick(`Applied ${o.path}`);
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { files, overrides: outOverrides };
}
