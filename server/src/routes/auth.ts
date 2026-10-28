import type { FastifyInstance } from 'fastify';
import {
  changePassword,
  checkLogin,
  clearSessionCookie,
  consumeSecondFactor,
  issueMfaToken,
  issueToken,
  regenerateRecoveryCodes,
  requireAuth,
  setSessionCookie,
  setupAdmin,
  setupRequired,
  totpBeginSetup,
  totpConfirm,
  totpDisable,
  totpEnabled,
  totpStatus,
  userFromRequest,
  verifyMfaToken,
} from '../auth.js';
import { HttpError } from '../util.js';

export async function authRoutes(app: FastifyInstance) {
  app.get('/api/auth/status', async (req) => ({ setupRequired: setupRequired(), user: userFromRequest(req) }));

  app.post<{ Body: { username: string; password: string } }>('/api/auth/setup', async (req, reply) => {
    await setupAdmin(req.body?.username, req.body?.password);
    setSessionCookie(reply, issueToken(req.body.username));
    return { ok: true, user: req.body.username };
  });

  // Basic brute-force damping: per-IP failures slow the endpoint down.
  const failures = new Map<string, { n: number; at: number }>();
  const damp = async (ip: string) => {
    const f = failures.get(ip);
    if (f && Date.now() - f.at < 15 * 60_000 && f.n >= 5) await new Promise((r) => setTimeout(r, Math.min(8000, 500 * 2 ** (f.n - 5))));
  };
  const fail = (ip: string) => {
    const f = failures.get(ip);
    failures.set(ip, { n: f && Date.now() - f.at < 15 * 60_000 ? f.n + 1 : 1, at: Date.now() });
  };

  app.post<{ Body: { username: string; password: string } }>('/api/auth/login', async (req, reply) => {
    await damp(req.ip);
    if (!(await checkLogin(req.body?.username || '', req.body?.password || ''))) {
      fail(req.ip);
      throw new HttpError(401, 'Invalid username or password');
    }
    failures.delete(req.ip);
    if (totpEnabled()) return { ok: false, mfaRequired: true, mfaToken: issueMfaToken(req.body.username) };
    setSessionCookie(reply, issueToken(req.body.username));
    return { ok: true, user: req.body.username };
  });

  /** Second step: TOTP or recovery code + the short-lived token from step one. */
  app.post<{ Body: { mfaToken: string; code: string } }>('/api/auth/login/2fa', async (req, reply) => {
    await damp(req.ip);
    const user = verifyMfaToken(req.body?.mfaToken);
    if (!user) throw new HttpError(401, 'Your login expired, start again');
    if (!(await consumeSecondFactor(req.body?.code || ''))) {
      fail(req.ip);
      throw new HttpError(401, 'Invalid authentication code');
    }
    failures.delete(req.ip);
    setSessionCookie(reply, issueToken(user));
    return { ok: true, user };
  });

  app.get('/api/auth/2fa', { preHandler: requireAuth }, async () => totpStatus());
  app.post('/api/auth/2fa/setup', { preHandler: requireAuth }, async () => totpBeginSetup());
  app.post<{ Body: { code: string } }>('/api/auth/2fa/confirm', { preHandler: requireAuth }, async (req) => ({ recoveryCodes: await totpConfirm(req.body?.code || '') }));
  app.post<{ Body: { password: string; code: string } }>('/api/auth/2fa/disable', { preHandler: requireAuth }, async (req) => {
    await totpDisable(req.body?.password || '', req.body?.code || '');
    return { ok: true };
  });
  app.post<{ Body: { code: string } }>('/api/auth/2fa/recovery-codes', { preHandler: requireAuth }, async (req) => ({ recoveryCodes: await regenerateRecoveryCodes(req.body?.code || '') }));

  app.post('/api/auth/logout', async (_req, reply) => {
    clearSessionCookie(reply);
    return { ok: true };
  });

  app.post<{ Body: { current: string; next: string } }>('/api/auth/password', { preHandler: requireAuth }, async (req) => {
    await changePassword(req.body?.current || '', req.body?.next || '');
    return { ok: true };
  });
}
