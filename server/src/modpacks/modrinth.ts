/** Modrinth lookups for modpacks: search, versions, identifying an uploaded pack, and which mods run on servers. */
import { fetchJson } from '../util.js';

export type Fetcher = (url: string, init?: RequestInit) => Promise<any>;
const MR = 'https://api.modrinth.com/v2';
const LOADER_NAMES = new Set(['fabric', 'quilt', 'forge', 'neoforge']);
const defaultFetch: Fetcher = (url, init) => fetchJson(url, init);

export interface PackHit {
  projectId: string;
  slug: string;
  title: string;
  icon?: string;
  downloads: number;
  mcVersions: string[];
  loaders: string[];
}

export async function searchPacks(q: string, offset: number, f: Fetcher = defaultFetch): Promise<{ hits: PackHit[]; total: number }> {
  const u = new URL(`${MR}/search`);
  u.searchParams.set('facets', JSON.stringify([['project_type:modpack'], ['server_side:required', 'server_side:optional']]));
  u.searchParams.set('limit', '20');
  u.searchParams.set('offset', String(Math.max(0, offset | 0)));
  if (q.trim()) {
    u.searchParams.set('query', q.trim());
    u.searchParams.set('index', 'relevance');
  } else u.searchParams.set('index', 'downloads');
  const d = await f(u.toString());
  return {
    total: d.total_hits ?? 0,
    hits: (d.hits ?? []).map((h: any) => ({
      projectId: h.project_id,
      slug: h.slug,
      title: h.title,
      icon: h.icon_url || undefined,
      downloads: h.downloads ?? 0,
      mcVersions: h.versions ?? [],
      loaders: (h.categories ?? []).filter((c: string) => LOADER_NAMES.has(c)),
    })),
  };
}

export interface PackVersion {
  id: string;
  name: string;
  versionNumber: string;
  type: string;
  mc: string[];
  loaders: string[];
  date: string;
  fileUrl: string;
  fileSha1: string;
  fileSize: number;
}

export function toPackVersion(v: any): PackVersion | null {
  const file = (v.files ?? []).find((x: any) => x.primary && /\.mrpack$/i.test(x.filename)) || (v.files ?? []).find((x: any) => /\.mrpack$/i.test(x.filename));
  if (!file) return null;
  return {
    id: v.id,
    name: v.name,
    versionNumber: v.version_number,
    type: v.version_type,
    mc: v.game_versions ?? [],
    loaders: v.loaders ?? [],
    date: v.date_published,
    fileUrl: file.url,
    fileSha1: file.hashes?.sha1,
    fileSize: file.size ?? 0,
  };
}

export async function packVersions(idOrSlug: string, f: Fetcher = defaultFetch): Promise<PackVersion[]> {
  const list = await f(`${MR}/project/${encodeURIComponent(idOrSlug)}/version`);
  return (list ?? []).map(toPackVersion).filter((v: PackVersion | null): v is PackVersion => !!v);
}

export async function packVersion(versionId: string, f: Fetcher = defaultFetch): Promise<{ version: PackVersion; projectId: string }> {
  const v = await f(`${MR}/version/${encodeURIComponent(versionId)}`);
  const pv = toPackVersion(v);
  if (!pv) throw new Error('That version has no .mrpack file');
  return { version: pv, projectId: v.project_id };
}

/** Index of the newest release, or of the newest version when there is no release. */
export function defaultVersion(vs: { type: string; date: string }[]): number {
  const idx = vs.map((_, i) => i);
  const releases = idx.filter((i) => vs[i].type === 'release');
  const pool = releases.length ? releases : idx;
  return pool.reduce((best, i) => (vs[i].date > vs[best].date ? i : best), pool[0] ?? 0);
}

export interface PackLink {
  projectId: string;
  slug: string;
  title: string;
  icon?: string;
  versionId: string;
  versionNumber: string;
  confidence: 'exact' | 'name-version';
}

export async function projectInfo(id: string, f: Fetcher = defaultFetch): Promise<{ id: string; slug: string; title: string; icon?: string }> {
  const p = await f(`${MR}/project/${encodeURIComponent(id)}`);
  return { id: p.id, slug: p.slug, title: p.title, icon: p.icon_url || undefined };
}

/**
 * Find the Modrinth project and version an uploaded pack came from. A file downloaded from Modrinth matches by
 * hash; a launcher export (Prism, Modrinth App) is a new zip, so fall back to the pack name and version number.
 */
export async function identifyPack(mrpackSha1: string, index: { name: string; versionId: string }, f: Fetcher = defaultFetch): Promise<PackLink | null> {
  try {
    const v = await f(`${MR}/version_file/${mrpackSha1}?algorithm=sha1`);
    if (v?.project_id) {
      const p = await projectInfo(v.project_id, f);
      return { projectId: p.id, slug: p.slug, title: p.title, icon: p.icon, versionId: v.id, versionNumber: v.version_number, confidence: 'exact' };
    }
  } catch {
    /* not a published file */
  }
  if (!index.name || !index.versionId) return null;
  let hits: any[] = [];
  try {
    const u = new URL(`${MR}/search`);
    u.searchParams.set('query', index.name);
    u.searchParams.set('facets', JSON.stringify([['project_type:modpack']]));
    u.searchParams.set('limit', '5');
    hits = (await f(u.toString()))?.hits ?? [];
  } catch {
    return null;
  }
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  hits.sort((a, b) => Number(norm(b.title) === norm(index.name)) - Number(norm(a.title) === norm(index.name)));
  for (const h of hits) {
    let versions: any[] = [];
    try {
      versions = await f(`${MR}/project/${encodeURIComponent(h.project_id)}/version`);
    } catch {
      continue;
    }
    const v = versions.find((x) => x.version_number === index.versionId);
    if (!v) continue;
    const p = await projectInfo(h.project_id, f).catch(() => ({ id: h.project_id, slug: h.slug, title: h.title, icon: h.icon_url }));
    return { projectId: p.id, slug: p.slug, title: p.title, icon: p.icon || undefined, versionId: v.id, versionNumber: v.version_number, confidence: 'name-version' };
  }
  return null;
}

/** Modrinth project and its server_side flag for each file sha1 that Modrinth knows. */
export async function projectSides(hashes: string[], f: Fetcher = defaultFetch): Promise<Record<string, { projectId: string; serverSide: string }>> {
  if (!hashes.length) return {};
  const versions: Record<string, any> = await f(`${MR}/version_files`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ hashes, algorithm: 'sha1' }),
  });
  const ids = [...new Set(Object.values(versions).map((v: any) => v.project_id).filter(Boolean))];
  const sides: Record<string, string> = {};
  for (let i = 0; i < ids.length; i += 100) {
    const batch = ids.slice(i, i + 100);
    const projects: any[] = await f(`${MR}/projects?ids=${encodeURIComponent(JSON.stringify(batch))}`);
    for (const p of projects) sides[p.id] = p.server_side;
  }
  const out: Record<string, { projectId: string; serverSide: string }> = {};
  for (const [h, v] of Object.entries(versions)) if (v?.project_id) out[h] = { projectId: v.project_id, serverSide: sides[v.project_id] ?? 'unknown' };
  return out;
}
