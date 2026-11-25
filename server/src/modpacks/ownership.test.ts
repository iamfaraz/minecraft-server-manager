import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { isAdminEdited, markAdminOwned, snapshotBaselines } from './ownership.js';
import type { ModpackRecord } from './install.js';

const o = { path: 'config/a.toml', packSha1: 'p', baselineSha1: 'b' };
test('isAdminEdited false when matches pack or baseline', () => {
  assert.equal(isAdminEdited(o, 'p'), false);
  assert.equal(isAdminEdited(o, 'b'), false);
});
test('isAdminEdited true when differs from both', () => assert.equal(isAdminEdited(o, 'x'), true));
test('isAdminEdited true when adminOwned', () => assert.equal(isAdminEdited({ ...o, adminOwned: true }, 'p'), true));
test('isAdminEdited false when file missing', () => assert.equal(isAdminEdited(o, null), false));

function fakeInst(root: string, mp: Partial<ModpackRecord>) {
  let saves = 0;
  const rec = { modpack: { source: 'upload', title: 'T', versionNumber: '1', files: [], overrides: [], skips: {}, updates: { mode: 'notify' }, ...mp } as ModpackRecord };
  return { root, rec, save: async () => void saves++, get saves() { return saves; } };
}

test('markAdminOwned ignores non-pack paths', async () => {
  const i = fakeInst('/tmp', { files: [{ path: 'mods/a.jar', sha1: 'x' }] });
  await markAdminOwned(i as any, 'mods/mine.jar');
  assert.equal(i.rec.modpack.files[0].adminOwned, undefined);
  assert.equal(i.saves, 0);
});

test('markAdminOwned marks pack files and configs', async () => {
  const i = fakeInst('/tmp', { files: [{ path: 'mods/a.jar', sha1: 'x' }], overrides: [{ path: 'config/a.toml', packSha1: 'p' }] });
  await markAdminOwned(i as any, 'mods/a.jar');
  await markAdminOwned(i as any, './config/a.toml');
  assert.equal(i.rec.modpack.files[0].adminOwned, true);
  assert.equal(i.rec.modpack.overrides[0].adminOwned, true);
});

test('snapshotBaselines records current hashes once', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'own-'));
  await fsp.mkdir(path.join(root, 'config'));
  await fsp.writeFile(path.join(root, 'config/a.toml'), 'rewritten by mod');
  const i = fakeInst(root, { overrides: [{ path: 'config/a.toml', packSha1: 'p' }, { path: 'config/gone.toml', packSha1: 'q' }], baselinePending: true });
  await snapshotBaselines(i as any);
  assert.equal(i.rec.modpack.overrides[0].baselineSha1, crypto.createHash('sha1').update('rewritten by mod').digest('hex'));
  assert.equal(i.rec.modpack.overrides[1].baselineSha1, undefined);
  assert.equal(i.rec.modpack.baselinePending, false);
});

import { replacePackFile } from './ownership.js';
test('replacePackFile moves a pack entry to the admin-updated file', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'own2-'));
  await fsp.mkdir(path.join(root, 'mods'));
  await fsp.writeFile(path.join(root, 'mods/sodium-0.6.jar'), 'new');
  const i = fakeInst(root, { files: [{ path: 'mods/sodium-0.5.jar', sha1: 'old', projectId: 'P' }] });
  await replacePackFile(i as any, 'mods/sodium-0.5.jar', 'mods/sodium-0.6.jar');
  assert.deepEqual(i.rec.modpack.files[0], { path: 'mods/sodium-0.6.jar', sha1: crypto.createHash('sha1').update('new').digest('hex'), projectId: 'P', adminOwned: true });
});
