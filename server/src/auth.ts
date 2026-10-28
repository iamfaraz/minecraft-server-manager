import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { getAppConfig, saveAppConfig } from './store.js';
import { HttpError } from './util.js';

const COOKIE = 'mcsm_session';
const TTL_MS = 1000 * 60 * 60 * 24 * 14;

function sign(payload: string): string {
  return crypto.createHmac('sha256', getAppConfig().secret).update(payload).digest('base64url');
}

export function issueToken(username: string): string {
  const exp = Date.now() + TTL_MS;
  const payload = `${Buffer.from(username).toString('base64url')}.${exp}`;
  return `${payload}.${sign(payload)}`;
}

export function verifyToken(token: string | undefined): string | null {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const payload = `${parts[0]}.${parts[1]}`;
  const expected = sign(payload);
  if (expected.length !== parts[2].length || !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(parts[2]))) return null;
  if (Number(parts[1]) < Date.now()) return null;
  return Buffer.from(parts[0], 'base64url').toString();
}

export function setupRequired(): boolean {
  return !getAppConfig().admin;
}

export async function setupAdmin(username: string, password: string): Promise<void> {
  if (!setupRequired()) throw new HttpError(409, 'Already set up');
  if (!username || username.length < 2) throw new HttpError(400, 'Username too short');
  if (!password || password.length < 8) throw new HttpError(400, 'Password must be at least 8 characters');
  getAppConfig().admin = { username, passwordHash: await bcrypt.hash(password, 10) };
  await saveAppConfig();
}

export async function checkLogin(username: string, password: string): Promise<boolean> {
  const admin = getAppConfig().admin;
  if (!admin) return false;
  if (admin.username !== username) return false;
  return bcrypt.compare(password, admin.passwordHash);
}

export async function changePassword(current: string, next: string): Promise<void> {
  const admin = getAppConfig().admin;
  if (!admin) throw new HttpError(409, 'Not set up');
  if (!(await bcrypt.compare(current, admin.passwordHash))) throw new HttpError(403, 'Current password is incorrect');
  if (!next || next.length < 8) throw new HttpError(400, 'Password must be at least 8 characters');
  admin.passwordHash = await bcrypt.hash(next, 10);
  await saveAppConfig();
}

export function cookieName(): string {
  return COOKIE;
}

export function setSessionCookie(reply: FastifyReply, token: string): void {
  reply.setCookie(COOKIE, token, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    maxAge: TTL_MS / 1000,
  });
}

export function clearSessionCookie(reply: FastifyReply): void {
  reply.clearCookie(COOKIE, { path: '/' });
}

export function userFromRequest(req: FastifyRequest): string | null {
  const token = (req.cookies as Record<string, string | undefined>)?.[COOKIE];
  return verifyToken(token);
}

export function userFromCookieHeader(header: string | undefined): string | null {
  if (!header) return null;
  const m = new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`).exec(header);
  return verifyToken(m ? decodeURIComponent(m[1]) : undefined);
}

/** Fastify preHandler: requires an authenticated session. */
export async function requireAuth(req: FastifyRequest, _reply: FastifyReply): Promise<void> {
  const user = userFromRequest(req);
  if (!user) throw new HttpError(401, 'Not authenticated');
  (req as any).user = user;
}
