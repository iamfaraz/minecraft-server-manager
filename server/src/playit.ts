import { spawn, type ChildProcess } from 'node:child_process';
import fsp from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { config } from './config.js';
import { bus } from './events.js';
import { getAppConfig, saveAppConfig } from './store.js';
import { downloadTo, exists, stripAnsi, which, HttpError } from './util.js';
import type { ServerRecord } from './servers/types.js';

export type PlayitState = 'disabled' | 'installing' | 'starting' | 'claiming' | 'running' | 'stopped' | 'error';

export interface PlayitTunnel {
  id: string;
  name: string;
  tunnelType: string | null;
  portType: string;
  localPort: number | null;
  localIp: string | null;
  address: string | null;
  active: boolean;
  disabledReason?: string | null;
}

export interface PlayitStatus {
  state: PlayitState;
  enabled: boolean;
  claimed: boolean;
  claimUrl: string | null;
  binary: string | null;
  error: string | null;
  tunnels: PlayitTunnel[];
  tunnelsError: string | null;
  log: string[];
  startedAt: string | null;
}

const API = 'https://api.playit.gg';
/** Pinned agent release (single-binary CLI with `start` + claim link). Must match PLAYIT_VERSION in the Dockerfile. */
const PLAYIT_VERSION = process.env.MCSM_PLAYIT_VERSION || 'v0.15.26';

class PlayitService {
  private proc: ChildProcess | null = null;
  private state: PlayitState = 'disabled';
  private claimUrl: string | null = null;
  private error: string | null = null;
  private log: string[] = [];
  private binary: string | null = null;
  private tunnels: PlayitTunnel[] = [];
  private tunnelsError: string | null = null;
  private tunnelsAt = 0;
  private startedAt: Date | null = null;
  private stopping = false;
  private restartTimer: NodeJS.Timeout | null = null;
  private tunnelTimer: NodeJS.Timeout | null = null;

  get secretPath() {
    return path.join(config.playitDir, 'playit.toml');
  }

  async init() {
    if (getAppConfig().playit.enabled) this.start().catch((e) => this.fail(e.message));
    this.tunnelTimer = setInterval(() => {
      if (this.state === 'running') this.refreshTunnels().catch(() => {});
    }, 60_000);
  }

  private pushLog(l: string) {
    this.log.push(l);
    if (this.log.length > 200) this.log.splice(0, this.log.length - 200);
  }

  private setState(s: PlayitState) {
    this.state = s;
    bus.publish({ type: 'playit', status: this.status() });
  }

  private fail(msg: string) {
    this.error = msg;
    this.pushLog(`[Blockhost] ${msg}`);
    this.setState('error');
  }

  async isClaimed(): Promise<boolean> {
    try {
      const raw = await fsp.readFile(this.secretPath, 'utf8');
      return /secret_key\s*=\s*"[^"]{10,}"/.test(raw) || raw.trim().length > 20;
    } catch {
      return false;
    }
  }

  private async readSecret(): Promise<string | null> {
    try {
      const raw = await fsp.readFile(this.secretPath, 'utf8');
      const m = /secret_key\s*=\s*"([^"]+)"/.exec(raw);
      if (m) return m[1];
      const t = raw.trim();
      return /^[A-Za-z0-9]{20,}$/.test(t) ? t : null;
    } catch {
      return null;
    }
  }

  status(): PlayitStatus {
    return {
      state: this.state,
      enabled: getAppConfig().playit.enabled,
      claimed: this.state === 'running',
      claimUrl: this.claimUrl,
      binary: this.binary,
      error: this.error,
      tunnels: this.tunnels,
      tunnelsError: this.tunnelsError,
      log: this.log.slice(-60),
      startedAt: this.startedAt?.toISOString() ?? null,
    };
  }

  private async ensureBinary(): Promise<string> {
    if (config.playitBin && (await exists(config.playitBin))) return config.playitBin;
    const sys = await which('playit');
    if (sys) return sys;
    const local = path.join(config.runtimesDir, 'playit', 'playit');
    if (await exists(local)) return local;
    this.setState('installing');
    this.pushLog('[Blockhost] Downloading playit agent');
    const os = config.platform === 'darwin' ? 'darwin' : 'linux';
    const arch = config.arch === 'arm64' ? (os === 'darwin' ? 'arm64' : 'aarch64') : 'amd64';
    const url = `https://github.com/playit-cloud/playit-agent/releases/download/${PLAYIT_VERSION}/playit-${os}-${arch}`;
    await downloadTo(url, local, (_p, m) => this.pushLog(`[Blockhost] ${m}`));
    await fsp.chmod(local, 0o755);
    return local;
  }

  async enable() {
    getAppConfig().playit.enabled = true;
    await saveAppConfig();
    await this.start();
  }

  async disable() {
    getAppConfig().playit.enabled = false;
    await saveAppConfig();
    await this.stop();
    this.setState('disabled');
  }

  /** Forget the agent secret so a fresh claim happens on next start. */
  async reset() {
    await this.stop();
    await fsp.rm(this.secretPath, { force: true });
    this.tunnels = [];
    this.claimUrl = null;
    if (getAppConfig().playit.enabled) await this.start();
    else this.setState('disabled');
  }

  async start() {
    if (this.proc) return;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    this.error = null;
    this.stopping = false;
    try {
      this.binary = await this.ensureBinary();
    } catch (e) {
      return this.fail(`Could not install playit agent: ${(e as Error).message}`);
    }
    await fsp.mkdir(config.playitDir, { recursive: true });
    const claimed = await this.isClaimed();
    this.setState(claimed ? 'starting' : 'claiming');
    const args = config.playitArgs
      ? config.playitArgs.split(/\s+/).filter(Boolean)
      : ['--stdout', '--secret_path', this.secretPath, ...(config.inDocker ? ['--platform_docker'] : []), 'start'];
    this.pushLog(`[Blockhost] $ ${path.basename(this.binary)} ${args.join(' ')}`);
    const proc = spawn(this.binary, args, { cwd: config.playitDir, env: { ...process.env, NO_COLOR: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
    this.proc = proc;
    this.startedAt = new Date();
    const onLine = (raw: string) => {
      const line = stripAnsi(raw).trim();
      if (!line) return;
      this.pushLog(line);
      const claim = /https:\/\/playit\.gg\/claim\/[A-Za-z0-9_-]+/.exec(line);
      if (claim) {
        this.claimUrl = claim[0];
        this.setState('claiming');
      }
      if (/agent (is )?running|tunnel(s)? (running|connected)|Connected|control channel|Setup done|agent connected|authenticated/i.test(line) && this.state !== 'running') {
        this.isClaimed().then((ok) => {
          if (ok) {
            this.claimUrl = null;
            this.setState('running');
            this.refreshTunnels().catch(() => {});
          }
        });
      }
      if (/error|failed|invalid/i.test(line) && !/retry/i.test(line)) bus.publish({ type: 'playit', status: this.status() });
    };
    for (const s of [proc.stdout!, proc.stderr!]) readline.createInterface({ input: s, crlfDelay: Infinity }).on('line', onLine);
    proc.on('error', (e) => this.fail(`playit failed to start: ${e.message}`));
    proc.on('exit', (code) => {
      this.proc = null;
      this.pushLog(`[Blockhost] playit exited (code ${code})`);
      if (this.stopping) return this.setState('stopped');
      if (!getAppConfig().playit.enabled) return this.setState('disabled');
      this.setState('error');
      this.error = `Agent exited with code ${code}; restarting in 15s`;
      this.restartTimer = setTimeout(() => this.start().catch(() => {}), 15_000);
    });
    // The agent prints little when the secret is valid; probe the API to flip to running.
    setTimeout(() => {
      if (this.proc && this.state === 'starting') {
        this.isClaimed().then((ok) => {
          if (ok) {
            this.setState('running');
            this.refreshTunnels().catch(() => {});
          }
        });
      }
    }, 4000);
  }

  async stop() {
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    const p = this.proc;
    if (!p) return;
    this.stopping = true;
    const exited = new Promise<void>((r) => p.once('exit', () => r()));
    p.kill('SIGTERM');
    await Promise.race([exited, new Promise((r) => setTimeout(r, 8000))]);
    if (this.proc) p.kill('SIGKILL');
    this.proc = null;
  }

  private async api<T>(endpoint: string, body: unknown): Promise<T> {
    const secret = await this.readSecret();
    if (!secret) throw new HttpError(409, 'playit agent is not claimed yet');
    const res = await fetch(`${API}${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `agent-key ${secret}` },
      body: JSON.stringify(body ?? {}),
    });
    const text = await res.text();
    let json: any;
    try {
      json = JSON.parse(text);
    } catch {
      throw new HttpError(502, `playit API returned ${res.status}`);
    }
    if (!res.ok || json.status === 'error') {
      const msg = json?.data?.message || json?.data?.type || json?.message || JSON.stringify(json?.data || json).slice(0, 200);
      throw new HttpError(502, `playit API: ${msg}`);
    }
    return (json.data ?? json) as T;
  }

  private mapTunnel(t: any): PlayitTunnel {
    const alloc = t.alloc?.data ?? t.alloc ?? {};
    const origin = t.origin?.data ?? t.origin ?? {};
    const domain: string | undefined = alloc.assigned_domain || alloc.ip_hostname;
    const port: number | undefined = alloc.port_start ?? alloc.port;
    let address: string | null = null;
    if (domain) {
      const type = t.tunnel_type || '';
      const defaultPort = type === 'minecraft-java' ? 25565 : type === 'minecraft-bedrock' ? 19132 : null;
      address = port && port !== defaultPort ? `${domain}:${port}` : domain;
    }
    return {
      id: t.id,
      name: t.name || '',
      tunnelType: t.tunnel_type ?? null,
      portType: t.port_type || 'tcp',
      localPort: origin.local_port ?? null,
      localIp: origin.local_ip ?? null,
      address,
      active: !!t.active && !t.disabled_reason,
      disabledReason: t.disabled_reason ?? null,
    };
  }

  async refreshTunnels(force = false): Promise<PlayitTunnel[]> {
    if (!force && Date.now() - this.tunnelsAt < 20_000) return this.tunnels;
    try {
      const d = await this.api<any>('/tunnels/list', {});
      const list: any[] = d?.tunnels || [];
      this.tunnels = list.map((t) => this.mapTunnel(t));
      this.tunnelsError = null;
    } catch (e) {
      this.tunnelsError = (e as Error).message;
    }
    this.tunnelsAt = Date.now();
    bus.publish({ type: 'playit', status: this.status() });
    return this.tunnels;
  }

  tunnelsForPort(port: number, udp: boolean): string[] {
    return this.tunnels
      .filter((t) => t.localPort === port && t.address && (udp ? t.portType !== 'tcp' : t.portType !== 'udp'))
      .map((t) => t.address!);
  }

  async createTunnel(rec: ServerRecord, kind: 'game' | 'geyser' = 'game'): Promise<PlayitTunnel> {
    if (this.state !== 'running') throw new HttpError(409, 'playit agent is not running');
    const bedrockLike = rec.edition === 'bedrock' || kind === 'geyser';
    const localPort = kind === 'geyser' ? rec.geyserPort! : rec.port;
    const body = {
      name: `${rec.name}${kind === 'geyser' ? ' (Geyser)' : ''}`.slice(0, 40),
      tunnel_type: bedrockLike ? 'minecraft-bedrock' : 'minecraft-java',
      port_type: bedrockLike ? 'udp' : 'tcp',
      port_count: 1,
      origin: { type: 'default', data: { local_ip: '127.0.0.1', local_port: localPort } },
      enabled: true,
    };
    const d = await this.api<any>('/tunnels/create', body);
    await this.refreshTunnels(true);
    const id = d?.id ?? d?.tunnel_id ?? d;
    return this.tunnels.find((t) => t.id === id) || { id: String(id), name: body.name, tunnelType: body.tunnel_type, portType: body.port_type, localPort, localIp: '127.0.0.1', address: null, active: true };
  }

  async deleteTunnel(id: string): Promise<void> {
    await this.api('/tunnels/delete', { tunnel_id: id });
    await this.refreshTunnels(true);
  }
}

export const playit = new PlayitService();
