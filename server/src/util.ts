import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, type SpawnOptions } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { config } from './config.js';

export const UA = 'Blockhost-MinecraftServerManager/0.1 (+https://github.com)';

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}
export const bad = (msg: string) => new HttpError(400, msg);
export const notFound = (msg = 'Not found') => new HttpError(404, msg);
export const conflict = (msg: string) => new HttpError(409, msg);

export function uid(len = 10): string {
  return crypto.randomBytes(len).toString('base64url').replace(/[^a-zA-Z0-9]/g, '').slice(0, len).toLowerCase();
}

export function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'server';
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function exists(p: string): Promise<boolean> {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

export async function readJson<T>(p: string, fallback: T): Promise<T> {
  try {
    const raw = await fsp.readFile(p, 'utf8');
    return JSON.parse(raw.replace(/^﻿/, '')) as T;
  } catch {
    return fallback;
  }
}

/** Tolerant JSON parse: strips BOM and // or /* comments (Bedrock manifests often have them). */
export function parseJsonLoose<T = unknown>(raw: string): T {
  const noBom = raw.replace(/^﻿/, '');
  try {
    return JSON.parse(noBom) as T;
  } catch {
    const stripped = noBom
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '')
      .replace(/,\s*([}\]])/g, '$1');
    return JSON.parse(stripped) as T;
  }
}

export async function writeJson(p: string, data: unknown): Promise<void> {
  await fsp.mkdir(path.dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(data, null, 2));
  await fsp.rename(tmp, p);
}

export async function rmrf(p: string): Promise<void> {
  await fsp.rm(p, { recursive: true, force: true });
}

export async function dirSize(dir: string): Promise<number> {
  let total = 0;
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = await fsp.readdir(d, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (e.isFile()) {
        try {
          total += (await fsp.stat(full)).size;
        } catch {
          /* ignore */
        }
      }
    }
  }
  return total;
}

/** Resolve `rel` inside `root`, refusing any escape (../, absolute paths, symlink tricks are checked by caller). */
export function safeJoin(root: string, rel: string): string {
  const cleaned = (rel || '').replace(/\\/g, '/').replace(/^\/+/, '');
  const resolved = path.resolve(root, cleaned);
  const rootResolved = path.resolve(root);
  if (resolved !== rootResolved && !resolved.startsWith(rootResolved + path.sep)) {
    throw new HttpError(400, 'Path escapes server directory');
  }
  return resolved;
}

export async function fetchJson<T = any>(url: string, init: RequestInit = {}, timeoutMs = 20_000): Promise<T> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      ...init,
      signal: ctl.signal,
      headers: { 'User-Agent': UA, Accept: 'application/json', ...(init.headers || {}) },
    });
    if (!res.ok) throw new HttpError(502, `Upstream ${res.status} for ${url}`);
    return (await res.json()) as T;
  } finally {
    clearTimeout(t);
  }
}

export async function fetchText(url: string, timeoutMs = 20_000): Promise<string> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctl.signal, headers: { 'User-Agent': UA } });
    if (!res.ok) throw new HttpError(502, `Upstream ${res.status} for ${url}`);
    return await res.text();
  } finally {
    clearTimeout(t);
  }
}

export type Progress = (pct: number | null, message: string) => void;

/**
 * Download a URL to the cache (keyed by URL hash) and return the cached path.
 * Large downloads (BDS zips, JDKs) are only fetched once.
 */
export async function downloadCached(url: string, onProgress?: Progress, ext?: string): Promise<string> {
  const hash = crypto.createHash('sha1').update(url).digest('hex').slice(0, 16);
  const name = ext ? `${hash}${ext}` : `${hash}-${path.basename(new URL(url).pathname).slice(0, 60) || 'file'}`;
  const dest = path.join(config.cacheDir, name);
  if (await exists(dest)) {
    onProgress?.(100, `Using cached ${path.basename(dest)}`);
    return dest;
  }
  await downloadTo(url, dest, onProgress);
  return dest;
}

export async function downloadTo(url: string, dest: string, onProgress?: Progress): Promise<void> {
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.part`;
  const res = await fetch(url, {
    headers: {
      // minecraft.net CDN rejects non-browser user agents
      'User-Agent':
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
      Accept: '*/*',
    },
    redirect: 'follow',
  });
  if (!res.ok || !res.body) throw new HttpError(502, `Download failed (${res.status}) for ${url}`);
  const total = Number(res.headers.get('content-length') || 0);
  let done = 0;
  let lastEmit = 0;
  let label = path.basename(new URL(url).pathname) || 'file';
  try {
    label = decodeURIComponent(label);
  } catch {
    /* keep raw */
  }
  const counter = new (await import('node:stream')).Transform({
    transform(chunk, _enc, cb) {
      done += chunk.length;
      const now = Date.now();
      if (now - lastEmit > 300) {
        lastEmit = now;
        onProgress?.(total ? Math.round((done / total) * 100) : null, `Downloading ${label} (${fmtBytes(done)}${total ? ' / ' + fmtBytes(total) : ''})`);
      }
      cb(null, chunk);
    },
  });
  await pipeline(Readable.fromWeb(res.body as any), counter, fs.createWriteStream(tmp));
  await fsp.rename(tmp, dest);
  onProgress?.(100, `Downloaded ${label}`);
}

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export function run(
  cmd: string,
  args: string[],
  opts: SpawnOptions & { onLine?: (line: string) => void; timeoutMs?: number } = {},
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { ...opts, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const feed = (buf: Buffer, isErr: boolean) => {
      const s = buf.toString();
      if (isErr) stderr += s;
      else stdout += s;
      if (opts.onLine) for (const l of s.split(/\r?\n/)) if (l.trim()) opts.onLine(l);
    };
    child.stdout?.on('data', (b) => feed(b, false));
    child.stderr?.on('data', (b) => feed(b, true));
    const timer = opts.timeoutMs ? setTimeout(() => child.kill('SIGKILL'), opts.timeoutMs) : null;
    child.on('error', (e) => {
      if (timer) clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

export async function which(bin: string): Promise<string | null> {
  const dirs = (process.env.PATH || '').split(path.delimiter);
  for (const d of dirs) {
    const p = path.join(d, bin);
    try {
      await fsp.access(p, fs.constants.X_OK);
      return p;
    } catch {
      /* next */
    }
  }
  return null;
}

/** Find a file by predicate under `dir` up to `maxDepth`. */
export async function findFile(dir: string, pred: (name: string, rel: string) => boolean, maxDepth = 4): Promise<string | null> {
  const walk = async (d: string, depth: number): Promise<string | null> => {
    let entries: fs.Dirent[];
    try {
      entries = await fsp.readdir(d, { withFileTypes: true });
    } catch {
      return null;
    }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isFile() && pred(e.name, path.relative(dir, full))) return full;
    }
    if (depth >= maxDepth) return null;
    for (const e of entries) {
      if (e.isDirectory()) {
        const r = await walk(path.join(d, e.name), depth + 1);
        if (r) return r;
      }
    }
    return null;
  };
  return walk(dir, 0);
}

/* ---------- .properties handling (preserves comments and order) ---------- */

export class PropertiesFile {
  private lines: string[] = [];
  constructor(private file: string) {}

  static async load(file: string): Promise<PropertiesFile> {
    const pf = new PropertiesFile(file);
    try {
      const raw = await fsp.readFile(file, 'utf8');
      pf.lines = raw.split(/\r?\n/);
      if (pf.lines.length && pf.lines[pf.lines.length - 1] === '') pf.lines.pop();
    } catch {
      pf.lines = [];
    }
    return pf;
  }

  get(key: string): string | undefined {
    for (const l of this.lines) {
      const m = /^\s*([^#!=:\s][^=:]*?)\s*[=:]\s*(.*)$/.exec(l);
      if (m && m[1] === key) return m[2];
    }
    return undefined;
  }

  set(key: string, value: string | number | boolean): void {
    const v = String(value);
    for (let i = 0; i < this.lines.length; i++) {
      const m = /^\s*([^#!=:\s][^=:]*?)\s*[=:]/.exec(this.lines[i]);
      if (m && m[1] === key) {
        this.lines[i] = `${key}=${v}`;
        return;
      }
    }
    this.lines.push(`${key}=${v}`);
  }

  entries(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const l of this.lines) {
      const m = /^\s*([^#!=:\s][^=:]*?)\s*[=:]\s*(.*)$/.exec(l);
      if (m) out[m[1]] = m[2];
    }
    return out;
  }

  async save(): Promise<void> {
    await fsp.mkdir(path.dirname(this.file), { recursive: true });
    await fsp.writeFile(this.file, this.lines.join('\n') + '\n');
  }
}

export function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1B\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\x1B\][^\x07]*\x07/g, '');
}

export function compareVersions(a: string, b: string): number {
  const split = (v: string) => v.split(/[.\-]/).map((x) => (/^\d+$/.test(x) ? +x : x));
  const pa = split(a), pb = split(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i], y = pb[i];
    if (x === y) continue;
    // A release (no extra part) ranks above a pre-release tag ("rc", "pre"); a missing number ranks below a number.
    if (x === undefined) return typeof y === 'string' ? 1 : -1;
    if (y === undefined) return typeof x === 'string' ? -1 : 1;
    if (typeof x === 'number' && typeof y === 'number') return x - y;
    if (typeof x === 'number') return 1;
    if (typeof y === 'number') return -1;
    return x < y ? -1 : 1;
  }
  return 0;
}
