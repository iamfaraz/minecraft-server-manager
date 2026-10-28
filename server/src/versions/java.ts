import { fetchJson, fetchText, compareVersions } from '../util.js';
import type { JavaType } from '../servers/types.js';

interface Cached<T> {
  at: number;
  value: T;
}
const cache = new Map<string, Cached<unknown>>();
async function cached<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  const c = cache.get(key) as Cached<T> | undefined;
  if (c && Date.now() - c.at < ttlMs) return c.value;
  const value = await fn();
  cache.set(key, { at: Date.now(), value });
  return value;
}
const TTL = 10 * 60 * 1000;

export interface VersionList {
  type: JavaType;
  versions: string[]; // newest first
  latest: string | null;
  snapshots?: string[];
}

/* ---------------- Mojang ---------------- */
interface MojangManifest {
  latest: { release: string; snapshot: string };
  versions: { id: string; type: string; url: string; releaseTime: string }[];
}
export const mojangManifest = () =>
  cached('mojang', TTL, () => fetchJson<MojangManifest>('https://piston-meta.mojang.com/mc/game/version_manifest_v2.json'));

/** Java major required by a Minecraft version, straight from Mojang's version metadata (falls back to a heuristic). */
export async function requiredJavaMajor(version: string): Promise<number> {
  try {
    const m = await mojangManifest();
    const v = m.versions.find((x) => x.id === version);
    if (v) {
      const meta = await cached(`meta:${version}`, 6 * 60 * 60 * 1000, () => fetchJson<any>(v.url));
      const mj = Number(meta?.javaVersion?.majorVersion);
      if (mj) return mj;
    }
  } catch {
    /* offline or unknown version */
  }
  return recommendedJavaMajor(version);
}

export async function vanillaServerUrl(version: string): Promise<string> {
  const m = await mojangManifest();
  const v = m.versions.find((x) => x.id === version);
  if (!v) throw new Error(`Unknown Minecraft version ${version}`);
  const meta = await fetchJson<any>(v.url);
  const url = meta?.downloads?.server?.url;
  if (!url) throw new Error(`Minecraft ${version} has no server download`);
  return url;
}

/* ---------------- Paper (fill v3, fallback v2) ---------------- */
async function paperVersions(project: 'paper'): Promise<string[]> {
  try {
    const d = await fetchJson<any>(`https://fill.papermc.io/v3/projects/${project}`);
    const groups = d?.versions as Record<string, string[]> | undefined;
    if (groups) {
      const all = Object.values(groups).flat();
      return all.sort(compareVersions).reverse();
    }
  } catch {
    /* fall through */
  }
  const d = await fetchJson<any>(`https://api.papermc.io/v2/projects/${project}`);
  return ((d?.versions as string[]) || []).slice().sort(compareVersions).reverse();
}

export async function paperDownloadUrl(version: string): Promise<string> {
  try {
    const d = await fetchJson<any>(`https://fill.papermc.io/v3/projects/paper/versions/${version}/builds`);
    const builds: any[] = (Array.isArray(d) ? d : d?.builds || []).slice().sort((a: any, b: any) => (b.id ?? b.build ?? 0) - (a.id ?? a.build ?? 0));
    const stable = builds.find((b) => b.channel === 'STABLE') || builds[0];
    const url = stable?.downloads?.['server:default']?.url;
    if (url) return url;
  } catch {
    /* fall through */
  }
  const d = await fetchJson<any>(`https://api.papermc.io/v2/projects/paper/versions/${version}/builds`);
  const builds: any[] = d?.builds || [];
  const b = builds.filter((x) => x.channel === 'default').pop() || builds.pop();
  if (!b) throw new Error(`No Paper builds for ${version}`);
  const file = b.downloads?.application?.name;
  return `https://api.papermc.io/v2/projects/paper/versions/${version}/builds/${b.build}/downloads/${file}`;
}

/* ---------------- Purpur ---------------- */
async function purpurVersions(): Promise<string[]> {
  const d = await fetchJson<any>('https://api.purpurmc.org/v2/purpur');
  return ((d?.versions as string[]) || []).slice().sort(compareVersions).reverse();
}
export const purpurDownloadUrl = (version: string) => `https://api.purpurmc.org/v2/purpur/${version}/latest/download`;

/* ---------------- Fabric ---------------- */
async function fabricVersions(): Promise<{ versions: string[]; snapshots: string[] }> {
  const d = await fetchJson<{ version: string; stable: boolean }[]>('https://meta.fabricmc.net/v2/versions/game');
  return {
    versions: d.filter((x) => x.stable).map((x) => x.version),
    snapshots: d.filter((x) => !x.stable).map((x) => x.version),
  };
}
export async function fabricServerJarUrl(version: string): Promise<{ url: string; loader: string; installer: string }> {
  const loaders = await fetchJson<any[]>(`https://meta.fabricmc.net/v2/versions/loader/${version}`);
  const loader = (loaders.find((l) => l.loader?.stable) || loaders[0])?.loader?.version;
  if (!loader) throw new Error(`No Fabric loader for ${version}`);
  const installers = await fetchJson<any[]>('https://meta.fabricmc.net/v2/versions/installer');
  const installer = (installers.find((i) => i.stable) || installers[0])?.version;
  return {
    url: `https://meta.fabricmc.net/v2/versions/loader/${version}/${loader}/${installer}/server/jar`,
    loader,
    installer,
  };
}

/* ---------------- Forge ---------------- */
interface ForgePromos {
  promos: Record<string, string>;
}
const forgePromos = () =>
  cached('forge', TTL, () => fetchJson<ForgePromos>('https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json'));

async function forgeVersions(): Promise<string[]> {
  const p = await forgePromos();
  const set = new Set<string>();
  for (const k of Object.keys(p.promos)) set.add(k.replace(/-(recommended|latest)$/, ''));
  return [...set].sort(compareVersions).reverse();
}
export async function forgeInstallerUrl(mcVersion: string): Promise<{ url: string; forgeVersion: string }> {
  const p = await forgePromos();
  const fv = p.promos[`${mcVersion}-recommended`] || p.promos[`${mcVersion}-latest`];
  if (!fv) throw new Error(`No Forge build for ${mcVersion}`);
  // Some old versions have an extra suffix (e.g. 1.7.10-10.13.4.1614-1.7.10)
  const full = `${mcVersion}-${fv}`;
  return {
    url: `https://maven.minecraftforge.net/net/minecraftforge/forge/${full}/forge-${full}-installer.jar`,
    forgeVersion: fv,
  };
}

/* ---------------- NeoForge ---------------- */
async function neoforgeAll(): Promise<string[]> {
  return cached('neoforge', TTL, async () => {
    const xml = await fetchText('https://maven.neoforged.net/releases/net/neoforged/neoforge/maven-metadata.xml');
    return [...xml.matchAll(/<version>([^<]+)<\/version>/g)].map((m) => m[1]);
  });
}
/**
 * NeoForge version -> Minecraft version.
 *  legacy:     21.1.x -> 1.21.1 ; 20.4.x -> 1.20.4 ; 21.0.x -> 1.21
 *  year-based: 26.3.0.x -> 26.3 ; 26.1.2.x -> 26.1.2
 */
function neoToMc(v: string): string | null {
  const p = v.split(/[.-]/);
  const a = +p[0], b = +p[1], c = +p[2];
  if (!Number.isInteger(a) || !Number.isInteger(b)) return null;
  if (a >= 26) {
    if (p.length < 4) return null;
    return c === 0 ? `${a}.${b}` : `${a}.${b}.${c}`;
  }
  return b === 0 ? `1.${a}` : `1.${a}.${b}`;
}
async function neoforgeVersions(): Promise<string[]> {
  const all = await neoforgeAll();
  const set = new Set<string>();
  for (const v of all) {
    const mc = neoToMc(v);
    if (mc) set.add(mc);
  }
  return [...set].sort(compareVersions).reverse();
}
export async function neoforgeInstallerUrl(mcVersion: string): Promise<{ url: string; neoVersion: string }> {
  const all = await neoforgeAll();
  const candidates = all.filter((v) => neoToMc(v) === mcVersion);
  const stable = candidates.filter((v) => !/beta|alpha/i.test(v));
  const pick = (stable.length ? stable : candidates).sort(compareVersions).pop();
  if (!pick) throw new Error(`No NeoForge build for ${mcVersion}`);
  return {
    url: `https://maven.neoforged.net/releases/net/neoforged/neoforge/${pick}/neoforge-${pick}-installer.jar`,
    neoVersion: pick,
  };
}

/* ---------------- Public API ---------------- */
export async function listJavaVersions(type: JavaType): Promise<VersionList> {
  return cached(`list:${type}`, TTL, async () => {
    switch (type) {
      case 'VANILLA': {
        const m = await mojangManifest();
        const versions = m.versions.filter((v) => v.type === 'release').map((v) => v.id);
        const snapshots = m.versions.filter((v) => v.type === 'snapshot').map((v) => v.id).slice(0, 30);
        return { type, versions, latest: m.latest.release, snapshots };
      }
      case 'PAPER': {
        const versions = await paperVersions('paper');
        return { type, versions, latest: versions[0] ?? null };
      }
      case 'PURPUR': {
        const versions = await purpurVersions();
        return { type, versions, latest: versions[0] ?? null };
      }
      case 'FABRIC': {
        const { versions, snapshots } = await fabricVersions();
        return { type, versions, latest: versions[0] ?? null, snapshots: snapshots.slice(0, 30) };
      }
      case 'FORGE': {
        const versions = await forgeVersions();
        return { type, versions, latest: versions[0] ?? null };
      }
      case 'NEOFORGE': {
        const versions = await neoforgeVersions();
        return { type, versions, latest: versions[0] ?? null };
      }
    }
  });
}

/** Recommended Java major for a Minecraft version. */
export function recommendedJavaMajor(version: string): number {
  const m = /^(\d+)\.(\d+)(?:\.(\d+))?/.exec(version);
  if (!m) return 21; // snapshots like 24w33a
  const major = +m[1], minor = +m[2], patch = +(m[3] || 0);
  if (major === 1) {
    if (minor <= 16) return 8;
    if (minor <= 19) return 17;
    if (minor === 20) return patch >= 5 ? 21 : 17;
    return 21;
  }
  // Year-based versioning (26.x and later) requires Java 25
  if (major >= 26) return 25;
  return 21;
}
