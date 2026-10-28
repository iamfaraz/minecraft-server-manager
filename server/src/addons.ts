import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import AdmZip from 'adm-zip';
import { downloadTo, exists, fetchJson, parseJsonLoose, readJson, rmrf, safeJoin, writeJson, bad, HttpError } from './util.js';
import { extensionDir } from './install/java.js';
import type { ServerInstance } from './servers/instance.js';
import type { ServerType } from './servers/types.js';
import { bus } from './events.js';

/* ------------------------------ Java: plugins / mods ------------------------------ */

export interface AddonFile {
  fileName: string;
  size: number;
  enabled: boolean;
  modrinth?: { projectId: string; versionId: string; title: string; icon?: string; slug?: string };
  managed?: 'geyser';
}

const manifestFile = (inst: ServerInstance) => path.join(inst.dir, 'addons.json');
type AddonManifest = Record<string, AddonFile['modrinth']>;

export async function listAddons(inst: ServerInstance): Promise<{ dir: string | null; addons: AddonFile[] }> {
  const dir = extensionDir(inst.rec);
  if (!dir) return { dir: null, addons: [] };
  const full = path.join(inst.root, dir);
  const manifest = await readJson<AddonManifest>(manifestFile(inst), {});
  let entries: string[] = [];
  try {
    entries = await fsp.readdir(full);
  } catch {
    return { dir, addons: [] };
  }
  const out: AddonFile[] = [];
  for (const e of entries) {
    if (!/\.jar(\.disabled)?$/i.test(e)) continue;
    const st = await fsp.stat(path.join(full, e));
    const base = e.replace(/\.disabled$/, '');
    out.push({
      fileName: e,
      size: st.size,
      enabled: !e.endsWith('.disabled'),
      modrinth: manifest[base],
      managed: /^(Geyser|floodgate)-/i.test(base) ? 'geyser' : undefined,
    });
  }
  return { dir, addons: out.sort((a, b) => a.fileName.localeCompare(b.fileName)) };
}

function addonPath(inst: ServerInstance, fileName: string): string {
  const dir = extensionDir(inst.rec);
  if (!dir) throw bad('This server type has no plugin/mod directory');
  if (!/^[^/\\]+\.jar(\.disabled)?$/i.test(fileName)) throw bad('Invalid file name');
  return safeJoin(path.join(inst.root, dir), fileName);
}

export async function saveAddonUpload(inst: ServerInstance, fileName: string, data: Buffer): Promise<void> {
  if (!/\.jar$/i.test(fileName)) throw bad('Only .jar files can be uploaded here');
  const p = addonPath(inst, path.basename(fileName));
  await fsp.mkdir(path.dirname(p), { recursive: true });
  await fsp.writeFile(p, data);
}

export async function deleteAddon(inst: ServerInstance, fileName: string): Promise<void> {
  await fsp.rm(addonPath(inst, fileName), { force: true });
  const m = await readJson<AddonManifest>(manifestFile(inst), {});
  delete m[fileName.replace(/\.disabled$/, '')];
  await writeJson(manifestFile(inst), m);
}

export async function toggleAddon(inst: ServerInstance, fileName: string): Promise<void> {
  const p = addonPath(inst, fileName);
  const target = fileName.endsWith('.disabled') ? p.replace(/\.disabled$/, '') : `${p}.disabled`;
  await fsp.rename(p, target);
}

const LOADERS: Record<string, string[]> = {
  PAPER: ['paper', 'spigot', 'bukkit'],
  PURPUR: ['purpur', 'paper', 'spigot', 'bukkit'],
  FABRIC: ['fabric'],
  FORGE: ['forge'],
  NEOFORGE: ['neoforge'],
};
const projectType = (t: ServerType) => (t === 'PAPER' || t === 'PURPUR' ? 'plugin' : 'mod');
const MR = 'https://api.modrinth.com/v2';

export async function searchModrinth(inst: ServerInstance, query: string, offset = 0) {
  const loaders = LOADERS[inst.rec.type];
  if (!loaders) throw bad('This server type does not support plugins or mods');
  const facets = [[`project_type:${projectType(inst.rec.type)}`], loaders.map((l) => `categories:${l}`), [`versions:${inst.rec.version}`]];
  const url = `${MR}/search?query=${encodeURIComponent(query)}&limit=20&offset=${offset}&index=${query ? 'relevance' : 'downloads'}&facets=${encodeURIComponent(JSON.stringify(facets))}`;
  const d = await fetchJson<any>(url);
  const installed = await readJson<AddonManifest>(manifestFile(inst), {});
  const installedIds = new Set(Object.values(installed).map((m) => m?.projectId));
  return {
    total: d.total_hits,
    hits: (d.hits || []).map((h: any) => ({
      projectId: h.project_id,
      slug: h.slug,
      title: h.title,
      description: h.description,
      icon: h.icon_url,
      downloads: h.downloads,
      author: h.author,
      categories: h.categories,
      installed: installedIds.has(h.project_id),
    })),
  };
}

export async function installModrinth(inst: ServerInstance, projectId: string, depth = 0, log?: (m: string) => void): Promise<string[]> {
  const loaders = LOADERS[inst.rec.type];
  if (!loaders) throw bad('This server type does not support plugins or mods');
  const manifest = await readJson<AddonManifest>(manifestFile(inst), {});
  if (Object.values(manifest).some((m) => m?.projectId === projectId)) return [];
  const prog = (pct: number | null, message: string, extra: { done?: boolean; error?: string } = {}) => bus.publish({ type: 'addon.progress', id: inst.id, key: projectId, pct, message, ...extra });
  prog(null, 'Resolving version');
  let project: any;
  try {
    project = await fetchJson<any>(`${MR}/project/${encodeURIComponent(projectId)}`);
  } catch (e) {
    prog(null, `Failed: ${(e as Error).message}`, { done: true, error: (e as Error).message });
    throw e;
  }
  const versions = await fetchJson<any[]>(
    `${MR}/project/${encodeURIComponent(projectId)}/version?loaders=${encodeURIComponent(JSON.stringify(loaders))}&game_versions=${encodeURIComponent(JSON.stringify([inst.rec.version]))}`,
  );
  const v = versions[0];
  if (!v) {
    const msg = `${project.title} has no release for ${inst.rec.type} ${inst.rec.version}`;
    prog(null, msg, { done: true, error: msg });
    throw new HttpError(404, msg);
  }
  const file = v.files.find((f: any) => f.primary) || v.files[0];
  const dir = extensionDir(inst.rec)!;
  const dest = addonPath(inst, path.basename(file.filename));
  log?.(`Downloading ${project.title} ${v.version_number}`);
  await fsp.mkdir(path.join(inst.root, dir), { recursive: true });
  await downloadTo(file.url, dest, (pct, msg) => prog(pct, msg));
  manifest[path.basename(file.filename)] = { projectId: project.id, versionId: v.id, title: project.title, icon: project.icon_url, slug: project.slug };
  await writeJson(manifestFile(inst), manifest);
  const installed = [project.title];
  prog(100, `Installed ${v.version_number}`, { done: true });
  if (depth < 2) {
    for (const dep of v.dependencies || []) {
      if (dep.dependency_type !== 'required' || !dep.project_id) continue;
      try {
        installed.push(...(await installModrinth(inst, dep.project_id, depth + 1, log)));
      } catch (e) {
        log?.(`Dependency ${dep.project_id} skipped: ${(e as Error).message}`);
      }
    }
  }
  return installed;
}

/* ------------------------------ Bedrock: packs ------------------------------ */

export interface BedrockPack {
  folder: string;
  kind: 'behavior' | 'resource';
  uuid: string;
  name: string;
  version: number[];
  description?: string;
  active: boolean;
}

interface PackManifest {
  header: { name: string; uuid: string; version: number[]; description?: string };
  modules?: { type: string }[];
}

function kindOf(m: PackManifest): 'behavior' | 'resource' {
  const types = (m.modules || []).map((x) => x.type);
  if (types.some((t) => ['resources', 'client_data', 'skin_pack'].includes(t))) return 'resource';
  return 'behavior';
}

const worldPacksFile = (inst: ServerInstance, kind: 'behavior' | 'resource') =>
  path.join(inst.root, 'worlds', inst.rec.levelName, kind === 'behavior' ? 'world_behavior_packs.json' : 'world_resource_packs.json');

async function readPackDir(inst: ServerInstance, kind: 'behavior' | 'resource', active: Set<string>): Promise<BedrockPack[]> {
  const dir = path.join(inst.root, kind === 'behavior' ? 'behavior_packs' : 'resource_packs');
  let entries: string[] = [];
  try {
    entries = await fsp.readdir(dir);
  } catch {
    return [];
  }
  const out: BedrockPack[] = [];
  for (const e of entries) {
    try {
      const raw = await fsp.readFile(path.join(dir, e, 'manifest.json'), 'utf8');
      const m = parseJsonLoose<PackManifest>(raw);
      if (!m?.header?.uuid) continue;
      out.push({
        folder: e,
        kind,
        uuid: m.header.uuid,
        name: m.header.name?.startsWith('pack.') ? e : m.header.name || e,
        version: m.header.version || [1, 0, 0],
        description: m.header.description?.startsWith('pack.') ? undefined : m.header.description,
        active: active.has(m.header.uuid),
      });
    } catch {
      /* not a pack */
    }
  }
  return out;
}

export async function listPacks(inst: ServerInstance): Promise<BedrockPack[]> {
  const bp = await readJson<{ pack_id: string }[]>(worldPacksFile(inst, 'behavior'), []);
  const rp = await readJson<{ pack_id: string }[]>(worldPacksFile(inst, 'resource'), []);
  return [
    ...(await readPackDir(inst, 'behavior', new Set(bp.map((x) => x.pack_id)))),
    ...(await readPackDir(inst, 'resource', new Set(rp.map((x) => x.pack_id)))),
  ].filter((p) => !/^(vanilla|chemistry|experimental)/i.test(p.folder) || p.active);
}

async function setPackActive(inst: ServerInstance, kind: 'behavior' | 'resource', uuid: string, version: number[], active: boolean) {
  const f = worldPacksFile(inst, kind);
  await fsp.mkdir(path.dirname(f), { recursive: true });
  const list = (await readJson<{ pack_id: string; version: number[] }[]>(f, [])).filter((x) => x.pack_id !== uuid);
  if (active) list.push({ pack_id: uuid, version });
  await writeJson(f, list);
}

export async function togglePack(inst: ServerInstance, folder: string, kind: 'behavior' | 'resource', active: boolean): Promise<void> {
  const packs = await listPacks(inst);
  const p = packs.find((x) => x.folder === folder && x.kind === kind);
  if (!p) throw new HttpError(404, 'Pack not found');
  await setPackActive(inst, kind, p.uuid, p.version, active);
}

export async function removePack(inst: ServerInstance, folder: string, kind: 'behavior' | 'resource'): Promise<void> {
  const packs = await listPacks(inst);
  const p = packs.find((x) => x.folder === folder && x.kind === kind);
  if (!p) throw new HttpError(404, 'Pack not found');
  await setPackActive(inst, kind, p.uuid, p.version, false);
  await rmrf(safeJoin(path.join(inst.root, kind === 'behavior' ? 'behavior_packs' : 'resource_packs'), folder));
}

/** Install .mcpack / .mcaddon (zip) into the server and activate on the current world. */
export async function installPackArchive(inst: ServerInstance, fileName: string, data: Buffer): Promise<string[]> {
  if (!/\.(mcpack|mcaddon|zip)$/i.test(fileName)) throw bad('Upload a .mcpack or .mcaddon file');
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'mcsm-pack-'));
  const installed: string[] = [];
  try {
    const extract = async (buf: Buffer, dest: string) => {
      const z = new AdmZip(buf);
      z.extractAllTo(dest, true);
    };
    await extract(data, tmp);
    // .mcaddon may contain nested .mcpack files
    const walk = async (d: string, depth: number): Promise<string[]> => {
      const found: string[] = [];
      for (const e of await fsp.readdir(d, { withFileTypes: true })) {
        const full = path.join(d, e.name);
        if (e.isFile() && /\.mcpack$/i.test(e.name)) {
          const sub = path.join(d, `${e.name}.extracted`);
          await extract(await fsp.readFile(full), sub);
          found.push(...(await walk(sub, depth + 1)));
        } else if (e.isFile() && e.name === 'manifest.json') found.push(d);
        else if (e.isDirectory() && depth < 4) found.push(...(await walk(full, depth + 1)));
      }
      return found;
    };
    const packDirs = [...new Set(await walk(tmp, 0))];
    if (!packDirs.length) throw bad('No manifest.json found in the archive');
    for (const pd of packDirs) {
      const m = parseJsonLoose<PackManifest>(await fsp.readFile(path.join(pd, 'manifest.json'), 'utf8'));
      if (!m?.header?.uuid) continue;
      const kind = kindOf(m);
      const safeName = (m.header.name?.startsWith('pack.') ? path.basename(pd) : m.header.name || path.basename(pd)).replace(/[^a-zA-Z0-9 _.-]/g, '').trim().slice(0, 60) || m.header.uuid;
      const dest = path.join(inst.root, kind === 'behavior' ? 'behavior_packs' : 'resource_packs', safeName);
      await rmrf(dest);
      await fsp.mkdir(path.dirname(dest), { recursive: true });
      await fsp.cp(pd, dest, { recursive: true });
      await setPackActive(inst, kind, m.header.uuid, m.header.version || [1, 0, 0], true);
      installed.push(`${safeName} (${kind})`);
    }
  } finally {
    await rmrf(tmp);
  }
  if (await exists(path.join(inst.root, 'worlds', inst.rec.levelName))) inst.pushLog(`[Blockhost] Installed packs: ${installed.join(', ')}. Restart to apply.`);
  return installed;
}
