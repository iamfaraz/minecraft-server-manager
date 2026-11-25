/**
 * Which pack files must not be installed on a server. Pack authors often get the server/client flags wrong,
 * so three signals are combined: the pack's own env, Modrinth's project data, and the mod's metadata file.
 * The admin can override any decision in the preview.
 */
import AdmZip from 'adm-zip';

export type SkipReason = 'pack-env' | 'modrinth-server-unsupported' | 'mod-metadata-client' | 'admin';

export interface SkipDecision {
  path: string;
  skip: boolean;
  reason?: SkipReason;
}

/** True when the jar's own metadata says it only runs on the client. Unreadable jars count as not client-only. */
export function jarIsClientOnly(jar: Buffer): boolean {
  let zip: AdmZip;
  try {
    zip = new AdmZip(jar);
  } catch {
    return false;
  }
  const json = (name: string): any => {
    try {
      const e = zip.getEntry(name);
      return e ? JSON.parse(e.getData().toString('utf8')) : null;
    } catch {
      return null;
    }
  };
  const fabric = json('fabric.mod.json');
  if (fabric?.environment === 'client') return true;
  const quilt = json('quilt.mod.json');
  if (quilt?.minecraft?.environment === 'client' || quilt?.quilt_loader?.minecraft?.environment === 'client') return true;
  for (const name of ['META-INF/mods.toml', 'META-INF/neoforge.mods.toml']) {
    try {
      const e = zip.getEntry(name);
      if (e && /^\s*clientSideOnly\s*=\s*true\b/m.test(e.getData().toString('utf8'))) return true;
    } catch {
      /* ignore */
    }
  }
  return false;
}

export function decideSkips(
  files: { path: string; env?: { server?: string }; projectServerSide?: string; clientOnlyJar?: boolean }[],
  adminOverrides: Record<string, boolean>,
): SkipDecision[] {
  return files.map((f) => {
    const o = adminOverrides[f.path];
    if (o === true) return { path: f.path, skip: true, reason: 'admin' };
    if (o === false) return { path: f.path, skip: false, reason: undefined };
    if (f.env?.server === 'unsupported') return { path: f.path, skip: true, reason: 'pack-env' };
    if (f.projectServerSide === 'unsupported') return { path: f.path, skip: true, reason: 'modrinth-server-unsupported' };
    if (f.clientOnlyJar) return { path: f.path, skip: true, reason: 'mod-metadata-client' };
    return { path: f.path, skip: false, reason: undefined };
  });
}
