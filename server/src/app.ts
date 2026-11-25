/** The HTTP API: error format, authentication hooks and every route plugin. Shared by the server and the tests. */
import type { FastifyInstance } from 'fastify';
import { eventRoutes } from './api/events.js';
import { registerTokenActivity } from './api/guard.js';
import { tokens } from './api/tokens.js';
import { authRoutes } from './routes/auth.js';
import { contentRoutes } from './routes/content.js';
import { downloadRoutes } from './routes/downloads.js';
import { miscRoutes } from './routes/misc.js';
import { modpackRoutes } from './routes/modpacks.js';
import { serverRoutes } from './routes/servers.js';
import { tokenRoutes } from './routes/tokens.js';
import { V1_PREFIX, v1Routes } from './routes/v1.js';
import { HttpError } from './util.js';
import { wsRoutes } from './ws.js';

export async function registerApi(app: FastifyInstance): Promise<void> {
  app.setErrorHandler((err: any, _req, reply) => {
    if (err instanceof HttpError) {
      if (err.status === 429 && err.data?.retryAfter) reply.header('Retry-After', String(err.data.retryAfter));
      return reply.code(err.status).send({ ...err.data, error: err.message });
    }
    const anyErr = err as any;
    if (anyErr.validation || anyErr.statusCode === 400) return reply.code(400).send({ error: err.message });
    if (anyErr.statusCode === 413) return reply.code(413).send({ error: 'Upload too large' });
    app.log.error(err);
    reply.code(500).send({ error: err.message || 'Internal error' });
  });

  registerTokenActivity(app);
  app.addHook('onClose', async () => tokens.flush());
  await app.register(authRoutes);
  await app.register(tokenRoutes);
  await app.register(v1Routes, { prefix: V1_PREFIX });
  await app.register(eventRoutes);
  await app.register(serverRoutes);
  await app.register(miscRoutes);
  await app.register(contentRoutes);
  await app.register(downloadRoutes);
  await app.register(modpackRoutes);
  await app.register(wsRoutes);
}
