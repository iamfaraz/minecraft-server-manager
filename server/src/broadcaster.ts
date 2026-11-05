import { spawn, type ChildProcess } from 'node:child_process';
import fsp from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { config } from './config.js';
import { bus } from './events.js';
import { downloadTo, exists, rmrf, stripAnsi, PropertiesFile, HttpError } from './util.js';
import { ensureJava } from './versions/runtime.js';
import type { ServerInstance } from './servers/instance.js';
import type { ServerRecord } from './servers/types.js';

/**
 * Xbox Live broadcasting for console players (Switch / Xbox / PlayStation), powered by
 * MCXboxBroadcast (https://github.com/MCXboxBroadcast/Broadcaster, GPL-3.0, run as a separate process).
 *
 * Consoles cannot type a server address. The broadcaster signs in to a spare Microsoft account and advertises
 * the server as that account's joinable session; friends of the account see it in the Friends tab. Joins are
 * relayed to the server's NetherNet signaling, so the server must use transport=nethernet.
 */
const MCXB_VERSION = process.env.MCSM_MCXB_VERSION || '162';
const CONFIG_VERSION = 9;
const BUNDLED_JAR = '/opt/mcxboxbroadcast/MCXboxBroadcastStandalone.jar';

export type BroadcastState = 'off' | 'waiting' | 'installing' | 'starting' | 'auth' | 'online' | 'error';

export interface BroadcastStatus {
  enabled: boolean;
  state: BroadcastState;
  supported: boolean;
  reason: string | null;
  authUrl: string | null;
  authCode: string | null;
  gamertag: string | null;
  signedIn: boolean;
  error: string | null;
  warning: string | null;
  version: string;
  log: string[];
}

interface Running {
  proc: ChildProcess | null;
  state: BroadcastState;
  authUrl: string | null;
  authCode: string | null;
  gamertag: string | null;
  error: string | null;
  warning: string | null;
  log: string[];
  stopping: boolean;
  restartTimer: NodeJS.Timeout | null;
}

const fresh = (): Running => ({ proc: null, state: 'off', authUrl: null, authCode: null, gamertag: null, error: null, warning: null, log: [], stopping: false, restartTimer: null });
const yamlStr = (s: string) => `'${s.replace(/'/g, "''")}'`;

class BroadcasterService {
  private items = new Map<string, Running>();
  private lookup: ((id: string) => ServerInstance | undefined) | null = null;

  dir(id: string) {
    return path.join(config.serversDir, id, 'broadcaster');
  }

  /** Wire into server lifecycle: start with the server, stop with it. */
  init(lookup: (id: string) => ServerInstance | undefined, all: () => ServerInstance[]) {
    this.lookup = lookup;
    bus.on('event', (ev: any) => {
      if (ev.type !== 'server.state') return;
      const inst = lookup(ev.id);
      if (!inst?.rec.broadcast?.enabled) return;
      if (ev.state === 'running') this.start(inst).catch(() => {});
      else if (['stopping', 'stopped', 'crashed', 'error'].includes(ev.state)) this.stop(ev.id, 'waiting').catch(() => {});
    });
    for (const inst of all()) if (inst.rec.broadcast?.enabled && inst.state === 'running') this.start(inst).catch(() => {});
  }

  supported(rec: ServerRecord): { ok: boolean; reason: string | null } {
    if (rec.edition !== 'bedrock') return { ok: false, reason: 'Console broadcasting is available for Bedrock servers.' };
    if (rec.transport !== 'nethernet') return { ok: false, reason: 'Requires the NetherNet transport (consoles join over WebRTC).' };
    return { ok: true, reason: null };
  }

  private item(id: string): Running {
    let r = this.items.get(id);
    if (!r) {
      r = fresh();
      this.items.set(id, r);
    }
    return r;
  }

  private publish(id: string) {
    const inst = this.lookup?.(id);
    if (inst) this.status(inst).then((status) => bus.publish({ type: 'broadcast', id, status } as any)).catch(() => {});
  }

  private push(id: string, line: string) {
    const r = this.item(id);
    r.log.push(line);
    if (r.log.length > 150) r.log.splice(0, r.log.length - 150);
  }

  async signedIn(id: string): Promise<boolean> {
    try {
      const entries = await fsp.readdir(path.join(this.dir(id), 'cache'));
      return entries.some((e) => e.endsWith('.json'));
    } catch {
      return false;
    }
  }

  async status(inst: ServerInstance): Promise<BroadcastStatus> {
    const r = this.item(inst.id);
    const sup = this.supported(inst.rec);
    const enabled = !!inst.rec.broadcast?.enabled;
    let state = r.state;
    if (!enabled) state = 'off';
    else if (!r.proc && state !== 'error' && state !== 'installing') state = 'waiting';
    return {
      enabled,
      state,
      supported: sup.ok,
      reason: sup.reason,
      authUrl: r.authUrl,
      authCode: r.authCode,
      gamertag: r.gamertag,
      signedIn: await this.signedIn(inst.id),
      error: r.error,
      warning: r.warning,
      version: MCXB_VERSION,
      log: r.log.slice(-80),
    };
  }

  private async ensureJar(id: string): Promise<string> {
    if (await exists(BUNDLED_JAR)) return BUNDLED_JAR;
    const local = path.join(config.runtimesDir, 'mcxboxbroadcast', MCXB_VERSION, 'MCXboxBroadcastStandalone.jar');
    if (await exists(local)) return local;
    const r = this.item(id);
    r.state = 'installing';
    this.publish(id);
    this.push(id, `[Blockhost] Downloading MCXboxBroadcast ${MCXB_VERSION}`);
    await downloadTo(`https://github.com/MCXboxBroadcast/Broadcaster/releases/download/${MCXB_VERSION}/MCXboxBroadcastStandalone.jar`, local);
    return local;
  }

  /** Create or patch config.yml so joins are relayed to this server. */
  private async writeConfig(inst: ServerInstance): Promise<void> {
    const dir = this.dir(inst.id);
    await fsp.mkdir(dir, { recursive: true });
    const file = path.join(dir, 'config.yml');
    const props = await PropertiesFile.load(path.join(inst.root, 'server.properties'));
    const hostName = props.get('server-name') || inst.rec.name;
    const maxPlayers = Number(props.get('max-players')) || 10;
    const gm = (props.get('gamemode') || 'survival').toLowerCase();
    const gameMode = gm === 'creative' ? 'Creative' : gm === 'adventure' ? 'Adventure' : 'Survival';
    if (await exists(file)) {
      let raw = await fsp.readFile(file, 'utf8');
      raw = raw
        .replace(/^(\s*remote-address:).*$/m, `$1 127.0.0.1`)
        .replace(/^(\s*remote-port:).*$/m, `$1 '${inst.rec.port}'`)
        .replace(/^(\s*host-name:).*$/m, `$1 ${yamlStr(hostName)}`)
        .replace(/^(\s*world-name:).*$/m, `$1 ${yamlStr(inst.rec.levelName)}`)
        .replace(/^(\s*max-players:).*$/m, `$1 ${maxPlayers}`)
        .replace(/^(\s*game-mode:).*$/m, `$1 ${gameMode}`);
      await fsp.writeFile(file, raw);
      return;
    }
    const yml = `# Managed by Blockhost. remote-address/port and session-info are rewritten on every start.
session:
  remote-address: 127.0.0.1
  remote-port: '${inst.rec.port}'
  update-interval: 30
  query-server: true
  config-fallback: true
  session-info:
    host-name: ${yamlStr(hostName)}
    world-name: ${yamlStr(inst.rec.levelName)}
    game-mode: ${gameMode}
    players: 0
    max-players: ${maxPlayers}
  hide-old-sessions: true
  allow-ipv6: false
friend-sync:
  update-interval: 60
  auto-friend: true
  initial-invite: true
  expiry:
    enabled: true
    days: 15
    check: 1800
notifications:
  enabled: false
  webhook-url: ''
debug-mode: false
suppress-session-update-message: true
config-version: ${CONFIG_VERSION}
`;
    await fsp.writeFile(file, yml);
  }

  async start(inst: ServerInstance): Promise<void> {
    const id = inst.id;
    const r = this.item(id);
    if (r.proc) return;
    const sup = this.supported(inst.rec);
    if (!sup.ok) {
      r.state = 'error';
      r.error = sup.reason;
      this.publish(id);
      return;
    }
    if (r.restartTimer) {
      clearTimeout(r.restartTimer);
      r.restartTimer = null;
    }
    r.error = null;
    r.warning = null;
    r.stopping = false;
    try {
      const jar = await this.ensureJar(id);
      const java = await ensureJava(21);
      await this.writeConfig(inst);
      r.state = 'starting';
      this.publish(id);
      this.push(id, `[Blockhost] Starting MCXboxBroadcast ${MCXB_VERSION} → 127.0.0.1:${inst.rec.port}`);
      const proc = spawn(java.path, ['-Xmx256M', '-jar', jar], { cwd: this.dir(id), env: { ...process.env, NO_COLOR: '1', TERM: 'dumb' }, stdio: ['pipe', 'pipe', 'pipe'] });
      r.proc = proc;
      let skipping = 0;
      const onLine = (raw: string) => {
        const line = stripAnsi(raw).replace(/\[m/g, '').trimEnd();
        if (!line.trim()) return;
        // Collapse Java stack traces to keep the log readable
        if (/^\s+at |^Caused by:|^\s*\.\.\. \d+ more/.test(line)) {
          if (skipping++ > 0) return;
        } else skipping = 0;
        if (/sun\.misc\.Unsafe|StatusConsoleListener|Please consider reporting/.test(line)) return;
        this.push(id, line.replace(/(enter the code )\S+/, '$1········'));
        let m: RegExpExecArray | null;
        if ((m = /open the page (\S+) and enter the code (\S+) to authenticate/.exec(line))) {
          r.authUrl = m[1];
          r.authCode = m[2];
          r.state = 'auth';
          this.publish(id);
        } else if ((m = /Successfully authenticated as (.+)$/.exec(line))) {
          r.gamertag = m[1].trim();
          r.authUrl = r.authCode = null;
          this.publish(id);
        } else if (/Creation of Xbox LIVE session was successful/.test(line)) {
          r.state = 'online';
          r.error = null;
          this.publish(id);
          inst.pushLog(`[Blockhost] Console broadcast is live${r.gamertag ? ` as "${r.gamertag}"` : ''}. Console players: add that account as a friend and join from the Friends tab.`);
        } else if (/Failed to ping server/.test(line)) {
          r.warning = 'The broadcaster could not reach the server over NetherNet yet.';
          this.publish(id);
        } else if (/age verification/i.test(line)) {
          r.error = 'The Microsoft account needs age verification. Sign in at xbox.com once, then restart the broadcast.';
          this.publish(id);
        } else if (/Failed to (get\/refresh auth token|create session|start NetherNet signaling)|Session is dead/.test(line)) {
          r.warning = line.replace(/^\[[^\]]*\]\s*/, '').slice(0, 200);
          this.publish(id);
        } else if (/Updated session|Got update session response/.test(line) && r.state === 'starting') {
          r.state = 'online';
          this.publish(id);
        }
      };
      for (const s of [proc.stdout!, proc.stderr!]) readline.createInterface({ input: s, crlfDelay: Infinity }).on('line', onLine);
      proc.on('error', (e) => {
        r.proc = null;
        r.state = 'error';
        r.error = `Could not start the broadcaster: ${e.message}`;
        this.publish(id);
      });
      proc.on('exit', (code) => {
        if (r.proc === proc) r.proc = null;
        this.push(id, `[Blockhost] Broadcaster exited (code ${code})`);
        if (r.stopping) return;
        const cur = this.lookup?.(id);
        if (!cur?.rec.broadcast?.enabled || cur.state !== 'running') {
          r.state = 'waiting';
          this.publish(id);
          return;
        }
        r.state = 'error';
        r.error = `Broadcaster exited with code ${code}; retrying in 30s`;
        this.publish(id);
        r.restartTimer = setTimeout(() => {
          r.restartTimer = null;
          const again = this.lookup?.(id);
          if (again?.rec.broadcast?.enabled && again.state === 'running') this.start(again).catch(() => {});
        }, 30_000);
      });
    } catch (e) {
      r.state = 'error';
      r.error = (e as Error).message;
      this.publish(id);
    }
  }

  async stop(id: string, next: BroadcastState = 'off'): Promise<void> {
    const r = this.item(id);
    if (r.restartTimer) {
      clearTimeout(r.restartTimer);
      r.restartTimer = null;
    }
    const p = r.proc;
    r.stopping = true;
    r.proc = null;
    r.state = next;
    r.authUrl = r.authCode = null;
    this.publish(id);
    if (p && p.exitCode === null) {
      const exited = new Promise<void>((res) => p.once('exit', () => res()));
      const wait = (ms: number) => Promise.race([exited.then(() => true), new Promise<boolean>((res) => setTimeout(() => res(false), ms))]);
      try {
        p.stdin?.write('exit\n'); // lets it close the Xbox Live session cleanly
      } catch {
        /* ignore */
      }
      if (!(await wait(2500))) {
        p.kill('SIGTERM');
        if (!(await wait(2000))) {
          p.kill('SIGKILL');
          await exited;
        }
      }
    }
  }

  async restart(inst: ServerInstance): Promise<void> {
    await this.stop(inst.id, 'waiting');
    if (inst.rec.broadcast?.enabled && inst.state === 'running') await this.start(inst);
  }

  /** Forget the Microsoft account (delete cached tokens) so a new sign-in is requested. */
  async signOut(inst: ServerInstance): Promise<void> {
    await this.stop(inst.id, 'waiting');
    await rmrf(path.join(this.dir(inst.id), 'cache'));
    const r = this.item(inst.id);
    r.gamertag = null;
    if (inst.rec.broadcast?.enabled && inst.state === 'running') await this.start(inst);
    else this.publish(inst.id);
  }

  async setEnabled(inst: ServerInstance, enabled: boolean): Promise<void> {
    if (enabled) {
      const sup = this.supported(inst.rec);
      if (!sup.ok) throw new HttpError(409, sup.reason || 'Not supported');
    }
    inst.rec.broadcast = { ...(inst.rec.broadcast || {}), enabled };
    await inst.save();
    if (enabled && inst.state === 'running') await this.start(inst);
    if (!enabled) await this.stop(inst.id, 'off');
    this.publish(inst.id);
  }

  async shutdown(): Promise<void> {
    await Promise.all([...this.items.keys()].map((id) => this.stop(id, 'off')));
  }
}

export const broadcaster = new BroadcasterService();
