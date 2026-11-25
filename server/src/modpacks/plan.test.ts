import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planPackUpdate } from './plan.js';
import type { ModpackRecord } from './install.js';

const rec = (over: Partial<ModpackRecord>): ModpackRecord => ({ source: 'modrinth', title: 'T', versionNumber: '1', files: [], overrides: [], skips: {}, updates: { mode: 'notify' }, ...over });
const nf = (p: string, sha1: string, projectId?: string, skip = false) => ({ path: p, hashes: { sha1, sha512: '' }, downloads: ['u'], fileSize: 1, projectId, skip });
const kinds = (plan: ReturnType<typeof planPackUpdate>) => plan.actions.map((a) => `${a.kind}:${a.path}`).sort();

test('removes dropped unchanged mod', () => {
  const p = planPackUpdate(rec({ files: [{ path: 'mods/a.jar', sha1: 'a' }] }), { files: [], overrides: [] }, { 'mods/a.jar': 'a' });
  assert.deepEqual(kinds(p), ['remove:mods/a.jar']);
});

test('keeps dropped mod admin replaced', () => {
  const p = planPackUpdate(rec({ files: [{ path: 'mods/a.jar', sha1: 'a' }] }), { files: [], overrides: [] }, { 'mods/a.jar': 'changed' });
  assert.deepEqual(kinds(p), ['keep-changed-file:mods/a.jar']);
});

test('does not install pack copy of admin-updated project', () => {
  const p = planPackUpdate(
    rec({ files: [{ path: 'mods/sodium-0.5.jar', sha1: 's5', projectId: 'P', adminOwned: true }] }),
    { files: [nf('mods/sodium-0.6.jar', 's6', 'P')], overrides: [] },
    { 'mods/sodium-0.5.jar': 's5' },
  );
  assert.deepEqual(kinds(p), ['keep-admin-file:mods/sodium-0.5.jar']);
  assert.deepEqual(p.summary.adminKept, ['mods/sodium-0.5.jar']);
});

test('replaces changed mod by projectId when filename changes', () => {
  const p = planPackUpdate(rec({ files: [{ path: 'mods/x-1.jar', sha1: 'x1', projectId: 'X' }] }), { files: [nf('mods/x-2.jar', 'x2', 'X')], overrides: [] }, { 'mods/x-1.jar': 'x1' });
  assert.deepEqual(kinds(p), ['replace:mods/x-2.jar']);
  const r = p.actions[0] as { kind: 'replace'; from?: string };
  assert.equal(r.from, 'mods/x-1.jar');
  assert.equal(p.summary.updated, 1);
});

test('unchanged mod needs no action', () => {
  const p = planPackUpdate(rec({ files: [{ path: 'mods/a.jar', sha1: 'a' }] }), { files: [nf('mods/a.jar', 'a')], overrides: [] }, { 'mods/a.jar': 'a' });
  assert.deepEqual(kinds(p), []);
});

test('adds new mod and ignores skipped ones', () => {
  const p = planPackUpdate(rec({}), { files: [nf('mods/n.jar', 'n'), nf('mods/c.jar', 'c', undefined, true)], overrides: [] }, {});
  assert.deepEqual(kinds(p), ['add:mods/n.jar']);
});

test('jar under overrides/mods follows file rules', () => {
  const p = planPackUpdate(rec({ files: [{ path: 'mods/extra-1.0.jar', sha1: 'e1' }] }), { files: [], overrides: [{ path: 'mods/extra-1.1.jar', sha1: 'e2', cls: 'file' }] }, { 'mods/extra-1.0.jar': 'e1' });
  assert.deepEqual(kinds(p), ['add:mods/extra-1.1.jar', 'remove:mods/extra-1.0.jar']);
});

test('writes untouched config', () => {
  const p = planPackUpdate(rec({ overrides: [{ path: 'config/a.toml', packSha1: 'p1' }] }), { files: [], overrides: [{ path: 'config/a.toml', sha1: 'p2', cls: 'config' }] }, { 'config/a.toml': 'p1' });
  assert.deepEqual(kinds(p), ['write-config:config/a.toml']);
  assert.equal(p.summary.configsUpdated, 1);
});

test('keeps edited config', () => {
  const p = planPackUpdate(rec({ overrides: [{ path: 'config/a.toml', packSha1: 'p1', baselineSha1: 'b1' }] }), { files: [], overrides: [{ path: 'config/a.toml', sha1: 'p2', cls: 'config' }] }, { 'config/a.toml': 'mine' });
  assert.deepEqual(kinds(p), ['keep-config:config/a.toml']);
  assert.deepEqual(p.summary.configsKept, ['config/a.toml']);
});

test('config rewritten by mod after first start counts as untouched', () => {
  const p = planPackUpdate(rec({ overrides: [{ path: 'config/a.toml', packSha1: 'p1', baselineSha1: 'b1' }] }), { files: [], overrides: [{ path: 'config/a.toml', sha1: 'p2', cls: 'config' }] }, { 'config/a.toml': 'b1' });
  assert.deepEqual(kinds(p), ['write-config:config/a.toml']);
});

test('leaves configs the pack removed', () => {
  const p = planPackUpdate(rec({ overrides: [{ path: 'config/old.toml', packSha1: 'o' }] }), { files: [], overrides: [] }, { 'config/old.toml': 'o' });
  assert.deepEqual(kinds(p), []);
});

test('summary counts match actions', () => {
  const p = planPackUpdate(
    rec({ files: [{ path: 'mods/gone.jar', sha1: 'g' }, { path: 'mods/up.jar', sha1: 'u1' }], overrides: [{ path: 'config/c.toml', packSha1: 'c1' }] }),
    { files: [nf('mods/up.jar', 'u2'), nf('mods/new.jar', 'n')], overrides: [{ path: 'config/c.toml', sha1: 'c2', cls: 'config' }] },
    { 'mods/gone.jar': 'g', 'mods/up.jar': 'u1', 'config/c.toml': 'c1' },
  );
  assert.deepEqual({ ...p.summary }, { added: 1, updated: 1, removed: 1, configsUpdated: 1, configsKept: [], adminKept: [] });
});
