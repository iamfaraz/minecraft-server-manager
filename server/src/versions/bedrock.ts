import { fetchJson } from '../util.js';

export interface BedrockVersions {
  latest: { version: string; url: string } | null;
  preview: { version: string; url: string } | null;
  fetchedAt: string;
}

let cache: { at: number; value: BedrockVersions } | null = null;

const LINKS_API = 'https://net-secondary.web.minecraft-services.net/api/v1.0/download/links';

export async function bedrockVersions(): Promise<BedrockVersions> {
  if (cache && Date.now() - cache.at < 10 * 60 * 1000) return cache.value;
  const out: BedrockVersions = { latest: null, preview: null, fetchedAt: new Date().toISOString() };
  try {
    const d = await fetchJson<any>(LINKS_API);
    const links: { downloadType: string; downloadUrl: string }[] = d?.result?.links || d?.links || [];
    for (const l of links) {
      const v = /bedrock-server-([\d.]+)\.zip/.exec(l.downloadUrl)?.[1];
      if (!v) continue;
      if (l.downloadType === 'serverBedrockLinux') out.latest = { version: v, url: l.downloadUrl };
      if (l.downloadType === 'serverBedrockPreviewLinux') out.preview = { version: v, url: l.downloadUrl };
    }
  } catch (e) {
    if (cache) return cache.value;
    throw e;
  }
  cache = { at: Date.now(), value: out };
  return out;
}

/** Resolve LATEST / PREVIEW / explicit version to a concrete version + download URL. */
export async function resolveBedrock(version: string): Promise<{ version: string; url: string; channel: 'release' | 'preview' }> {
  const v = version.trim();
  if (!v || v.toUpperCase() === 'LATEST') {
    const r = await bedrockVersions();
    if (!r.latest) throw new Error('Could not determine the latest Bedrock version');
    return { ...r.latest, channel: 'release' };
  }
  if (v.toUpperCase() === 'PREVIEW') {
    const r = await bedrockVersions();
    if (!r.preview) throw new Error('Could not determine the Bedrock preview version');
    return { ...r.preview, channel: 'preview' };
  }
  if (!/^\d+(\.\d+){2,3}$/.test(v)) throw new Error(`Invalid Bedrock version "${v}"`);
  // Explicit version: check whether it's the current latest/preview to reuse its signed URL, else use the known CDN pattern.
  try {
    const r = await bedrockVersions();
    if (r.latest?.version === v) return { ...r.latest, channel: 'release' };
    if (r.preview?.version === v) return { ...r.preview, channel: 'preview' };
  } catch {
    /* ignore */
  }
  return {
    version: v,
    url: `https://www.minecraft.net/bedrockdedicatedserver/bin-linux/bedrock-server-${v}.zip`,
    channel: 'release',
  };
}
