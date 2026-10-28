import fsp from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';
import { safeJoin, bad, HttpError } from './util.js';
import type { ServerInstance } from './servers/instance.js';

export interface FileEntry {
  name: string;
  type: 'file' | 'dir';
  size: number;
  mtime: string;
}

const MAX_TEXT = 2 * 1024 * 1024;
const TEXT_EXT = /\.(txt|properties|json|json5|yml|yaml|toml|cfg|conf|ini|log|md|sh|bat|lang|mcmeta|csv|xml|html|js|ts|snbt|nbt\.txt)$/i;

async function realInside(inst: ServerInstance, rel: string): Promise<string> {
  const p = safeJoin(inst.root, rel);
  // Guard against symlinks pointing outside the root.
  try {
    const real = await fsp.realpath(p);
    const rootReal = await fsp.realpath(inst.root);
    if (real !== rootReal && !real.startsWith(rootReal + path.sep)) throw new HttpError(400, 'Path escapes server directory');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  return p;
}

export async function listDir(inst: ServerInstance, rel: string): Promise<{ path: string; entries: FileEntry[] }> {
  const p = await realInside(inst, rel);
  const entries = await fsp.readdir(p, { withFileTypes: true });
  const out: FileEntry[] = [];
  for (const e of entries) {
    try {
      const st = await fsp.stat(path.join(p, e.name));
      out.push({ name: e.name, type: st.isDirectory() ? 'dir' : 'file', size: st.size, mtime: st.mtime.toISOString() });
    } catch {
      /* broken symlink */
    }
  }
  out.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
  return { path: path.relative(inst.root, p).replace(/\\/g, '/'), entries: out };
}

export async function readFile(inst: ServerInstance, rel: string): Promise<{ content: string; size: number; truncated: boolean; binary: boolean }> {
  const p = await realInside(inst, rel);
  const st = await fsp.stat(p);
  if (st.isDirectory()) throw bad('Is a directory');
  const fh = await fsp.open(p, 'r');
  try {
    const len = Math.min(st.size, MAX_TEXT);
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, 0);
    const binary = !TEXT_EXT.test(p) && buf.subarray(0, 8000).includes(0);
    return { content: binary ? '' : buf.toString('utf8'), size: st.size, truncated: st.size > MAX_TEXT, binary };
  } finally {
    await fh.close();
  }
}

export async function writeFile(inst: ServerInstance, rel: string, content: string): Promise<void> {
  const p = await realInside(inst, rel);
  await fsp.mkdir(path.dirname(p), { recursive: true });
  await fsp.writeFile(p, content);
}

export async function writeFileBuffer(inst: ServerInstance, dirRel: string, name: string, data: Buffer): Promise<void> {
  if (!name || /[/\\]/.test(name)) throw bad('Invalid file name');
  const dir = await realInside(inst, dirRel);
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, name), data);
}

export async function mkdir(inst: ServerInstance, rel: string): Promise<void> {
  await fsp.mkdir(await realInside(inst, rel), { recursive: true });
}

export async function remove(inst: ServerInstance, rel: string): Promise<void> {
  const p = await realInside(inst, rel);
  if (path.resolve(p) === path.resolve(inst.root)) throw bad('Cannot delete the server root');
  await fsp.rm(p, { recursive: true, force: true });
}

export async function rename(inst: ServerInstance, rel: string, newRel: string): Promise<void> {
  const a = await realInside(inst, rel);
  const b = await realInside(inst, newRel);
  await fsp.mkdir(path.dirname(b), { recursive: true });
  await fsp.rename(a, b);
}

export async function openForDownload(inst: ServerInstance, rel: string): Promise<{ stream: fs.ReadStream; name: string; size: number }> {
  const p = await realInside(inst, rel);
  const st = await fsp.stat(p);
  if (st.isDirectory()) throw bad('Cannot download a directory');
  return { stream: fs.createReadStream(p), name: path.basename(p), size: st.size };
}
