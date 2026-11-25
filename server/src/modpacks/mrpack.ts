/**
 * Reading Modrinth modpacks (.mrpack): a zip with modrinth.index.json, overrides/ (both sides) and
 * server-overrides/ (server only, applied after overrides/). client-overrides/ is not used on a server.
 * https://support.modrinth.com/en/articles/8802351-modrinth-modpack-format-mrpack
 */
import AdmZip from 'adm-zip';
import path from 'node:path';
import { bad } from '../util.js';

export interface MrpackFile {
  path: string;
  hashes: { sha1: string; sha512: string };
  env?: { client?: string; server?: string };
  downloads: string[];
  fileSize: number;
}

export interface MrpackIndex {
  formatVersion: 1;
  game: 'minecraft';
  name: string;
  versionId: string;
  summary?: string;
  files: MrpackFile[];
  dependencies: Record<string, string>;
}

export type PackLoaderType = 'VANILLA' | 'FABRIC' | 'QUILT' | 'FORGE' | 'NEOFORGE';
export interface PackLoader {
  type: PackLoaderType;
  mc: string;
  loaderVersion?: string;
}

export interface MrpackOverride {
  /** Path inside the server folder. */
  path: string;
  source: 'overrides' | 'server-overrides';
  /** Entry name inside the zip. */
  entry: string;
}

/** Normalise a relative path from a pack and refuse anything that could leave the server folder. */
export function assertSafeRelPath(p: string): string {
  const s = String(p ?? '').replace(/\\/g, '/');
  if (!s || s.startsWith('/') || /^[a-zA-Z]:/.test(s) || s.includes('\0')) throw bad(`Unsafe path in modpack: ${p}`);
  const norm = path.posix.normalize(s);
  if (norm === '.' || norm.startsWith('../') || norm === '..' || s.split('/').includes('..')) throw bad(`Unsafe path in modpack: ${p}`);
  return norm;
}

/** Overrides that behave like mods (installed, replaced, removed) rather than like config files (merged with edits). */
export function classifyOverride(p: string): 'file' | 'config' {
  if (/^(mods|plugins|resourcepacks|datapacks)\//i.test(p)) return 'file';
  if (/\.(jar|zip)$/i.test(p)) return 'file';
  return 'config';
}

export function loaderFromDeps(deps: Record<string, string>): PackLoader {
  const mc = deps.minecraft;
  if (!mc) throw bad('Modpack does not say which Minecraft version it needs');
  if (deps['fabric-loader']) return { type: 'FABRIC', mc, loaderVersion: deps['fabric-loader'] };
  if (deps['quilt-loader']) return { type: 'QUILT', mc, loaderVersion: deps['quilt-loader'] };
  if (deps.neoforge) return { type: 'NEOFORGE', mc, loaderVersion: deps.neoforge };
  if (deps.forge) return { type: 'FORGE', mc, loaderVersion: deps.forge };
  return { type: 'VANILLA', mc };
}

function openZip(file: string): AdmZip {
  try {
    return new AdmZip(file);
  } catch {
    throw bad('Not a Modrinth modpack (the file is not a zip archive)');
  }
}

export function readMrpack(file: string): { index: MrpackIndex; overrides: MrpackOverride[]; read(entry: string): Buffer } {
  const zip = openZip(file);
  const entry = zip.getEntry('modrinth.index.json');
  if (!entry) {
    if (zip.getEntry('manifest.json')) throw bad('This looks like a CurseForge pack; only Modrinth (.mrpack) packs are supported');
    throw bad('Not a Modrinth modpack (modrinth.index.json missing)');
  }
  let index: MrpackIndex;
  try {
    index = JSON.parse(entry.getData().toString('utf8'));
  } catch {
    throw bad('Not a Modrinth modpack (modrinth.index.json is not valid JSON)');
  }
  if (index.formatVersion !== 1) throw bad(`Unsupported modpack format version ${index.formatVersion}`);
  if (index.game !== 'minecraft') throw bad(`Unsupported modpack game ${index.game}`);
  if (!Array.isArray(index.files)) index.files = [];
  index.dependencies ||= {};
  for (const f of index.files) {
    f.path = assertSafeRelPath(f.path);
    if (!f.hashes?.sha1 && !f.hashes?.sha512) throw bad(`Modpack file ${f.path} has no hash`);
    if (!Array.isArray(f.downloads) || !f.downloads.length) throw bad(`Modpack file ${f.path} has no download URL`);
  }

  const byPath = new Map<string, MrpackOverride>();
  for (const source of ['overrides', 'server-overrides'] as const) {
    for (const e of zip.getEntries()) {
      if (e.isDirectory || !e.entryName.startsWith(`${source}/`)) continue;
      const rel = assertSafeRelPath(e.entryName.slice(source.length + 1));
      byPath.set(rel, { path: rel, source, entry: e.entryName });
    }
  }
  const read = (name: string): Buffer => {
    const e = zip.getEntry(name);
    if (!e) throw new Error(`${name} missing from modpack`);
    return e.getData();
  };
  return { index, overrides: [...byPath.values()], read };
}
