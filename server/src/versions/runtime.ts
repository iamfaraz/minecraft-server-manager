import fsp from 'node:fs/promises';
import path from 'node:path';
import * as tar from 'tar';
import { config } from '../config.js';
import { downloadCached, exists, findFile, run, which, type Progress } from '../util.js';

export interface JavaRuntime {
  major: number;
  path: string; // path to java binary
  source: 'bundled' | 'downloaded' | 'system';
  version?: string;
}

const detected = new Map<number, JavaRuntime>();

async function javaMajorOf(bin: string): Promise<{ major: number; version: string } | null> {
  try {
    const r = await run(bin, ['-version'], { timeoutMs: 15_000 });
    const m = /version "([^"]+)"/.exec(r.stderr + r.stdout);
    if (!m) return null;
    const v = m[1];
    const major = v.startsWith('1.') ? +v.split('.')[1] : +v.split(/[.+-]/)[0];
    return { major, version: v };
  } catch {
    return null;
  }
}

async function javaBinUnder(dir: string): Promise<string | null> {
  const direct = path.join(dir, 'bin', 'java');
  if (await exists(direct)) return direct;
  const macHome = path.join(dir, 'Contents', 'Home', 'bin', 'java');
  if (await exists(macHome)) return macHome;
  return findFile(dir, (name, rel) => name === 'java' && /(^|\/)bin\/java$/.test(rel), 4);
}

/** Enumerate runtimes we know about: downloaded (data dir), bundled (/opt/java), system. */
export async function listJavaRuntimes(): Promise<JavaRuntime[]> {
  const out = new Map<number, JavaRuntime>();
  const scan = async (base: string, source: JavaRuntime['source']) => {
    let entries: string[] = [];
    try {
      entries = await fsp.readdir(base);
    } catch {
      return;
    }
    for (const e of entries) {
      const bin = await javaBinUnder(path.join(base, e));
      if (!bin) continue;
      const info = await javaMajorOf(bin);
      if (info && !out.has(info.major)) out.set(info.major, { major: info.major, path: bin, source, version: info.version });
    }
  };
  await scan(path.join(config.runtimesDir, 'java'), 'downloaded');
  await scan('/opt/java', 'bundled');
  if (process.env.JAVA_HOME) {
    const bin = await javaBinUnder(process.env.JAVA_HOME);
    if (bin) {
      const info = await javaMajorOf(bin);
      if (info && !out.has(info.major)) out.set(info.major, { major: info.major, path: bin, source: 'system', version: info.version });
    }
  }
  const sys = await which('java');
  if (sys) {
    const info = await javaMajorOf(sys);
    if (info && !out.has(info.major)) out.set(info.major, { major: info.major, path: sys, source: 'system', version: info.version });
  }
  detected.clear();
  for (const r of out.values()) detected.set(r.major, r);
  return [...out.values()].sort((a, b) => a.major - b.major);
}

function adoptiumUrl(major: number): string {
  const os = config.platform === 'darwin' ? 'mac' : 'linux';
  const arch = config.arch === 'arm64' ? 'aarch64' : 'x64';
  return `https://api.adoptium.net/v3/binary/latest/${major}/ga/${os}/${arch}/jre/hotspot/normal/eclipse`;
}

/** Ensure a Java runtime for `major` exists, downloading from Adoptium when needed. */
export async function ensureJava(major: number, onProgress?: Progress): Promise<JavaRuntime> {
  if (!detected.size) await listJavaRuntimes();
  const have = detected.get(major);
  if (have) return have;
  onProgress?.(null, `Java ${major} not found — downloading from Adoptium`);
  const dest = path.join(config.runtimesDir, 'java', String(major));
  const archive = await downloadCached(adoptiumUrl(major), onProgress, `-jre${major}.tar.gz`);
  await fsp.rm(dest, { recursive: true, force: true });
  await fsp.mkdir(dest, { recursive: true });
  onProgress?.(null, `Extracting Java ${major}`);
  await tar.x({ file: archive, cwd: dest, strip: 1 });
  const bin = await javaBinUnder(dest);
  if (!bin) throw new Error(`Java ${major} archive did not contain bin/java`);
  const info = await javaMajorOf(bin);
  const rt: JavaRuntime = { major, path: bin, source: 'downloaded', version: info?.version };
  detected.set(major, rt);
  return rt;
}

export async function box64Available(): Promise<string | null> {
  return which('box64');
}

/** Whether Bedrock Dedicated Server can run on this host at all. */
export async function bedrockSupport(): Promise<{ supported: boolean; reason?: string; emulated: boolean }> {
  if (config.platform !== 'linux') return { supported: false, emulated: false, reason: 'Bedrock Dedicated Server only runs on Linux (use the Docker image).' };
  if (config.arch === 'x64') return { supported: true, emulated: false };
  if (await box64Available()) return { supported: true, emulated: true };
  return { supported: false, emulated: true, reason: 'This is an ARM host and box64 is not installed; Bedrock needs x86_64 emulation.' };
}
