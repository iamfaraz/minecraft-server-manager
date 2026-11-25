import fsp from 'node:fs/promises';
import path from 'node:path';
import { downloadCached, downloadTo, exists, fetchJson, findFile, run, PropertiesFile, type Progress } from '../util.js';
import { CancelledError, downloads, type DownloadCtx } from '../downloads.js';
import { ensureJava } from '../versions/runtime.js';
import {
  fabricServerJarUrl,
  forgeInstallerUrl,
  neoforgeInstallerUrl,
  paperDownloadUrl,
  purpurDownloadUrl,
  quiltInstallArgs,
  quiltInstallerUrl,
  quiltLoaderFor,
  quiltLoaderJarUrl,
  requiredJavaMajor,
  vanillaServerUrl,
} from '../versions/java.js';
import type { LaunchSpec, ServerRecord } from '../servers/types.js';
import { MOD_TYPES, PLUGIN_TYPES } from '../servers/types.js';

export async function javaMajorFor(rec: ServerRecord): Promise<number> {
  const m = rec.java?.major;
  return !m || m === 'auto' ? requiredJavaMajor(rec.version) : m;
}

async function cleanOldBinaries(root: string): Promise<void> {
  const names = ['server.jar', 'fabric-server-launch.jar', 'quilt-server-launch.jar', 'quilt-installer.jar', 'forge-installer.jar', 'neoforge-installer.jar', 'run.sh', 'run.bat', 'installer.jar.log'];
  for (const n of names) await fsp.rm(path.join(root, n), { force: true });
  await fsp.rm(path.join(root, '.fabric'), { recursive: true, force: true });
  await fsp.rm(path.join(root, '.quilt'), { recursive: true, force: true });
  await fsp.rm(path.join(root, 'libraries', 'org', 'quiltmc'), { recursive: true, force: true });
  await fsp.rm(path.join(root, 'libraries', 'net', 'minecraftforge', 'forge'), { recursive: true, force: true });
  await fsp.rm(path.join(root, 'libraries', 'net', 'neoforged', 'neoforge'), { recursive: true, force: true });
  let entries: string[] = [];
  try {
    entries = await fsp.readdir(root);
  } catch {
    return;
  }
  for (const e of entries) {
    if (/^(forge|neoforge)-.*\.jar$/.test(e) || /^minecraft_server\..*\.jar$/.test(e)) await fsp.rm(path.join(root, e), { force: true });
  }
}

/** Run a loader installer jar. Its own library downloads show as one step in the downloads panel; cancel kills it. */
export async function runInstaller(javaBin: string, root: string, args: string[], onProgress: Progress, ctx: DownloadCtx | undefined, label: string): Promise<void> {
  onProgress(null, 'Running installer (this can take a few minutes)…');
  const track = ctx?.taskId ? downloads.trackProcess(ctx.taskId, `${label}: downloading libraries`) : null;
  const signal = track?.signal ?? ctx?.signal;
  let r;
  try {
    r = await run(javaBin, args, {
      cwd: root,
      timeoutMs: 15 * 60_000,
      signal,
      onLine: (l) => {
        if (/download|process|extract|install/i.test(l)) onProgress(null, l.slice(0, 160));
      },
    });
  } catch (e) {
    track?.end(false, (e as Error).message);
    if (signal?.aborted) throw new CancelledError();
    throw e;
  }
  if (signal?.aborted) {
    track?.end(false, 'Cancelled');
    throw new CancelledError();
  }
  if (r.code !== 0) {
    const msg = `Installer exited with code ${r.code}: ${(r.stderr || r.stdout).slice(-800)}`;
    track?.end(false, msg);
    throw new Error(msg);
  }
  track?.end(true);
}

async function resolveModloaderLaunch(root: string, group: 'minecraftforge/forge' | 'neoforged/neoforge'): Promise<LaunchSpec> {
  const base = path.join(root, 'libraries', 'net', ...group.split('/'));
  let versions: string[] = [];
  try {
    versions = await fsp.readdir(base);
  } catch {
    /* no args file (old forge) */
  }
  for (const v of versions) {
    const f = path.join(base, v, 'unix_args.txt');
    if (await exists(f)) return { kind: 'argsfile', file: path.relative(root, f) };
  }
  const jar = await findFile(root, (name, rel) => !rel.includes('/') && /^forge-.*\.jar$/.test(name) && !/installer/.test(name), 0);
  if (jar) return { kind: 'jar', jar: path.basename(jar) };
  throw new Error('Installer finished but no launch target was found');
}

export interface InstallResult {
  build: NonNullable<ServerRecord['build']>;
  javaMajor: number;
}

/**
 * Install or update the Java server binaries in `root`. Worlds, configs, plugins and mods are never touched.
 */
export async function installJava(rec: ServerRecord, root: string, onProgress: Progress, initialProps?: Record<string, string>, ctx?: DownloadCtx): Promise<InstallResult> {
  await fsp.mkdir(root, { recursive: true });
  const major = await javaMajorFor(rec);
  onProgress(null, `Preparing Java ${major} runtime`);
  const rt = await ensureJava(major, onProgress, ctx);

  const isUpdate = rec.installed;
  if (isUpdate) {
    onProgress(null, 'Removing previous server binaries');
    await cleanOldBinaries(root);
  }

  const pin = rec.build?.pinnedLoaderVersion;
  let launch: LaunchSpec;
  let downloadUrl = '';
  let loaderVersion: string | undefined;

  switch (rec.type) {
    case 'VANILLA': {
      downloadUrl = await vanillaServerUrl(rec.version);
      const f = await downloadCached(downloadUrl, onProgress, `-vanilla-${rec.version}.jar`, ctx);
      await fsp.copyFile(f, path.join(root, 'server.jar'));
      launch = { kind: 'jar', jar: 'server.jar' };
      break;
    }
    case 'PAPER': {
      downloadUrl = await paperDownloadUrl(rec.version);
      const f = await downloadCached(downloadUrl, onProgress, `-paper-${rec.version}.jar`, ctx);
      await fsp.copyFile(f, path.join(root, 'server.jar'));
      launch = { kind: 'jar', jar: 'server.jar' };
      break;
    }
    case 'PURPUR': {
      downloadUrl = purpurDownloadUrl(rec.version);
      // Purpur's "latest" URL changes content; don't cache it across installs.
      const dest = path.join(root, 'server.jar');
      await downloadTo(downloadUrl, dest, onProgress, ctx);
      launch = { kind: 'jar', jar: 'server.jar' };
      break;
    }
    case 'FABRIC': {
      const info = await fabricServerJarUrl(rec.version, pin);
      downloadUrl = info.url;
      loaderVersion = info.loader;
      const f = await downloadCached(downloadUrl, onProgress, `-fabric-${rec.version}-${info.loader}.jar`, ctx);
      await fsp.copyFile(f, path.join(root, 'fabric-server-launch.jar'));
      launch = { kind: 'jar', jar: 'fabric-server-launch.jar' };
      break;
    }
    case 'QUILT': {
      loaderVersion = await quiltLoaderFor(rec.version, pin);
      downloadUrl = quiltLoaderJarUrl(loaderVersion);
      const installer = await quiltInstallerUrl();
      const f = await downloadCached(installer.url, onProgress, `-quilt-installer-${installer.version}.jar`, ctx);
      const inst = path.join(root, 'quilt-installer.jar');
      await fsp.copyFile(f, inst);
      await runInstaller(rt.path, root, quiltInstallArgs(rec.version, loaderVersion), onProgress, ctx, 'Quilt installer');
      await fsp.rm(inst, { force: true });
      if (!(await exists(path.join(root, 'quilt-server-launch.jar')))) throw new Error('Quilt installer finished but quilt-server-launch.jar is missing');
      launch = { kind: 'jar', jar: 'quilt-server-launch.jar' };
      break;
    }
    case 'FORGE': {
      const info = await forgeInstallerUrl(rec.version, pin);
      downloadUrl = info.url;
      loaderVersion = info.forgeVersion;
      const f = await downloadCached(downloadUrl, onProgress, `-forge-${rec.version}-${info.forgeVersion}-installer.jar`, ctx);
      const inst = path.join(root, 'forge-installer.jar');
      await fsp.copyFile(f, inst);
      await runInstaller(rt.path, root, ['-jar', inst, '--installServer', '.'], onProgress, ctx, 'Forge installer');
      await fsp.rm(inst, { force: true });
      await fsp.rm(path.join(root, 'forge-installer.jar.log'), { force: true });
      launch = await resolveModloaderLaunch(root, 'minecraftforge/forge');
      break;
    }
    case 'NEOFORGE': {
      const info = await neoforgeInstallerUrl(rec.version, pin);
      downloadUrl = info.url;
      loaderVersion = info.neoVersion;
      const f = await downloadCached(downloadUrl, onProgress, `-neoforge-${info.neoVersion}-installer.jar`, ctx);
      const inst = path.join(root, 'neoforge-installer.jar');
      await fsp.copyFile(f, inst);
      await runInstaller(rt.path, root, ['-jar', inst, '--installServer', '.'], onProgress, ctx, 'NeoForge installer');
      await fsp.rm(inst, { force: true });
      await fsp.rm(path.join(root, 'neoforge-installer.jar.log'), { force: true });
      launch = await resolveModloaderLaunch(root, 'neoforged/neoforge');
      break;
    }
    default:
      throw new Error(`Unsupported Java server type ${rec.type}`);
  }

  await fsp.writeFile(path.join(root, 'eula.txt'), '# Accepted via Blockhost\neula=true\n');
  await syncJavaProperties(rec, root, initialProps);

  if (PLUGIN_TYPES.includes(rec.type)) await fsp.mkdir(path.join(root, 'plugins'), { recursive: true });
  if (MOD_TYPES.includes(rec.type)) await fsp.mkdir(path.join(root, 'mods'), { recursive: true });

  // Modpack servers get Geyser after the pack's own mods are in place (see manager), so its Fabric API is not doubled.
  if (rec.geyser && !rec.modpack) await installGeyser(rec, root, onProgress, ctx);

  onProgress(100, 'Install complete');
  return {
    javaMajor: major,
    build: { downloadUrl, loaderVersion, pinnedLoaderVersion: pin, launch, installedAt: new Date().toISOString() },
  };
}

/** Write/patch server.properties so the port and level name always match the record. */
export async function syncJavaProperties(rec: ServerRecord, root: string, initialProps?: Record<string, string>): Promise<void> {
  const file = path.join(root, 'server.properties');
  const fresh = !(await exists(file));
  const pf = await PropertiesFile.load(file);
  if (fresh) {
    pf.set('motd', 'A Minecraft Server');
    pf.set('max-players', 20);
    pf.set('online-mode', 'true');
    pf.set('enable-rcon', 'false');
    pf.set('enable-query', 'false');
    pf.set('enable-status', 'true');
    pf.set('spawn-protection', 0);
    for (const [k, v] of Object.entries(initialProps || {})) pf.set(k, v);
  }
  pf.set('server-port', rec.port);
  pf.set('level-name', rec.levelName);
  await pf.save();
}

export function extensionDir(rec: ServerRecord): 'plugins' | 'mods' | null {
  if (PLUGIN_TYPES.includes(rec.type)) return 'plugins';
  if (MOD_TYPES.includes(rec.type)) return 'mods';
  return null;
}

/** Download Geyser + Floodgate (and Fabric API on Fabric) into the extension directory. */
export async function installGeyser(rec: ServerRecord, root: string, onProgress: Progress, ctx?: DownloadCtx): Promise<void> {
  const dir = extensionDir(rec);
  if (!dir || rec.type === 'FORGE') throw new Error('Geyser is supported on Paper, Purpur, Fabric, Quilt and NeoForge servers');
  const platform = dir === 'plugins' ? 'spigot' : rec.type === 'NEOFORGE' ? 'neoforge' : 'fabric';
  const target = path.join(root, dir);
  await fsp.mkdir(target, { recursive: true });
  const base = 'https://download.geysermc.org/v2/projects';
  onProgress(null, 'Downloading Geyser');
  await downloadTo(`${base}/geyser/versions/latest/builds/latest/downloads/${platform}`, path.join(target, `Geyser-${platform}.jar`), onProgress, { ...ctx, label: `Geyser-${platform}.jar` });
  onProgress(null, 'Downloading Floodgate');
  try {
    await downloadTo(`${base}/floodgate/versions/latest/builds/latest/downloads/${platform}`, path.join(target, `floodgate-${platform}.jar`), onProgress, { ...ctx, label: `floodgate-${platform}.jar` });
  } catch (e) {
    if (e instanceof CancelledError) throw e;
    onProgress(null, `Floodgate not available for ${platform} (${(e as Error).message}); Geyser installed without it`);
  }
  if ((rec.type === 'FABRIC' || rec.type === 'QUILT') && !(await hasFabricApi(target))) {
    onProgress(null, 'Downloading Fabric API');
    const versions = await fetchJson<any[]>(
      `https://api.modrinth.com/v2/project/fabric-api/version?loaders=${encodeURIComponent('["fabric"]')}&game_versions=${encodeURIComponent(JSON.stringify([rec.version]))}`,
    );
    const file = versions?.[0]?.files?.find((f: any) => f.primary) || versions?.[0]?.files?.[0];
    if (file?.url) await downloadTo(file.url, path.join(target, file.filename || 'fabric-api.jar'), onProgress, ctx);
  }
}

/** True when mods/ already holds Fabric API or Quilted Fabric API (a second copy stops the server). */
export async function hasFabricApi(modsDir: string): Promise<boolean> {
  let entries: string[] = [];
  try {
    entries = await fsp.readdir(modsDir);
  } catch {
    return false;
  }
  return entries.some((e) => /^(fabric-api|qfapi|quilted-fabric-api)[-_].*\.jar$/i.test(e));
}

export async function removeGeyser(rec: ServerRecord, root: string): Promise<void> {
  const dir = extensionDir(rec);
  if (!dir) return;
  let entries: string[] = [];
  try {
    entries = await fsp.readdir(path.join(root, dir));
  } catch {
    return;
  }
  for (const e of entries) if (/^(Geyser|floodgate)-.*\.jar$/i.test(e)) await fsp.rm(path.join(root, dir, e), { force: true });
}

/**
 * Geyser reads any config option from GEYSER_<PATH> environment variables (applied on every start, including the
 * first, before config.yml exists). We set the Bedrock listener per server process:
 *   port            RakNet (UDP) + built-in NetherNet signaling (TCP)
 *   webrtc-port     NetherNet/WebRTC media (UDP), the next port up
 *   transport=both  accept classic RakNet clients and NetherNet (consoles via Xbox Live, new clients)
 */
export function geyserEnv(rec: ServerRecord, advertiseIp: string, hostNetwork: boolean): Record<string, string> {
  if (!rec.geyser || !rec.geyserPort) return {};
  const env: Record<string, string> = {
    GEYSER_BEDROCK_PORT: String(rec.geyserPort),
    GEYSER_BEDROCK_WEBRTC_PORT: String(rec.geyserPort + 1),
    GEYSER_BEDROCK_TRANSPORT: 'both',
    GEYSER_BEDROCK_CLONE_REMOTE_PORT: 'false',
  };
  // Behind Docker's bridge the container's own addresses are unreachable; tell players where to connect.
  if (advertiseIp && !hostNetwork) env.GEYSER_BEDROCK_SIGNALING_ADVERTISE_ADDRESSES = advertiseIp;
  return env;
}
