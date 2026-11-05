import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import net from 'node:net';
import dgram from 'node:dgram';
import path from 'node:path';
import readline from 'node:readline';
import { config } from '../config.js';
import { bus } from '../events.js';
import { serverRoot, serverDir, serverRecordFile } from '../store.js';
import { readJson, stripAnsi, which, writeJson, HttpError } from '../util.js';
import { parseLine, type ParsedEvent } from './logparser.js';
import { lingeringTcpSockets, probeNetherNet } from './status.js';
import { HOST_MARK, bannerLines, defaultStyle, detectStyle, hostPrefix, levelFor, type HostLevel, type LogStyle } from './hostlog.js';
import type { OnlinePlayer, PingResult, ServerRecord, ServerState, ServerSummary, StatsSample } from './types.js';
import { ensureJava } from '../versions/runtime.js';
import { javaMajorFor, syncJavaProperties, geyserEnv } from '../install/java.js';
import { syncBedrockProperties, resolveAdvertiseIp } from '../install/bedrock.js';

const LOG_RING = 1000;
const HOST_TAG = '[Blockhost] ';
const STATS_RING = 180; // 15 min at 5s

export interface BlockedPlayer {
  name: string;
  id?: string;
  reason?: string;
  at: string;
}

export interface SeenPlayer {
  name: string;
  id?: string;
  ip?: string;
  lastSeen: string;
}

function aikarFlags(xmxMb: number): string[] {
  const big = xmxMb >= 12 * 1024;
  return [
    '-XX:+UseG1GC', '-XX:+ParallelRefProcEnabled', '-XX:MaxGCPauseMillis=200', '-XX:+UnlockExperimentalVMOptions',
    '-XX:+DisableExplicitGC', '-XX:+AlwaysPreTouch',
    `-XX:G1NewSizePercent=${big ? 40 : 30}`, `-XX:G1MaxNewSizePercent=${big ? 50 : 40}`, `-XX:G1HeapRegionSize=${big ? 16 : 8}M`,
    `-XX:G1ReservePercent=${big ? 15 : 20}`, '-XX:G1HeapWastePercent=5', '-XX:G1MixedGCCountTarget=4',
    `-XX:InitiatingHeapOccupancyPercent=${big ? 20 : 15}`, '-XX:G1MixedGCLiveThresholdPercent=90',
    '-XX:G1RSetUpdatingPauseTimePercent=5', '-XX:SurvivorRatio=32', '-XX:+PerfDisableSharedMem', '-XX:MaxTenuringThreshold=1',
    '-Dusing.aikars.flags=https://mcflags.emc.gs', '-Daikars.new.flags=true',
  ];
}
function zgcFlags(javaMajor: number): string[] {
  const f = ['-XX:+UseZGC', '-XX:+AlwaysPreTouch'];
  if (javaMajor >= 21 && javaMajor < 23) f.splice(1, 0, '-XX:+ZGenerational');
  return f;
}

export class ServerInstance extends EventEmitter {
  state: ServerState = 'stopped';
  proc: ChildProcess | null = null;
  startedAt: Date | null = null;
  logs: string[] = [];
  /** Log format this server prints in, learned from its own output; Blockhost's lines copy it. */
  private logStyle: LogStyle | null = null;
  private logStyleSeen = false;
  players = new Map<string, OnlinePlayer>();
  seen = new Map<string, SeenPlayer>();
  stats: StatsSample[] = [];
  ping: PingResult | null = null;
  /** Bedrock-side reachability of Geyser on a Java server (RakNet ping on the Geyser port). */
  geyserPing: PingResult | null = null;
  lastExit: ServerSummary['lastExit'] = null;
  diskBytes = 0;
  install: { pct: number | null; message: string } | null = null;
  errorDetail: string | null = null;
  remoteAddresses: string[] = [];
  private intentionalStop = false;
  private restartTimes: number[] = [];
  private restartTimer: NodeJS.Timeout | null = null;
  /** Bumped by every start and by a stop that interrupts one, so a start waiting for its port knows it was superseded. */
  private startSeq = 0;
  private netherNetRepairs = 0;
  private waiters: { pred: (ev: ParsedEvent | null, line: string) => boolean; resolve: (v: { ev: ParsedEvent | null; line: string }) => void; timer: NodeJS.Timeout }[] = [];
  private seenDirty: NodeJS.Timeout | null = null;
  private lastOom = false;
  private muted: { until: number; re: RegExp } | null = null;
  private taps = new Set<(line: string) => void>();
  /** Blockhost-managed blocklist (Bedrock has no ban command): blocked players are kicked as they join. */
  blocked = new Map<string, BlockedPlayer>();

  constructor(public rec: ServerRecord) {
    super();
  }

  get id() {
    return this.rec.id;
  }
  get root() {
    return serverRoot(this.rec.id);
  }
  get dir() {
    return serverDir(this.rec.id);
  }
  get isActive() {
    return this.state === 'starting' || this.state === 'running' || this.state === 'stopping';
  }

  async load(): Promise<void> {
    const seen = await readJson<SeenPlayer[]>(path.join(this.dir, 'players.json'), []);
    for (const s of seen) this.seen.set(s.name.toLowerCase(), s);
    const blocked = await readJson<BlockedPlayer[]>(path.join(this.dir, 'blocklist.json'), []);
    for (const b of blocked) this.blocked.set(b.name.toLowerCase(), b);
  }

  async saveBlocked(): Promise<void> {
    await writeJson(path.join(this.dir, 'blocklist.json'), [...this.blocked.values()]);
  }

  isBlocked(name: string, id?: string): BlockedPlayer | undefined {
    const byName = this.blocked.get(name.toLowerCase());
    if (byName) return byName;
    if (id) for (const b of this.blocked.values()) if (b.id && b.id === id) return b;
    return undefined;
  }

  /** Send a command without echoing it into the console log (used for background status queries). */
  sendSilent(command: string): void {
    if (!this.proc?.stdin?.writable) throw new HttpError(409, 'Server is not running');
    this.proc.stdin.write(command.replace(/^\//, '').trim() + '\n');
  }

  /** Hide console lines matching `re` for a short while, so status queries do not flood the log. */
  muteOutput(re: RegExp, ms: number): void {
    this.muted = { until: Date.now() + ms, re };
  }

  /** Observe every output line until the returned function is called. */
  tap(fn: (line: string) => void): () => void {
    this.taps.add(fn);
    return () => this.taps.delete(fn);
  }

  async save(): Promise<void> {
    this.rec.updatedAt = new Date().toISOString();
    await writeJson(serverRecordFile(this.rec.id), this.rec);
    bus.publish({ type: 'server.changed', id: this.id });
  }

  private persistSeen() {
    if (this.seenDirty) return;
    this.seenDirty = setTimeout(() => {
      this.seenDirty = null;
      writeJson(path.join(this.dir, 'players.json'), [...this.seen.values()]).catch(() => {});
    }, 2000);
  }

  setState(state: ServerState, detail?: string) {
    if (this.state === state && !detail) return;
    this.state = state;
    this.errorDetail = detail ?? (state === 'error' || state === 'crashed' ? this.errorDetail : null);
    bus.publish({ type: 'server.state', id: this.id, state, detail: this.errorDetail ?? undefined });
  }

  setProgress(pct: number | null, message: string) {
    this.install = { pct, message };
    bus.publish({ type: 'server.progress', id: this.id, pct, message });
  }

  /**
   * Add a line to the console. Lines starting with "[Blockhost] " are ours: they are rewritten with the same
   * timestamp prefix the server uses, so they line up with its output (the UI paints them blue).
   */
  pushLog(line: string) {
    if (line.startsWith(HOST_TAG)) line = this.hostLine(line.slice(HOST_TAG.length));
    this.logs.push(line);
    if (this.logs.length > LOG_RING) this.logs.splice(0, this.logs.length - LOG_RING);
    bus.publish({ type: 'server.log', id: this.id, line });
  }

  /** A titled block of Blockhost lines, like the banners the servers print themselves. */
  banner(title: string, body: string[]) {
    const now = new Date();
    for (const text of bannerLines(title, body)) this.pushLog(this.hostLine(text, 'INFO', now));
  }

  private hostLine(message: string, level: HostLevel = levelFor(message), at = new Date()): string {
    return HOST_MARK + hostPrefix(this.logStyle ?? defaultStyle(this.rec), level, at) + message;
  }

  /** Wait for a parsed event or a raw line matching a predicate. */
  waitFor(pred: (ev: ParsedEvent | null, line: string) => boolean, timeoutMs: number): Promise<{ ev: ParsedEvent | null; line: string }> {
    return new Promise((resolve, reject) => {
      const w = {
        pred,
        resolve,
        timer: setTimeout(() => {
          this.waiters = this.waiters.filter((x) => x !== w);
          reject(new Error('Timed out waiting for server output'));
        }, timeoutMs),
      };
      this.waiters.push(w);
    });
  }

  send(command: string): void {
    if (!this.proc || !this.proc.stdin || !this.proc.stdin.writable) throw new HttpError(409, 'Server is not running');
    const cmd = command.replace(/^\//, '').trim();
    if (!cmd) return;
    this.proc.stdin.write(cmd + '\n');
    this.pushLog(`> ${cmd}`);
  }

  /* ------------------------------------------------------------------ */

  private async checkPortFree(): Promise<void> {
    const ports: { port: number; udp: boolean }[] =
      this.rec.edition === 'java'
        ? [
            { port: this.rec.port, udp: false },
            ...(this.rec.geyser && this.rec.geyserPort
              ? [
                  { port: this.rec.geyserPort, udp: true },
                  { port: this.rec.geyserPort + 1, udp: true },
                  { port: this.rec.geyserPort, udp: false },
                ]
              : []),
          ]
        : this.rec.transport === 'nethernet'
          ? [{ port: this.rec.port, udp: true }, { port: this.rec.port, udp: false }]
          : [{ port: this.rec.port, udp: true }, { port: this.rec.portV6 ?? this.rec.port + 1, udp: true }];
    for (const { port, udp } of ports) {
      const free = await new Promise<boolean>((res) => {
        if (udp) {
          const s = dgram.createSocket('udp4');
          s.once('error', () => res(false));
          s.bind(port, () => s.close(() => res(true)));
        } else {
          // Probe by connecting rather than listening: after a server stops, its accepted connections sit in
          // TIME_WAIT for a minute and make a listen() test report EADDRINUSE even though the port is free.
          const c = new net.Socket();
          let done = false;
          const finish = (isFree: boolean) => {
            if (done) return;
            done = true;
            c.destroy();
            res(isFree);
          };
          c.setTimeout(700, () => finish(true));
          c.once('error', () => finish(true));
          c.connect(port, '127.0.0.1', () => finish(false));
        }
      });
      if (!free) throw new HttpError(409, `Port ${port}/${udp ? 'udp' : 'tcp'} is already in use`);
    }
  }

  async buildCommand(): Promise<{ cmd: string; args: string[]; env: NodeJS.ProcessEnv }> {
    const env: NodeJS.ProcessEnv = { ...process.env };
    if (this.rec.edition === 'bedrock') {
      env.LD_LIBRARY_PATH = '.';
      if (config.arch === 'arm64') {
        const box = await which('box64');
        if (!box) throw new HttpError(500, 'box64 is required to run Bedrock on ARM hosts');
        return { cmd: box, args: ['./bedrock_server'], env };
      }
      return { cmd: './bedrock_server', args: [], env };
    }
    const major = await javaMajorFor(this.rec);
    const rt = await ensureJava(major, (p, m) => this.setProgress(p, m));
    if (this.rec.geyser) Object.assign(env, geyserEnv(this.rec, await resolveAdvertiseIp(this.rec.advertiseIp || config.advertiseIp || ''), config.hostNetwork));
    const j = this.rec.java!;
    const args = [`-Xms${Math.min(j.xmsMb || j.xmxMb, j.xmxMb)}M`, `-Xmx${j.xmxMb}M`];
    if (j.preset === 'aikar') args.push(...aikarFlags(j.xmxMb));
    else if (j.preset === 'zgc') args.push(...zgcFlags(major));
    if (j.extraArgs?.trim()) args.push(...j.extraArgs.trim().split(/\s+/));
    args.push('-Dfile.encoding=UTF-8', '-Dlog4j2.formatMsgNoLookups=true');
    // JDK 24+ warns on every sun.misc.Unsafe memory access (used by JOML/Netty); the game is fine, silence the noise.
    if (major >= 24) args.push('--sun-misc-unsafe-memory-access=allow');
    const launch = this.rec.build?.launch;
    if (!launch || launch.kind === 'bedrock') throw new HttpError(409, 'Server is not installed');
    if (launch.kind === 'jar') args.push('-jar', launch.jar);
    else args.push(`@${launch.file}`);
    args.push('nogui');
    return { cmd: rt.path, args, env };
  }

  async start(): Promise<void> {
    if (this.isActive) throw new HttpError(409, 'Server is already running');
    if (this.state === 'installing') throw new HttpError(409, 'Server is installing');
    if (!this.rec.installed) throw new HttpError(409, 'Server is not installed yet');
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    this.intentionalStop = false;
    this.lastOom = false;
    this.setState('starting');
    const run = ++this.startSeq;
    try {
      await this.checkPortFree();
    } catch (e) {
      this.setState('error', (e as Error).message);
      throw e;
    }
    if (this.usesNetherNetListener && (await lingeringTcpSockets(this.rec.port))) {
      // Finish in the background so the caller is not held for up to a minute; the console shows what is going on.
      this.waitForPortRelease(run)
        .then((go) => (go ? this.launch() : undefined))
        .catch((e) => {
          this.pushLog(`[Blockhost] Failed to start: ${(e as Error).message}`);
        });
      return;
    }
    await this.launch();
  }

  /** Bedrock on NetherNet is the one server here whose TCP listener cannot bind while old connections linger. */
  private get usesNetherNetListener(): boolean {
    return this.rec.edition === 'bedrock' && this.rec.transport === 'nethernet';
  }

  /**
   * Bedrock binds its NetherNet signaling port without SO_REUSEADDR. While connections from the previous run are
   * still in TIME_WAIT (60 seconds after each one the server closed, e.g. every status request from the console
   * broadcaster) that bind fails, and Bedrock carries on without NetherNet and without reporting an error.
   * So wait until the port is really free. Resolves false if the start was cancelled meanwhile.
   */
  private async waitForPortRelease(run: number): Promise<boolean> {
    const port = this.rec.port;
    this.pushLog(`[Blockhost] Waiting for port ${port} to be released by the previous run (up to a minute). Bedrock cannot open NetherNet while it is busy.`);
    const deadline = Date.now() + 75_000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 1000));
      if (this.startSeq !== run || this.state !== 'starting') return false;
      if (!(await lingeringTcpSockets(port))) return true;
    }
    this.pushLog(`[Blockhost] Port ${port} is still busy after 75 seconds; starting anyway.`);
    return this.startSeq === run && this.state === 'starting';
  }

  private async launch(): Promise<void> {
    try {
      if (this.rec.edition === 'java') {
        await syncJavaProperties(this.rec, this.root);
      } else {
        await syncBedrockProperties(this.rec, this.root);
      }
      const { cmd, args, env } = await this.buildCommand();
      this.install = null;
      this.logStyleSeen = false; // the version or flavor may have changed since the last run
      this.pushLog(`[Blockhost] Starting: ${path.basename(cmd)} ${args.join(' ')}`);
      const proc = spawn(cmd, args, { cwd: this.root, env, stdio: ['pipe', 'pipe', 'pipe'] });
      this.proc = proc;
      this.startedAt = new Date();
      this.players.clear();
      this.rec.lastRunning = true;
      this.save().catch(() => {});
      const attach = (stream: NodeJS.ReadableStream) => {
        const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
        rl.on('line', (l) => this.onLine(stripAnsi(l)));
      };
      attach(proc.stdout!);
      attach(proc.stderr!);
      proc.on('error', (e) => {
        this.pushLog(`[Blockhost] Failed to start: ${e.message}`);
        this.setState('error', e.message);
        this.proc = null;
      });
      proc.on('exit', (code, signal) => this.onExit(code, signal));
    } catch (e) {
      this.proc = null;
      this.setState('error', (e as Error).message);
      throw e;
    }
  }

  async stop(timeoutMs = config.stopTimeoutMs): Promise<void> {
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    const proc = this.proc;
    if (!proc) {
      this.startSeq++; // cancels a start that is still waiting for its port
      if (this.state !== 'stopped') this.setState('stopped');
      return;
    }
    this.intentionalStop = true;
    this.setState('stopping');
    const exited = new Promise<void>((res) => proc.once('exit', () => res()));
    try {
      proc.stdin?.write('stop\n');
    } catch {
      /* ignore */
    }
    const timer = new Promise<'timeout'>((res) => setTimeout(() => res('timeout'), timeoutMs));
    const r = await Promise.race([exited.then(() => 'ok' as const), timer]);
    if (r === 'timeout') {
      this.pushLog('[Blockhost] Server did not stop in time, sending SIGTERM');
      proc.kill('SIGTERM');
      const r2 = await Promise.race([exited.then(() => 'ok' as const), new Promise<'timeout'>((res) => setTimeout(() => res('timeout'), 15_000))]);
      if (r2 === 'timeout') {
        this.pushLog('[Blockhost] Force killing server');
        proc.kill('SIGKILL');
        await exited;
      }
    }
  }

  kill(): void {
    this.intentionalStop = true;
    this.proc?.kill('SIGKILL');
  }

  /**
   * Safety net for the case waitForPortRelease guards against: Bedrock says "Server started" even when its NetherNet
   * listener failed to bind. If nothing answers on the signaling port, restart once the port is free. Two tries at
   * most per healthy start, so a server that genuinely cannot listen is not restarted forever.
   */
  private async verifyNetherNet(proc: ChildProcess | null): Promise<void> {
    for (let i = 0; i < 4; i++) {
      if ((await probeNetherNet('127.0.0.1', this.rec.port, 1500)).ok) {
        this.netherNetRepairs = 0;
        return;
      }
      await new Promise((r) => setTimeout(r, 1500));
      if (this.proc !== proc || this.state !== 'running') return;
    }
    if (this.netherNetRepairs >= 2) {
      this.pushLog(`[Blockhost] NetherNet is still not listening on port ${this.rec.port} after ${this.netherNetRepairs} restarts; not retrying. Players cannot join until this is fixed (check that nothing else uses the port).`);
      return;
    }
    this.netherNetRepairs++;
    this.pushLog(`[Blockhost] NetherNet did not start listening on port ${this.rec.port}, so players could not join. Restarting the server to fix it.`);
    await this.stop();
    await this.start();
  }

  private onLine(line: string) {
    if (!this.logStyleSeen) {
      const style = detectStyle(line);
      if (style) {
        this.logStyle = style;
        this.logStyleSeen = true;
      }
    }
    const hidden = this.muted && Date.now() < this.muted.until && this.muted.re.test(line);
    if (!hidden) this.pushLog(line);
    for (const t of this.taps) t(line);
    if (/OutOfMemoryError/.test(line)) this.lastOom = true;
    const ev = parseLine(this.rec.edition, line);
    if (ev) this.handleEvent(ev);
    if (this.waiters.length) {
      const remaining: typeof this.waiters = [];
      for (const w of this.waiters) {
        if (w.pred(ev, line)) {
          clearTimeout(w.timer);
          w.resolve({ ev, line });
        } else remaining.push(w);
      }
      this.waiters = remaining;
    }
  }

  private handleEvent(ev: ParsedEvent) {
    switch (ev.kind) {
      case 'started':
        if (this.state === 'starting') this.setState('running');
        this.restartTimes = [];
        if (this.usesNetherNetListener) this.verifyNetherNet(this.proc).catch(() => {});
        break;
      case 'uuid': {
        const s = this.seen.get(ev.name.toLowerCase()) || { name: ev.name, lastSeen: new Date().toISOString() };
        s.id = ev.uuid;
        this.seen.set(ev.name.toLowerCase(), s);
        this.persistSeen();
        break;
      }
      case 'join': {
        const key = ev.name.toLowerCase();
        const existing = this.players.get(key);
        const p: OnlinePlayer = existing || { name: ev.name, joinedAt: new Date().toISOString() };
        if (ev.id) p.id = ev.id;
        if (ev.ip) p.ip = ev.ip;
        const seen = this.seen.get(key);
        if (!p.id && seen?.id) p.id = seen.id;
        this.players.set(key, p);
        this.seen.set(key, { name: ev.name, id: p.id ?? seen?.id, ip: p.ip ?? seen?.ip, lastSeen: new Date().toISOString() });
        this.persistSeen();
        this.emitPlayers();
        this.enforceBlock(ev.name, p.id);
        break;
      }
      case 'leave':
        if (this.players.delete(ev.name.toLowerCase())) this.emitPlayers();
        break;
      case 'port-in-use':
        this.errorDetail = 'Port already in use';
        break;
      default:
        break;
    }
  }

  /** Bedrock: remove a blocked player shortly after they connect (retry once in case they were still loading). */
  private enforceBlock(name: string, id?: string) {
    if (this.rec.edition !== 'bedrock') return;
    const b = this.isBlocked(name, id);
    if (!b) return;
    const kick = () => {
      if (!this.players.has(name.toLowerCase()) || !this.proc) return;
      try {
        this.send(`kick "${name}" ${b.reason || 'You are blocked from this server'}`);
      } catch {
        /* server went away */
      }
    };
    setTimeout(kick, 800);
    setTimeout(kick, 6000);
  }

  private emitPlayers() {
    bus.publish({ type: 'server.players', id: this.id, players: [...this.players.values()] });
  }

  private onExit(code: number | null, signal: NodeJS.Signals | null) {
    this.proc = null;
    const oom = this.lastOom || code === 137 || signal === 'SIGKILL' && !this.intentionalStop;
    this.lastExit = { code, signal, at: new Date().toISOString(), oom };
    this.players.clear();
    this.emitPlayers();
    this.ping = null;
    this.geyserPing = null;
    this.pushLog(`[Blockhost] Server process exited (code ${code ?? 'null'}${signal ? `, signal ${signal}` : ''})`);
    for (const w of this.waiters) {
      clearTimeout(w.timer);
    }
    this.waiters = [];
    const clean = this.intentionalStop || code === 0;
    if (clean) {
      this.rec.lastRunning = false;
      this.save().catch(() => {});
      this.setState('stopped');
      return;
    }
    this.setState('crashed', oom ? 'Out of memory' : this.errorDetail || `Exit code ${code}`);
    if (this.rec.restartOnCrash) {
      const now = Date.now();
      this.restartTimes = this.restartTimes.filter((t) => now - t < 10 * 60_000);
      if (this.restartTimes.length < 3) {
        this.restartTimes.push(now);
        this.pushLog(`[Blockhost] Restarting in 5s (attempt ${this.restartTimes.length}/3)`);
        this.restartTimer = setTimeout(() => {
          this.restartTimer = null;
          this.start().catch((e) => this.pushLog(`[Blockhost] Restart failed: ${e.message}`));
        }, 5000);
      } else {
        this.pushLog('[Blockhost] Too many crashes; not restarting automatically.');
        this.rec.lastRunning = false;
        this.save().catch(() => {});
      }
    } else {
      this.rec.lastRunning = false;
      this.save().catch(() => {});
    }
  }

  pushStats(sample: StatsSample) {
    this.stats.push(sample);
    if (this.stats.length > STATS_RING) this.stats.splice(0, this.stats.length - STATS_RING);
    bus.publish({ type: 'server.stats', id: this.id, sample });
  }

  summary(): ServerSummary {
    return {
      ...this.rec,
      state: this.state,
      pid: this.proc?.pid ?? null,
      startedAt: this.isActive && this.startedAt ? this.startedAt.toISOString() : null,
      players: [...this.players.values()],
      ping: this.ping,
      geyserPing: this.rec.geyser ? this.geyserPing : null,
      lastExit: this.lastExit,
      diskBytes: this.diskBytes,
      lastStats: this.stats[this.stats.length - 1] ?? null,
      install: this.state === 'installing' ? this.install : null,
      address: { remote: this.remoteAddresses },
    };
  }
}
