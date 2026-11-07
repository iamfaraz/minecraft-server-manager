/**
 * "Is there a newer server executable?" for a server, checked on demand.
 *
 * Two kinds of update are told apart:
 *   build:   a newer build of the same Minecraft version (Paper build, Fabric loader, Forge version, ...). Safe;
 *            the world stays as it is.
 *   version: a newer Minecraft version for this server type. The world is upgraded on first start, so a backup is
 *            taken first and the admin is told.
 * Both are applied through the normal reinstall / version change, which stops a running server and starts it again.
 */
import type { ServerInstance } from './servers/instance.js';
import { bedrockVersions } from './versions/bedrock.js';
import { fabricServerJarUrl, forgeInstallerUrl, listJavaVersions, neoforgeInstallerUrl, paperDownloadUrl, vanillaServerUrl } from './versions/java.js';
import type { JavaType } from './servers/types.js';

const NAMES: Record<string, string> = { VANILLA: 'Vanilla', PAPER: 'Paper', PURPUR: 'Purpur', FABRIC: 'Fabric', FORGE: 'Forge', NEOFORGE: 'NeoForge', BEDROCK: 'Bedrock' };

export interface UpdateCheck {
  checkedAt: string;
  current: { type: string; version: string; build?: string; installedAt?: string };
  /** A newer build of the installed version, or null; `unknown` when the source does not number its builds. */
  build: { available: boolean; unknown?: boolean; label: string } | null;
  /** The newest Minecraft version for this server type, if newer than the installed one. */
  version: { available: boolean; latest: string | null; label: string };
}

/** What a fresh install of the current version would download, with a human label for the build. */
async function latestBuild(inst: ServerInstance): Promise<{ url: string; label: string } | null> {
  const rec = inst.rec;
  switch (rec.type) {
    case 'VANILLA':
      return { url: await vanillaServerUrl(rec.version), label: 'the release jar' };
    case 'PAPER': {
      const url = await paperDownloadUrl(rec.version);
      const build = /build[s/-]*(\d+)/i.exec(url)?.[1];
      return { url, label: build ? `build ${build}` : 'the newest build' };
    }
    case 'FABRIC': {
      const info = await fabricServerJarUrl(rec.version);
      return { url: info.url, label: `loader ${info.loader}` };
    }
    case 'FORGE': {
      const info = await forgeInstallerUrl(rec.version);
      return { url: info.url, label: `Forge ${info.forgeVersion}` };
    }
    case 'NEOFORGE': {
      const info = await neoforgeInstallerUrl(rec.version);
      return { url: info.url, label: `NeoForge ${info.neoVersion}` };
    }
    default:
      return null; // Purpur publishes no build number in its download link; Bedrock has versions only
  }
}

export async function checkUpdates(inst: ServerInstance): Promise<UpdateCheck> {
  const rec = inst.rec;
  const current = { type: rec.type, version: rec.version, build: rec.build?.loaderVersion ?? /build[s/-]*(\d+)/i.exec(rec.build?.downloadUrl ?? '')?.[1], installedAt: rec.build?.installedAt };

  let build: UpdateCheck['build'] = null;
  if (rec.edition === 'java') {
    if (rec.type === 'PURPUR') build = { available: false, unknown: true, label: 'Purpur does not say which build is installed; reinstalling fetches the newest one' };
    else {
      const latest = await latestBuild(inst).catch(() => null);
      if (latest) {
        const installed = rec.build?.downloadUrl;
        build = installed && installed !== latest.url ? { available: true, label: `${latest.label} of ${rec.version}` } : { available: false, label: `${latest.label} of ${rec.version} is installed` };
      }
    }
  }

  let latest: string | null = null;
  if (rec.edition === 'bedrock') latest = (await bedrockVersions()).latest?.version ?? null;
  else latest = (await listJavaVersions(rec.type as JavaType)).latest;
  const newer = !!latest && latest !== rec.version && !/^(latest|preview)$/i.test(rec.version);
  return {
    checkedAt: new Date().toISOString(),
    current,
    build,
    version: { available: newer, latest, label: newer ? `${NAMES[rec.type] ?? rec.type} ${latest}` : latest ? `${rec.version} is the newest ${NAMES[rec.type] ?? rec.type} version` : 'Could not look up versions' },
  };
}
