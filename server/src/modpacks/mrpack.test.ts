import { test } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { assertSafeRelPath, classifyOverride, loaderFromDeps, readMrpack } from './mrpack.js';

export function index(over: Record<string, unknown> = {}) {
  return { formatVersion: 1, game: 'minecraft', name: 'Pack', versionId: '1.0.0', files: [], dependencies: { minecraft: '1.21.1', 'fabric-loader': '0.16.9' }, ...over };
}
async function zipFile(name: string, entries: Record<string, string | object>): Promise<string> {
  const z = new AdmZip();
  for (const [k, v] of Object.entries(entries)) z.addFile(k, Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)));
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'mrpack-'));
  const f = path.join(dir, name);
  z.writeZip(f);
  return f;
}

test('loaderFromDeps maps each loader', () => {
  assert.deepEqual(loaderFromDeps({ minecraft: '1.21.1', 'fabric-loader': '0.16.9' }), { type: 'FABRIC', mc: '1.21.1', loaderVersion: '0.16.9' });
  assert.deepEqual(loaderFromDeps({ minecraft: '1.21.1', 'quilt-loader': '0.27.1' }), { type: 'QUILT', mc: '1.21.1', loaderVersion: '0.27.1' });
  assert.deepEqual(loaderFromDeps({ minecraft: '1.20.1', forge: '47.3.0' }), { type: 'FORGE', mc: '1.20.1', loaderVersion: '47.3.0' });
  assert.deepEqual(loaderFromDeps({ minecraft: '1.21.1', neoforge: '21.1.77' }), { type: 'NEOFORGE', mc: '1.21.1', loaderVersion: '21.1.77' });
  assert.deepEqual(loaderFromDeps({ minecraft: '1.21.1' }), { type: 'VANILLA', mc: '1.21.1' });
});

test('readMrpack lets server-overrides win', async () => {
  const f = await zipFile('p.mrpack', { 'modrinth.index.json': index(), 'overrides/config/a.toml': 'both', 'server-overrides/config/a.toml': 'server', 'overrides/config/b.toml': 'b' });
  const r = readMrpack(f);
  const a = r.overrides.find((o) => o.path === 'config/a.toml')!;
  assert.equal(a.source, 'server-overrides');
  assert.equal(r.overrides.length, 2);
});

test('readMrpack ignores client-overrides', async () => {
  const f = await zipFile('p.mrpack', { 'modrinth.index.json': index(), 'client-overrides/options.txt': 'x' });
  assert.equal(readMrpack(f).overrides.length, 0);
});

test('assertSafeRelPath rejects escapes', () => {
  for (const bad of ['../x', '/etc/x', 'C:\\x', 'mods/../../x', 'C:/x', '']) assert.throws(() => assertSafeRelPath(bad), /Unsafe path/, bad);
  assert.equal(assertSafeRelPath('mods/a.jar'), 'mods/a.jar');
  assert.equal(assertSafeRelPath('config\\b.toml'), 'config/b.toml');
});

test('classifyOverride', () => {
  assert.equal(classifyOverride('mods/a.jar'), 'file');
  assert.equal(classifyOverride('config/a.toml'), 'config');
  assert.equal(classifyOverride('resourcepacks/x.zip'), 'file');
  assert.equal(classifyOverride('datapacks/y/pack.mcmeta'), 'file');
  assert.equal(classifyOverride('plugins/z.jar'), 'file');
});

test('accepts mrpack by content not extension', async () => {
  const f = await zipFile('pack.zip', { 'modrinth.index.json': index({ name: 'Zipped' }) });
  assert.equal(readMrpack(f).index.name, 'Zipped');
});

test('rejects curseforge zip with message', async () => {
  const f = await zipFile('cf.zip', { 'manifest.json': { manifestType: 'minecraftModpack' } });
  assert.throws(() => readMrpack(f), /CurseForge/);
});

test('rejects formatVersion 2', async () => {
  const f = await zipFile('p.mrpack', { 'modrinth.index.json': index({ formatVersion: 2 }) });
  assert.throws(() => readMrpack(f), /Unsupported modpack format version 2/);
});

test('rejects unsafe file path in index', async () => {
  const f = await zipFile('p.mrpack', { 'modrinth.index.json': index({ files: [{ path: '../evil.jar', hashes: { sha1: 'a', sha512: 'b' }, downloads: ['https://x'], fileSize: 1 }] }) });
  assert.throws(() => readMrpack(f), /path/i);
});
