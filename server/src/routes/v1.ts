/**
 * The stable integration API (/api/v1). Shapes here are kept compatible across releases, unlike the internal /api
 * the web UI uses. Every endpoint declares the permission it needs; the API reference page is built from ENDPOINTS.
 */
import os from 'node:os';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { requireAuth } from '../auth.js';
import { requestToken, visibleTo } from '../api/guard.js';
import { ANY_TOKEN, SCOPES } from '../api/scopes.js';
import { createBackup, listBackups, restoreBackup, type BackupMeta } from '../backups.js';
import { config } from '../config.js';
import { isUpdating } from '../modpacks/update.js';
import * as mods from '../modupdates.js';
import { playit } from '../playit.js';
import { getPlayers, playerAction, type PlayerAction } from '../players.js';
import { HOST_MARK } from '../servers/hostlog.js';
import { manager } from '../servers/manager.js';
import { MOD_TYPES, PLUGIN_TYPES, type BackupScope, type ServerSummary } from '../servers/types.js';
import { checkUpdates } from '../updates.js';
import { bad, HttpError } from '../util.js';
import { visibleDownloads } from './downloads.js';

export interface V1Endpoint {
  method: 'GET' | 'POST';
  path: string;
  scope?: string;
  summary: string;
  body?: Record<string, unknown>;
  query?: Record<string, string>;
  websocket?: boolean;
}

export const ENDPOINTS: V1Endpoint[] = [];
export const V1_PREFIX = '/api/v1';

const PLAYER_ACTIONS: PlayerAction[] = ['whitelist-add', 'whitelist-remove', 'op', 'deop', 'kick', 'ban', 'pardon'];

/** The v1 view of a server. Add fields freely; never rename or remove them. */
export function serverDto(s: ServerSummary) {
  const ping = s.ping?.ok ? s.ping : null;
  return {
    id: s.id,
    name: s.name,
    edition: s.edition,
    type: s.type,
    version: s.version,
    state: s.state,
    online: s.state === 'running',
    startedAt: s.startedAt,
    autoStart: s.autoStart,
    players: { online: s.players.length, max: ping?.max ?? null, names: s.players.map((p) => p.name) },
    address: { port: s.port, remote: s.address?.remote ?? [] },
    crossPlay: s.edition === 'java' ? { enabled: !!s.geyser, port: s.geyserPort ?? null } : null,
    modpack: s.modpack ? { title: s.modpack.title, version: s.modpack.versionNumber, projectId: s.modpack.projectId ?? null } : null,
    usage: s.lastStats ? { cpuPercent: Math.round(s.lastStats.cpu), memoryMb: Math.round(s.lastStats.memMb) } : null,
    install: s.install,
  };
}

function withRemote(s: ServerSummary): ServerSummary {
  const remote = playit.tunnelsForPort(s.port, s.edition === 'bedrock');
  if (s.geyser && s.geyserPort) remote.push(...playit.tunnelsForPort(s.geyserPort, true).map((a) => `${a} (Bedrock via Geyser)`));
  return { ...s, address: { ...s.address, remote } };
}

const backupDto = (b: BackupMeta) => ({ id: b.id, label: b.label, scope: b.scope, createdAt: b.createdAt, bytes: b.bytes, version: b.version, automatic: b.auto });

const CODES: Record<number, string> = { 400: 'bad_request', 401: 'unauthorized', 403: 'forbidden', 404: 'not_found', 409: 'conflict', 413: 'too_large', 429: 'rate_limited' };

export async function v1Routes(app: FastifyInstance) {
  ENDPOINTS.length = 0;
  app.setErrorHandler((err: any, _req, reply) => {
    const status = err instanceof HttpError ? err.status : err.statusCode && err.statusCode < 500 ? err.statusCode : 500;
    if (status === 429 && err.data?.retryAfter) reply.header('Retry-After', String(err.data.retryAfter));
    const { retryAfter: _r, ...details } = (err instanceof HttpError && err.data) || {};
    if (status >= 500) app.log.error(err);
    reply.code(status).send({ error: { code: CODES[status] ?? 'internal', message: err.message || 'Internal error', ...(Object.keys(details).length ? { details } : {}) } });
  });
  app.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: { code: 'not_found', message: 'No such endpoint' } }));
  app.addHook('preHandler', requireAuth);

  const def = <P = Record<string, string>>(e: V1Endpoint, handler: (req: Omit<FastifyRequest, 'params' | 'body' | 'query'> & { params: P; body: any; query: any }, reply: FastifyReply) => Promise<unknown>) => {
    ENDPOINTS.push(e);
    // Registered under the /api/v1 prefix (see app.ts); e.path is the full path for the reference page.
    app.route({ method: e.method, url: e.path.slice(V1_PREFIX.length) || '/', config: { scope: e.scope }, handler: handler as any });
  };
  const inst = (id: string) => manager.get(id);

  def({ method: 'GET', path: '/api/v1/me', scope: ANY_TOKEN, summary: 'The token making the request: its name, permissions, server limit and expiry.' }, async (req) => {
    const t = requestToken(req);
    if (!t) return { type: 'session', name: (req as any).user, scopes: SCOPES.map((s) => s.id), servers: null, expiresAt: null };
    return { type: 'token', id: t.id, name: t.name, scopes: t.scopes, servers: t.servers ?? null, expiresAt: t.expiresAt ?? null };
  });

  def({ method: 'GET', path: '/api/v1/servers', scope: 'servers:read', summary: 'All servers with status, players online, address and resource use.' }, async (req) => ({
    servers: manager
      .list()
      .filter((s) => visibleTo(req, s.id))
      .map((s) => serverDto(withRemote(s))),
  }));

  def<{ id: string }>({ method: 'GET', path: '/api/v1/servers/:id', scope: 'servers:read', summary: 'One server.' }, async (req) => serverDto(withRemote(inst(req.params.id).summary())));

  for (const action of ['start', 'stop', 'restart', 'kill'] as const) {
    const summary = { start: 'Start the server.', stop: 'Stop the server gracefully.', restart: 'Stop the server if running, then start it.', kill: 'Force-stop a server that does not respond.' }[action];
    def<{ id: string }>({ method: 'POST', path: `/api/v1/servers/:id/${action}`, scope: 'servers:power', summary }, async (req) => {
      const i = inst(req.params.id);
      if (action === 'start') await manager.startServer(i.id);
      else if (action === 'stop') await i.stop();
      else if (action === 'kill') i.kill();
      else {
        if (i.isActive) await i.stop();
        await manager.startServer(i.id);
      }
      return { ok: true, state: i.state };
    });
  }

  def<{ id: string }>({ method: 'GET', path: '/api/v1/servers/:id/players', scope: 'players:read', summary: 'Players online, plus whitelist, operators and bans.' }, async (req) => {
    const s = inst(req.params.id);
    const p = await getPlayers(s);
    const names = (l: { name: string }[]) => l.map((x) => x.name);
    return { online: p.online.map((o) => ({ name: o.name, id: o.id ?? null, joinedAt: o.joinedAt })), max: s.ping?.max ?? null, whitelistEnabled: p.whitelistEnabled, whitelist: names(p.whitelist), ops: names(p.ops), banned: names(p.banned) };
  });

  def<{ id: string; name: string; action: string }>(
    { method: 'POST', path: '/api/v1/servers/:id/players/:name/:action', scope: 'players:manage', summary: `Act on a player. action is one of: ${PLAYER_ACTIONS.join(', ')}.`, body: { reason: 'optional, for kick and ban' } },
    async (req) => {
      const action = req.params.action as PlayerAction;
      if (!PLAYER_ACTIONS.includes(action)) throw bad(`action must be one of ${PLAYER_ACTIONS.join(', ')}`);
      const r = await playerAction(inst(req.params.id), action, req.params.name, req.body?.reason);
      return { ok: true, message: r.message };
    },
  );

  def<{ id: string }>({ method: 'GET', path: '/api/v1/servers/:id/logs', scope: 'console:read', summary: 'The latest console lines (default 100, at most 1000).', query: { lines: '100' } }, async (req) => {
    const n = Math.max(1, Math.min(Number(req.query?.lines) || 100, 1000));
    return { lines: inst(req.params.id).logs.slice(-n).map((l) => (l.startsWith(HOST_MARK) ? l.slice(HOST_MARK.length) : l)) };
  });

  def<{ id: string }>({ method: 'POST', path: '/api/v1/servers/:id/command', scope: 'console:write', summary: 'Run a console command (without the leading slash).', body: { command: 'say Hello from the API' } }, async (req) => {
    const cmd = req.body?.command;
    if (!cmd || typeof cmd !== 'string' || cmd.length > 2000) throw bad('command must be a string of up to 2000 characters');
    const i = inst(req.params.id);
    if (i.state !== 'running') throw new HttpError(409, 'The server is not running');
    i.send(cmd);
    return { ok: true };
  });

  def<{ id: string }>({ method: 'GET', path: '/api/v1/servers/:id/backups', scope: 'backups:read', summary: 'Backups of this server, newest first.' }, async (req) => {
    inst(req.params.id);
    return { backups: (await listBackups(req.params.id)).map(backupDto) };
  });

  def<{ id: string }>({ method: 'POST', path: '/api/v1/servers/:id/backups', scope: 'backups:create', summary: 'Take a backup now. scope is "world" (default) or "full".', body: { label: 'before-event', scope: 'world' } }, async (req, reply) => {
    const scope: BackupScope = req.body?.scope === 'full' ? 'full' : 'world';
    const meta = await createBackup(inst(req.params.id), { label: typeof req.body?.label === 'string' ? req.body.label : undefined, scope });
    reply.code(201);
    return backupDto(meta);
  });

  def<{ id: string; backupId: string }>({ method: 'POST', path: '/api/v1/servers/:id/backups/:backupId/restore', scope: 'backups:restore', summary: 'Replace the server with a backup (the server is stopped first).' }, async (req) => {
    if (isUpdating(req.params.id)) throw new HttpError(409, 'The modpack is being updated; try again when it finishes');
    await restoreBackup(inst(req.params.id), req.params.backupId);
    return { ok: true };
  });

  def<{ id: string }>({ method: 'GET', path: '/api/v1/servers/:id/updates', scope: 'content:read', summary: 'Available updates: server software, modpack, and mods or plugins.' }, async (req) => {
    const i = inst(req.params.id);
    const u = await checkUpdates(i);
    let addons: { file: string; title: string | null; current: string | null; latest: string | null }[] | null = null;
    if (MOD_TYPES.includes(i.rec.type) || PLUGIN_TYPES.includes(i.rec.type)) {
      const r = await mods.checkUpdates(i).catch(() => null);
      addons = r ? r.addons.filter((a) => a.updateAvailable).map((a) => ({ file: a.fileName, title: a.title ?? null, current: a.currentVersion ?? null, latest: a.latestVersion ?? null })) : null;
    }
    return {
      server: { type: u.current.type, version: u.current.version, newBuild: u.build?.available ?? false, newVersion: u.version.available ? u.version.latest : null },
      modpack: u.modpack ? { available: u.modpack.available, latest: u.modpack.latest?.versionNumber ?? null, changesMinecraftVersion: u.modpack.changesMcVersion } : null,
      addons,
    };
  });

  def({ method: 'GET', path: '/api/v1/downloads', scope: 'downloads:read', summary: 'Download tasks (server installs, mods, modpacks) and their progress.' }, async (req) => {
    const s = visibleDownloads(req);
    return {
      tasks: s.tasks.map((t) => ({ id: t.id, label: t.label, serverId: t.serverId ?? null, kind: t.kind, state: t.state, error: t.error ?? null, files: t.files, bytesDone: t.bytesFinished, startedAt: t.startedAt, finishedAt: t.finishedAt ?? null })),
      active: s.jobs.filter((j) => !j.finishedAt).map((j) => ({ taskId: j.taskId ?? null, label: j.label, state: j.state, bytesDone: j.bytesDone, bytesTotal: j.bytesTotal, speedBps: j.speedBps })),
    };
  });

  def({ method: 'GET', path: '/api/v1/system', scope: 'system:read', summary: 'Host CPU, memory and uptime, and how many servers are running.' }, async () => {
    const all = manager.list();
    return {
      version: config.version,
      platform: config.platform,
      arch: config.arch,
      uptimeSec: Math.round(process.uptime()),
      cpu: { cores: os.cpus().length, load1: os.loadavg()[0] },
      memory: { totalMb: Math.round(os.totalmem() / 1048576), freeMb: Math.round(os.freemem() / 1048576), allocatedMb: manager.totalXmxMb() },
      servers: { total: all.length, running: all.filter((s) => s.state === 'running').length },
    };
  });

  ENDPOINTS.push({
    method: 'GET',
    path: '/api/v1/events',
    summary: 'Websocket of live events (server state, players, logs, backups, downloads), filtered to what the token may see. Send {"type":"subscribe","serverId":"…"} for console lines (needs console:read).',
    websocket: true,
  });
}
