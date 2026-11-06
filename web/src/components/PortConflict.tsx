import { useState, type ReactNode } from 'react';
import { clsx } from 'clsx';
import { ApiError, api } from '../lib/api';
import type { PortConflictError, PortSlot, StartResolve } from '../lib/types';
import { Modal, Spinner } from './ui';
import { useToast } from './Toast';

type Choice = StartResolve['mode'];
const SLOT_LABEL: Record<PortSlot, string> = { port: 'Server port', geyserPort: 'Cross-play (Geyser) port' };

/**
 * Starts or restarts a server. If one of its ports is taken, the returned `dialog` asks what to do (stop the server
 * in the way, move to a free port, or pick a port) and retries. Render `dialog` somewhere in the calling component.
 * `start` resolves once the request went through or the dialog took over; other errors are thrown to the caller.
 */
export function useServerStart() {
  const toast = useToast();
  const [pending, setPending] = useState<{ action: 'start' | 'restart'; data: PortConflictError } | null>(null);
  const [choice, setChoice] = useState<Choice>('stop-others');
  const [custom, setCustom] = useState<Partial<Record<PortSlot, string>>>({});
  const [busy, setBusy] = useState(false);

  const open = (action: 'start' | 'restart', data: PortConflictError) => {
    const slots = [...new Set(data.conflicts.map((c) => c.slot))];
    const canStop = data.conflicts.every((c) => c.holder);
    const canAuto = slots.every((slot) => data.suggestion[slot] !== undefined);
    setChoice(canStop ? 'stop-others' : canAuto ? 'auto' : 'custom');
    setCustom(Object.fromEntries(slots.map((slot) => [slot, String(data.suggestion[slot] ?? '')])));
    setPending({ action, data });
  };

  const request = async (id: string, action: 'start' | 'restart', resolve?: StartResolve) => {
    try {
      await api.post(`/api/servers/${id}/${action}`, resolve ? { resolve } : undefined);
      setPending(null);
    } catch (e) {
      if (e instanceof ApiError && e.data.code === 'PORT_CONFLICT') open(action, e.data as PortConflictError);
      else throw e;
    }
  };

  const confirm = async () => {
    if (!pending) return;
    const { data, action } = pending;
    let resolve: StartResolve;
    if (choice === 'custom') {
      const ports: Partial<Record<PortSlot, number>> = {};
      for (const [slot, text] of Object.entries(custom) as [PortSlot, string][]) {
        const n = Number(text);
        if (!Number.isInteger(n) || n < 1024 || n > 65535) return toast.error(`${SLOT_LABEL[slot]}: enter a number from 1024 to 65535`);
        ports[slot] = n;
      }
      resolve = { mode: 'custom', ...ports };
    } else resolve = { mode: choice };
    setBusy(true);
    try {
      // After a restart the server is already stopped, so the retry is always a plain start.
      await request(data.server.id, action === 'restart' ? 'start' : action, resolve);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  let dialog: ReactNode = null;
  if (pending) {
    const { data } = pending;
    const slots = [...new Set(data.conflicts.map((c) => c.slot))];
    const holders = [...new Map(data.conflicts.filter((c) => c.holder).map((c) => [c.holder!.id, c.holder!])).values()];
    const canStop = data.conflicts.every((c) => c.holder);
    const canAuto = slots.every((slot) => data.suggestion[slot] !== undefined);
    const ports = [...new Set(data.conflicts.map((c) => c.port))];
    const holderNames = holders.map((h) => `"${h.name}"`).join(' and ');
    const option = (value: Choice, enabled: boolean, title: ReactNode, detail: ReactNode, extra?: ReactNode) => (
      <label className={clsx('flex gap-3 rounded-xl border p-3.5 transition', !enabled ? 'cursor-not-allowed border-line opacity-50' : choice === value ? 'cursor-pointer border-accent/60 bg-accent/10' : 'cursor-pointer border-line hover:border-white/20')}>
        <input type="radio" name="port-conflict" className="mt-1 accent-emerald-400" checked={choice === value} disabled={!enabled} onChange={() => setChoice(value)} />
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium text-ink">{title}</span>
          <span className="mt-0.5 block text-xs text-muted">{detail}</span>
          {choice === value && extra}
        </span>
      </label>
    );
    dialog = (
      <Modal
        open
        onClose={() => !busy && setPending(null)}
        title={`Port ${ports.join(' and ')} is already in use`}
        footer={
          <>
            <button className="btn-secondary" onClick={() => setPending(null)} disabled={busy}>
              Cancel
            </button>
            <button className="btn-primary" onClick={confirm} disabled={busy}>
              {busy && <Spinner />}
              Start server
            </button>
          </>
        }
      >
        <div className="space-y-4">
          <ul className="space-y-1.5 text-sm text-muted">
            {data.conflicts.map((c) => (
              <li key={`${c.port}/${c.proto}/${c.holder?.id ?? 'x'}`}>
                <span className="text-ink">"{data.server.name}"</span> needs port <span className="font-mono text-ink">{c.port}</span> ({c.proto.toUpperCase()}, {c.role.toLowerCase()}), but{' '}
                {c.holder ? (
                  <>
                    <span className="text-ink">"{c.holder.name}"</span> is running on it.
                  </>
                ) : (
                  'another program on this machine is using it.'
                )}
              </li>
            ))}
          </ul>
          <div className="space-y-2">
            {option(
              'stop-others',
              canStop,
              canStop ? `Stop ${holderNames} and start "${data.server.name}"` : 'Stop the other server',
              canStop ? 'Both keep this port and take turns: only one of them can run at a time.' : 'Not possible: the port is used by a program Blockhost does not manage.',
            )}
            {option(
              'auto',
              canAuto,
              canAuto ? `Move "${data.server.name}" to port ${slots.map((slot) => data.suggestion[slot]).join(' and ')}` : 'Move to the next free port',
              canAuto ? 'The next free port in the range. Players connect to the new port from now on.' : 'Not possible: no free port is left in the range.',
            )}
            {option(
              'custom',
              true,
              'Choose a port',
              'Use a port you pick. Outside the published range it only works if you publish it in Docker yourself.',
              <span className="mt-3 flex flex-wrap gap-3">
                {slots.map((slot) => (
                  <span key={slot} className="block">
                    <span className="label">{SLOT_LABEL[slot]}</span>
                    <input className="input w-32 font-mono" inputMode="numeric" value={custom[slot] ?? ''} onChange={(e) => setCustom({ ...custom, [slot]: e.target.value.replace(/\D/g, '') })} />
                  </span>
                ))}
              </span>,
            )}
          </div>
        </div>
      </Modal>
    );
  }

  return { start: (id: string, action: 'start' | 'restart' = 'start') => request(id, action), dialog };
}
