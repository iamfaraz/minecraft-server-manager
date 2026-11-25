/**
 * /api/v1/events: live events for integrations, filtered by the token's permissions and server limit.
 * Auth: `Authorization: Bearer …` on the upgrade request, or a first message {"type":"auth","token":"…"} within 5 s.
 * Messages out: {"event": "<name>", "serverId": "…" | null, "data": {…}}.
 */
import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import { bus, type BusEvent } from '../events.js';
import { manager } from '../servers/manager.js';
import { HOST_MARK } from '../servers/hostlog.js';
import { userFromCookieHeader } from '../auth.js';
import { serverDto } from '../routes/v1.js';
import { canSeeServer, isExpired, tokens, type StoredToken } from './tokens.js';

const AUTH_WINDOW_MS = 5_000;
const stripHost = (l: string) => (l.startsWith(HOST_MARK) ? l.slice(HOST_MARK.length) : l);

/** The permission an event needs, or null when integrations never get it. */
export function eventScope(ev: BusEvent): string | null {
  switch (ev.type) {
    case 'server.state':
    case 'server.progress':
    case 'server.stats':
    case 'server.changed':
      return 'servers:read';
    case 'server.players':
      return 'players:read';
    case 'server.log':
      return 'console:read';
    case 'backup.changed':
      return 'backups:read';
    case 'download.changed':
      return 'downloads:read';
    case 'addon.progress':
      return 'content:read';
    case 'playit':
    case 'broadcast':
      return 'network:read';
    default:
      return null;
  }
}

export function eventServer(ev: BusEvent): string | undefined {
  if (ev.type === 'download.changed') return ev.job?.serverId ?? ev.task?.serverId;
  return 'id' in ev ? (ev.id as string | undefined) : undefined;
}

/** May a client with this token (undefined = the logged-in admin) receive this event? */
export function mayReceive(t: StoredToken | undefined, ev: BusEvent, logSubs: Set<string>): boolean {
  const scope = eventScope(ev);
  if (!scope) return false;
  const sid = eventServer(ev);
  if (ev.type === 'server.log' && !logSubs.has(sid!)) return false;
  if (!t) return true;
  if (!t.scopes.includes(scope)) return false;
  if (t.servers) return ev.type !== 'playit' && canSeeServer(t, sid);
  return true;
}

export function toV1(ev: BusEvent) {
  const { type, ...rest } = ev as any;
  const serverId = eventServer(ev) ?? null;
  if ('id' in rest) delete rest.id;
  if (type === 'server.log' && typeof rest.line === 'string') rest.line = stripHost(rest.line);
  return { event: type, serverId, data: rest };
}

interface Client {
  ws: WebSocket;
  token?: StoredToken;
  session: boolean;
  logs: Set<string>;
}

export async function eventRoutes(app: FastifyInstance) {
  const clients = new Set<Client>();
  const send = (c: Client, msg: unknown) => {
    if (c.ws.readyState === c.ws.OPEN) c.ws.send(JSON.stringify(msg));
  };

  bus.on('event', (ev: BusEvent) => {
    for (const c of clients) {
      if (!c.session && !c.token) continue;
      if (c.token && isExpired(c.token)) {
        c.ws.close(4401, 'token expired');
        clients.delete(c);
        continue;
      }
      if (mayReceive(c.token, ev, c.logs)) send(c, toV1(ev));
    }
  });
  tokens.events.on('revoked', (id: string) => {
    for (const c of clients) if (c.token?.id === id) (c.ws.close(4401, 'token revoked'), clients.delete(c));
  });

  const hello = (c: Client) => {
    const servers = c.token && !c.token.scopes.includes('servers:read') ? [] : manager.list().filter((s) => canSeeServer(c.token, s.id)).map(serverDto);
    send(c, { event: 'hello', serverId: null, data: { scopes: c.token?.scopes ?? null, servers } });
  };

  app.get('/api/v1/events', { websocket: true }, async (socket, req) => {
    const c: Client = { ws: socket, session: false, logs: new Set() };
    clients.add(c);
    socket.on('close', () => clients.delete(c));
    socket.on('error', () => clients.delete(c));

    const accept = async (bearer: string) => {
      try {
        const t = await tokens.verify(bearer);
        tokens.rateLimit(t);
        c.token = t;
        tokens.record(t, { at: new Date().toISOString(), method: 'WS', path: '/api/v1/events', status: 101, ip: req.ip });
        hello(c);
      } catch (e) {
        socket.close(4401, (e as Error).message.slice(0, 100));
        clients.delete(c);
      }
    };

    const header = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? '')?.[1];
    if (header) await accept(header);
    else if (userFromCookieHeader(req.headers.cookie)) {
      c.session = true;
      hello(c);
    } else {
      const timer = setTimeout(() => {
        if (!c.token) (socket.close(4401, 'authenticate within 5 seconds'), clients.delete(c));
      }, AUTH_WINDOW_MS);
      timer.unref();
    }

    socket.on('message', async (raw) => {
      let msg: any;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (msg?.type === 'auth' && typeof msg.token === 'string' && !c.token && !c.session) return accept(msg.token);
      if (!c.token && !c.session) return;
      if (msg?.type === 'ping') return send(c, { event: 'pong', serverId: null, data: {} });
      if ((msg?.type === 'subscribe' || msg?.type === 'unsubscribe') && typeof msg.serverId === 'string') {
        const id = msg.serverId;
        if (msg.type === 'unsubscribe') return void c.logs.delete(id);
        if (c.token && (!c.token.scopes.includes('console:read') || !canSeeServer(c.token, id))) {
          return send(c, { event: 'error', serverId: id, data: { code: 'forbidden', message: 'This token cannot read that console' } });
        }
        const inst = manager.instances.get(id);
        if (!inst) return send(c, { event: 'error', serverId: id, data: { code: 'not_found', message: 'Server not found' } });
        c.logs.add(id);
        send(c, { event: 'server.backlog', serverId: id, data: { lines: inst.logs.slice(-200).map(stripHost) } });
      }
    });
  });
}
