/** Authenticating requests that carry an access token (`Authorization: Bearer bh_…`) instead of the session cookie. */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { HttpError } from '../util.js';
import { ROUTE_SCOPES } from './scopes.js';
import { authorize, canSeeServer, tokens, type StoredToken } from './tokens.js';

declare module 'fastify' {
  interface FastifyContextConfig {
    /** Permission an access token needs for this route (v1 routes declare it here; internal ones in ROUTE_SCOPES). */
    scope?: string;
  }
}

/** The bearer token on a request, or null when there is none (an empty or malformed header counts as a bad token). */
export function bearerFrom(header: string | undefined): string | null {
  if (header === undefined) return null;
  const m = /^Bearer\s+(\S+)\s*$/i.exec(header);
  if (!m) throw new HttpError(401, 'Authorization header must be "Bearer <token>"');
  return m[1];
}

/** The scope a route needs: its own config, else the internal route table. */
export function scopeFor(method: string, url: string | undefined, configured?: string): string | undefined {
  if (configured) return configured;
  if (!url) return undefined;
  return ROUTE_SCOPES[`${method === 'HEAD' ? 'GET' : method} ${url}`];
}

/** The server a route is about, when its path is /api/servers/:id/… or /api/v1/servers/:id/…. */
export function serverParam(url: string | undefined, params: unknown): string | undefined {
  if (!url || !/^\/api\/(v1\/)?servers\/:id(\/|$)/.test(url)) return undefined;
  return (params as { id?: string } | undefined)?.id;
}

export async function tokenAuth(req: FastifyRequest, bearer: string): Promise<StoredToken> {
  const t = await tokens.verify(bearer);
  (req as any).apiToken = t; // set first so refused requests show up in the token's activity too
  tokens.rateLimit(t);
  authorize(t, scopeFor(req.method, req.routeOptions.url, req.routeOptions.config?.scope), serverParam(req.routeOptions.url, req.params));
  (req as any).user = `token:${t.name}`;
  return t;
}

export const requestToken = (req: FastifyRequest): StoredToken | undefined => (req as any).apiToken;

/** Lists filtered to the servers a limited token may see (the session sees everything). */
export const visibleTo = (req: FastifyRequest, serverId: string | undefined) => canSeeServer(requestToken(req), serverId);

/** Record each token request in its activity once the response is sent. */
export function registerTokenActivity(app: FastifyInstance): void {
  app.addHook('onResponse', async (req, reply) => {
    const t = requestToken(req);
    if (!t) return;
    tokens.record(t, { at: new Date().toISOString(), method: req.method, path: req.url.split('?')[0], status: reply.statusCode, ip: req.ip });
  });
}
