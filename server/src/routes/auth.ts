import type { FastifyInstance } from 'fastify';
import { changePassword, checkLogin, clearSessionCookie, issueToken, requireAuth, setSessionCookie, setupAdmin, setupRequired, userFromRequest } from '../auth.js';
import { HttpError } from '../util.js';

export async function authRoutes(app: FastifyInstance) {
  app.get('/api/auth/status', async (req) => ({ setupRequired: setupRequired(), user: userFromRequest(req) }));

  app.post<{ Body: { username: string; password: string } }>('/api/auth/setup', async (req, reply) => {
    await setupAdmin(req.body?.username, req.body?.password);
    setSessionCookie(reply, issueToken(req.body.username));
    return { ok: true, user: req.body.username };
  });

  app.post<{ Body: { username: string; password: string } }>('/api/auth/login', async (req, reply) => {
    if (!(await checkLogin(req.body?.username || '', req.body?.password || ''))) throw new HttpError(401, 'Invalid username or password');
    setSessionCookie(reply, issueToken(req.body.username));
    return { ok: true, user: req.body.username };
  });

  app.post('/api/auth/logout', async (_req, reply) => {
    clearSessionCookie(reply);
    return { ok: true };
  });

  app.post<{ Body: { current: string; next: string } }>('/api/auth/password', { preHandler: requireAuth }, async (req) => {
    await changePassword(req.body?.current || '', req.body?.next || '');
    return { ok: true };
  });
}
