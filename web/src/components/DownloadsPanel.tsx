import { clsx } from 'clsx';
import { Check, ChevronDown, ChevronRight, Download, Loader2, RotateCcw, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useDownloads } from '../hooks/useDownloads';
import { fmtBytes, fmtDuration, timeAgo } from '../lib/format';
import type { DownloadJob, DownloadTask } from '../lib/types';

const isLive = (j: DownloadJob) => j.state === 'queued' || j.state === 'active' || j.state === 'verifying';

function Bar({ pct, indeterminate }: { pct: number | null; indeterminate?: boolean }) {
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/10">
      {indeterminate || pct == null ? <div className="h-full w-1/3 animate-pulse rounded-full bg-accent/70" /> : <div className="h-full rounded-full bg-accent transition-[width]" style={{ width: `${Math.min(100, pct)}%` }} />}
    </div>
  );
}

function JobRow({ j }: { j: DownloadJob }) {
  const pct = j.bytesTotal ? Math.round((j.bytesDone / j.bytesTotal) * 100) : null;
  const eta = j.speedBps > 0 && j.bytesTotal ? fmtDuration(((j.bytesTotal - j.bytesDone) / j.speedBps) * 1000) : null;
  return (
    <div className="space-y-1 py-1.5">
      <div className="flex items-center gap-2 text-xs">
        <span className="min-w-0 flex-1 truncate font-medium text-ink/90">{j.label}</span>
        <span className="shrink-0 tabular-nums text-muted">
          {j.state === 'queued'
            ? 'queued'
            : j.state === 'verifying'
              ? 'checking'
              : j.indeterminate
                ? 'working…'
                : `${fmtBytes(j.bytesDone)}${j.bytesTotal ? ` / ${fmtBytes(j.bytesTotal)}` : ''}${j.speedBps ? ` · ${fmtBytes(j.speedBps)}/s` : ''}${eta ? ` · ${eta}` : ''}`}
        </span>
      </div>
      {j.state !== 'queued' && <Bar pct={pct} indeterminate={j.indeterminate || j.state === 'verifying'} />}
      {j.error && <p className="text-[11px] text-amber-300/90">{j.error}</p>}
    </div>
  );
}

function TaskCard({ t, jobs, onCancel, onRetry }: { t: DownloadTask; jobs: DownloadJob[]; onCancel: () => void; onRetry: () => void }) {
  const [open, setOpen] = useState(false);
  const many = jobs.length > 5;
  const live = t.state === 'active';
  const done = jobs.filter((j) => j.state === 'done').length;
  const failed = jobs.filter((j) => j.state === 'failed').length;
  const retrying = jobs.filter((j) => isLive(j) && j.attempt > 1).length;
  const bytesDone = jobs.reduce((a, j) => a + j.bytesDone, 0);
  const bytesTotal = jobs.reduce((a, j) => a + (j.bytesTotal ?? 0), 0);
  const shown = many && !open ? [] : live ? jobs.filter(isLive).concat(jobs.filter((j) => !isLive(j))) : jobs;
  return (
    <div className="rounded-xl border border-line bg-white/[0.02] px-3 py-2.5">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{t.label}</p>
          {!live && (
            <p className={clsx('text-[11px]', t.state === 'done' ? 'text-muted' : t.state === 'cancelled' ? 'text-muted' : 'text-rose-300')}>
              {t.state === 'done' ? 'Finished' : t.state === 'cancelled' ? 'Cancelled' : t.error || 'Failed'} · {timeAgo(t.finishedAt)}
            </p>
          )}
        </div>
        {live ? (
          <button className="btn-ghost btn-sm shrink-0 text-xs" onClick={onCancel}>
            <X className="size-3.5" /> Cancel
          </button>
        ) : t.state === 'done' ? (
          <Check className="mt-0.5 size-4 shrink-0 text-accent" />
        ) : t.canRetry ? (
          <button className="btn-ghost btn-sm shrink-0 text-xs" onClick={onRetry}>
            <RotateCcw className="size-3.5" /> Retry
          </button>
        ) : null}
      </div>
      {many && (
        <button className="mt-1.5 flex w-full items-center gap-1.5 text-left text-xs text-muted hover:text-ink" onClick={() => setOpen((o) => !o)}>
          {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
          <span className="tabular-nums">
            {jobs.length} files · {done} / {jobs.length} · {fmtBytes(bytesDone)}
            {bytesTotal ? ` / ${fmtBytes(bytesTotal)}` : ''}
          </span>
          {failed > 0 && <span className="text-rose-300">· {failed} failed</span>}
          {retrying > 0 && <span className="text-amber-300">· {retrying} retrying</span>}
        </button>
      )}
      {many && live && !open && <div className="mt-1.5"><Bar pct={jobs.length ? (done / jobs.length) * 100 : null} /></div>}
      {(live || open || !many) && shown.length > 0 && (
        <div className="mt-1 divide-y divide-white/5">
          {(live && !open ? shown.filter(isLive) : shown).map((j) => (
            <JobRow key={j.id} j={j} />
          ))}
        </div>
      )}
    </div>
  );
}

export function DownloadsButton({ className }: { className?: string }) {
  const d = useDownloads();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  const toggle = () => {
    const r = ref.current?.getBoundingClientRect();
    if (r) setPos({ top: r.bottom + 8, left: Math.max(8, Math.min(r.left, window.innerWidth - 388)) });
    setOpen((o) => !o);
  };

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!ref.current?.contains(t) && !panelRef.current?.contains(t)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const byId = new Map(d.jobs.map((j) => [j.id, j]));
  const taskJobs = (t: DownloadTask) => t.jobIds.map((id) => byId.get(id)).filter((j): j is DownloadJob => !!j);
  const sorted = [...d.tasks].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  const active = sorted.filter((t) => t.state === 'active');
  const recent = sorted.filter((t) => t.state !== 'active');

  return (
    <div className={clsx('relative', className)} ref={ref}>
      <button className="btn-ghost btn-sm relative" title="Downloads" onClick={toggle}>
        {d.active > 0 ? <Loader2 className="size-4 animate-spin text-accent" /> : <Download className="size-4" />}
        {d.active > 0 && <span className="absolute -right-1 -top-1 flex min-w-4 items-center justify-center rounded-full bg-accent px-1 text-[10px] font-bold text-emerald-950">{d.active}</span>}
      </button>
      {open && createPortal(
        <div
          ref={panelRef}
          style={pos ? ({ '--dl-top': `${pos.top}px`, '--dl-left': `${pos.left}px` } as React.CSSProperties) : undefined}
          className="fixed inset-0 z-50 flex flex-col bg-panel sm:inset-auto sm:left-[var(--dl-left)] sm:top-[var(--dl-top)] sm:max-h-[70vh] sm:w-[380px] sm:rounded-2xl sm:border sm:border-line sm:shadow-2xl"
        >
          <header className="flex items-center justify-between border-b border-line px-4 py-3">
            <h3 className="text-sm font-semibold">Downloads</h3>
            <div className="flex items-center gap-1">
              {recent.length > 0 && (
                <button className="btn-ghost btn-sm text-xs" onClick={() => d.clearHistory()}>
                  Clear history
                </button>
              )}
              <button className="btn-ghost btn-sm" onClick={() => setOpen(false)}>
                <X className="size-4" />
              </button>
            </div>
          </header>
          <div className="flex-1 space-y-4 overflow-y-auto p-3">
            {!sorted.length && <p className="px-1 py-6 text-center text-sm text-muted">Nothing downloaded yet.</p>}
            {active.length > 0 && (
              <section className="space-y-2">
                <p className="px-1 text-[11px] font-semibold uppercase tracking-wider text-muted">Active</p>
                {active.map((t) => (
                  <TaskCard key={t.id} t={t} jobs={taskJobs(t)} onCancel={() => d.cancelTask(t.id)} onRetry={() => d.retryTask(t.id)} />
                ))}
              </section>
            )}
            {recent.length > 0 && (
              <section className="space-y-2">
                <p className="px-1 text-[11px] font-semibold uppercase tracking-wider text-muted">Recent</p>
                {recent.map((t) => (
                  <TaskCard key={t.id} t={t} jobs={taskJobs(t)} onCancel={() => d.cancelTask(t.id)} onRetry={() => d.retryTask(t.id)} />
                ))}
              </section>
            )}
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}
