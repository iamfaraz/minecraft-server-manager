import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import websocket from '@fastify/websocket';
import WebSocket from 'ws';
import type { AddressInfo } from 'node:net';
import { registerApi } from '../app.js';
import { bus } from '../events.js';
import { loadAppConfig } from '../store.js';
import { mayReceive, toV1 } from './events.js';
import { tokens } from './tokens.js';

const T = (scopes: string[], servers?: string[]) => ({ scopes, servers }) as any;

test('events are filtered by permission and server limit', () => {
  const state = { type: 'server.state', id: 's1', state: 'running' } as const;
  const log = { type: 'server.log', id: 's1', line: 'hi' } as const;
  assert.equal(mayReceive(T(['servers:read']), state, new Set()), true);
  assert.equal(mayReceive(T(['players:read']), state, new Set()), false);
  assert.equal(mayReceive(T(['servers:read'], ['s2']), state, new Set()), false);
  assert.equal(mayReceive(T(['console:read']), log, new Set()), false, 'not subscribed');
  assert.equal(mayReceive(T(['console:read']), log, new Set(['s1'])), true);
  assert.equal(mayReceive(T(['servers:read', 'console:read']), { type: 'toast', level: 'info', message: 'x' }, new Set()), false);
  assert.equal(mayReceive(T(['downloads:read'], ['s1']), { type: 'download.changed', task: { serverId: 's1' } as any }, new Set()), true);
  assert.equal(mayReceive(T(['downloads:read'], ['s1']), { type: 'download.changed', task: { serverId: 's2' } as any }, new Set()), false);
  assert.equal(mayReceive(undefined, state, new Set()), true, 'the admin session sees everything');
  assert.deepEqual(toV1(state), { event: 'server.state', serverId: 's1', data: { state: 'running' } });
});

let app: FastifyInstance;
let url: string;
before(async () => {
  await loadAppConfig();
  app = Fastify();
  await app.register(cookie);
  await app.register(websocket);
  await registerApi(app);
  await app.listen({ port: 0, host: '127.0.0.1' });
  url = `ws://127.0.0.1:${(app.server.address() as AddressInfo).port}/api/v1/events`;
});
after(() => app.close());

function open(headers: Record<string, string> = {}) {
  const ws = new WebSocket(url, { headers });
  const msgs: any[] = [];
  const waiters: (() => void)[] = [];
  ws.on('message', (d) => {
    msgs.push(JSON.parse(String(d)));
    waiters.splice(0).forEach((w) => w());
  });
  const closed = new Promise<number>((r) => ws.on('close', (code) => r(code)));
  const next = async (pred: (m: any) => boolean) => {
    for (let i = 0; i < 50; i++) {
      const m = msgs.find(pred);
      if (m) return m;
      await new Promise<void>((r) => (waiters.push(r), setTimeout(r, 100)));
    }
    throw new Error('no matching message');
  };
  return { ws, msgs, next, closed, ready: new Promise((r) => ws.on('open', r)) };
}

test('header auth gets hello and permitted events only', async () => {
  const { token } = await tokens.create({ name: 'ws', scopes: ['servers:read'] }, []);
  const c = open({ authorization: `Bearer ${token}` });
  const hello = await c.next((m) => m.event === 'hello');
  assert.deepEqual(hello.data.scopes, ['servers:read']);
  bus.publish({ type: 'server.players', id: 'x', players: [] });
  bus.publish({ type: 'server.state', id: 'x', state: 'running' });
  await c.next((m) => m.event === 'server.state');
  assert.ok(!c.msgs.some((m) => m.event === 'server.players'));
  c.ws.close();
});

test('first-message auth works, and revoking the token closes the socket', async () => {
  const { token, info } = await tokens.create({ name: 'ws2', scopes: ['servers:read'] }, []);
  const c = open();
  await c.ready;
  c.ws.send(JSON.stringify({ type: 'auth', token }));
  await c.next((m) => m.event === 'hello');
  await tokens.revoke(info.id);
  assert.equal(await c.closed, 4401);
});

test('a bad token is closed with 4401', async () => {
  const c = open({ authorization: 'Bearer bh_nope' });
  assert.equal(await c.closed, 4401);
});
