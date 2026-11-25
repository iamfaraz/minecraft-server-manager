import type { FastifyInstance, FastifyRequest } from 'fastify';
import { requireAuth } from '../auth.js';
import { requestToken, visibleTo } from '../api/guard.js';
import { downloads } from '../downloads.js';
import { bad, HttpError, notFound } from '../util.js';

/** Downloads a request may see: everything for the session, only its servers' for a server-limited token. */
export function visibleDownloads(req: FastifyRequest) {
  const s = downloads.snapshot();
  const tasks = s.tasks.filter((t) => visibleTo(req, t.serverId));
  return { tasks, jobs: s.jobs.filter((j) => visibleTo(req, j.serverId)) };
}

/** A server-limited token may only act on its own servers' downloads. */
function assertVisible(req: FastifyRequest, serverId: string | undefined) {
  if (!visibleTo(req, serverId)) throw notFound('Download not found');
}

export async function downloadRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);

  app.get('/api/downloads', async (req) => visibleDownloads(req));
  app.post<{ Params: { id: string } }>('/api/downloads/tasks/:id/cancel', async (req) => {
    assertVisible(req, downloads.snapshot().tasks.find((x) => x.id === req.params.id)?.serverId);
    downloads.cancelTask(req.params.id);
    return { ok: true };
  });
  app.post<{ Params: { id: string } }>('/api/downloads/:id/cancel', async (req) => {
    assertVisible(req, downloads.jobs().find((x) => x.id === req.params.id)?.serverId);
    downloads.cancelJob(req.params.id);
    return { ok: true };
  });
  app.post<{ Params: { id: string } }>('/api/downloads/tasks/:id/retry', async (req) => {
    const t = downloads.snapshot().tasks.find((x) => x.id === req.params.id);
    assertVisible(req, t?.serverId);
    if (!t?.canRetry) throw bad('This task cannot be retried');
    // Retries can run for minutes (a whole reinstall); progress arrives over the websocket.
    downloads.retryTask(req.params.id).catch(() => {});
    return { ok: true };
  });
  app.delete('/api/downloads/history', async (req) => {
    if (requestToken(req)?.servers) throw new HttpError(403, 'Tokens limited to some servers cannot clear the whole history');
    downloads.clearHistory();
    return { ok: true };
  });
}
