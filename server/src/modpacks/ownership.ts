/**
 * Which pack files the admin has made their own. Pack updates replace untouched files and keep the admin's.
 * A config counts as edited when it was saved through the app, or when it matches neither what the pack wrote nor
 * what it looked like after the first start (mods rewrite their own configs on first start).
 */
import path from 'node:path';
import { fileHash } from '../downloads.js';
import type { ManifestOverride, ModpackRecord } from './install.js';

type PackInst = { root: string; rec: { modpack?: ModpackRecord }; save(): Promise<void> };

export function isAdminEdited(o: ManifestOverride, currentSha1: string | null): boolean {
  if (o.adminOwned) return true;
  if (currentSha1 == null) return false;
  return currentSha1 !== o.packSha1 && currentSha1 !== o.baselineSha1;
}

export async function hashOrNull(file: string): Promise<string | null> {
  try {
    return await fileHash(file, 'sha1');
  } catch {
    return null;
  }
}

/** Record each config's hash after the first successful start of a pack version. */
export async function snapshotBaselines(inst: PackInst): Promise<void> {
  const mp = inst.rec.modpack;
  if (!mp?.baselinePending) return;
  for (const o of mp.overrides) {
    if (o.baselineSha1) continue;
    const h = await hashOrNull(path.join(inst.root, o.path));
    if (h) o.baselineSha1 = h;
  }
  mp.baselinePending = false;
  await inst.save();
}

/** The admin changed, replaced or deleted a file the pack put there. No-op for other paths. */
export async function markAdminOwned(inst: PackInst, rel: string): Promise<void> {
  const mp = inst.rec.modpack;
  if (!mp) return;
  const p = path.posix.normalize(rel.replace(/\\/g, '/')).replace(/^\.?\//, '');
  let changed = false;
  for (const e of [...mp.files, ...mp.overrides]) {
    if (e.path === p && !e.adminOwned) {
      e.adminOwned = true;
      changed = true;
    }
  }
  if (changed) await inst.save();
}

/** A pack mod was updated by hand to a new file: follow it, and leave it to the admin from now on. */
export async function replacePackFile(inst: PackInst, oldRel: string, newRel: string): Promise<void> {
  const e = inst.rec.modpack?.files.find((f) => f.path === oldRel);
  if (!e) return;
  e.path = newRel;
  e.sha1 = (await hashOrNull(path.join(inst.root, newRel))) ?? e.sha1;
  e.adminOwned = true;
  await inst.save();
}

/** Path of `full` relative to the server root, with forward slashes. */
export const relToRoot = (root: string, full: string) => path.relative(root, full).split(path.sep).join('/');
