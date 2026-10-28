import { clsx } from 'clsx';
import { X, Loader2, type LucideIcon } from 'lucide-react';
import { useEffect, type ReactNode } from 'react';
import type { ServerState } from '../lib/types';

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={clsx('animate-spin', className || 'size-4')} />;
}

export function Card({ className, children, title, action, padded = true }: { className?: string; children: ReactNode; title?: ReactNode; action?: ReactNode; padded?: boolean }) {
  return (
    <section className={clsx('card', className)}>
      {(title || action) && (
        <header className="flex items-center justify-between gap-3 border-b border-line px-5 py-3.5">
          <h3 className="text-sm font-semibold tracking-tight">{title}</h3>
          {action}
        </header>
      )}
      <div className={padded ? 'p-5' : ''}>{children}</div>
    </section>
  );
}

export function Field({ label, hint, children, className }: { label: ReactNode; hint?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <label className={clsx('block', className)}>
      <span className="label">{label}</span>
      {children}
      {hint && <span className="mt-1.5 block text-xs text-muted">{hint}</span>}
    </label>
  );
}

export function Toggle({ checked, onChange, label, description, disabled }: { checked: boolean; onChange: (v: boolean) => void; label?: ReactNode; description?: ReactNode; disabled?: boolean }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={clsx('flex w-full items-center justify-between gap-4 rounded-xl border border-line px-4 py-3 text-left transition hover:bg-white/[0.03] disabled:opacity-50', checked && 'border-accent/30 bg-accent/[0.04]')}
    >
      <span>
        {label && <span className="block text-sm font-medium">{label}</span>}
        {description && <span className="block text-xs text-muted">{description}</span>}
      </span>
      <span className={clsx('relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition', checked ? 'bg-accent' : 'bg-white/15')}>
        <span className={clsx('inline-block size-5 rounded-full bg-white shadow transition-transform', checked ? 'translate-x-5.5' : 'translate-x-0.5')} />
      </span>
    </button>
  );
}

export function Modal({ open, onClose, title, children, footer, wide }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={clsx('card fade-up w-full', wide ? 'max-w-3xl' : 'max-w-lg')}>
        <header className="flex items-center justify-between border-b border-line px-5 py-4">
          <h3 className="text-base font-semibold tracking-tight">{title}</h3>
          <button className="btn-ghost btn-sm" onClick={onClose} aria-label="Close">
            <X className="size-4" />
          </button>
        </header>
        <div className="max-h-[70vh] overflow-y-auto p-5">{children}</div>
        {footer && <footer className="flex justify-end gap-2 border-t border-line px-5 py-4">{footer}</footer>}
      </div>
    </div>
  );
}

export const STATE_META: Record<ServerState, { label: string; dot: string; text: string; bg: string }> = {
  running: { label: 'Running', dot: 'bg-emerald-400 dot-live', text: 'text-emerald-300', bg: 'border-emerald-500/30 bg-emerald-500/10' },
  starting: { label: 'Starting', dot: 'bg-amber-400 animate-pulse', text: 'text-amber-300', bg: 'border-amber-500/30 bg-amber-500/10' },
  stopping: { label: 'Stopping', dot: 'bg-amber-400 animate-pulse', text: 'text-amber-300', bg: 'border-amber-500/30 bg-amber-500/10' },
  installing: { label: 'Installing', dot: 'bg-sky-400 animate-pulse', text: 'text-sky-300', bg: 'border-sky-500/30 bg-sky-500/10' },
  stopped: { label: 'Stopped', dot: 'bg-slate-500', text: 'text-slate-300', bg: 'border-white/10 bg-white/[0.04]' },
  crashed: { label: 'Crashed', dot: 'bg-rose-400', text: 'text-rose-300', bg: 'border-rose-500/30 bg-rose-500/10' },
  error: { label: 'Error', dot: 'bg-rose-400', text: 'text-rose-300', bg: 'border-rose-500/30 bg-rose-500/10' },
};

export function StatusPill({ state, className }: { state: ServerState; className?: string }) {
  const m = STATE_META[state];
  return (
    <span className={clsx('chip', m.bg, m.text, className)}>
      <span className={clsx('size-1.5 rounded-full', m.dot)} />
      {m.label}
    </span>
  );
}

export function StatusDot({ state, className }: { state: ServerState; className?: string }) {
  return <span className={clsx('inline-block size-2 rounded-full', STATE_META[state].dot, className)} />;
}

export function EditionBadge({ edition }: { edition: 'java' | 'bedrock' }) {
  return edition === 'java' ? (
    <span className="chip border-orange-500/30 bg-orange-500/10 text-orange-300">Java</span>
  ) : (
    <span className="chip border-sky-500/30 bg-sky-500/10 text-sky-300">Bedrock</span>
  );
}

export function EmptyState({ icon: Icon, title, description, action }: { icon?: LucideIcon; title: string; description?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 px-6 py-14 text-center">
      {Icon && (
        <div className="flex size-12 items-center justify-center rounded-2xl border border-line bg-white/[0.03]">
          <Icon className="size-5 text-muted" />
        </div>
      )}
      <div>
        <p className="text-sm font-medium">{title}</p>
        {description && <p className="mt-1 max-w-sm text-sm text-muted">{description}</p>}
      </div>
      {action}
    </div>
  );
}

export function ProgressBar({ pct, className }: { pct: number | null; className?: string }) {
  return (
    <div className={clsx('h-1.5 w-full overflow-hidden rounded-full bg-white/10', className)}>
      {pct == null ? (
        <div className="h-full w-1/3 animate-[indeterminate_1.4s_ease-in-out_infinite] rounded-full bg-accent" style={{ animationName: 'indeterminate' }} />
      ) : (
        <div className="h-full rounded-full bg-accent transition-[width] duration-300" style={{ width: `${Math.max(2, Math.min(100, pct))}%` }} />
      )}
      <style>{`@keyframes indeterminate{0%{transform:translateX(-100%)}100%{transform:translateX(300%)}}`}</style>
    </div>
  );
}

export function Stat({ label, value, sub, icon: Icon, tone }: { label: string; value: ReactNode; sub?: ReactNode; icon?: LucideIcon; tone?: 'accent' | 'violet' | 'amber' | 'rose' }) {
  const tones = {
    accent: 'text-accent bg-accent/10 border-accent/20',
    violet: 'text-violet-300 bg-violet-500/10 border-violet-500/20',
    amber: 'text-amber-300 bg-amber-500/10 border-amber-500/20',
    rose: 'text-rose-300 bg-rose-500/10 border-rose-500/20',
  };
  return (
    <div className="card flex items-center gap-4 p-4">
      {Icon && (
        <div className={clsx('flex size-10 shrink-0 items-center justify-center rounded-xl border', tones[tone || 'accent'])}>
          <Icon className="size-4.5" />
        </div>
      )}
      <div className="min-w-0">
        <p className="text-[11px] font-medium uppercase tracking-wider text-muted">{label}</p>
        <p className="truncate text-xl font-semibold tracking-tight">{value}</p>
        {sub && <p className="truncate text-xs text-muted">{sub}</p>}
      </div>
    </div>
  );
}

export function Segmented<T extends string>({ value, onChange, options, className }: { value: T; onChange: (v: T) => void; options: { value: T; label: ReactNode }[]; className?: string }) {
  return (
    <div className={clsx('inline-flex rounded-xl border border-line bg-black/30 p-1', className)}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          className={clsx('rounded-lg px-3 py-1.5 text-sm font-medium transition', value === o.value ? 'bg-white/10 text-ink shadow' : 'text-muted hover:text-ink')}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function ConfirmModal({ open, onClose, onConfirm, title, body, confirmLabel = 'Confirm', danger, busy }: { open: boolean; onClose: () => void; onConfirm: () => void; title: string; body: ReactNode; confirmLabel?: string; danger?: boolean; busy?: boolean }) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      footer={
        <>
          <button className="btn-secondary" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className={danger ? 'btn-danger' : 'btn-primary'} onClick={onConfirm} disabled={busy}>
            {busy && <Spinner />}
            {confirmLabel}
          </button>
        </>
      }
    >
      <div className="text-sm text-muted">{body}</div>
    </Modal>
  );
}
