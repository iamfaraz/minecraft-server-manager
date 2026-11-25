import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../auth.js';
import { downloads } from '../downloads.js';
import { bad } from '../util.js';

export async function downloadRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);

  app.get('/api/downloads', async () => downloads.snapshot());
  app.post<{ Params: { id: string } }>('/api/downloads/tasks/:id/cancel', async (req) => {
    downloads.cancelTask(req.params.id);
    return { ok: true };
  });
  app.post<{ Params: { id: string } }>('/api/downloads/:id/cancel', async (req) => {
    downloads.cancelJob(req.params.id);
    return { ok: true };
  });
  app.post<{ Params: { id: string } }>('/api/downloads/tasks/:id/retry', async (req) => {
    const t = downloads.snapshot().tasks.find((x) => x.id === req.params.id);
    if (!t?.canRetry) throw bad('This task cannot be retried');
    // Retries can run for minutes (a whole reinstall); progress arrives over the websocket.
    downloads.retryTask(req.params.id).catch(() => {});
    return { ok: true };
  });
  app.delete('/api/downloads/history', async () => {
    downloads.clearHistory();
    return { ok: true };
  });
}
