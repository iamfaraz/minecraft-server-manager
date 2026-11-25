/**
 * Packs waiting to become servers: <data>/modpacks/<id>/{pack.mrpack, meta.json}. A pack gets here from an upload
 * or from a Modrinth version; either way the preview (loader, files, client-only skips, link) is worked out once.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { FastifyRequest } from 'fastify';
import { config } from '../config.js';
import { fileHash, withTask } from '../downloads.js';
import { bad, downloadTo, notFound, readJson, rmrf, uid, writeJson } from '../util.js';
import { decideSkips, type SkipReason } from './clientOnly.js';
import { loaderFromDeps, readMrpack, type MrpackIndex, type PackLoader } from './mrpack.js';
import { identifyPack, packVersion, projectInfo, projectSides, type PackLink } from './modrinth.js';

export interface StagedFile {
  path: string;
  size: number;
  skip: boolean;
  reason?: SkipReason;
  projectId?: string;
}

export interface StagedPack {
  id: string;
  fileName: string;
  createdAt: string;
  index: Pick<MrpackIndex, 'name' | 'versionId' | 'summary'>;
  loader: PackLoader;
  link: PackLink | null;
  files: StagedFile[];
  overrideCount: number;
  downloadBytes: number;
}

export const stagedDir = path.join(config.dataDir, 'modpacks');
const dirOf = (id: string) => {
  if (!/^[a-z0-9-]+$/.test(id)) throw bad('Invalid modpack id');
  return path.join(stagedDir, id);
};
export const stagedFile = (id: string) => path.join(dirOf(id), 'pack.mrpack');
const metaFile = (id: string) => path.join(dirOf(id), 'meta.json');

/** Work out the preview for a pack file already saved at stagedFile(id). */
async function build(id: string, fileName: string, link?: PackLink | null): Promise<StagedPack> {
  const file = stagedFile(id);
  const { index, overrides } = readMrpack(file);
  const loader = loaderFromDeps(index.dependencies);
  if (link === undefined) link = await identifyPack(await fileHash(file, 'sha1'), index).catch(() => null);
  const sides = await projectSides(index.files.map((f) => f.hashes.sha1).filter(Boolean)).catch(() => ({}) as Awaited<ReturnType<typeof projectSides>>);
  const decisions = decideSkips(
    index.files.map((f) => ({ path: f.path, env: f.env, projectServerSide: sides[f.hashes.sha1]?.serverSide })),
    {},
  );
  const files: StagedFile[] = index.files.map((f, i) => ({ path: f.path, size: f.fileSize ?? 0, skip: decisions[i].skip, reason: decisions[i].reason, projectId: sides[f.hashes.sha1]?.projectId }));
  const meta: StagedPack = {
    id,
    fileName,
    createdAt: new Date().toISOString(),
    index: { name: index.name, versionId: index.versionId, summary: index.summary },
    loader,
    link,
    files,
    overrideCount: overrides.length,
    downloadBytes: files.filter((f) => !f.skip).reduce((a, f) => a + f.size, 0),
  };
  await writeJson(metaFile(id), meta);
  return meta;
}

export async function stageUpload(req: FastifyRequest): Promise<StagedPack> {
  const part = await req.file();
  if (!part) throw bad('No file uploaded');
  const id = `pack-${uid(6)}`;
  await fsp.mkdir(dirOf(id), { recursive: true });
  try {
    await pipeline(part.file, fs.createWriteStream(stagedFile(id)));
    if (part.file.truncated) throw bad('The file is too large');
    return await build(id, path.basename(part.filename || 'pack.mrpack'));
  } catch (e) {
    await rmrf(dirOf(id));
    throw e;
  }
}

export async function stageFromModrinth(versionId: string): Promise<StagedPack> {
  const { version, projectId } = await packVersion(versionId);
  const p = await projectInfo(projectId);
  const id = `pack-${uid(6)}`;
  await fsp.mkdir(dirOf(id), { recursive: true });
  try {
    await withTask({ label: `Modpack ${p.title} ${version.versionNumber}`, kind: 'modpack' }, (ctx) =>
      downloadTo(version.fileUrl, stagedFile(id), undefined, { ...ctx, sha1: version.fileSha1, label: `${p.slug}-${version.versionNumber}.mrpack` }),
    );
    const link: PackLink = { projectId: p.id, slug: p.slug, title: p.title, icon: p.icon, versionId: version.id, versionNumber: version.versionNumber, confidence: 'exact' };
    return await build(id, `${p.slug}-${version.versionNumber}.mrpack`, link);
  } catch (e) {
    await rmrf(dirOf(id));
    throw e;
  }
}

export async function getStaged(id: string): Promise<StagedPack> {
  const m = await readJson<StagedPack | null>(metaFile(id), null);
  if (!m) throw notFound('Modpack not found');
  return m;
}

export async function listStaged(): Promise<StagedPack[]> {
  await fsp.mkdir(stagedDir, { recursive: true });
  const out: StagedPack[] = [];
  for (const e of await fsp.readdir(stagedDir)) {
    const m = await readJson<StagedPack | null>(path.join(stagedDir, e, 'meta.json'), null);
    if (m) out.push(m);
  }
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function deleteStaged(id: string): Promise<void> {
  await getStaged(id);
  await rmrf(dirOf(id));
}
