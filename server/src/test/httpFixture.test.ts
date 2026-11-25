import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixtureBytes, startFixture } from './httpFixture.js';

test('/ok returns deterministic bytes', async () => {
  const fx = await startFixture();
  try {
    const buf = Buffer.from(await (await fetch(`${fx.url}/ok/1000`)).arrayBuffer());
    assert.deepEqual(buf, fixtureBytes(1000));
  } finally {
    await fx.close();
  }
});

test('/ok honours Range', async () => {
  const fx = await startFixture();
  try {
    const res = await fetch(`${fx.url}/ok/1000`, { headers: { Range: 'bytes=500-' } });
    assert.equal(res.status, 206);
    assert.deepEqual(Buffer.from(await res.arrayBuffer()), fixtureBytes(1000).subarray(500));
  } finally {
    await fx.close();
  }
});

test('/flaky fails n times then succeeds', async () => {
  const fx = await startFixture();
  try {
    const codes = [];
    for (let i = 0; i < 3; i++) codes.push((await fetch(`${fx.url}/flaky/2/10`)).status);
    assert.deepEqual(codes, [500, 500, 200]);
    assert.equal(fx.hits['/flaky/2/10'], 3);
  } finally {
    await fx.close();
  }
});
