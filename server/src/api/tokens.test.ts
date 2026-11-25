import { test } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { authorize, canSeeServer, TokenStore } from './tokens.js';
import { cleanScopes, PRESETS, ROUTE_SCOPES, SCOPE_IDS, SCOPES } from './scopes.js';

const store = async (rate?: number) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'tok-'));
  return { s: new TokenStore(path.join(dir, 't.json'), rate), file: path.join(dir, 't.json') };
};

test('a created token verifies, and only its hash is stored', async () => {
  const { s, file } = await store();
  const { token, info } = await s.create({ name: 'Bot', scopes: ['servers:read'] }, []);
  assert.match(token, /^bh_[A-Za-z0-9_-]{43}$/);
  assert.equal(info.prefix, token.slice(0, 9));
  assert.equal((await s.verify(token)).id, info.id);
  const raw = await fsp.readFile(file, 'utf8');
  assert.ok(!raw.includes(token));
  assert.ok(!('hash' in info));
});

test('wrong, revoked and expired tokens are refused', async () => {
  const { s } = await store();
  const { token, info } = await s.create({ name: 'A', scopes: ['servers:read'] }, []);
  await assert.rejects(s.verify('bh_nope'), (e: any) => e.status === 401);
  let revoked = '';
  s.events.on('revoked', (id) => (revoked = id));
  await s.revoke(info.id);
  assert.equal(revoked, info.id);
  await assert.rejects(s.verify(token), (e: any) => e.status === 401);
  const b = await s.create({ name: 'B', scopes: ['servers:read'], expiresAt: new Date(Date.now() + 50).toISOString() }, []);
  await new Promise((r) => setTimeout(r, 80));
  await assert.rejects(s.verify(b.token), /expired/);
  assert.equal((await s.list())[0].expired, true);
});

test('create validates name, scopes, servers and expiry', async () => {
  const { s } = await store();
  await assert.rejects(s.create({ name: ' ', scopes: ['servers:read'] }, []), /name/);
  await assert.rejects(s.create({ name: 'x', scopes: ['nope'] }, []), /at least one permission/);
  await assert.rejects(s.create({ name: 'x', scopes: ['servers:read'], servers: ['ghost'] }, ['s1']), /Unknown server/);
  await assert.rejects(s.create({ name: 'x', scopes: ['servers:read'], expiresAt: '2000-01-01' }, []), /future/);
});

test('server-limited tokens cannot hold global scopes', async () => {
  const { s } = await store();
  const { info } = await s.create({ name: 'x', scopes: ['servers:read', 'system:read', 'servers:create'], servers: ['s1'] }, ['s1']);
  assert.deepEqual(info.scopes, ['servers:read']);
  assert.deepEqual(cleanScopes(['system:read', 'system:read', 'bogus'], false), ['system:read']);
});

test('authorize checks the scope, the server limit and global scopes', () => {
  const all = { scopes: ['servers:read', 'servers:power', 'system:read'] };
  assert.doesNotThrow(() => authorize(all, 'servers:read', 's1'));
  assert.throws(() => authorize(all, 'servers:delete', 's1'), (e: any) => e.status === 403 && /servers:delete/.test(e.message));
  assert.throws(() => authorize(all, undefined), /cannot use this endpoint/);
  const limited = { scopes: ['servers:read', 'system:read'], servers: ['s1'] };
  assert.doesNotThrow(() => authorize(limited, 'servers:read', 's1'));
  assert.throws(() => authorize(limited, 'servers:read', 's2'), /not allowed to use that server/);
  assert.throws(() => authorize(limited, 'system:read'), /limited to some servers/);
  assert.equal(canSeeServer(limited, 's1'), true);
  assert.equal(canSeeServer(limited, 's2'), false);
  assert.equal(canSeeServer(limited, undefined), false);
  assert.equal(canSeeServer(all as any, 's9'), true);
});

test('rate limit refuses past the per-minute budget', async () => {
  const { s } = await store(3);
  const { token } = await s.create({ name: 'x', scopes: ['servers:read'] }, []);
  const t = await s.verify(token);
  s.rateLimit(t);
  s.rateLimit(t);
  s.rateLimit(t);
  assert.throws(() => s.rateLimit(t), (e: any) => e.status === 429 && e.data.retryAfter > 0);
});

test('activity keeps the last 200 entries, newest first', async () => {
  const { s } = await store();
  const { token, info } = await s.create({ name: 'x', scopes: ['servers:read'] }, []);
  const t = await s.verify(token);
  for (let i = 0; i < 205; i++) s.record(t, { at: new Date().toISOString(), method: 'GET', path: `/p${i}`, status: 200 });
  const a = await s.activity(info.id);
  assert.equal(a.length, 200);
  assert.equal(a[0].path, '/p204');
  assert.ok((await s.list())[0].lastUsedAt);
  await s.flush();
});

test('forgetServer drops a deleted server from limits', async () => {
  const { s } = await store();
  const { info } = await s.create({ name: 'x', scopes: ['servers:read'], servers: ['s1', 's2'] }, ['s1', 's2']);
  await s.forgetServer('s1');
  assert.deepEqual((await s.list()).find((t) => t.id === info.id)!.servers, ['s2']);
});

test('scope table: every route maps to a known scope and presets use known scopes', () => {
  for (const [route, scope] of Object.entries(ROUTE_SCOPES)) assert.ok(SCOPE_IDS.has(scope), `${route} → ${scope}`);
  for (const p of PRESETS) for (const s of p.scopes) assert.ok(SCOPE_IDS.has(s), `${p.id} → ${s}`);
  assert.equal(new Set(SCOPES.map((s) => s.id)).size, SCOPES.length);
});
