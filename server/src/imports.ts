import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import AdmZip from 'adm-zip';
import { config } from './config.js';
import { dirSize, exists, readJson, rmrf, run, slugify, uid, which, writeJson, bad, notFound, HttpError } from './util.js';
import type { Edition } from './servers/types.js';

/**
 * World imports live in <data>/imports/<id>/ with a normalised layout:
 *   import.json              metadata
 *   world/                   the world folder (Java: contains level.dat + region/ ; Bedrock: level.dat + db/)
 *   world_nether/, world_the_end/   (Java, only when the source was a Paper-style split world)
 * Users can also drop a raw world folder (or a folder containing one) into <data>/imports/ and register it.
 */
export interface WorldImport {
  id: string;
  name: string;
  edition: Edition;
  levelName: string;
  bytes: number;
  createdAt: string;
  source: 'zip' | 'folder-upload' | 'server-folder';
  hasNether?: boolean;
  hasEnd?: boolean;
}

export const importsDir = path.join(config.dataDir, 'imports');
const importDir = (id: string) => path.join(importsDir, id);
const metaFile = (id: string) => path.join(importDir(id), 'import.json');

async function isGzip(file: string): Promise<boolean> {
  try {
    const fh = await fsp.open(file, 'r');
    try {
      const b = Buffer.alloc(2);
      await fh.read(b, 0, 2, 0);
      return b[0] === 0x1f && b[1] === 0x8b;
    } finally {
      await fh.close();
    }
  } catch {
    return false;
  }
}

export interface DetectedWorld {
  dir: string; // folder containing level.dat
  edition: Edition;
  levelName: string;
  nether?: string;
  end?: string;
}

/** Find the (first) Minecraft world folder under `root`, up to a few levels deep. */
export async function detectWorld(root: string): Promise<DetectedWorld | null> {
  const queue: { dir: string; depth: number }[] = [{ dir: root, depth: 0 }];
  while (queue.length) {
    const { dir, depth } = queue.shift()!;
    let entries: string[] = [];
    try {
      entries = await fsp.readdir(dir);
    } catch {
      continue;
    }
    if (entries.includes('level.dat')) {
      const levelDat = path.join(dir, 'level.dat');
      const bedrock = entries.includes('db') || entries.includes('levelname.txt') || !(await isGzip(levelDat));
      if (bedrock) {
        let levelName = path.basename(dir);
        try {
          const n = (await fsp.readFile(path.join(dir, 'levelname.txt'), 'utf8')).trim();
          if (n) levelName = n;
        } catch {
          /* keep folder name */
        }
        return { dir, edition: 'bedrock', levelName };
      }
      const base = path.basename(dir);
      const parent = path.dirname(dir);
      const sib = async (suffix: string) => ((await exists(path.join(parent, `${base}${suffix}`, 'level.dat'))) || (await exists(path.join(parent, `${base}${suffix}`, 'DIM-1'))) || (await exists(path.join(parent, `${base}${suffix}`, 'DIM1'))) ? path.join(parent, `${base}${suffix}`) : undefined);
      return { dir, edition: 'java', levelName: base, nether: await sib('_nether'), end: await sib('_the_end') };
    }
    if (depth >= 4) continue;
    for (const e of entries) {
      if (e.startsWith('.') || e === '__MACOSX') continue;
      try {
        if ((await fsp.stat(path.join(dir, e))).isDirectory()) queue.push({ dir: path.join(dir, e), depth: depth + 1 });
      } catch {
        /* ignore */
      }
    }
  }
  return null;
}

async function extractZip(zip: string, dest: string): Promise<void> {
  const unzip = await which('unzip');
  if (unzip) {
    const r = await run(unzip, ['-o', '-q', zip, '-d', dest], { timeoutMs: 20 * 60_000 });
    if (r.code !== null && r.code > 1) throw new HttpError(400, `Could not extract archive: ${r.stderr.slice(-300)}`);
    return;
  }
  new AdmZip(zip).extractAllTo(dest, true);
}

/** Normalise a detected world into imports/<id>/ and write metadata. */
async function finalise(id: string, name: string, det: DetectedWorld, source: WorldImport['source'], stagingToRemove?: string): Promise<WorldImport> {
  const dir = importDir(id);
  await fsp.mkdir(dir, { recursive: true });
  const move = async (src: string, dstName: string) => {
    const dst = path.join(dir, dstName);
    await rmrf(dst);
    try {
      await fsp.rename(src, dst);
    } catch {
      await fsp.cp(src, dst, { recursive: true });
      await rmrf(src);
    }
  };
  await move(det.dir, 'world');
  if (det.nether) await move(det.nether, 'world_nether');
  if (det.end) await move(det.end, 'world_the_end');
  if (stagingToRemove) await rmrf(stagingToRemove);
  const meta: WorldImport = {
    id,
    name: name.trim() || det.levelName,
    edition: det.edition,
    levelName: det.levelName.replace(/[\\/:*?"<>|]/g, '_'),
    bytes: await dirSize(dir),
    createdAt: new Date().toISOString(),
    source,
    hasNether: !!det.nether,
    hasEnd: !!det.end,
  };
  await writeJson(metaFile(id), meta);
  return meta;
}

export async function listImports(): Promise<WorldImport[]> {
  await fsp.mkdir(importsDir, { recursive: true });
  const out: WorldImport[] = [];
  for (const e of await fsp.readdir(importsDir)) {
    const m = await readJson<WorldImport | null>(metaFile(e), null);
    if (m && (await exists(path.join(importDir(e), 'world')))) out.push(m);
  }
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function getImport(id: string): Promise<WorldImport> {
  if (!/^[a-z0-9-]+$/.test(id)) throw bad('Invalid import id');
  const m = await readJson<WorldImport | null>(metaFile(id), null);
  if (!m) throw notFound('Import not found');
  return m;
}

export async function deleteImport(id: string): Promise<void> {
  await getImport(id);
  await rmrf(importDir(id));
}

/** Folders inside <data>/imports that are not registered imports yet (user copied them in by hand). */
export async function unregisteredFolders(): Promise<{ name: string; edition: Edition | null; levelName: string | null }[]> {
  await fsp.mkdir(importsDir, { recursive: true });
  const out: { name: string; edition: Edition | null; levelName: string | null }[] = [];
  for (const e of await fsp.readdir(importsDir)) {
    if (e.startsWith('.')) continue;
    const full = path.join(importsDir, e);
    try {
      if (!(await fsp.stat(full)).isDirectory()) continue;
    } catch {
      continue;
    }
    if (await exists(metaFile(e))) continue;
    const det = await detectWorld(full);
    out.push({ name: e, edition: det?.edition ?? null, levelName: det?.levelName ?? null });
  }
  return out;
}

/** Register a folder the user placed under <data>/imports (or a zip file there). */
export async function importFromServerFolder(name: string, label?: string): Promise<WorldImport> {
  if (!name || /[/\\]/.test(name) || name.startsWith('.')) throw bad('Invalid folder name');
  const src = path.join(importsDir, name);
  if (!(await exists(src))) throw notFound(`${name} not found in imports/`);
  const id = `${slugify(label || name)}-${uid(4)}`;
  const st = await fsp.stat(src);
  if (st.isFile()) {
    if (!/\.(zip|mcworld)$/i.test(name)) throw bad('Only .zip and .mcworld files can be imported');
    const staging = await fsp.mkdtemp(path.join(os.tmpdir(), 'mcsm-import-'));
    await extractZip(src, staging);
    const det = await detectWorld(staging);
    if (!det) {
      await rmrf(staging);
      throw bad('No Minecraft world (level.dat) found in the archive');
    }
    const meta = await finalise(id, label || name.replace(/\.(zip|mcworld)$/i, ''), det, 'zip', staging);
    await fsp.rm(src, { force: true });
    return meta;
  }
  const det = await detectWorld(src);
  if (!det) throw bad('No Minecraft world (level.dat) found in that folder');
  const meta = await finalise(id, label || name, det, 'server-folder');
  // Remove whatever is left of the original folder (it may have been the world itself or a wrapper).
  if (path.resolve(det.dir) !== path.resolve(src) && (await exists(src))) await rmrf(src);
  return meta;
}

/**
 * Handle a multipart upload: either one .zip/.mcworld, or many files whose filenames carry relative paths
 * (folder upload via webkitdirectory). Returns the registered import.
 */
export async function importFromUpload(req: any): Promise<WorldImport> {
  const staging = await fsp.mkdtemp(path.join(os.tmpdir(), 'mcsm-import-'));
  let label = '';
  let fileCount = 0;
  let zipPath: string | null = null;
  try {
    for await (const part of req.parts()) {
      if (part.type !== 'file') {
        if (part.fieldname === 'name') label = String(part.value);
        continue;
      }
      const rel = String(part.filename || '')
        .replace(/\\/g, '/')
        .split('/')
        .filter((seg) => seg && seg !== '.' && seg !== '..')
        .join('/');
      if (!rel) {
        await part.toBuffer();
        continue;
      }
      const dest = path.join(staging, 'upload', rel);
      await fsp.mkdir(path.dirname(dest), { recursive: true });
      const { pipeline } = await import('node:stream/promises');
      const fs = await import('node:fs');
      await pipeline(part.file, fs.createWriteStream(dest));
      fileCount++;
      if (fileCount === 1 && /\.(zip|mcworld)$/i.test(rel)) zipPath = dest;
    }
    if (!fileCount) throw bad('No files uploaded');
    let searchRoot = path.join(staging, 'upload');
    if (fileCount === 1 && zipPath) {
      searchRoot = path.join(staging, 'extracted');
      await extractZip(zipPath, searchRoot);
    }
    const det = await detectWorld(searchRoot);
    if (!det) throw bad('No Minecraft world found (expected a folder with level.dat, a .mcworld, or a zipped world folder)');
    const id = `${slugify(label || det.levelName)}-${uid(4)}`;
    return await finalise(id, label || det.levelName, det, fileCount === 1 && zipPath ? 'zip' : 'folder-upload', staging);
  } catch (e) {
    await rmrf(staging);
    throw e;
  }
}

/** Copy an import's world into a server root using that server's edition layout and level name. */
export async function applyImport(id: string, targetRoot: string, edition: Edition, levelName: string): Promise<void> {
  const meta = await getImport(id);
  if (meta.edition !== edition) throw bad(`This import is a ${meta.edition === 'java' ? 'Java' : 'Bedrock'} world and cannot be used for a ${edition === 'java' ? 'Java' : 'Bedrock'} server`);
  const src = importDir(id);
  const copy = async (from: string, to: string) => {
    await rmrf(to);
    await fsp.mkdir(path.dirname(to), { recursive: true });
    await fsp.cp(from, to, { recursive: true });
  };
  if (edition === 'bedrock') {
    await copy(path.join(src, 'world'), path.join(targetRoot, 'worlds', levelName));
    return;
  }
  await copy(path.join(src, 'world'), path.join(targetRoot, levelName));
  if (meta.hasNether) await copy(path.join(src, 'world_nether'), path.join(targetRoot, `${levelName}_nether`));
  if (meta.hasEnd) await copy(path.join(src, 'world_the_end'), path.join(targetRoot, `${levelName}_the_end`));
}
