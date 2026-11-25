import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import websocket from '@fastify/websocket';
import { registerApi } from '../app.js';
import { issueToken } from '../auth.js';
import { loadAppConfig } from '../store.js';
import { ROUTE_SCOPES } from './scopes.js';
import { tokens } from './tokens.js';

let app: FastifyInstance;
const routes: string[] = [];
let session: string;

before(async () => {
  await loadAppConfig();
  app = Fastify();
  await app.register(cookie);
  await app.register(multipart);
  await app.register(websocket);
  app.addHook('onRoute', (r) => {
    for (const m of [r.method].flat()) if (m !== 'HEAD') routes.push(`${m} ${r.url}`);
  });
  await registerApi(app);
  await app.ready();
  session = `mcsm_session=${issueToken('admin')}`;
});
after(() => app.close());

const call = (method: string, url: string, auth?: string, body?: unknown) =>
  app.inject({ method: method as any, url, headers: auth?.startsWith('mcsm_session') ? { cookie: auth } : auth ? { authorization: `Bearer ${auth}` } : {}, ...(body ? { payload: body as any } : {}) });

async function mkToken(scopes: string[], extra: Record<string, unknown> = {}) {
  const r = await call('POST', '/api/tokens', session, { name: 'test', scopes, ...extra });
  assert.equal(r.statusCode, 201, r.body);
  return r.json() as { token: string; info: { id: string } };
}

test('every internal route has a permission, and the table has no stale entries', () => {
  const own = routes.filter((r) => /^\w+ \/api\//.test(r) && !/^\w+ \/api\/(auth|tokens|v1)(\/|$)/.test(r));
  const missing = own.filter((r) => !(r in ROUTE_SCOPES));
  assert.deepEqual(missing, [], `routes without a scope: ${missing.join(', ')}`);
  const stale = Object.keys(ROUTE_SCOPES).filter((r) => !routes.includes(r));
  assert.deepEqual(stale, [], `scopes for routes that do not exist: ${stale.join(', ')}`);
});

test('a token reaches v1 and internal routes it has permission for, and nothing else', async () => {
  const { token } = await mkToken(['servers:read']);
  assert.equal((await call('GET', '/api/v1/servers', token)).statusCode, 200);
  assert.equal((await call('GET', '/api/servers', token)).statusCode, 200);
  const r = await call('POST', '/api/v1/servers/x/start', token);
  assert.equal(r.statusCode, 403);
  assert.equal(r.json().error.code, 'forbidden');
  assert.match(r.json().error.message, /servers:power/);
  assert.equal((await call('GET', '/api/system', token)).statusCode, 403);
  assert.equal((await call('GET', '/api/v1/me', token)).json().scopes.join(), 'servers:read');
});

test('tokens can never touch the account or token management', async () => {
  const { token } = await mkToken(['servers:read', 'system:read', 'system:manage']);
  for (const [m, u] of [['GET', '/api/auth/2fa'], ['POST', '/api/auth/password'], ['GET', '/api/tokens'], ['POST', '/api/tokens'], ['GET', '/api/tokens/reference']]) {
    assert.equal((await call(m, u, token, m === 'POST' ? {} : undefined)).statusCode, 403, `${m} ${u}`);
  }
});

test('bad, malformed and revoked tokens get 401', async () => {
  const { token, info } = await mkToken(['servers:read']);
  assert.equal((await call('GET', '/api/v1/servers', 'bh_wrong')).statusCode, 401);
  assert.equal((await app.inject({ method: 'GET', url: '/api/v1/servers', headers: { authorization: 'Basic abc' } })).statusCode, 401);
  assert.equal((await call('DELETE', `/api/tokens/${info.id}`, session)).statusCode, 200);
  const r = await call('GET', '/api/v1/servers', token);
  assert.equal(r.statusCode, 401);
  assert.equal(r.json().error.code, 'unauthorized');
});

test('a server-limited token is kept to its servers', async () => {
  const { token } = await tokens.create({ name: 'limited', scopes: ['servers:read', 'console:read'], servers: ['s1'] }, ['s1']);
  const r = await call('GET', '/api/v1/servers/s2', token);
  assert.equal(r.statusCode, 403);
  assert.match(r.json().error.message, /not allowed to use that server/);
  assert.equal((await call('GET', '/api/servers/s2/logs', token)).statusCode, 403);
  // allowed server passes the permission check (then 404s: no such server in the test data folder)
  assert.equal((await call('GET', '/api/servers/s1/logs', token)).statusCode, 404);
  assert.deepEqual((await call('GET', '/api/v1/servers', token)).json(), { servers: [] });
});

test('requests show up in the token activity, including refused ones', async () => {
  const { token, info } = await mkToken(['servers:read']);
  await call('GET', '/api/v1/servers', token);
  await call('GET', '/api/system', token);
  const a = (await call('GET', `/api/tokens/${info.id}/activity`, session)).json().activity;
  assert.deepEqual(a.map((x: any) => [x.path, x.status]), [['/api/system', 403], ['/api/v1/servers', 200]]);
});

test('rate limit answers 429 with Retry-After', async () => {
  const { token } = await mkToken(['servers:read']);
  let last;
  for (let i = 0; i < 121; i++) last = await call('GET', '/api/v1/me', token);
  assert.equal(last!.statusCode, 429);
  assert.ok(Number(last!.headers['retry-after']) > 0);
  assert.equal(last!.json().error.code, 'rate_limited');
});

test('the session still works everywhere, and the reference lists v1 endpoints', async () => {
  assert.equal((await call('GET', '/api/v1/servers', session)).statusCode, 200);
  assert.equal((await call('GET', '/api/servers', session)).statusCode, 200);
  const ref = (await call('GET', '/api/tokens/reference', session)).json();
  assert.ok(ref.endpoints.some((e: any) => e.path === '/api/v1/servers/:id/start' && e.scope === 'servers:power'));
  assert.ok(ref.endpoints.some((e: any) => e.path === '/api/v1/events' && e.websocket));
  assert.equal((await call('GET', '/api/v1/nope', session)).json().error.code, 'not_found');
});
