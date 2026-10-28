import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import { bus, type BusEvent } from './events.js';
import { userFromCookieHeader } from './auth.js';
import { manager } from './servers/manager.js';
import { playit } from './playit.js';

interface Client {
  ws: WebSocket;
  subs: Set<string>;
}

export async function wsRoutes(app: FastifyInstance) {
  const clients = new Set<Client>();

  bus.on('event', (ev: BusEvent) => {
    let payload: string | null = null;
    for (const c of clients) {
      if (ev.type === 'server.log' && !c.subs.has(ev.id)) continue;
      if (c.ws.readyState !== c.ws.OPEN) continue;
      payload ??= JSON.stringify(ev);
      c.ws.send(payload);
    }
  });

  app.get('/ws', { websocket: true }, (socket, req) => {
    const user = userFromCookieHeader(req.headers.cookie);
    if (!user) {
      socket.close(4401, 'unauthorized');
      return;
    }
    const client: Client = { ws: socket, subs: new Set() };
    clients.add(client);
    socket.send(JSON.stringify({ type: 'hello', servers: manager.list(), playit: playit.status() }));
    socket.on('message', (raw) => {
      try {
        const msg = JSON.parse(String(raw));
        if (msg.type === 'subscribe' && typeof msg.id === 'string') {
          client.subs.add(msg.id);
          const inst = manager.instances.get(msg.id);
          if (inst) socket.send(JSON.stringify({ type: 'server.backlog', id: msg.id, lines: inst.logs.slice(-500) }));
        } else if (msg.type === 'unsubscribe' && typeof msg.id === 'string') {
          client.subs.delete(msg.id);
        } else if (msg.type === 'ping') {
          socket.send(JSON.stringify({ type: 'pong' }));
        }
      } catch {
        /* ignore malformed */
      }
    });
    socket.on('close', () => clients.delete(client));
    socket.on('error', () => clients.delete(client));
  });
}
