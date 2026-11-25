import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { CancelledError, DownloadManager } from './downloads.js';
import { ETAG, fixtureBytes, startFixture, type Fixture } from './test/httpFixture.js';

let fx: Fixture;
let dir: string;
before(async () => {
  fx = await startFixture();
  dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dl-test-'));
});
after(async () => {
  await fx.close();
  await fsp.rm(dir, { recursive: true, force: true });
});

const mk = (o: Partial<ConstructorParameters<typeof DownloadManager>[0]> = {}) => new DownloadManager({ stallMs: 300, connectMs: 300, backoffMs: [10, 10], ...o });
let n = 0;
const dest = () => path.join(dir, `f${++n}.bin`);
const exists = (p: string) => fsp.access(p).then(() => true, () => false);

test('downloads a file and renames .part', async () => {
  const d = dest();
  await mk().download(`${fx.url}/ok/5000`, d);
  assert.deepEqual(await fsp.readFile(d), fixtureBytes(5000));
  assert.equal(await exists(`${d}.part`), false);
});

test('retries 5xx then succeeds', async () => {
  const m = mk();
  await m.download(`${fx.url}/flaky/2/100`, dest());
  assert.equal(m.jobs().at(-1)!.attempt, 3);
  assert.equal(m.jobs().at(-1)!.state, 'done');
});

test('fails after 3 attempts', async () => {
  await assert.rejects(mk().download(`${fx.url}/flaky/5/101`, dest()));
  assert.equal(fx.hits['/flaky/5/101'], 3);
});

test('does not retry 404', async () => {
  const m = mk();
  await assert.rejects(m.download(`${fx.url}/status/404`, dest()), /404/);
  assert.equal(fx.hits['/status/404'], 1);
  assert.equal(m.jobs().at(-1)!.state, 'failed');
});

test('aborts a stalled download and retries', async () => {
  const t0 = Date.now();
  await assert.rejects(mk().download(`${fx.url}/stall/1000`, dest()));
  assert.equal(fx.hits['/stall/1000'], 3);
  assert.ok(Date.now() - t0 < 3000);
});

test('resumes with Range after a dropped connection', async () => {
  const d = dest();
  await mk().download(`${fx.url}/drop/10000`, d);
  assert.deepEqual(await fsp.readFile(d), fixtureBytes(10000));
  assert.equal(fx.requests['/drop/10000'][1].range, 'bytes=5000-');
});

test('fails on short body', async () => {
  const d = dest();
  await assert.rejects(mk().download(`${fx.url}/short/1000`, d));
  assert.equal(await exists(`${d}.part`), false);
});

test('verifies sha512 and fails on mismatch', async () => {
  const good = crypto.createHash('sha512').update(fixtureBytes(300)).digest('hex');
  const d1 = dest();
  await assert.rejects(mk().download(`${fx.url}/ok/300`, d1, { sha512: '00'.repeat(64) }), /hash/i);
  assert.equal(await exists(d1), false);
  const d2 = dest();
  await mk().download(`${fx.url}/ok/300`, d2, { sha512: good });
  assert.equal(await exists(d2), true);
});

test('dedupes same dest', async () => {
  const m = mk();
  const d = dest();
  await Promise.all([m.download(`${fx.url}/ok/2222`, d), m.download(`${fx.url}/ok/2222`, d)]);
  assert.equal(fx.hits['/ok/2222'], 1);
});

test('queues beyond concurrency', async () => {
  const m = mk({ concurrency: 2, stallMs: 2000 });
  let maxActive = 0;
  let sawQueued = false;
  m.on('change', () => {
    const js = m.jobs();
    maxActive = Math.max(maxActive, js.filter((j) => j.state === 'active').length);
    if (js.some((j) => j.state === 'queued')) sawQueued = true;
  });
  await Promise.all([1, 2, 3].map((i) => m.download(`${fx.url}/slow/${3000 + i}`, dest())));
  assert.ok(maxActive <= 2);
  assert.ok(sawQueued);
});

test('cancel via signal', async () => {
  const m = mk({ stallMs: 2000 });
  const d = dest();
  const ctl = new AbortController();
  const p = m.download(`${fx.url}/slow/20000`, d, { signal: ctl.signal });
  setTimeout(() => ctl.abort(), 150);
  await assert.rejects(p, CancelledError);
  assert.equal(m.jobs().at(-1)!.state, 'cancelled');
  assert.equal(await exists(`${d}.part`), false);
});

/* ---------------- Task 3: tasks, history, events, util ---------------- */
import { sweepPartials, wireBus } from './downloads.js';
import { EventEmitter } from 'node:events';

test('cancelTask aborts all jobs in task', async () => {
  const m = mk({ stallMs: 2000 });
  const t = m.startTask({ label: 'T', kind: 'server-install' });
  const ps = [m.download(`${fx.url}/slow/30001`, dest(), t.ctx), m.download(`${fx.url}/slow/30002`, dest(), t.ctx)];
  setTimeout(() => m.cancelTask(t.id), 150);
  await Promise.all(ps.map((p) => assert.rejects(p, CancelledError)));
  assert.equal(m.snapshot().tasks.find((x) => x.id === t.id)!.state, 'cancelled');
});

test('trackProcess signal aborts on cancel', async () => {
  const m = mk();
  const t = m.startTask({ label: 'T', kind: 'server-install' });
  const proc = m.trackProcess(t.id, 'Forge installer: downloading libraries');
  assert.equal(m.snapshot().jobs.find((j) => j.indeterminate)!.state, 'active');
  m.cancelTask(t.id);
  assert.equal(proc.signal.aborted, true);
});

test('cancelJob cancels its task', async () => {
  const m = mk({ stallMs: 2000 });
  const t = m.startTask({ label: 'T', kind: 'addon' });
  const p = m.download(`${fx.url}/slow/30003`, dest(), t.ctx);
  await new Promise((r) => setTimeout(r, 100));
  m.cancelJob(m.snapshot().jobs.at(-1)!.id);
  await assert.rejects(p, CancelledError);
  assert.equal(m.snapshot().tasks.find((x) => x.id === t.id)!.state, 'cancelled');
});

test('retryTask calls retry callback', async () => {
  const m = mk();
  let calls = 0;
  const t = m.startTask({ label: 'T', kind: 'addon', retry: async () => void calls++ });
  t.fail(new Error('x'));
  const t2 = m.startTask({ label: 'U', kind: 'addon' });
  assert.equal(m.snapshot().tasks.find((x) => x.id === t.id)!.canRetry, true);
  assert.equal(m.snapshot().tasks.find((x) => x.id === t2.id)!.canRetry, false);
  await m.retryTask(t.id);
  assert.equal(calls, 1);
});

test('history keeps last 100', async () => {
  const m = mk();
  for (let i = 0; i < 105; i++) await m.download(`${fx.url}/ok/10`, dest());
  assert.equal(m.snapshot().jobs.filter((j) => j.finishedAt).length, 100);
});

test('publishes download.changed on bus', async () => {
  const m = mk();
  const fake = new EventEmitter() as EventEmitter & { publish(ev: unknown): void };
  const seen: any[] = [];
  fake.publish = (ev) => seen.push(ev);
  wireBus(m, fake);
  await m.download(`${fx.url}/ok/11`, dest());
  const states = seen.filter((e) => e.type === 'download.changed' && e.job).map((e) => e.job.state);
  assert.ok(states.includes('active'));
  assert.ok(states.includes('done'));
});

test('reuses legacy cache file without hash', async () => {
  const { downloadCached } = await import('./util.js');
  const url = `${fx.url}/ok/777`;
  const f = await downloadCached(url, undefined, '-legacy.bin');
  await fsp.writeFile(f, 'legacy');
  const before = fx.hits['/ok/777'];
  assert.equal(await downloadCached(url, undefined, '-legacy.bin'), f);
  assert.equal(fx.hits['/ok/777'], before);
  const good = crypto.createHash('sha1').update(fixtureBytes(777)).digest('hex');
  await downloadCached(url, undefined, '-legacy.bin', { sha1: good });
  assert.equal(fx.hits['/ok/777'], before + 1);
  assert.deepEqual(await fsp.readFile(f), fixtureBytes(777));
});

test('sweepPartials removes stale .part files', async () => {
  const d = await fsp.mkdtemp(path.join(os.tmpdir(), 'sweep-'));
  await fsp.writeFile(path.join(d, 'a.jar.part'), 'x');
  await fsp.writeFile(path.join(d, 'b.part'), 'x');
  await fsp.writeFile(path.join(d, 'keep.jar'), 'x');
  assert.equal(await sweepPartials(d), 2);
  assert.deepEqual(await fsp.readdir(d), ['keep.jar']);
});

test('withTask marks task done or failed', async () => {
  const m = mk();
  const { withTask } = await import('./downloads.js');
  await withTask({ label: 'ok', kind: 'addon' }, (ctx) => m.download(`${fx.url}/ok/12`, dest(), ctx), m);
  await assert.rejects(withTask({ label: 'bad', kind: 'addon' }, (ctx) => m.download(`${fx.url}/status/403`, dest(), ctx), m));
  const states = Object.fromEntries(m.snapshot().tasks.map((t) => [t.label, t.state]));
  assert.deepEqual(states, { ok: 'done', bad: 'failed' });
});

/* ---------------- Final review fixes ---------------- */
test('downloads a file a server would gzip', async () => {
  const d = dest();
  await mk().download(`${fx.url}/gzip/5000`, d);
  assert.deepEqual(await fsp.readFile(d), fixtureBytes(5000));
});

test('a failed task aborts its other downloads', async () => {
  const m = mk({ stallMs: 5000 });
  const { withTask } = await import('./downloads.js');
  await assert.rejects(withTask({ label: 'T', kind: 'modpack' }, (ctx) => Promise.all([m.download(`${fx.url}/status/403`, dest(), ctx), m.download(`${fx.url}/slow/60000`, dest(), ctx)]), m));
  await new Promise((r) => setTimeout(r, 200));
  const slow = m.jobs().find((j) => j.url.endsWith('/slow/60000'))!;
  assert.equal(slow.state, 'cancelled');
});

test('makes one more attempt than there are backoff delays', async () => {
  await assert.rejects(mk({ backoffMs: [10] }).download(`${fx.url}/flaky/5/102`, dest()));
  assert.equal(fx.hits['/flaky/5/102'], 2);
});

test('a joined download survives the first caller being cancelled', async () => {
  const m = mk({ stallMs: 2000 });
  const d = dest();
  const a = new AbortController();
  const first = m.download(`${fx.url}/slow/20000`, d, { signal: a.signal });
  const second = m.download(`${fx.url}/slow/20000`, d);
  setTimeout(() => a.abort(), 100);
  await assert.rejects(first, CancelledError);
  await second;
  assert.deepEqual(await fsp.readFile(d), fixtureBytes(20000));
});

test('a joined download checks its own hash', async () => {
  const m = mk();
  const d = dest();
  const first = m.download(`${fx.url}/ok/2323`, d);
  const second = m.download(`${fx.url}/ok/2323`, d, { sha1: 'deadbeef' });
  await first;
  await assert.rejects(second, /hash mismatch/);
});

test('a job whose folder cannot be made ends failed', async () => {
  const m = mk();
  const blocker = dest();
  await fsp.writeFile(blocker, 'x');
  await assert.rejects(m.download(`${fx.url}/ok/10`, path.join(blocker, 'sub', 'f.bin')));
  assert.equal(m.jobs().at(-1)!.state, 'failed');
});

test('resume sends If-Range with the ETag', async () => {
  const d = dest();
  await mk().download(`${fx.url}/drop/10001`, d);
  assert.equal(fx.requests['/drop/10001'][1]['if-range'], ETAG);
});

test('a refused Range (416) restarts from zero', async () => {
  const d = dest();
  await mk().download(`${fx.url}/r416/8000`, d);
  assert.deepEqual(await fsp.readFile(d), fixtureBytes(8000));
});

test('mirrors are tried within one job', async () => {
  const m = mk();
  const d = dest();
  await m.download(`${fx.url}/status/404`, d, { mirrors: [`${fx.url}/ok/3030`] });
  assert.deepEqual(await fsp.readFile(d), fixtureBytes(3030));
  assert.equal(m.jobs().length, 1);
  assert.equal(m.jobs()[0].state, 'done');
});

test('task counts survive history trimming', async () => {
  const m = mk({ concurrency: 20 });
  const t = m.startTask({ label: 'big', kind: 'modpack' });
  await Promise.all(Array.from({ length: 120 }, (_, i) => m.download(`${fx.url}/ok/${50 + i}`, path.join(dir, 'many', `${i}.bin`), t.ctx)));
  t.done();
  const task = m.snapshot().tasks[0];
  assert.deepEqual(task.files, { total: 120, done: 120, failed: 0 });
  assert.equal(task.bytesFinished, Array.from({ length: 120 }, (_, i) => 50 + i).reduce((a, b) => a + b, 0));
});

test('sweepPartials looks into subfolders up to a depth', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'sweep-'));
  await fsp.mkdir(path.join(root, 's1', 'mods'), { recursive: true });
  await fsp.writeFile(path.join(root, 's1', 'mods', 'a.jar.part'), 'x');
  await fsp.writeFile(path.join(root, 's1', 'mods', 'keep.jar'), 'x');
  assert.equal(await sweepPartials(root, 2), 1);
  assert.equal(await exists(path.join(root, 's1', 'mods', 'keep.jar')), true);
});

test('records when a file actually starts downloading, separate from when it was queued', async () => {
  const m = mk();
  await m.download(`${fx.url}/ok/100`, dest());
  const j = m.jobs().at(-1)!;
  assert.ok(j.activeAt, 'activeAt is set');
  assert.ok(j.activeAt! >= j.startedAt && j.activeAt! <= j.finishedAt!);
});

test('keeps the first start time across retries', async () => {
  const m = mk();
  const seen: string[] = [];
  m.on('change', (j: any) => j.activeAt && seen.push(j.activeAt));
  await m.download(`${fx.url}/flaky/2/100`, dest());
  assert.equal(new Set(seen).size, 1);
});

test('a network error names its cause, not just "fetch failed"', async () => {
  const net = await import('node:net');
  const srv = net.createServer();
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const port = (srv.address() as { port: number }).port;
  await new Promise((r) => srv.close(r));
  const m = mk({ backoffMs: [] });
  await assert.rejects(m.download(`http://127.0.0.1:${port}/x`, dest()), /ECONNREFUSED/);
});
