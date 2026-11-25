/**
 * Which Minecraft versions the newest Geyser runs on. The app always installs the newest Geyser, which follows the
 * newest Minecraft closely (on Fabric/NeoForge often a single version), so older servers must not get it. Modrinth
 * lists the Minecraft versions of each Geyser build; that list is the source of truth here.
 */
import { compareVersions, fetchJson } from '../util.js';

type Fetcher = (url: string) => Promise<any>;
export type GeyserSupport = { supported: boolean | null; versions: string[] };

/** The Geyser build a server type uses (null: no Geyser for this type). */
export function geyserLoader(type: string): 'paper' | 'fabric' | 'neoforge' | null {
  if (type === 'PAPER' || type === 'PURPUR') return 'paper';
  if (type === 'FABRIC' || type === 'QUILT') return 'fabric';
  if (type === 'NEOFORGE') return 'neoforge';
  return null;
}

const TTL = 60 * 60_000;
const cache = new Map<string, { at: number; versions: string[] }>();

async function newestVersions(loader: string, f: Fetcher, fresh: boolean): Promise<string[]> {
  const hit = cache.get(loader);
  if (!fresh && hit && Date.now() - hit.at < TTL) return hit.versions;
  const list = await f(`https://api.modrinth.com/v2/project/geyser/version?loaders=${encodeURIComponent(JSON.stringify([loader]))}`);
  // Newest first; the app downloads "latest", so only the newest build counts.
  const versions: string[] = Array.isArray(list) && list[0]?.game_versions ? list[0].game_versions : [];
  cache.set(loader, { at: Date.now(), versions });
  return versions;
}

/** `supported: null` when Modrinth could not be asked (callers then leave Geyser as it is). */
export async function geyserSupport(type: string, mc: string, f: Fetcher = (u) => fetchJson(u), fresh = false): Promise<GeyserSupport> {
  const loader = geyserLoader(type);
  if (!loader) return { supported: false, versions: [] };
  try {
    const versions = await newestVersions(loader, f, fresh);
    return { supported: versions.includes(mc), versions };
  } catch {
    return { supported: null, versions: [] };
  }
}

/** "26.3" or "1.20.5 – 26.3" for messages. */
export function versionRange(versions: string[]): string {
  if (!versions.length) return 'no versions';
  const v = [...versions].sort(compareVersions);
  return v.length === 1 ? v[0] : `${v[0]} – ${v.at(-1)}`;
}
