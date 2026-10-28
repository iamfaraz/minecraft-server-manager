import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { getAppConfig, saveAppConfig } from './store.js';
import { HttpError } from './util.js';
import { generateRecoveryCodes, generateSecret, hashRecovery, otpauthUrl, verifyTotp } from './totp.js';
import QRCode from 'qrcode';

const COOKIE = 'mcsm_session';
const TTL_MS = 1000 * 60 * 60 * 24 * 14;
const MFA_TTL_MS = 5 * 60 * 1000;
const ISSUER = 'Blockhost';

function sign(payload: string): string {
  return crypto.createHmac('sha256', getAppConfig().secret).update(payload).digest('base64url');
}

function issue(scope: 's' | 'mfa', username: string, ttl: number): string {
  const exp = Date.now() + ttl;
  const payload = `${scope}.${Buffer.from(username).toString('base64url')}.${exp}`;
  return `${payload}.${sign(payload)}`;
}
function verify(scope: 's' | 'mfa', token: string | undefined): string | null {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 4 || parts[0] !== scope) return null;
  const payload = `${parts[0]}.${parts[1]}.${parts[2]}`;
  const expected = sign(payload);
  if (expected.length !== parts[3].length || !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(parts[3]))) return null;
  if (Number(parts[2]) < Date.now()) return null;
  return Buffer.from(parts[1], 'base64url').toString();
}

export const issueToken = (username: string) => issue('s', username, TTL_MS);
export const verifyToken = (token: string | undefined) => verify('s', token);
/** Short-lived token proving the password step passed; exchanged for a session after the TOTP step. */
export const issueMfaToken = (username: string) => issue('mfa', username, MFA_TTL_MS);
export const verifyMfaToken = (token: string | undefined) => verify('mfa', token);

/* ---------------------------- Two-factor (TOTP) ---------------------------- */

export function totpEnabled(): boolean {
  return !!getAppConfig().admin?.totp?.enabled;
}

/** Start enrolment: generate a pending secret and return QR + manual key. Not active until confirmed. */
export async function totpBeginSetup(): Promise<{ secret: string; otpauthUrl: string; qrDataUrl: string; issuer: string; account: string }> {
  const admin = getAppConfig().admin;
  if (!admin) throw new HttpError(409, 'Not set up');
  const secret = generateSecret();
  admin.totp = { ...(admin.totp || { secret: '', enabled: false, recoveryHashes: [] }), pendingSecret: secret };
  await saveAppConfig();
  const url = otpauthUrl(ISSUER, admin.username, secret);
  const qrDataUrl = await QRCode.toDataURL(url, { margin: 1, width: 240, color: { dark: '#e6edf3', light: '#0f141b' } });
  return { secret, otpauthUrl: url, qrDataUrl, issuer: ISSUER, account: admin.username };
}

/** Confirm enrolment with a code from the app; returns one-time recovery codes. */
export async function totpConfirm(code: string): Promise<string[]> {
  const admin = getAppConfig().admin;
  const pending = admin?.totp?.pendingSecret;
  if (!admin || !pending) throw new HttpError(409, 'Start the 2FA setup first');
  const counter = verifyTotp(pending, code);
  if (counter === null) throw new HttpError(400, 'That code is not valid. Check the time on your device and try again.');
  const codes = generateRecoveryCodes();
  admin.totp = { secret: pending, enabled: true, recoveryHashes: codes.map(hashRecovery), lastCounter: counter, enabledAt: new Date().toISOString() };
  await saveAppConfig();
  return codes;
}

export async function totpDisable(password: string, code: string): Promise<void> {
  const admin = getAppConfig().admin;
  if (!admin) throw new HttpError(409, 'Not set up');
  if (!(await bcrypt.compare(password, admin.passwordHash))) throw new HttpError(403, 'Password is incorrect');
  if (admin.totp?.enabled && !(await consumeSecondFactor(code))) throw new HttpError(403, 'Invalid authentication code');
  delete admin.totp;
  await saveAppConfig();
}

/** Accepts a TOTP code (replay-protected) or an unused recovery code. */
export async function consumeSecondFactor(code: string): Promise<boolean> {
  const admin = getAppConfig().admin;
  const t = admin?.totp;
  if (!admin || !t?.enabled) return false;
  const trimmed = (code || '').trim();
  if (/^\d{6}$/.test(trimmed.replace(/\s+/g, ''))) {
    const counter = verifyTotp(t.secret, trimmed);
    if (counter === null) return false;
    if (t.lastCounter !== undefined && counter <= t.lastCounter) return false; // replay within the window
    t.lastCounter = counter;
    await saveAppConfig();
    return true;
  }
  const h = hashRecovery(trimmed);
  const idx = t.recoveryHashes.indexOf(h);
  if (idx === -1) return false;
  t.recoveryHashes.splice(idx, 1);
  await saveAppConfig();
  return true;
}

export function totpStatus(): { enabled: boolean; recoveryCodesLeft: number; enabledAt?: string } {
  const t = getAppConfig().admin?.totp;
  return { enabled: !!t?.enabled, recoveryCodesLeft: t?.enabled ? t.recoveryHashes.length : 0, enabledAt: t?.enabledAt };
}

export async function regenerateRecoveryCodes(code: string): Promise<string[]> {
  const admin = getAppConfig().admin;
  if (!admin?.totp?.enabled) throw new HttpError(409, '2FA is not enabled');
  if (!(await consumeSecondFactor(code))) throw new HttpError(403, 'Invalid authentication code');
  const codes = generateRecoveryCodes();
  admin.totp.recoveryHashes = codes.map(hashRecovery);
  await saveAppConfig();
  return codes;
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
