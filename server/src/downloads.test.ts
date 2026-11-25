import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { CancelledError, DownloadManager } from './downloads.js';
import { fixtureBytes, startFixture, type Fixture } from './test/httpFixture.js';

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

const mk = (o: Partial<ConstructorParameters<typeof DownloadManager>[0]> = {}) => new DownloadManager({ stallMs: 300, connectMs: 300, backoffMs: [10, 10, 10], ...o });
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
