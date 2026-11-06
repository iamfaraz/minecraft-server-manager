import crypto from 'node:crypto';
import path from 'node:path';
import { fetchJson, readJson, writeJson, PropertiesFile, bad, HttpError } from './util.js';
import type { ServerInstance } from './servers/instance.js';

export interface ListedPlayer {
  name: string;
  id?: string;
  level?: number;
  reason?: string;
  permission?: string;
}

export interface RosterEntry {
  name: string;
  id?: string;
  online: boolean;
  joinedAt?: string;
  lastSeen?: string;
  ip?: string;
  allowlisted: boolean;
  /** java: 'operator' | 'player' ; bedrock: 'operator' | 'member' | 'visitor' | 'default' */
  permission: string;
  opLevel?: number;
  blocked: boolean;
  blockReason?: string;
}

export interface PlayersView {
  /** Every player the server knows about, merged from online, seen, allowlist, operators and blocklist. */
  roster: RosterEntry[];
  permissionLevels: string[];
  defaultPermission: string | null;
  online: { name: string; id?: string; ip?: string; joinedAt: string }[];
  whitelist: ListedPlayer[];
  whitelistEnabled: boolean;
  ops: ListedPlayer[];
  banned: ListedPlayer[];
  seen: { name: string; id?: string; lastSeen: string }[];
  running: boolean;
}

function offlineUuid(name: string): string {
  const h = crypto.createHash('md5').update(`OfflinePlayer:${name}`, 'utf8').digest();
  h[6] = (h[6] & 0x0f) | 0x30;
  h[8] = (h[8] & 0x3f) | 0x80;
  const s = h.toString('hex');
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}
const dashed = (u: string) => (u.includes('-') ? u : `${u.slice(0, 8)}-${u.slice(8, 12)}-${u.slice(12, 16)}-${u.slice(16, 20)}-${u.slice(20)}`);

export async function resolveJavaUuid(inst: ServerInstance, name: string): Promise<string> {
  const seen = inst.seen.get(name.toLowerCase());
  if (seen?.id) return seen.id;
  // The server's own record of names it has met. This is the only place a cross-play (Floodgate) player's id
  // appears: it is derived from their Xbox account and never printed in the log.
  const cached = (await readJson<{ uuid: string; name: string }[]>(path.join(inst.root, 'usercache.json'), [])).find((u) => u.name?.toLowerCase() === name.toLowerCase());
  if (cached?.uuid) return dashed(cached.uuid);
  const props = await PropertiesFile.load(path.join(inst.root, 'server.properties'));
  if (props.get('online-mode') === 'false') return offlineUuid(name);
  try {
    const d = await fetchJson<{ id: string; name: string }>(`https://api.mojang.com/users/profiles/minecraft/${encodeURIComponent(name)}`);
    return dashed(d.id);
  } catch {
    throw new HttpError(404, `Could not resolve a Mojang account named "${name}"`);
  }
}

function xuidFor(inst: ServerInstance, name: string): string | undefined {
  return inst.seen.get(name.toLowerCase())?.id;
}

function buildRoster(
  inst: ServerInstance,
  lists: { whitelist: ListedPlayer[]; ops: ListedPlayer[]; banned: ListedPlayer[] },
  permById: Map<string, string>,
): RosterEntry[] {
  const java = inst.rec.edition === 'java';
  const map = new Map<string, RosterEntry>();
  const get = (name: string, id?: string): RosterEntry => {
    const key = name.toLowerCase();
    let e = map.get(key);
    if (!e) {
      e = { name, id, online: false, allowlisted: false, permission: java ? 'player' : 'default', blocked: false };
      map.set(key, e);
    }
    if (id && !e.id) e.id = id;
    return e;
  };
  for (const s of inst.seen.values()) {
    const e = get(s.name, s.id);
    e.lastSeen = s.lastSeen;
    e.ip = s.ip;
  }
  for (const p of inst.players.values()) {
    const e = get(p.name, p.id);
    e.online = true;
    e.joinedAt = p.joinedAt;
    e.ip = p.ip ?? e.ip;
  }
  for (const w of lists.whitelist) if (w.name) get(w.name, w.id).allowlisted = true;
  for (const o of lists.ops) {
    if (!o.name) continue;
    const e = get(o.name, o.id);
    e.permission = 'operator';
    e.opLevel = o.level;
  }
  for (const b of lists.banned) {
    if (!b.name) continue;
    const e = get(b.name, b.id);
    e.blocked = true;
    e.blockReason = b.reason;
  }
  if (!java) {
    for (const e of map.values()) {
      const perm = e.id ? permById.get(e.id) : undefined;
      if (perm) e.permission = perm;
    }
    for (const b of inst.blocked.values()) {
      const e = get(b.name, b.id);
      e.blocked = true;
      e.blockReason = b.reason;
    }
  }
  return [...map.values()].sort((a, b) => Number(b.online) - Number(a.online) || (b.lastSeen || '').localeCompare(a.lastSeen || '') || a.name.localeCompare(b.name));
}

export async function getPlayers(inst: ServerInstance): Promise<PlayersView> {
  const root = inst.root;
  const props = await PropertiesFile.load(path.join(root, 'server.properties'));
  const seen = [...inst.seen.values()].sort((a, b) => b.lastSeen.localeCompare(a.lastSeen)).slice(0, 50);
  const nameOf = (id?: string) => (id ? seen.find((s) => s.id === id)?.name : undefined);
  if (inst.rec.edition === 'java') {
    const wl = await readJson<any[]>(path.join(root, 'whitelist.json'), []);
    const ops = await readJson<any[]>(path.join(root, 'ops.json'), []);
    const banned = await readJson<any[]>(path.join(root, 'banned-players.json'), []);
    const lists = {
      whitelist: wl.map((w) => ({ name: w.name, id: w.uuid })),
      ops: ops.map((o) => ({ name: o.name, id: o.uuid, level: o.level })),
      banned: banned.map((b) => ({ name: b.name, id: b.uuid, reason: b.reason })),
    };
    return {
      roster: buildRoster(inst, lists, new Map()),
      permissionLevels: ['player', 'operator'],
      defaultPermission: null,
      online: [...inst.players.values()],
      ...lists,
      whitelistEnabled: props.get('white-list') === 'true',
      seen,
      running: inst.state === 'running',
    };
  }
  const al = await readJson<any[]>(path.join(root, 'allowlist.json'), []);
  const perms = await readJson<any[]>(path.join(root, 'permissions.json'), []);
  const nameOfAny = (id?: string) => (id ? [...inst.seen.values()].find((x) => x.id === id)?.name : undefined) || nameOf(id);
  const lists = {
    whitelist: al.map((a) => ({ name: a.name, id: a.xuid })),
    ops: perms.filter((p) => p.permission === 'operator').map((p) => ({ name: nameOfAny(p.xuid) || p.xuid, id: p.xuid, permission: p.permission })),
    banned: [...inst.blocked.values()].map((b) => ({ name: b.name, id: b.id, reason: b.reason })),
  };
  const permById = new Map<string, string>(perms.filter((p) => p.xuid).map((p) => [String(p.xuid), String(p.permission)]));
  return {
    roster: buildRoster(inst, lists, permById),
    permissionLevels: ['visitor', 'member', 'operator'],
    defaultPermission: props.get('default-player-permission-level') || 'member',
    online: [...inst.players.values()],
    ...lists,
    whitelistEnabled: props.get('allow-list') === 'true',
    seen,
    running: inst.state === 'running',
  };
}

export type PlayerAction = 'whitelist-add' | 'whitelist-remove' | 'whitelist-on' | 'whitelist-off' | 'op' | 'deop' | 'kick' | 'ban' | 'pardon' | 'block' | 'unblock' | 'permission';

const q = (name: string) => (/\s/.test(name) ? `"${name}"` : name);

/** Bedrock: set visitor / member / operator in permissions.json and reload it live. Needs the player's XUID. */
async function setBedrockPermission(inst: ServerInstance, name: string, level: string): Promise<{ message: string }> {
  if (!['visitor', 'member', 'operator', 'default'].includes(level)) throw bad('Permission must be visitor, member, operator or default');
  const running = inst.state === 'running';
  const xuid = xuidFor(inst, name) || inst.players.get(name.toLowerCase())?.id;
  if (!xuid) {
    if (running && level === 'operator') {
      inst.send(`op ${q(name)}`);
      return { message: 'Op command sent. Bedrock only knows players who are online or have joined before.' };
    }
    throw bad(`${name} has not joined this server yet, so their Xbox ID is unknown. Ask them to join once first.`);
  }
  const f = path.join(inst.root, 'permissions.json');
  const list = (await readJson<any[]>(f, [])).filter((x) => x.xuid !== xuid);
  if (level !== 'default') list.push({ permission: level, xuid });
  await writeJson(f, list);
  if (running) {
    inst.send('permission reload');
    // Online players only pick up the change through op/deop.
    if (inst.players.has(name.toLowerCase())) inst.send(level === 'operator' ? `op ${q(name)}` : `deop ${q(name)}`);
  }
  return { message: level === 'default' ? `${name} now uses the default permission` : `${name} is now ${level === 'operator' ? 'an operator' : `a ${level}`}` };
}

export async function playerAction(inst: ServerInstance, action: PlayerAction, name: string, reason?: string, level?: string): Promise<{ message: string }> {
  name = (name || '').trim();
  const running = inst.state === 'running';
  const java = inst.rec.edition === 'java';

  // Edition-neutral aliases used by the roster UI.
  if (action === 'permission') {
    if (!name) throw bad('Player name is required');
    if (!java) return setBedrockPermission(inst, name, String(level || ''));
    if (level !== 'operator' && level !== 'player') throw bad('Permission must be operator or player');
    action = level === 'operator' ? 'op' : 'deop';
  }
  if (action === 'block' || action === 'unblock') {
    if (!name) throw bad('Player name is required');
    if (java) action = action === 'block' ? 'ban' : 'pardon';
    else {
      const key = name.toLowerCase();
      if (action === 'block') {
        inst.blocked.set(key, { name, id: xuidFor(inst, name) || inst.players.get(key)?.id, reason: (reason || '').slice(0, 120) || undefined, at: new Date().toISOString() });
        await inst.saveBlocked();
        if (running && inst.players.has(key)) inst.send(`kick ${q(name)} ${reason || 'You are blocked from this server'}`);
        return { message: `${name} is blocked and will be removed whenever they join` };
      }
      inst.blocked.delete(key);
      await inst.saveBlocked();
      return { message: `${name} is no longer blocked` };
    }
  }
  if (!['whitelist-on', 'whitelist-off'].includes(action) && !name) throw bad('Player name is required');
  if (name.length > 32 || /[\r\n]/.test(name)) throw bad('Invalid player name');

  if (action === 'whitelist-on' || action === 'whitelist-off') {
    const on = action === 'whitelist-on';
    const pf = await PropertiesFile.load(path.join(inst.root, 'server.properties'));
    pf.set(java ? 'white-list' : 'allow-list', on);
    await pf.save();
    if (running) {
      if (java) inst.send(on ? 'whitelist on' : 'whitelist off');
      else inst.send(on ? 'allowlist on' : 'allowlist off');
    }
    return { message: `${java ? 'Whitelist' : 'Allowlist'} ${on ? 'enabled' : 'disabled'}${!running || !java ? ' (applies on restart for Bedrock)' : ''}` };
  }

  if (running) {
    const cmd: Record<PlayerAction, string | null> = java
      ? {
          'whitelist-add': `whitelist add ${name}`,
          'whitelist-remove': `whitelist remove ${name}`,
          op: `op ${name}`,
          deop: `deop ${name}`,
          kick: `kick ${name}${reason ? ' ' + reason : ''}`,
          ban: `ban ${name}${reason ? ' ' + reason : ''}`,
          pardon: `pardon ${name}`,
          'whitelist-on': null,
          'whitelist-off': null,
          block: null,
          unblock: null,
          permission: null,
        }
      : {
          'whitelist-add': `allowlist add ${q(name)}`,
          'whitelist-remove': `allowlist remove ${q(name)}`,
          op: `op ${q(name)}`,
          deop: `deop ${q(name)}`,
          kick: `kick ${q(name)}${reason ? ' ' + reason : ''}`,
          ban: null,
          pardon: null,
          'whitelist-on': null,
          'whitelist-off': null,
          block: null,
          unblock: null,
          permission: null,
        };
    const c = cmd[action];
    if (!c) throw bad(`${action} is not supported on ${java ? 'Java' : 'Bedrock'}`);
    inst.send(c);
    if (!java && action === 'op' && !xuidFor(inst, name)) {
      return { message: 'Command sent. Bedrock can only op players who are online or have joined before.' };
    }
    return { message: `Sent: ${c}` };
  }

  // Offline: edit the JSON files directly
  const root = inst.root;
  if (java) {
    switch (action) {
      case 'whitelist-add': {
        const uuid = await resolveJavaUuid(inst, name);
        const f = path.join(root, 'whitelist.json');
        const list = await readJson<any[]>(f, []);
        if (!list.some((x) => x.name?.toLowerCase() === name.toLowerCase())) list.push({ uuid, name });
        await writeJson(f, list);
        return { message: `${name} added to whitelist` };
      }
      case 'whitelist-remove': {
        const f = path.join(root, 'whitelist.json');
        await writeJson(f, (await readJson<any[]>(f, [])).filter((x) => x.name?.toLowerCase() !== name.toLowerCase()));
        return { message: `${name} removed from whitelist` };
      }
      case 'op': {
        const uuid = await resolveJavaUuid(inst, name);
        const f = path.join(root, 'ops.json');
        const list = await readJson<any[]>(f, []);
        if (!list.some((x) => x.name?.toLowerCase() === name.toLowerCase())) list.push({ uuid, name, level: 4, bypassesPlayerLimit: false });
        await writeJson(f, list);
        return { message: `${name} is now an operator` };
      }
      case 'deop': {
        const f = path.join(root, 'ops.json');
        await writeJson(f, (await readJson<any[]>(f, [])).filter((x) => x.name?.toLowerCase() !== name.toLowerCase()));
        return { message: `${name} is no longer an operator` };
      }
      case 'ban': {
        const uuid = await resolveJavaUuid(inst, name);
        const f = path.join(root, 'banned-players.json');
        const list = await readJson<any[]>(f, []);
        if (!list.some((x) => x.name?.toLowerCase() === name.toLowerCase()))
          list.push({ uuid, name, created: new Date().toISOString().replace('T', ' ').slice(0, 19) + ' +0000', source: 'Blockhost', expires: 'forever', reason: reason || 'Banned by an operator.' });
        await writeJson(f, list);
        return { message: `${name} banned` };
      }
      case 'pardon': {
        const f = path.join(root, 'banned-players.json');
        await writeJson(f, (await readJson<any[]>(f, [])).filter((x) => x.name?.toLowerCase() !== name.toLowerCase()));
        return { message: `${name} pardoned` };
      }
      case 'kick':
        throw bad('Server is not running');
    }
  } else {
    switch (action) {
      case 'whitelist-add': {
        const f = path.join(root, 'allowlist.json');
        const list = await readJson<any[]>(f, []);
        if (!list.some((x) => x.name?.toLowerCase() === name.toLowerCase())) {
          const entry: any = { ignoresPlayerLimit: false, name };
          const xuid = xuidFor(inst, name);
          if (xuid) entry.xuid = xuid;
          list.push(entry);
        }
        await writeJson(f, list);
        return { message: `${name} added to allowlist` };
      }
      case 'whitelist-remove': {
        const f = path.join(root, 'allowlist.json');
        await writeJson(f, (await readJson<any[]>(f, [])).filter((x) => x.name?.toLowerCase() !== name.toLowerCase()));
        return { message: `${name} removed from allowlist` };
      }
      case 'op': {
        const xuid = xuidFor(inst, name);
        if (!xuid) throw bad(`Unknown XUID for ${name}. The player must join once (or op them while the server is running).`);
        const f = path.join(root, 'permissions.json');
        const list = (await readJson<any[]>(f, [])).filter((x) => x.xuid !== xuid);
        list.push({ permission: 'operator', xuid });
        await writeJson(f, list);
        return { message: `${name} is now an operator` };
      }
      case 'deop': {
        const xuid = xuidFor(inst, name) || name;
        const f = path.join(root, 'permissions.json');
        await writeJson(f, (await readJson<any[]>(f, [])).filter((x) => x.xuid !== xuid));
        return { message: `${name} is no longer an operator` };
      }
      default:
        throw bad(`${action} requires a running server on Bedrock`);
    }
  }
  throw bad('Unsupported action');
}
