import fsp from 'node:fs/promises';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { downloadCached, exists, run, which, PropertiesFile, type Progress } from '../util.js';
import { resolveBedrock } from '../versions/bedrock.js';
import { bedrockSupport } from '../versions/runtime.js';
import type { ServerRecord } from '../servers/types.js';

/** Files that must survive an update. */
const PROTECTED = ['server.properties', 'allowlist.json', 'permissions.json', 'whitelist.json'];

async function extractZip(zip: string, dest: string, protect: boolean, onProgress: Progress): Promise<void> {
  const unzip = await which('unzip');
  const excludes = protect ? [...PROTECTED, 'worlds/*', 'behavior_packs/*', 'resource_packs/*'] : [];
  if (unzip) {
    const args = ['-o', '-q', zip, '-d', dest];
    if (excludes.length) args.push('-x', ...excludes);
    const r = await run(unzip, args, { timeoutMs: 10 * 60_000 });
    // unzip returns 1 for warnings; treat >1 as failure
    if (r.code !== null && r.code > 1) throw new Error(`unzip failed (${r.code}): ${r.stderr.slice(-500)}`);
    return;
  }
  onProgress(null, 'Extracting (JS fallback)');
  const z = new AdmZip(zip);
  for (const entry of z.getEntries()) {
    if (entry.isDirectory) continue;
    const name = entry.entryName;
    if (protect && (PROTECTED.includes(name) || /^(worlds|behavior_packs|resource_packs)\//.test(name))) continue;
    const out = path.join(dest, name);
    await fsp.mkdir(path.dirname(out), { recursive: true });
    await fsp.writeFile(out, entry.getData());
  }
}

export interface BedrockInstallResult {
  version: string;
  build: NonNullable<ServerRecord['build']>;
}

export async function installBedrock(rec: ServerRecord, root: string, onProgress: Progress, initialProps?: Record<string, string>): Promise<BedrockInstallResult> {
  const support = await bedrockSupport();
  if (!support.supported) throw new Error(support.reason || 'Bedrock is not supported on this host');
  await fsp.mkdir(root, { recursive: true });
  onProgress(null, `Resolving Bedrock version ${rec.version}`);
  const resolved = await resolveBedrock(rec.version);
  const zip = await downloadCached(resolved.url, onProgress, `-bds-${resolved.version}.zip`);
  const isUpdate = await exists(path.join(root, 'server.properties'));
  onProgress(null, isUpdate ? 'Updating server files (worlds and configs are preserved)' : 'Extracting server files');
  await extractZip(zip, root, isUpdate, onProgress);
  await fsp.chmod(path.join(root, 'bedrock_server'), 0o755).catch(() => {});
  await syncBedrockProperties(rec, root, isUpdate ? undefined : initialProps, !isUpdate);
  onProgress(100, 'Install complete');
  return {
    version: resolved.version,
    build: { downloadUrl: resolved.url, launch: { kind: 'bedrock' }, installedAt: new Date().toISOString() },
  };
}

export async function syncBedrockProperties(rec: ServerRecord, root: string, initialProps?: Record<string, string>, fresh = false): Promise<void> {
  const pf = await PropertiesFile.load(path.join(root, 'server.properties'));
  if (fresh) {
    pf.set('server-name', rec.name);
    for (const [k, v] of Object.entries(initialProps || {})) pf.set(k, v);
  }
  const transport = rec.transport || 'raknet';
  pf.set('transport', transport);
  pf.set('server-port', rec.port);
  pf.set('server-portv6', rec.portV6 ?? rec.port + 1);
  if (transport === 'nethernet') {
    // WebRTC data channels: share the game port so only one UDP port needs publishing.
    // Users behind NAT/tunnels can override this with the public:local mapping syntax in the properties editor.
    const current = pf.get('server-udp-ports');
    if (!current || /^\d+$/.test(current)) pf.set('server-udp-ports', rec.port);
  }
  // With RakNet, LAN visibility makes BDS also bind the default 19132/19133 — only allow it for the server that owns them.
  pf.set('enable-lan-visibility', transport === 'nethernet' || rec.port === 19132 ? 'true' : 'false');
  // BDS refuses to start with allow-list=true while online-mode=false.
  if (pf.get('online-mode') === 'false' && pf.get('allow-list') === 'true') pf.set('allow-list', 'false');
  pf.set('level-name', rec.levelName);
  await pf.save();
}
