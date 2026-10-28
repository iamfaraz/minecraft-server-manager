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

export interface PlayersView {
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

async function resolveJavaUuid(inst: ServerInstance, name: string): Promise<string> {
  const seen = inst.seen.get(name.toLowerCase());
  if (seen?.id) return seen.id;
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

export async function getPlayers(inst: ServerInstance): Promise<PlayersView> {
  const root = inst.root;
  const props = await PropertiesFile.load(path.join(root, 'server.properties'));
  const seen = [...inst.seen.values()].sort((a, b) => b.lastSeen.localeCompare(a.lastSeen)).slice(0, 50);
  const nameOf = (id?: string) => (id ? seen.find((s) => s.id === id)?.name : undefined);
  if (inst.rec.edition === 'java') {
    const wl = await readJson<any[]>(path.join(root, 'whitelist.json'), []);
    const ops = await readJson<any[]>(path.join(root, 'ops.json'), []);
    const banned = await readJson<any[]>(path.join(root, 'banned-players.json'), []);
    return {
      online: [...inst.players.values()],
      whitelist: wl.map((w) => ({ name: w.name, id: w.uuid })),
      whitelistEnabled: props.get('white-list') === 'true',
      ops: ops.map((o) => ({ name: o.name, id: o.uuid, level: o.level })),
      banned: banned.map((b) => ({ name: b.name, id: b.uuid, reason: b.reason })),
      seen,
      running: inst.state === 'running',
    };
  }
  const al = await readJson<any[]>(path.join(root, 'allowlist.json'), []);
  const perms = await readJson<any[]>(path.join(root, 'permissions.json'), []);
  return {
    online: [...inst.players.values()],
    whitelist: al.map((a) => ({ name: a.name, id: a.xuid })),
    whitelistEnabled: props.get('allow-list') === 'true',
    ops: perms.filter((p) => p.permission === 'operator').map((p) => ({ name: nameOf(p.xuid) || p.xuid, id: p.xuid, permission: p.permission })),
    banned: [],
    seen,
    running: inst.state === 'running',
  };
}

export type PlayerAction = 'whitelist-add' | 'whitelist-remove' | 'whitelist-on' | 'whitelist-off' | 'op' | 'deop' | 'kick' | 'ban' | 'pardon';

const q = (name: string) => (/\s/.test(name) ? `"${name}"` : name);

export async function playerAction(inst: ServerInstance, action: PlayerAction, name: string, reason?: string): Promise<{ message: string }> {
  name = (name || '').trim();
  const running = inst.state === 'running';
  const java = inst.rec.edition === 'java';
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
