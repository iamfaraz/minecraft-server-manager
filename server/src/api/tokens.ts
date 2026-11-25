/**
 * Access tokens for integrations (bots, Home Assistant, scripts, apps). Only a SHA-256 hash of each token is kept,
 * in <data>/api-tokens.json, together with its permissions, optional server limit, expiry and recent activity.
 */
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { config } from '../config.js';
import { HttpError, readJson, writeJson } from '../util.js';
import { ANY_TOKEN, cleanScopes, GLOBAL_SCOPES } from './scopes.js';

export interface Activity {
  at: string;
  method: string;
  path: string;
  status: number;
  ip?: string;
}

export interface StoredToken {
  id: string;
  name: string;
  /** First characters of the token, shown so tokens can be told apart. */
  prefix: string;
  hash: string;
  scopes: string[];
  /** Limit to these servers; absent = all servers. */
  servers?: string[];
  expiresAt?: string;
  createdAt: string;
  lastUsedAt?: string;
  lastUsedIp?: string;
  activity: Activity[];
}

export type TokenView = Omit<StoredToken, 'hash' | 'activity'> & { expired: boolean };

export interface CreateTokenInput {
  name: string;
  scopes: string[];
  servers?: string[] | null;
  expiresAt?: string | null;
}

const ACTIVITY = 200;
const RATE_PER_MIN = 120;
const SAVE_DELAY_MS = 5_000;

const hashOf = (token: string) => crypto.createHash('sha256').update(token).digest('hex');

export class TokenStore {
  private tokens: StoredToken[] = [];
  private loaded = false;
  private saveTimer: NodeJS.Timeout | null = null;
  private readonly hits = new Map<string, number[]>();
  readonly events = new EventEmitter();

  constructor(
    private readonly file: string,
    private readonly ratePerMin = RATE_PER_MIN,
  ) {}

  async load(): Promise<void> {
    if (this.loaded) return;
    this.tokens = (await readJson<{ tokens: StoredToken[] }>(this.file, { tokens: [] })).tokens ?? [];
    this.loaded = true;
  }

  private async saveNow(): Promise<void> {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    await writeJson(this.file, { tokens: this.tokens });
  }

  /** Activity and last-used times are written in batches. */
  private saveSoon(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => void this.saveNow().catch(() => {}), SAVE_DELAY_MS);
    this.saveTimer.unref();
  }

  async flush(): Promise<void> {
    if (this.saveTimer) await this.saveNow();
  }

  private view(t: StoredToken): TokenView {
    const { hash: _h, activity: _a, ...rest } = t;
    return { ...rest, expired: isExpired(t) };
  }

  async list(): Promise<TokenView[]> {
    await this.load();
    return this.tokens.map((t) => this.view(t));
  }

  async activity(id: string): Promise<Activity[]> {
    await this.load();
    const t = this.tokens.find((x) => x.id === id);
    if (!t) throw new HttpError(404, 'Token not found');
    return [...t.activity].reverse();
  }

  async create(input: CreateTokenInput, knownServers: string[]): Promise<{ token: string; info: TokenView }> {
    await this.load();
    const name = String(input.name ?? '').trim();
    if (!name || name.length > 60) throw new HttpError(400, 'Give the token a name (up to 60 characters)');
    const servers = input.servers?.length ? [...new Set(input.servers)] : undefined;
    if (servers?.some((s) => !knownServers.includes(s))) throw new HttpError(400, 'Unknown server in the server limit');
    const scopes = cleanScopes(input.scopes, !!servers);
    if (!scopes.length) throw new HttpError(400, 'Pick at least one permission');
    let expiresAt: string | undefined;
    if (input.expiresAt) {
      const d = new Date(input.expiresAt);
      if (Number.isNaN(d.getTime()) || d.getTime() <= Date.now()) throw new HttpError(400, 'Expiry must be a future date');
      expiresAt = d.toISOString();
    }
    const token = `bh_${crypto.randomBytes(32).toString('base64url')}`;
    const t: StoredToken = { id: `tok_${crypto.randomBytes(6).toString('hex')}`, name, prefix: token.slice(0, 9), hash: hashOf(token), scopes, servers, expiresAt, createdAt: new Date().toISOString(), activity: [] };
    this.tokens.push(t);
    await this.saveNow();
    return { token, info: this.view(t) };
  }

  async revoke(id: string): Promise<void> {
    await this.load();
    const i = this.tokens.findIndex((x) => x.id === id);
    if (i < 0) throw new HttpError(404, 'Token not found');
    this.tokens.splice(i, 1);
    this.hits.delete(id);
    await this.saveNow();
    this.events.emit('revoked', id);
  }

  /** A server was deleted: drop it from server limits (a token left with no servers keeps none, not all). */
  async forgetServer(serverId: string): Promise<void> {
    await this.load();
    let changed = false;
    for (const t of this.tokens) {
      if (t.servers?.includes(serverId)) {
        t.servers = t.servers.filter((s) => s !== serverId);
        changed = true;
      }
    }
    if (changed) await this.saveNow();
  }

  /** The token for a bearer string, or why not. Constant-time compare on the hash. */
  async verify(bearer: string): Promise<StoredToken> {
    await this.load();
    const h = Buffer.from(hashOf(bearer));
    const t = this.tokens.find((x) => x.hash.length === h.length && crypto.timingSafeEqual(Buffer.from(x.hash), h));
    if (!t) throw new HttpError(401, 'Invalid access token');
    if (isExpired(t)) throw new HttpError(401, 'This access token has expired');
    return t;
  }

  /** Count a request; throws 429 past the per-minute limit. */
  rateLimit(t: StoredToken): void {
    const now = Date.now();
    const recent = (this.hits.get(t.id) ?? []).filter((x) => now - x < 60_000);
    if (recent.length >= this.ratePerMin) {
      this.hits.set(t.id, recent);
      const retry = Math.ceil((60_000 - (now - recent[0])) / 1000);
      throw new HttpError(429, `Too many requests for this token; try again in ${retry}s`, { retryAfter: retry });
    }
    recent.push(now);
    this.hits.set(t.id, recent);
  }

  record(t: StoredToken, a: Activity): void {
    t.lastUsedAt = a.at;
    t.lastUsedIp = a.ip;
    t.activity.push(a);
    if (t.activity.length > ACTIVITY) t.activity.splice(0, t.activity.length - ACTIVITY);
    this.saveSoon();
  }
}

export function isExpired(t: { expiresAt?: string }): boolean {
  return !!t.expiresAt && new Date(t.expiresAt).getTime() <= Date.now();
}

/** May this token use `scope` (on `serverId`, when the request is about one server)? Throws 403 if not. */
export function authorize(t: Pick<StoredToken, 'scopes' | 'servers'>, scope: string | undefined, serverId?: string): void {
  if (!scope) throw new HttpError(403, 'Access tokens cannot use this endpoint');
  if (scope === ANY_TOKEN) return;
  if (!t.scopes.includes(scope)) throw new HttpError(403, `This token does not have the "${scope}" permission`);
  if (t.servers) {
    if (GLOBAL_SCOPES.has(scope)) throw new HttpError(403, `Tokens limited to some servers cannot use "${scope}"`);
    if (serverId && !t.servers.includes(serverId)) throw new HttpError(403, 'This token is not allowed to use that server');
  }
}

/** Can this token see this server at all (used to filter lists and events)? */
export const canSeeServer = (t: Pick<StoredToken, 'servers'> | undefined, serverId: string | undefined) => !t?.servers || (!!serverId && t.servers.includes(serverId));

export const tokens = new TokenStore(path.join(config.dataDir, 'api-tokens.json'));
