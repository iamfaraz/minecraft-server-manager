/** Managing access tokens. Session only: a token can never create, list or revoke tokens. */
import type { FastifyInstance } from 'fastify';
import { requireSession } from '../auth.js';
import { PRESETS, SCOPES } from '../api/scopes.js';
import { tokens, type CreateTokenInput } from '../api/tokens.js';
import { manager } from '../servers/manager.js';
import { ENDPOINTS } from './v1.js';

export async function tokenRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireSession);

  app.get('/api/tokens', async () => ({ tokens: await tokens.list(), scopes: SCOPES, presets: PRESETS }));

  app.post<{ Body: CreateTokenInput }>('/api/tokens', async (req, reply) => {
    const r = await tokens.create(req.body ?? ({} as CreateTokenInput), manager.list().map((s) => s.id));
    reply.code(201);
    return r;
  });

  app.delete<{ Params: { id: string } }>('/api/tokens/:id', async (req) => {
    await tokens.revoke(req.params.id);
    return { ok: true };
  });

  app.get<{ Params: { id: string } }>('/api/tokens/:id/activity', async (req) => ({ activity: await tokens.activity(req.params.id) }));

  /** What the API reference page shows. */
  app.get('/api/tokens/reference', async () => ({ endpoints: ENDPOINTS, scopes: SCOPES }));
}
