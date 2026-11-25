/**
 * What a pack update does to a server, worked out without touching disk. Mods and other binary files are
 * replaced or removed when the admin left them alone; configs get the new version unless the admin edited them.
 * Anything the admin owns is reported, never overwritten.
 */
import type { ModpackRecord } from './install.js';
import type { MrpackFile } from './mrpack.js';
import { isAdminEdited } from './ownership.js';

export type NextFile = MrpackFile & { projectId?: string; skip: boolean };
export type NextOverride = { path: string; sha1: string; cls: 'file' | 'config' };

export type PlanAction =
  | { kind: 'add' | 'replace'; path: string; file: MrpackFile | { override: string }; sha1: string; projectId?: string; from?: string }
  | { kind: 'remove'; path: string }
  | { kind: 'keep-admin-file'; path: string; packPath?: string }
  | { kind: 'keep-changed-file'; path: string }
  | { kind: 'write-config'; path: string; sha1: string }
  | { kind: 'keep-config'; path: string };

export interface UpdatePlan {
  actions: PlanAction[];
  summary: { added: number; updated: number; removed: number; configsUpdated: number; configsKept: string[]; adminKept: string[] };
}

export function planPackUpdate(old: ModpackRecord, next: { files: NextFile[]; overrides: NextOverride[] }, disk: Record<string, string | null>): UpdatePlan {
  const actions: PlanAction[] = [];
  const cur = (p: string) => disk[p] ?? null;

  // Everything that behaves like a mod, from the index and from override jars/packs.
  const incoming: { path: string; sha1: string; projectId?: string; file: MrpackFile | { override: string } }[] = [
    ...next.files.filter((f) => !f.skip).map((f) => ({ path: f.path, sha1: f.hashes.sha1, projectId: f.projectId, file: f as MrpackFile })),
    ...next.overrides.filter((o) => o.cls === 'file').map((o) => ({ path: o.path, sha1: o.sha1, file: { override: o.path } })),
  ];

  const matched = new Set<string>();
  for (const n of incoming) {
    const prev = old.files.find((f) => f.path === n.path) ?? (n.projectId ? old.files.find((f) => f.projectId === n.projectId) : undefined);
    if (!prev) {
      actions.push({ kind: 'add', path: n.path, file: n.file, sha1: n.sha1, projectId: n.projectId });
      continue;
    }
    matched.add(prev.path);
    if (prev.adminOwned) {
      actions.push({ kind: 'keep-admin-file', path: prev.path, packPath: n.path });
      continue;
    }
    if (prev.sha1 === n.sha1 && prev.path === n.path) continue;
    const onDisk = cur(prev.path);
    if (onDisk != null && onDisk !== prev.sha1) {
      // Changed outside the app: treat as the admin's, and do not add a second copy next to it.
      actions.push({ kind: 'keep-changed-file', path: prev.path });
      continue;
    }
    actions.push({ kind: 'replace', path: n.path, file: n.file, sha1: n.sha1, projectId: n.projectId ?? prev.projectId, from: prev.path !== n.path ? prev.path : undefined });
  }

  for (const f of old.files) {
    if (matched.has(f.path) || f.adminOwned) continue;
    const onDisk = cur(f.path);
    if (onDisk == null) continue;
    actions.push(onDisk === f.sha1 ? { kind: 'remove', path: f.path } : { kind: 'keep-changed-file', path: f.path });
  }

  for (const o of next.overrides.filter((x) => x.cls === 'config')) {
    const prev = old.overrides.find((x) => x.path === o.path);
    const onDisk = cur(o.path);
    if (prev && isAdminEdited(prev, onDisk)) {
      actions.push({ kind: 'keep-config', path: o.path });
      continue;
    }
    if (prev && prev.packSha1 === o.sha1 && onDisk != null) continue;
    actions.push({ kind: 'write-config', path: o.path, sha1: o.sha1 });
  }

  const count = (k: PlanAction['kind']) => actions.filter((a) => a.kind === k).length;
  return {
    actions,
    summary: {
      added: count('add'),
      updated: count('replace'),
      removed: count('remove'),
      configsUpdated: count('write-config'),
      configsKept: actions.filter((a) => a.kind === 'keep-config').map((a) => a.path),
      adminKept: actions.filter((a) => a.kind === 'keep-admin-file' || a.kind === 'keep-changed-file').map((a) => a.path),
    },
  };
}
