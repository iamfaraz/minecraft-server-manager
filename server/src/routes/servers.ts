import type { FastifyInstance } from 'fastify';
import path from 'node:path';
import { requireAuth } from '../auth.js';
import { manager } from '../servers/manager.js';
import { bad, PropertiesFile } from '../util.js';
import type { CreateServerInput, ServerRecord, ServerType } from '../servers/types.js';
import { playit } from '../playit.js';

export async function serverRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);

  const withRemote = (s: ReturnType<typeof manager.list>[number]) => {
    const remote = playit.tunnelsForPort(s.port, s.edition === 'bedrock');
    if (s.geyser && s.geyserPort) remote.push(...playit.tunnelsForPort(s.geyserPort, true).map((a) => `${a} (Bedrock via Geyser)`));
    s.address.remote = remote;
    return s;
  };

  app.get('/api/servers', async () => manager.list().map(withRemote));

  app.post<{ Body: CreateServerInput }>('/api/servers', async (req, reply) => {
    const s = await manager.create(req.body);
    reply.code(201);
    return withRemote(s);
  });

  app.get<{ Params: { id: string } }>('/api/servers/:id', async (req) => withRemote(manager.get(req.params.id).summary()));

  app.patch<{ Params: { id: string }; Body: Partial<ServerRecord> }>('/api/servers/:id', async (req) => withRemote(await manager.updateSettings(req.params.id, req.body || {})));

  app.delete<{ Params: { id: string }; Querystring: { deleteFiles?: string } }>('/api/servers/:id', async (req) => {
    await manager.remove(req.params.id, req.query.deleteFiles !== 'false');
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>('/api/servers/:id/start', async (req) => {
    await manager.get(req.params.id).start();
    return { ok: true };
  });
  app.post<{ Params: { id: string } }>('/api/servers/:id/stop', async (req) => {
    await manager.get(req.params.id).stop();
    return { ok: true };
  });
  app.post<{ Params: { id: string } }>('/api/servers/:id/restart', async (req) => {
    const inst = manager.get(req.params.id);
    if (inst.isActive) await inst.stop();
    await inst.start();
    return { ok: true };
  });
  app.post<{ Params: { id: string } }>('/api/servers/:id/kill', async (req) => {
    manager.get(req.params.id).kill();
    return { ok: true };
  });
  app.post<{ Params: { id: string }; Body: { command: string } }>('/api/servers/:id/command', async (req) => {
    const cmd = req.body?.command;
    if (!cmd || typeof cmd !== 'string' || cmd.length > 2000) throw bad('Invalid command');
    manager.get(req.params.id).send(cmd);
    return { ok: true };
  });

  app.get<{ Params: { id: string }; Querystring: { tail?: string } }>('/api/servers/:id/logs', async (req) => {
    const inst = manager.get(req.params.id);
    const n = Math.min(Number(req.query.tail || 500), 1000);
    return { lines: inst.logs.slice(-n) };
  });

  app.get<{ Params: { id: string } }>('/api/servers/:id/stats', async (req) => ({ samples: manager.get(req.params.id).stats }));

  app.get<{ Params: { id: string } }>('/api/servers/:id/properties', async (req) => {
    const inst = manager.get(req.params.id);
    const pf = await PropertiesFile.load(path.join(inst.root, 'server.properties'));
    return { properties: pf.entries(), running: inst.isActive };
  });

  app.put<{ Params: { id: string }; Body: { properties: Record<string, string> } }>('/api/servers/:id/properties', async (req) => {
    const inst = manager.get(req.params.id);
    const pf = await PropertiesFile.load(path.join(inst.root, 'server.properties'));
    const locked = new Set(['server-port', 'server-portv6', 'level-name', 'transport']);
    for (const [k, v] of Object.entries(req.body?.properties || {})) {
      if (!/^[a-zA-Z0-9_.-]+$/.test(k) || locked.has(k)) continue;
      if (/[\r\n]/.test(String(v))) continue;
      pf.set(k, String(v));
    }
    await pf.save();
    if (inst.isActive) inst.pushLog('[Blockhost] server.properties updated; restart to apply.');
    return { properties: pf.entries() };
  });

  app.post<{ Params: { id: string }; Body: { version: string; type?: ServerType; javaMajor?: number | 'auto'; backupFirst?: boolean } }>(
    '/api/servers/:id/version',
    async (req) => {
      if (!req.body?.version) throw bad('version is required');
      await manager.changeVersion(req.params.id, req.body);
      return { ok: true };
    },
  );
  app.post<{ Params: { id: string } }>('/api/servers/:id/reinstall', async (req) => {
    await manager.reinstall(req.params.id);
    return { ok: true };
  });

  app.post<{ Params: { id: string }; Body: { kind?: 'game' | 'geyser' } }>('/api/servers/:id/tunnel', async (req) => {
    const inst = manager.get(req.params.id);
    const t = await playit.createTunnel(inst.rec, req.body?.kind || 'game');
    return { tunnel: t };
  });
}
