import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import AdmZip from 'adm-zip';
import { fetchJson, downloadTo, exists, readJson, rmrf, run, which, writeJson, bad, notFound, HttpError, fmtBytes } from './util.js';
import { extensionDir } from './install/java.js';
import type { ServerInstance } from './servers/instance.js';
import { MOD_TYPES } from './servers/types.js';
import { listAddons } from './addons.js';

const MR = 'https://api.modrinth.com/v2';
const LOADERS: Record<string, string[]> = {
  PAPER: ['paper', 'spigot', 'bukkit'],
  PURPUR: ['purpur', 'paper', 'spigot', 'bukkit'],
  FABRIC: ['fabric'],
  FORGE: ['forge'],
  NEOFORGE: ['neoforge'],
};

export type Side = 'required' | 'optional' | 'unsupported' | 'unknown';

/** Library mods players need as soon as they install any other client mod, even though Modrinth marks them "optional". */
const LIBRARY_SLUGS = new Set(['fabric-api', 'fabric-language-kotlin', 'architectury-api', 'cloth-config', 'yacl', 'forge-config-api-port', 'geckolib', 'owo-lib', 'balm', 'collective', 'puzzles-lib', 'resourceful-lib', 'bookshelf-lib', 'moonlight', 'supermartijn642s-core-lib', 'supermartijn642s-config-lib', 'konkrete', 'midnightlib', 'cardinal-components-api', 'trinkets', 'kotlin-for-forge', 'creativecore', 'cupboard', 'ferrite-core', 'indium', 'placeholder-api', 'playeranimator', 'entity-model-features', 'entity-texture-features']);

export interface AddonUpdateInfo {
  fileName: string;
  enabled: boolean;
  managed?: string;
  size: number;
  sha1: string;
  onModrinth: boolean;
  projectId?: string;
  slug?: string;
  title?: string;
  icon?: string;
  clientSide: Side;
  serverSide: Side;
  /** Pre-selected for the client pack: required on the client, or a library mod other client mods depend on. */
  recommendedForClient: boolean;
  isLibrary: boolean;
  currentVersion?: string;
  currentVersionId?: string;
  latestVersion?: string;
  latestVersionId?: string;
  latestFileUrl?: string;
  latestFileName?: string;
  latestDate?: string;
  updateAvailable: boolean;
}

export interface UpdatesReport {
  checkedAt: string;
  gameVersion: string;
  loaders: string[];
  addons: AddonUpdateInfo[];
  updatesAvailable: number;
  clientRequired: number;
}

const cache = new Map<string, { at: number; key: string; report: UpdatesReport }>();

async function sha1File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha1');
    fs.createReadStream(file).on('data', (d) => h.update(d)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
  });
}

async function mrPost<T>(endpoint: string, body: unknown): Promise<T> {
  return fetchJson<T>(`${MR}${endpoint}`, { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } }, 30_000);
}

/** Identify every jar by hash on Modrinth and look up the newest compatible version. */
export async function checkUpdates(inst: ServerInstance, force = false): Promise<UpdatesReport> {
  const dir = extensionDir(inst.rec);
  if (!dir) throw bad('This server type has no plugins or mods');
  const loaders = LOADERS[inst.rec.type] || [];
  const { addons } = await listAddons(inst);
  const full = path.join(inst.root, dir);
  const entries: { a: (typeof addons)[number]; sha1: string }[] = [];
  for (const a of addons) entries.push({ a, sha1: await sha1File(path.join(full, a.fileName)) });
  const key = entries.map((e) => e.sha1).sort().join(',') + '|' + inst.rec.version;
  const c = cache.get(inst.id);
  if (!force && c && c.key === key && Date.now() - c.at < 10 * 60_000) return c.report;

  const hashes = entries.map((e) => e.sha1);
  let current: Record<string, any> = {};
  let latest: Record<string, any> = {};
  if (hashes.length) {
    try {
      current = await mrPost('/version_files', { hashes, algorithm: 'sha1' });
    } catch (e) {
      throw new HttpError(502, `Modrinth lookup failed: ${(e as Error).message}`);
    }
    try {
      latest = await mrPost('/version_files/update', { hashes, algorithm: 'sha1', loaders, game_versions: [inst.rec.version] });
    } catch {
      latest = {};
    }
  }
  const projectIds = [...new Set(Object.values(current).map((v: any) => v.project_id).filter(Boolean))] as string[];
  const projects: Record<string, any> = {};
  if (projectIds.length) {
    try {
      const list = await fetchJson<any[]>(`${MR}/projects?ids=${encodeURIComponent(JSON.stringify(projectIds))}`);
      for (const p of list) projects[p.id] = p;
    } catch {
      /* side info unavailable */
    }
  }
  const out: AddonUpdateInfo[] = entries.map(({ a, sha1 }) => {
    const cur = current[sha1];
    const lat = latest[sha1];
    const proj = cur ? projects[cur.project_id] : undefined;
    const latFile = lat?.files?.find((f: any) => f.primary) || lat?.files?.[0];
    const updateAvailable = !!(cur && lat && lat.id !== cur.id && new Date(lat.date_published) > new Date(cur.date_published));
    const clientSide = ((proj?.client_side as Side) || 'unknown');
    const isLibrary = !!proj?.slug && LIBRARY_SLUGS.has(proj.slug);
    return {
      recommendedForClient: clientSide === 'required' || (isLibrary && clientSide !== 'unsupported'),
      isLibrary,
      fileName: a.fileName,
      enabled: a.enabled,
      managed: a.managed,
      size: a.size,
      sha1,
      onModrinth: !!cur,
      projectId: cur?.project_id ?? a.modrinth?.projectId,
      slug: proj?.slug ?? a.modrinth?.slug,
      title: proj?.title ?? a.modrinth?.title,
      icon: proj?.icon_url ?? a.modrinth?.icon,
      clientSide,
      serverSide: (proj?.server_side as Side) || 'unknown',
      currentVersion: cur?.version_number,
      currentVersionId: cur?.id,
      latestVersion: lat?.version_number,
      latestVersionId: lat?.id,
      latestFileUrl: updateAvailable ? latFile?.url : undefined,
      latestFileName: updateAvailable ? latFile?.filename : undefined,
      latestDate: lat?.date_published,
      updateAvailable,
    };
  });
  const report: UpdatesReport = {
    checkedAt: new Date().toISOString(),
    gameVersion: inst.rec.version,
    loaders,
    addons: out,
    updatesAvailable: out.filter((x) => x.updateAvailable).length,
    clientRequired: out.filter((x) => x.recommendedForClient && x.enabled).length,
  };
  cache.set(inst.id, { at: Date.now(), key, report });
  return report;
}

/** Replace selected jars with their newest Modrinth build. Returns what changed. */
export async function applyUpdates(inst: ServerInstance, fileNames: string[] | 'all', log?: (m: string) => void): Promise<{ updated: { from: string; to: string; version: string }[] }> {
  const report = await checkUpdates(inst);
  const dir = extensionDir(inst.rec)!;
  const targets = report.addons.filter((a) => a.updateAvailable && (fileNames === 'all' || fileNames.includes(a.fileName)));
  const manifestFile = path.join(inst.dir, 'addons.json');
  const manifest = await readJson<Record<string, any>>(manifestFile, {});
  const updated: { from: string; to: string; version: string }[] = [];
  for (const t of targets) {
    if (!t.latestFileUrl || !t.latestFileName) continue;
    const disabled = t.fileName.endsWith('.disabled');
    const newName = path.basename(t.latestFileName) + (disabled ? '.disabled' : '');
    if (!/^[^/\\]+\.jar(\.disabled)?$/i.test(newName)) continue;
    const dest = path.join(inst.root, dir, newName);
    log?.(`Updating ${t.title || t.fileName} → ${t.latestVersion}`);
    await downloadTo(t.latestFileUrl, `${dest}.new`);
    await fsp.rm(path.join(inst.root, dir, t.fileName), { force: true });
    await fsp.rename(`${dest}.new`, dest);
    delete manifest[t.fileName.replace(/\.disabled$/, '')];
    manifest[newName.replace(/\.disabled$/, '')] = { projectId: t.projectId, versionId: t.latestVersionId, title: t.title, icon: t.icon, slug: t.slug };
    updated.push({ from: t.fileName, to: newName, version: t.latestVersion || '' });
  }
  await writeJson(manifestFile, manifest);
  cache.delete(inst.id);
  if (updated.length && inst.isActive) inst.pushLog(`[Blockhost] Updated ${updated.length} ${dir}; restart to load the new versions.`);
  return { updated };
}

/* ------------------------------ client packs ------------------------------ */

export interface ClientPackMeta {
  id: string;
  fileName: string;
  bytes: number;
  createdAt: string;
  mods: string[];
  installer?: string;
  loader: string;
  gameVersion: string;
}

const packsDir = (inst: ServerInstance) => path.join(inst.dir, 'client-packs');

export async function listClientPacks(inst: ServerInstance): Promise<ClientPackMeta[]> {
  const dir = packsDir(inst);
  let entries: string[] = [];
  try {
    entries = await fsp.readdir(dir);
  } catch {
    return [];
  }
  const out: ClientPackMeta[] = [];
  for (const e of entries) {
    if (!e.endsWith('.json')) continue;
    const m = await readJson<ClientPackMeta | null>(path.join(dir, e), null);
    if (m && (await exists(path.join(dir, m.fileName)))) out.push(m);
  }
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function deleteClientPack(inst: ServerInstance, id: string): Promise<void> {
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw bad('Invalid pack id');
  await fsp.rm(path.join(packsDir(inst), `${id}.zip`), { force: true });
  await fsp.rm(path.join(packsDir(inst), `${id}.json`), { force: true });
}

export function clientPackFile(inst: ServerInstance, id: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw bad('Invalid pack id');
  return path.join(packsDir(inst), `${id}.zip`);
}

async function loaderInstaller(inst: ServerInstance): Promise<{ url: string; fileName: string; label: string } | null> {
  const mc = inst.rec.version;
  const lv = inst.rec.build?.loaderVersion;
  switch (inst.rec.type) {
    case 'FABRIC': {
      const installers = await fetchJson<any[]>('https://meta.fabricmc.net/v2/versions/installer');
      const v = (installers.find((i) => i.stable) || installers[0])?.version;
      if (!v) return null;
      return { url: `https://maven.fabricmc.net/net/fabricmc/fabric-installer/${v}/fabric-installer-${v}.jar`, fileName: `fabric-installer-${v}.jar`, label: `Fabric installer ${v} (choose Minecraft ${mc}${lv ? `, loader ${lv}` : ''})` };
    }
    case 'FORGE':
      if (!lv) return null;
      return { url: `https://maven.minecraftforge.net/net/minecraftforge/forge/${mc}-${lv}/forge-${mc}-${lv}-installer.jar`, fileName: `forge-${mc}-${lv}-installer.jar`, label: `Forge ${lv} installer for Minecraft ${mc}` };
    case 'NEOFORGE':
      if (!lv) return null;
      return { url: `https://maven.neoforged.net/releases/net/neoforged/neoforge/${lv}/neoforge-${lv}-installer.jar`, fileName: `neoforge-${lv}-installer.jar`, label: `NeoForge ${lv} installer` };
    default:
      return null;
  }
}

export async function buildClientPack(
  inst: ServerInstance,
  opts: { files: string[]; includeInstaller: boolean; serverAddress?: string },
  log?: (m: string) => void,
): Promise<ClientPackMeta> {
  if (!MOD_TYPES.includes(inst.rec.type)) throw bad('Client packs are only meaningful for modded (Fabric/Forge/NeoForge) servers');
  const dir = extensionDir(inst.rec)!;
  const files = [...new Set(opts.files)].filter((f) => /^[^/\\]+\.jar$/i.test(f));
  if (!files.length) throw bad('Select at least one mod');
  for (const f of files) if (!(await exists(path.join(inst.root, dir, f)))) throw notFound(`${f} is not installed`);

  const stage = await fsp.mkdtemp(path.join(os.tmpdir(), 'mcsm-clientpack-'));
  try {
    await fsp.mkdir(path.join(stage, 'mods'), { recursive: true });
    for (const f of files) await fsp.copyFile(path.join(inst.root, dir, f), path.join(stage, 'mods', f));
    let installerLabel: string | undefined;
    if (opts.includeInstaller) {
      const inst2 = await loaderInstaller(inst);
      if (inst2) {
        log?.(`Downloading ${inst2.label}`);
        await fsp.mkdir(path.join(stage, 'installer'), { recursive: true });
        await downloadTo(inst2.url, path.join(stage, 'installer', inst2.fileName));
        installerLabel = inst2.label;
      }
    }
    const loaderName = inst.rec.type === 'FABRIC' ? 'Fabric' : inst.rec.type === 'FORGE' ? 'Forge' : 'NeoForge';
    const readme = [
      `${inst.rec.name} — client mods for Minecraft ${inst.rec.version} (${loaderName})`,
      '',
      `1. Install ${loaderName} for Minecraft ${inst.rec.version}${inst.rec.build?.loaderVersion ? ` (loader ${inst.rec.build.loaderVersion})` : ''}.`,
      installerLabel ? `   The installer is in the installer/ folder: ${installerLabel}. Run it with Java and choose "Client".` : `   Download the installer from ${inst.rec.type === 'FABRIC' ? 'https://fabricmc.net/use/installer/' : inst.rec.type === 'FORGE' ? 'https://files.minecraftforge.net/' : 'https://neoforged.net/'}.`,
      '2. Copy everything from the mods/ folder into your .minecraft/mods folder',
      '   Windows: %APPDATA%\\.minecraft\\mods   macOS: ~/Library/Application Support/minecraft/mods   Linux: ~/.minecraft/mods',
      `3. Launch the ${loaderName} profile in the Minecraft launcher.`,
      opts.serverAddress ? `4. Add the server: ${opts.serverAddress}` : '',
      '',
      'Included mods:',
      ...files.map((f) => `  - ${f}`),
      '',
      `Generated by Blockhost on ${new Date().toISOString()}`,
    ].filter((l) => l !== undefined).join('\n');
    await fsp.writeFile(path.join(stage, 'README.txt'), readme);

    const id = `${new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, '').replace('T', '-')}-client-mods`;
    const outDir = packsDir(inst);
    await fsp.mkdir(outDir, { recursive: true });
    const zipPath = path.join(outDir, `${id}.zip`);
    const zipBin = await which('zip');
    if (zipBin) {
      const r = await run(zipBin, ['-r', '-q', zipPath, '.'], { cwd: stage, timeoutMs: 10 * 60_000 });
      if (r.code !== 0) throw new Error(`zip failed: ${r.stderr.slice(-300)}`);
    } else {
      const z = new AdmZip();
      z.addLocalFolder(stage);
      z.writeZip(zipPath);
    }
    const st = await fsp.stat(zipPath);
    const meta: ClientPackMeta = {
      id,
      fileName: `${id}.zip`,
      bytes: st.size,
      createdAt: new Date().toISOString(),
      mods: files,
      installer: installerLabel,
      loader: loaderName,
      gameVersion: inst.rec.version,
    };
    await writeJson(path.join(outDir, `${id}.json`), meta);
    inst.pushLog(`[Blockhost] Client pack built: ${files.length} mods, ${fmtBytes(st.size)}`);
    return meta;
  } finally {
    await rmrf(stage);
  }
}
