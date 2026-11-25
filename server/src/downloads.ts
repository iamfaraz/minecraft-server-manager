/**
 * Every file download the app makes goes through here: a shared queue (6 at a time), stall and connect timeouts,
 * retries with Range resume, size and hash checks, and one download per destination at a time. Jobs are kept in
 * memory so the UI can show what is happening and what happened recently.
 */
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

export type Progress = (pct: number | null, message: string) => void;
export type JobState = 'queued' | 'active' | 'verifying' | 'done' | 'failed' | 'cancelled';
export type OwnerKind = 'server-install' | 'addon' | 'mod-update' | 'modpack' | 'runtime' | 'system';

export interface DownloadCtx {
  taskId?: string;
  serverId?: string;
  kind?: OwnerKind;
  label?: string;
  sha1?: string;
  sha512?: string;
  expectedSize?: number;
  signal?: AbortSignal;
}

export interface DownloadJob {
  id: string;
  url: string;
  label: string;
  kind: OwnerKind;
  serverId?: string;
  taskId?: string;
  bytesDone: number;
  bytesTotal: number | null;
  speedBps: number;
  state: JobState;
  error?: string;
  attempt: number;
  indeterminate?: boolean;
  startedAt: string;
  finishedAt?: string;
}

export interface DownloadTask {
  id: string;
  label: string;
  serverId?: string;
  kind: OwnerKind;
  state: 'active' | 'done' | 'failed' | 'cancelled';
  error?: string;
  startedAt: string;
  finishedAt?: string;
  canRetry: boolean;
  jobIds: string[];
}

export interface TaskHandle {
  id: string;
  signal: AbortSignal;
  /** Pass to every download of this task. */
  ctx: DownloadCtx;
  done(): void;
  fail(e: Error): void;
}

const HISTORY = 100;

export class CancelledError extends Error {
  constructor(message = 'Cancelled') {
    super(message);
    this.name = 'CancelledError';
  }
}

class AttemptError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

export interface ManagerOptions {
  concurrency?: number;
  stallMs?: number;
  connectMs?: number;
  /** Delay before attempt 2, 3, ...; its length + 1 is the number of attempts. */
  backoffMs?: number[];
}

const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

export function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  const u = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${u[i]}`;
}

export async function fileHash(file: string, algo: 'sha1' | 'sha512'): Promise<string> {
  const h = crypto.createHash(algo);
  for await (const chunk of fs.createReadStream(file)) h.update(chunk as Buffer);
  return h.digest('hex');
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(new CancelledError());
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => (clearTimeout(t), reject(new CancelledError())), { once: true });
  });

function labelFor(url: string): string {
  try {
    const b = path.basename(new URL(url).pathname) || 'file';
    return decodeURIComponent(b);
  } catch {
    return 'file';
  }
}

export class DownloadManager {
  protected readonly opts: Required<ManagerOptions>;
  protected readonly list: DownloadJob[] = [];
  private readonly inflight = new Map<string, Promise<void>>();
  private readonly emitter = new EventEmitter();
  private active = 0;
  private readonly waiting: (() => void)[] = [];
  private seq = 0;
  private readonly taskMap = new Map<string, { t: DownloadTask; ctl: AbortController; retry?: () => Promise<void> }>();
  private readonly jobCtl = new Map<string, AbortController>();

  constructor(opts: ManagerOptions = {}) {
    this.opts = { concurrency: 6, stallMs: 60_000, connectMs: 30_000, backoffMs: [2_000, 8_000, 20_000], ...opts };
    this.emitter.setMaxListeners(50);
  }

  on(event: 'change', fn: (job: DownloadJob) => void): void;
  on(event: 'task', fn: (task: DownloadTask) => void): void;
  on(event: 'change' | 'task', fn: (x: any) => void): void {
    this.emitter.on(event, fn);
  }

  snapshot(): { tasks: DownloadTask[]; jobs: DownloadJob[] } {
    return { tasks: [...this.taskMap.values()].map((x) => ({ ...x.t, jobIds: [...x.t.jobIds] })), jobs: this.jobs() };
  }

  startTask(t: { label: string; serverId?: string; kind: OwnerKind; retry?: () => Promise<void> }): TaskHandle {
    const id = `task${Date.now().toString(36)}${(++this.seq).toString(36)}`;
    const ctl = new AbortController();
    const task: DownloadTask = { id, label: t.label, serverId: t.serverId, kind: t.kind, state: 'active', startedAt: new Date().toISOString(), canRetry: !!t.retry, jobIds: [] };
    this.taskMap.set(id, { t: task, ctl, retry: t.retry });
    this.emitter.emit('task', task);
    return {
      id,
      signal: ctl.signal,
      ctx: { taskId: id, serverId: t.serverId, kind: t.kind, signal: ctl.signal },
      done: () => this.endTask(id, 'done'),
      fail: (e: Error) => this.endTask(id, e instanceof CancelledError || ctl.signal.aborted ? 'cancelled' : 'failed', e.message),
    };
  }

  private endTask(id: string, state: DownloadTask['state'], error?: string): void {
    const x = this.taskMap.get(id);
    if (!x || x.t.state !== 'active') return;
    x.t.state = state;
    x.t.error = error;
    x.t.finishedAt = new Date().toISOString();
    this.emitter.emit('task', x.t);
    this.trim();
  }

  cancelTask(id: string): void {
    const x = this.taskMap.get(id);
    if (!x) return;
    x.ctl.abort();
    for (const j of this.list) if (j.taskId === id && j.indeterminate && j.state === 'active') this.finish(j, 'cancelled', 'Cancelled');
    this.endTask(id, 'cancelled', 'Cancelled');
  }

  cancelJob(id: string): void {
    const job = this.list.find((j) => j.id === id);
    if (!job) return;
    if (job.taskId && this.taskMap.has(job.taskId)) return this.cancelTask(job.taskId);
    this.jobCtl.get(id)?.abort();
  }

  async retryTask(id: string): Promise<void> {
    const x = this.taskMap.get(id);
    if (!x?.retry) throw new Error('This task cannot be retried');
    await x.retry();
  }

  clearHistory(): void {
    for (let i = this.list.length - 1; i >= 0; i--) if (this.list[i].finishedAt) this.list.splice(i, 1);
    for (const [id, x] of this.taskMap) if (x.t.state !== 'active') this.taskMap.delete(id);
  }

  /** An install step whose downloads happen in a child process: shown without a percentage; cancel aborts `signal`. */
  trackProcess(taskId: string, label: string): { signal: AbortSignal; end(ok: boolean, error?: string): void } {
    const x = this.taskMap.get(taskId);
    const signal = x?.ctl.signal ?? new AbortController().signal;
    const job = this.newJob('', { taskId, label, kind: x?.t.kind, serverId: x?.t.serverId }, { indeterminate: true, state: 'active', attempt: 1 });
    return {
      signal,
      end: (ok, error) => {
        if (job.finishedAt) return;
        this.finish(job, ok ? 'done' : signal.aborted ? 'cancelled' : 'failed', ok ? undefined : error);
      },
    };
  }

  private trim(): void {
    const finished = this.list.filter((j) => j.finishedAt);
    for (const j of finished.slice(0, Math.max(0, finished.length - HISTORY))) this.list.splice(this.list.indexOf(j), 1);
    const done = [...this.taskMap.values()].filter((x) => x.t.state !== 'active');
    for (const x of done.slice(0, Math.max(0, done.length - HISTORY))) this.taskMap.delete(x.t.id);
  }

  jobs(): DownloadJob[] {
    return this.list.map((j) => ({ ...j }));
  }

  protected emit(job: DownloadJob): void {
    this.emitter.emit('change', job);
  }

  protected newJob(url: string, ctx: DownloadCtx, extra: Partial<DownloadJob> = {}): DownloadJob {
    const job: DownloadJob = {
      id: `dl${Date.now().toString(36)}${(++this.seq).toString(36)}`,
      url,
      label: ctx.label || labelFor(url),
      kind: ctx.kind || 'system',
      serverId: ctx.serverId,
      taskId: ctx.taskId,
      bytesDone: 0,
      bytesTotal: null,
      speedBps: 0,
      state: 'queued',
      attempt: 0,
      startedAt: new Date().toISOString(),
      ...extra,
    };
    this.list.push(job);
    this.onNewJob(job);
    this.emit(job);
    return job;
  }

  /** Hook for subclasses (task bookkeeping). */
  protected onNewJob(job: DownloadJob): void {
    if (job.taskId) this.taskMap.get(job.taskId)?.t.jobIds.push(job.id);
  }

  protected finish(job: DownloadJob, state: 'done' | 'failed' | 'cancelled', error?: string): void {
    job.state = state;
    job.error = error;
    job.speedBps = 0;
    job.finishedAt = new Date().toISOString();
    this.emit(job);
    this.trim();
  }

  download(url: string, dest: string, ctx: DownloadCtx = {}, onProgress?: Progress): Promise<void> {
    const key = path.resolve(dest);
    const existing = this.inflight.get(key);
    if (existing) return existing;
    const task = ctx.taskId ? this.taskMap.get(ctx.taskId) : undefined;
    const ctl = new AbortController();
    const signals = [ctl.signal, ...(ctx.signal ? [ctx.signal] : []), ...(task ? [task.ctl.signal] : [])];
    const job = this.newJob(url, { ...ctx, serverId: ctx.serverId ?? task?.t.serverId, kind: ctx.kind ?? task?.t.kind });
    this.jobCtl.set(job.id, ctl);
    const p = this.run(job, key, { ...ctx, signal: AbortSignal.any(signals) }, onProgress).finally(() => {
      this.inflight.delete(key);
      this.jobCtl.delete(job.id);
    });
    this.inflight.set(key, p);
    return p;
  }

  private async acquire(signal?: AbortSignal): Promise<void> {
    if (this.active < this.opts.concurrency) {
      this.active++;
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const go = () => {
        signal?.removeEventListener('abort', onAbort);
        this.active++;
        resolve();
      };
      const onAbort = () => {
        const i = this.waiting.indexOf(go);
        if (i >= 0) this.waiting.splice(i, 1);
        reject(new CancelledError());
      };
      if (signal?.aborted) return reject(new CancelledError());
      signal?.addEventListener('abort', onAbort, { once: true });
      this.waiting.push(go);
    });
  }

  private release(): void {
    this.active--;
    const next = this.waiting.shift();
    if (next) next();
  }

  private async run(job: DownloadJob, dest: string, ctx: DownloadCtx, onProgress?: Progress): Promise<void> {
    const part = `${dest}.part`;
    const cleanup = () => fsp.rm(part, { force: true }).catch(() => {});
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    try {
      await this.acquire(ctx.signal);
    } catch (e) {
      this.finish(job, 'cancelled', 'Cancelled');
      throw e;
    }
    try {
      const attempts = this.opts.backoffMs.length;
      const resume = { rangeOk: false };
      let lastErr: Error = new Error('Download failed');
      for (let i = 1; i <= attempts; i++) {
        if (i > 1) await sleep(this.opts.backoffMs[i - 2], ctx.signal);
        job.attempt = i;
        job.state = 'active';
        job.error = undefined;
        this.emit(job);
        try {
          await this.attempt(job, part, ctx, resume, onProgress);
          if (ctx.sha512 || ctx.sha1) {
            job.state = 'verifying';
            this.emit(job);
            const algo = ctx.sha512 ? 'sha512' : 'sha1';
            const got = await fileHash(part, algo);
            if (got !== (ctx.sha512 || ctx.sha1)!.toLowerCase()) {
              await cleanup();
              throw new AttemptError(`File hash mismatch for ${job.label}`, true);
            }
          }
          await fsp.rename(part, dest);
          this.finish(job, 'done');
          onProgress?.(100, `Downloaded ${job.label}`);
          return;
        } catch (e) {
          if (e instanceof CancelledError || ctx.signal?.aborted) throw e instanceof CancelledError ? e : new CancelledError();
          lastErr = e as Error;
          if (e instanceof AttemptError && !e.retryable) break;
          job.error = `${lastErr.message}${i < attempts ? ' — retrying' : ''}`;
          this.emit(job);
        }
      }
      await cleanup();
      this.finish(job, 'failed', lastErr.message);
      throw lastErr;
    } catch (e) {
      if (e instanceof CancelledError) {
        await cleanup();
        this.finish(job, 'cancelled', 'Cancelled');
      } else if (job.state !== 'failed') {
        await cleanup();
        this.finish(job, 'failed', (e as Error).message);
      }
      throw e;
    } finally {
      this.release();
    }
  }

  /** One HTTP attempt into `part`. Sets `resume.rangeOk` once the server has said it accepts byte ranges. */
  private async attempt(job: DownloadJob, part: string, ctx: DownloadCtx, resume: { rangeOk: boolean }, onProgress?: Progress): Promise<void> {
    let offset = 0;
    if (resume.rangeOk) offset = await fsp.stat(part).then((s) => s.size, () => 0);
    const ctl = new AbortController();
    let why: 'stall' | 'connect' | 'cancel' | null = null;
    const abort = (w: typeof why) => {
      why = w;
      ctl.abort();
    };
    const onCancel = () => abort('cancel');
    if (ctx.signal?.aborted) throw new CancelledError();
    ctx.signal?.addEventListener('abort', onCancel, { once: true });
    let timer = setTimeout(() => abort('connect'), this.opts.connectMs);
    const reset = () => {
      clearTimeout(timer);
      timer = setTimeout(() => abort('stall'), this.opts.stallMs);
    };
    const fail = (e: unknown): never => {
      if (why === 'cancel') throw new CancelledError();
      if (why === 'stall') throw new AttemptError(`No data for ${Math.round(this.opts.stallMs / 1000)}s`, true);
      if (why === 'connect') throw new AttemptError('Connection timed out', true);
      if (e instanceof AttemptError) throw e;
      throw new AttemptError(`Network error: ${(e as Error).message}`, true);
    };
    let fh: fsp.FileHandle | null = null;
    try {
      let res: Response;
      try {
        res = await fetch(job.url, {
          headers: { 'User-Agent': UA, Accept: '*/*', ...(offset > 0 ? { Range: `bytes=${offset}-` } : {}) },
          redirect: 'follow',
          signal: ctl.signal,
        });
      } catch (e) {
        return fail(e);
      }
      if (!res.ok || !res.body) {
        const retryable = res.status >= 500 || res.status === 408 || res.status === 429;
        throw new AttemptError(`Download failed (HTTP ${res.status}) for ${job.label}`, retryable);
      }
      if (res.headers.get('accept-ranges') === 'bytes') resume.rangeOk = true;
      const resumed = res.status === 206 && offset > 0;
      if (!resumed) offset = 0;
      const len = Number(res.headers.get('content-length') || 0);
      job.bytesTotal = len ? offset + len : ctx.expectedSize ?? null;
      job.bytesDone = offset;
      fh = await fsp.open(part, resumed ? 'a' : 'w');
      reset();
      let lastEmit = 0;
      let winBytes = 0;
      let winStart = Date.now();
      try {
        for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
          reset();
          await fh.write(chunk);
          job.bytesDone += chunk.length;
          winBytes += chunk.length;
          const now = Date.now();
          if (now - winStart >= 1000) {
            job.speedBps = Math.round((winBytes * 1000) / (now - winStart));
            winBytes = 0;
            winStart = now;
          }
          if (now - lastEmit > 300) {
            lastEmit = now;
            this.emit(job);
            const t = job.bytesTotal;
            onProgress?.(t ? Math.round((job.bytesDone / t) * 100) : null, `Downloading ${job.label} (${fmtSize(job.bytesDone)}${t ? ' / ' + fmtSize(t) : ''})`);
          }
        }
      } catch (e) {
        // Keep what arrived so the next attempt can resume (when the server allows ranges).
        fail(e);
      }
      const expected = job.bytesTotal ?? ctx.expectedSize;
      if (expected && job.bytesDone !== expected) {
        // Too many bytes, or too few from a server that cannot resume: start over next attempt.
        if (job.bytesDone > expected || !resume.rangeOk) {
          await fh.close();
          fh = null;
          await fsp.rm(part, { force: true });
        }
        throw new AttemptError(`Incomplete download (${fmtSize(job.bytesDone)} of ${fmtSize(expected)})`, true);
      }
    } finally {
      clearTimeout(timer);
      ctx.signal?.removeEventListener('abort', onCancel);
      await fh?.close().catch(() => {});
    }
  }
}

export const downloads = new DownloadManager();

/** Remove `*.part` files left by downloads that were interrupted (e.g. the app was stopped). */
export async function sweepPartials(dir: string): Promise<number> {
  let n = 0;
  let entries: string[] = [];
  try {
    entries = await fsp.readdir(dir);
  } catch {
    return 0;
  }
  for (const e of entries) {
    if (!e.endsWith('.part')) continue;
    await fsp.rm(path.join(dir, e), { force: true });
    n++;
  }
  return n;
}

/** Forward job and task changes to the websocket bus; progress-only updates at most every 300 ms per job. */
export function wireBus(m: DownloadManager, bus: { publish(ev: any): void }): void {
  const last = new Map<string, { at: number; state: JobState }>();
  m.on('change', (job) => {
    const prev = last.get(job.id);
    const now = Date.now();
    if (prev && prev.state === job.state && now - prev.at < 300) return;
    last.set(job.id, { at: now, state: job.state });
    if (job.finishedAt) last.delete(job.id);
    bus.publish({ type: 'download.changed', job: { ...job } });
  });
  m.on('task', (task) => bus.publish({ type: 'download.changed', task: { ...task, jobIds: [...task.jobIds] } }));
}

/** Run `fn` as one download task: its downloads are grouped, and the task ends done or failed with it. */
export async function withTask<T>(
  t: { label: string; serverId?: string; kind: OwnerKind; retry?: () => Promise<void> },
  fn: (ctx: DownloadCtx, task: TaskHandle) => Promise<T>,
  m: DownloadManager = downloads,
): Promise<T> {
  const task = m.startTask(t);
  try {
    const r = await fn(task.ctx, task);
    task.done();
    return r;
  } catch (e) {
    task.fail(e as Error);
    throw e;
  }
}
