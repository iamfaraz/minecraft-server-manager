import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../auth.js';
import { defaultVersion, packVersions, searchPacks } from '../modpacks/modrinth.js';
import { deleteStaged, getStaged, listStaged, stageFromModrinth, stageUpload } from '../modpacks/store.js';
import { bad } from '../util.js';

export async function modpackRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);

  app.post('/api/modpacks/upload', async (req) => stageUpload(req));
  app.post<{ Body: { versionId?: string } }>('/api/modpacks/stage', async (req) => {
    if (!req.body?.versionId) throw bad('versionId is required');
    return stageFromModrinth(req.body.versionId);
  });
  app.get('/api/modpacks/staged', async () => listStaged());
  app.get<{ Params: { id: string } }>('/api/modpacks/staged/:id', async (req) => getStaged(req.params.id));
  app.delete<{ Params: { id: string } }>('/api/modpacks/staged/:id', async (req) => {
    await deleteStaged(req.params.id);
    return { ok: true };
  });
  app.get<{ Querystring: { q?: string; offset?: string } }>('/api/modpacks/search', async (req) => searchPacks(req.query.q || '', Number(req.query.offset || 0)));
  app.get<{ Params: { idOrSlug: string } }>('/api/modpacks/project/:idOrSlug/versions', async (req) => {
    const versions = await packVersions(req.params.idOrSlug);
    return { versions, defaultIndex: versions.length ? defaultVersion(versions) : -1 };
  });
}
