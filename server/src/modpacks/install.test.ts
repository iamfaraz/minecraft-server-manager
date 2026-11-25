import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { DownloadManager } from '../downloads.js';
import { fixtureBytes, startFixture, type Fixture } from '../test/httpFixture.js';
import { installPackFiles } from './install.js';

let fx: Fixture;
before(async () => (fx = await startFixture()));
after(() => fx.close());

const m = () => new DownloadManager({ stallMs: 500, connectMs: 500, backoffMs: [10, 10, 10] });
const sha = (algo: string, b: Buffer) => crypto.createHash(algo).update(b).digest('hex');
function file(p: string, n: number, extra: Record<string, unknown> = {}) {
  const b = fixtureBytes(n);
  return { path: p, hashes: { sha1: sha('sha1', b), sha512: sha('sha512', b) }, downloads: [`${fx.url}/ok/${n}`], fileSize: n, ...extra };
}
async function pack(files: unknown[], entries: Record<string, string | Buffer> = {}): Promise<{ mrpack: string; root: string }> {
  const z = new AdmZip();
  z.addFile('modrinth.index.json', Buffer.from(JSON.stringify({ formatVersion: 1, game: 'minecraft', name: 'P', versionId: '1', files, dependencies: { minecraft: '1.21.1', 'fabric-loader': '0.16.9' } })));
  for (const [k, v] of Object.entries(entries)) z.addFile(k, Buffer.isBuffer(v) ? v : Buffer.from(v));
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pinst-'));
  z.writeZip(path.join(dir, 'p.mrpack'));
  await fsp.mkdir(path.join(dir, 'root'));
  return { mrpack: path.join(dir, 'p.mrpack'), root: path.join(dir, 'root') };
}
const exists = (p: string) => fsp.access(p).then(() => true, () => false);
const run = (p: { mrpack: string; root: string }, skips: Record<string, boolean> = {}) => installPackFiles(p.root, p.mrpack, skips, {}, () => {}, { manager: m() });

test('installs server files and skips env.server unsupported', async () => {
  const p = await pack([file('mods/a.jar', 1001), file('mods/client.jar', 1002, { env: { client: 'required', server: 'unsupported' } })]);
  await run(p);
  assert.deepEqual(await fsp.readFile(path.join(p.root, 'mods/a.jar')), fixtureBytes(1001));
  assert.equal(await exists(path.join(p.root, 'mods/client.jar')), false);
});

test('applies overrides then server-overrides', async () => {
  const p = await pack([], { 'overrides/config/x.toml': 'both', 'server-overrides/config/x.toml': 'server', 'overrides/config/y.toml': 'y' });
  await run(p);
  assert.equal(await fsp.readFile(path.join(p.root, 'config/x.toml'), 'utf8'), 'server');
  assert.equal(await fsp.readFile(path.join(p.root, 'config/y.toml'), 'utf8'), 'y');
});

test('falls back to second download URL', async () => {
  const f = file('mods/m.jar', 1003);
  f.downloads = [`${fx.url}/status/404`, `${fx.url}/ok/1003`];
  const p = await pack([f]);
  await run(p);
  assert.deepEqual(await fsp.readFile(path.join(p.root, 'mods/m.jar')), fixtureBytes(1003));
});

test('fails on hash mismatch and leaves no partial file', async () => {
  const f = file('mods/h.jar', 1004);
  f.hashes.sha512 = '00'.repeat(64);
  const p = await pack([f]);
  await assert.rejects(run(p), /hash/i);
  assert.equal(await exists(path.join(p.root, 'mods/h.jar')), false);
  assert.equal(await exists(path.join(p.root, 'mods/h.jar.part')), false);
});

test('records manifest with files vs config overrides', async () => {
  const p = await pack([file('mods/a.jar', 1005)], { 'overrides/mods/extra.jar': 'jar', 'overrides/config/c.toml': 'cfg' });
  const r = await run(p);
  assert.deepEqual(r.files.map((x) => x.path).sort(), ['mods/a.jar', 'mods/extra.jar']);
  assert.equal(r.files.find((x) => x.path === 'mods/extra.jar')!.sha1, sha('sha1', Buffer.from('jar')));
  assert.deepEqual(r.overrides, [{ path: 'config/c.toml', packSha1: sha('sha1', Buffer.from('cfg')) }]);
});

test('honours admin skip=false for flagged mod', async () => {
  const p = await pack([file('mods/c.jar', 1006, { env: { server: 'unsupported' } })]);
  await run(p, { 'mods/c.jar': false });
  assert.equal(await exists(path.join(p.root, 'mods/c.jar')), true);
});

test('removes a downloaded jar whose metadata says client-only', async () => {
  const z = new AdmZip();
  z.addFile('fabric.mod.json', Buffer.from(JSON.stringify({ id: 'x', environment: 'client' })));
  // Shipped as an override jar: the same metadata check applies as for downloaded jars.
  const p = await pack([], { 'overrides/mods/clientonly.jar': z.toBuffer() });
  const r = await run(p);
  assert.equal(await exists(path.join(p.root, 'mods/clientonly.jar')), false);
  assert.equal(r.files.length, 0);
});

test('rejects unsafe paths before writing anything', async () => {
  const p = await pack([file('../evil.jar', 1007)], { 'overrides/config/ok.toml': 'x' });
  await assert.rejects(run(p), /Unsafe path/);
  assert.deepEqual(await fsp.readdir(p.root), []);
});

test('refuses to write through a symlink that leaves the server folder', async () => {
  const outside = await fsp.mkdtemp(path.join(os.tmpdir(), 'outside-'));
  const p = await pack([], { 'overrides/config/x.toml': 'x' });
  await fsp.symlink(outside, path.join(p.root, 'config'));
  await assert.rejects(run(p), /outside the server folder/);
  assert.equal(await exists(path.join(outside, 'x.toml')), false);
});

test("the wizard's server.properties choices win over the pack's", async () => {
  const p = await pack([], { 'overrides/server.properties': 'difficulty=easy\nmotd=From the pack\n' });
  await installPackFiles(p.root, p.mrpack, {}, {}, () => {}, { manager: m(), properties: { difficulty: 'hard' } });
  const txt = await fsp.readFile(path.join(p.root, 'server.properties'), 'utf8');
  assert.match(txt, /^difficulty=hard$/m);
  assert.match(txt, /^motd=From the pack$/m);
});

test('a file already on disk with the right hash is not downloaded again (retry resumes)', async () => {
  const f = file('mods/kept.jar', 1010);
  f.downloads = [`${fx.url}/status/404`];
  const p = await pack([f]);
  await fsp.mkdir(path.join(p.root, 'mods'), { recursive: true });
  await fsp.writeFile(path.join(p.root, 'mods/kept.jar'), fixtureBytes(1010));
  const r = await run(p);
  assert.deepEqual(r.files.map((x) => x.path), ['mods/kept.jar']);
});

test('a file on disk with the wrong content is downloaded again', async () => {
  const p = await pack([file('mods/stale.jar', 1011)]);
  await fsp.mkdir(path.join(p.root, 'mods'), { recursive: true });
  await fsp.writeFile(path.join(p.root, 'mods/stale.jar'), 'old');
  await run(p);
  assert.deepEqual(await fsp.readFile(path.join(p.root, 'mods/stale.jar')), fixtureBytes(1011));
});

test('one failed file does not stop the others; the error says how many failed', async () => {
  const bad = file('mods/bad.jar', 1012);
  bad.downloads = [`${fx.url}/status/404`];
  const p = await pack([bad, file('mods/good.jar', 1013)]);
  await assert.rejects(run(p), /1 of 2 files could not be downloaded/);
  assert.deepEqual(await fsp.readFile(path.join(p.root, 'mods/good.jar')), fixtureBytes(1013));
});
