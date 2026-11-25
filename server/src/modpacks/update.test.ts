import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { DownloadManager } from '../downloads.js';
import { fixtureBytes, startFixture, type Fixture } from '../test/httpFixture.js';
import { applyPackUpdate, checkPackUpdate, detachPack, type UpdateDeps } from './update.js';
import type { ModpackRecord } from './install.js';

let fx: Fixture;
before(async () => (fx = await startFixture()));
after(() => fx.close());

const sha = (a: string, b: Buffer | string) => crypto.createHash(a).update(b).digest('hex');
const mfile = (p: string, n: number) => ({ path: p, hashes: { sha1: sha('sha1', fixtureBytes(n)), sha512: sha('sha512', fixtureBytes(n)) }, downloads: [`${fx.url}/ok/${n}`], fileSize: n });

/** A server whose pack v1 installed mods/a.jar (2001 bytes) and config/c.toml ("v1"). */
async function setup(opts: { running?: boolean; mcNext?: string } = {}) {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'upd-'));
  const root = path.join(base, 'root');
  await fsp.mkdir(path.join(root, 'mods'), { recursive: true });
  await fsp.mkdir(path.join(root, 'config'), { recursive: true });
  await fsp.writeFile(path.join(root, 'mods/a.jar'), fixtureBytes(2001));
  await fsp.writeFile(path.join(root, 'config/c.toml'), 'v1');
  // v2 drops a.jar, adds b.jar, changes the config
  const z = new AdmZip();
  z.addFile('modrinth.index.json', Buffer.from(JSON.stringify({ formatVersion: 1, game: 'minecraft', name: 'P', versionId: '2', files: [mfile('mods/b.jar', 2002)], dependencies: { minecraft: opts.mcNext ?? '1.21.1', 'fabric-loader': '0.16.9' } })));
  z.addFile('overrides/config/c.toml', Buffer.from('v2'));
  const packBuf = z.toBuffer();
  await fsp.writeFile(path.join(base, 'v2.mrpack'), packBuf);
  const mp: ModpackRecord = {
    source: 'modrinth', projectId: 'P', slug: 'p', title: 'P', versionId: 'v1', versionNumber: '1',
    files: [{ path: 'mods/a.jar', sha1: sha('sha1', fixtureBytes(2001)) }],
    overrides: [{ path: 'config/c.toml', packSha1: sha('sha1', 'v1') }],
    skips: {}, updates: { mode: 'notify' },
  };
  const events: string[] = [];
  let active = !!opts.running;
  const inst: any = {
    id: 's1', root, dir: base, state: active ? 'running' : 'stopped',
    rec: { id: 's1', name: 'S', type: 'FABRIC', version: '1.21.1', edition: 'java', build: { pinnedLoaderVersion: '0.16.9' }, modpack: mp },
    get isActive() { return active; },
    async stop() { events.push('stop'); active = false; this.state = 'stopped'; },
    async save() {},
    setState(s: string) { this.state = s; },
    setProgress() {},
    pushLog() {},
  };
  const fetcher = async (url: string) => {
    if (/\/project\/P\/version$/.test(url))
      return [
        { id: 'v2', name: 'v2', version_number: '2', version_type: 'release', game_versions: [opts.mcNext ?? '1.21.1'], loaders: ['fabric'], date_published: '2026-02-01', files: [{ primary: true, filename: 'p.mrpack', url: `${fx.url}/pack`, hashes: { sha1: sha('sha1', packBuf) }, size: packBuf.length }] },
        { id: 'v1', name: 'v1', version_number: '1', version_type: 'release', game_versions: ['1.21.1'], loaders: ['fabric'], date_published: '2026-01-01', files: [{ primary: true, filename: 'p.mrpack', url: 'x', hashes: { sha1: 'x' } }] },
      ];
    if (/\/version\/v2$/.test(url)) return { id: 'v2', project_id: 'P', version_number: '2', version_type: 'release', game_versions: [opts.mcNext ?? '1.21.1'], loaders: ['fabric'], date_published: '2026-02-01', files: [{ primary: true, filename: 'p.mrpack', url: 'file://' + path.join(base, 'v2.mrpack'), hashes: { sha1: sha('sha1', packBuf) } }] };
    if (/\/version_files$/.test(url)) return {};
    throw new Error('Upstream 404 for ' + url);
  };
  const deps: UpdateDeps = {
    fetcher: fetcher as any,
    manager: new DownloadManager({ stallMs: 500, connectMs: 500, backoffMs: [10, 10, 10] }),
    fetchPack: async (_url, dest) => void (await fsp.copyFile(path.join(base, 'v2.mrpack'), dest)),
    backup: async () => (events.push('backup'), 'b1'),
    restore: async () => void events.push('restore'),
    reinstall: async () => void events.push('reinstall'),
    start: async () => void events.push('start'),
    hits: () => fx.hits[`/ok/2002`] ?? 0,
  };
  return { base, root, inst, deps, events, mp };
}

test('checkPackUpdate returns null when ignored', async () => {
  const s = await setup();
  s.mp.updates.mode = 'ignore';
  assert.equal(await checkPackUpdate(s.inst, s.deps.fetcher), null);
});

test('checkPackUpdate hides skipped version', async () => {
  const s = await setup();
  assert.equal((await checkPackUpdate(s.inst, s.deps.fetcher))!.available, true);
  s.mp.updates.skippedVersionId = 'v2';
  assert.equal((await checkPackUpdate(s.inst, s.deps.fetcher))!.available, false);
});

test('checkPackUpdate flags changesMcVersion', async () => {
  const s = await setup({ mcNext: '1.21.4' });
  const r = await checkPackUpdate(s.inst, s.deps.fetcher);
  assert.equal(r!.changesMcVersion, true);
  assert.equal(r!.latest!.mc, '1.21.4');
});

test('applyPackUpdate downloads before stopping', async () => {
  const s = await setup({ running: true });
  let hitsAtStop = -1;
  const stop = s.inst.stop.bind(s.inst);
  s.inst.stop = async () => ((hitsAtStop = s.deps.hits!()), stop());
  const r = await applyPackUpdate(s.inst, 'v2', s.deps);
  assert.equal(hitsAtStop, 1);
  assert.deepEqual(await fsp.readdir(path.join(s.root, 'mods')), ['b.jar']);
  assert.equal(await fsp.readFile(path.join(s.root, 'config/c.toml'), 'utf8'), 'v2');
  assert.deepEqual({ added: r.added, removed: r.removed, configsUpdated: r.configsUpdated }, { added: 1, removed: 1, configsUpdated: 1 });
  assert.equal(s.inst.rec.modpack.versionId, 'v2');
  assert.deepEqual(s.inst.rec.modpack.files.map((f: any) => f.path), ['mods/b.jar']);
  assert.equal(s.events.indexOf('backup') > s.events.indexOf('stop'), true);
});

test('rolls back on apply failure', async () => {
  const s = await setup();
  const before = JSON.stringify(s.inst.rec);
  s.deps.reinstall = async () => {
    throw new Error('boom');
  };
  s.inst.rec.version = '1.20.1'; // forces a reinstall (pack wants 1.21.1)
  const snap = JSON.stringify(s.inst.rec);
  await assert.rejects(applyPackUpdate(s.inst, 'v2', s.deps), /^Error: Update failed and was rolled back: boom/);
  assert.ok(s.events.includes('restore'));
  assert.equal(JSON.stringify(s.inst.rec), snap);
  assert.notEqual(before, '');
});

test('restarts server after update and after rollback', async () => {
  const ok = await setup({ running: true });
  await applyPackUpdate(ok.inst, 'v2', ok.deps);
  assert.equal(ok.events.at(-1), 'start');
  const bad = await setup({ running: true });
  bad.deps.restore = async () => void bad.events.push('restore');
  bad.inst.rec.version = '1.20.1';
  bad.deps.reinstall = async () => {
    throw new Error('boom');
  };
  await assert.rejects(applyPackUpdate(bad.inst, 'v2', bad.deps));
  assert.deepEqual(bad.events.slice(-2), ['restore', 'start']);
});

test('detachPack clears pin and modpack', async () => {
  const s = await setup();
  await detachPack(s.inst);
  assert.equal(s.inst.rec.modpack, undefined);
  assert.equal(s.inst.rec.build.pinnedLoaderVersion, undefined);
});

test('a second update while one runs is refused', async () => {
  const s = await setup();
  let release!: () => void;
  s.deps.fetchPack = async (_u, dest) => {
    await new Promise<void>((r) => (release = r));
    await fsp.copyFile(path.join(s.base, 'v2.mrpack'), dest);
  };
  const first = applyPackUpdate(s.inst, 'v2', s.deps);
  await new Promise((r) => setTimeout(r, 50));
  await assert.rejects(applyPackUpdate(s.inst, 'v2', s.deps), /already being updated/i);
  release();
  await first;
});

test('server is marked installing during the backup', async () => {
  const s = await setup({ running: true });
  let stateAtBackup = '';
  s.deps.backup = async (i) => ((stateAtBackup = i.state), 'b1');
  await applyPackUpdate(s.inst, 'v2', s.deps);
  assert.equal(stateAtBackup, 'installing');
});

test('a start failure after a good update does not roll it back', async () => {
  const s = await setup({ running: true });
  s.deps.start = async () => {
    throw new Error('port in use');
  };
  const r = await applyPackUpdate(s.inst, 'v2', s.deps);
  assert.equal(s.events.includes('restore'), false);
  assert.equal(s.inst.rec.modpack.versionId, 'v2');
  assert.match(r.startError!, /port in use/);
});

test('record is restored even when restoring the backup fails', async () => {
  const s = await setup();
  s.inst.rec.version = '1.20.1';
  const snap = JSON.stringify(s.inst.rec);
  s.deps.reinstall = async () => {
    throw new Error('boom');
  };
  s.deps.restore = async () => {
    throw new Error('tar broke');
  };
  await assert.rejects(applyPackUpdate(s.inst, 'v2', s.deps), /rollback incomplete.*tar broke/i);
  assert.equal(JSON.stringify(s.inst.rec), snap);
});

test('a failed update can be retried from the downloads panel', async () => {
  const s = await setup();
  let fail = true;
  s.deps.reinstall = async () => {};
  const backup = s.deps.backup;
  s.deps.backup = async (i, l) => {
    if (fail) throw new Error('disk full');
    return backup(i, l);
  };
  await assert.rejects(applyPackUpdate(s.inst, 'v2', s.deps), /disk full/);
  const task = s.deps.manager!.snapshot().tasks.at(-1)!;
  assert.equal(task.state, 'failed');
  assert.equal(task.canRetry, true);
  fail = false;
  await s.deps.manager!.retryTask(task.id);
  assert.equal(s.mp.versionNumber, '2');
});

test('an update will not write through a symlink out of the server folder', async () => {
  const s = await setup();
  const outside = await fsp.mkdtemp(path.join(os.tmpdir(), 'outside-'));
  await fsp.rm(path.join(s.root, 'config'), { recursive: true });
  await fsp.symlink(outside, path.join(s.root, 'config'));
  await assert.rejects(applyPackUpdate(s.inst, 'v2', s.deps), /outside the server folder/);
  assert.equal(await fsp.access(path.join(outside, 'c.toml')).then(() => true, () => false), false);
});
