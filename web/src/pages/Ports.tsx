import { useQuery, useQueryClient } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { Cable, Info } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useServers } from '../hooks/useServers';
import { ApiError, api } from '../lib/api';
import type { PortMap, PortSlot, PortUse, ServerSummary, WsEvent } from '../lib/types';
import { useWsEvent } from '../lib/ws';
import { Card, EmptyState, Field, Modal, Segmented, Spinner, StatusDot } from '../components/ui';
import { useToast } from '../components/Toast';

type RangeKind = 'java' | 'bedrock';
const ACTIVE = ['starting', 'running', 'stopping'];
const isActive = (state: string) => ACTIVE.includes(state);

/** What a port row is, from the uses the server reports for it. */
function statusOf(uses: PortUse[]): { label: string; cls: string } {
  const holding = uses.filter((u) => !u.released);
  const shared = new Set(holding.map((u) => u.serverId)).size > 1;
  if (holding.some((u) => u.inUse)) return { label: shared ? 'In use, shared' : 'In use', cls: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300' };
  if (shared) return { label: 'Shared', cls: 'border-amber-500/30 bg-amber-500/10 text-amber-300' };
  if (holding.length) return { label: 'Assigned', cls: 'border-sky-500/30 bg-sky-500/10 text-sky-300' };
  return { label: 'Free', cls: 'border-white/10 bg-white/5 text-muted' };
}

interface AssignTarget {
  /** Fixed server and setting, or undefined to let the user pick one for `port`. */
  server?: ServerSummary;
  slot?: PortSlot;
  kind: RangeKind;
  /** Prefilled port, when assigning a specific free port. */
  port?: number;
}

function AssignModal({ target, map, servers, onClose }: { target: AssignTarget; map: PortMap; servers: ServerSummary[]; onClose: () => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  // Who can take a port from this range: Java servers their own port, Bedrock servers theirs, Java servers with cross-play their Geyser port.
  const candidates = target.server
    ? [{ s: target.server, slot: target.slot ?? 'port', label: target.server.name }]
    : servers.flatMap((s) => {
        if (target.kind === 'java') return s.edition === 'java' ? [{ s, slot: 'port' as PortSlot, label: s.name }] : [];
        if (s.edition === 'bedrock') return [{ s, slot: 'port' as PortSlot, label: s.name }];
        return s.geyser ? [{ s, slot: 'geyserPort' as PortSlot, label: `${s.name} (cross-play port)` }] : [];
      });
  const [pick, setPick] = useState(target.server ? `${target.server.id}:${target.slot}` : candidates[0] ? `${candidates[0].s.id}:${candidates[0].slot}` : '');
  const [mode, setMode] = useState<'auto' | 'custom'>(target.port ? 'custom' : 'auto');
  const [port, setPort] = useState(target.port ? String(target.port) : '');
  const [busy, setBusy] = useState(false);
  const [taken, setTaken] = useState<{ message: string } | null>(null);

  const chosen = candidates.find((c) => `${c.s.id}:${c.slot}` === pick);
  const pair = chosen ? chosen.slot === 'geyserPort' || chosen.s.edition === 'bedrock' : false;
  const [lo, hi] = map.ranges[target.kind];
  const n = Number(port);
  const outside = mode === 'custom' && port !== '' && (n < lo || n + (pair ? 1 : 0) > hi);

  const submit = async (share = false) => {
    if (!chosen) return;
    if (mode === 'custom' && (!Number.isInteger(n) || n < 1024 || n > 65535)) return toast.error('Enter a port from 1024 to 65535');
    setBusy(true);
    try {
      await api.post(`/api/servers/${chosen.s.id}/ports`, { [chosen.slot]: mode === 'auto' ? 'auto' : n, share });
      qc.invalidateQueries({ queryKey: ['ports'] });
      qc.invalidateQueries({ queryKey: ['servers'] });
      toast.success(isActive(chosen.s.state) ? 'Port assigned. Restart the server to apply it.' : 'Port assigned');
      onClose();
    } catch (e) {
      if (e instanceof ApiError && e.data.code === 'PORT_ASSIGNED') setTaken({ message: e.message });
      else toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={target.server ? `Port for ${target.server.name}` : `Assign port ${target.port}`}
      footer={
        <>
          <button className="btn-secondary" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          {taken ? (
            <button className="btn-primary" onClick={() => submit(true)} disabled={busy}>
              {busy && <Spinner />}
              Share the port
            </button>
          ) : (
            <button className="btn-primary" onClick={() => submit()} disabled={busy || !chosen}>
              {busy && <Spinner />}
              Assign
            </button>
          )}
        </>
      }
    >
      {!candidates.length ? (
        <p className="text-sm text-muted">No server can use a port from this range yet.</p>
      ) : (
        <div className="space-y-4">
          {!target.server && (
            <Field label="Server">
              <select className="input" value={pick} onChange={(e) => { setPick(e.target.value); setTaken(null); }}>
                {candidates.map((c) => (
                  <option key={`${c.s.id}:${c.slot}`} value={`${c.s.id}:${c.slot}`}>
                    {c.label}
                  </option>
                ))}
              </select>
            </Field>
          )}
          {!target.port && (
            <Segmented value={mode} onChange={(v) => { setMode(v); setTaken(null); }} options={[{ value: 'auto', label: 'Next free port' }, { value: 'custom', label: 'Choose a port' }]} />
          )}
          {mode === 'custom' && (
            <Field label="Port" hint={pair ? `This takes two ports in a row: ${port || 'N'} and ${port ? n + 1 : 'N+1'}.` : undefined}>
              <input className="input w-40 font-mono" inputMode="numeric" autoFocus value={port} disabled={!!target.port} onChange={(e) => { setPort(e.target.value.replace(/\D/g, '')); setTaken(null); }} />
            </Field>
          )}
          {mode === 'auto' && <p className="text-sm text-muted">Blockhost picks the lowest port in {lo}–{hi} that no server holds.</p>}
          {outside && !map.hostNetwork && (
            <p className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-200">
              Port {n} is outside the published range {lo}–{hi}. Players can only reach it if you also publish it in docker-compose.yml.
            </p>
          )}
          {taken && (
            <p className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-200">
              {taken.message}. They can share it and take turns: only one can run at a time, and starting the second one asks which to stop.
            </p>
          )}
          {chosen && isActive(chosen.s.state) && <p className="text-xs text-muted">{chosen.s.name} is running, so the change applies when it restarts.</p>}
        </div>
      )}
    </Modal>
  );
}

export function Ports() {
  const qc = useQueryClient();
  const toast = useToast();
  const { data: servers } = useServers();
  const q = useQuery({ queryKey: ['ports'], queryFn: () => api.get<PortMap>('/api/ports'), refetchInterval: 15_000 });
  useWsEvent((ev: WsEvent) => {
    if (ev.type === 'server.changed' || ev.type === 'server.state') qc.invalidateQueries({ queryKey: ['ports'] });
  });
  const [assign, setAssign] = useState<AssignTarget | null>(null);
  const [releasing, setReleasing] = useState<string | null>(null);

  const map = q.data;
  if (!map || !servers) {
    return (
      <div className="flex justify-center py-20">
        <Spinner className="size-6" />
      </div>
    );
  }
  const byId = new Map(servers.map((s) => [s.id, s]));
  const usesOf = new Map(map.ports.map((p) => [p.port, p.uses]));
  const inRange = (port: number, [lo, hi]: [number, number]) => port >= lo && port <= hi;
  const outside = map.ports.filter((p) => !inRange(p.port, map.ranges.java) && !inRange(p.port, map.ranges.bedrock));

  const release = async (use: PortUse) => {
    setReleasing(use.serverId);
    try {
      await api.post(`/api/servers/${use.serverId}/ports/release`);
      qc.invalidateQueries({ queryKey: ['ports'] });
      qc.invalidateQueries({ queryKey: ['servers'] });
      toast.success(`${use.name} released its ports. It gets ports again when you start it.`);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setReleasing(null);
    }
  };

  const row = (port: number, rangeKind: RangeKind | null) => {
    const uses = usesOf.get(port) ?? [];
    // Ports outside the ranges belong to whichever range their server would normally draw from.
    const kind: RangeKind = rangeKind ?? (uses.some((u) => u.edition === 'bedrock' || u.slot === 'geyserPort') ? 'bedrock' : 'java');
    const status = statusOf(uses);
    const free = !uses.some((u) => !u.released);
    return (
      <tr key={port} className="border-t border-line/60 align-top">
        <td className="w-24 px-5 py-3 font-mono text-sm text-ink">{port}</td>
        <td className="w-36 px-2 py-3">
          <span className={clsx('chip', status.cls)}>{status.label}</span>
        </td>
        <td className="px-2 py-3">
          {uses.length === 0 && <span className="text-sm text-muted">Nobody</span>}
          <ul className="space-y-2">
            {uses.map((u) => (
              <li key={`${u.serverId}:${u.slot}:${u.role}`} className={clsx('flex flex-wrap items-center gap-x-3 gap-y-1 text-sm', u.released && 'opacity-60')}>
                <span className="flex min-w-0 items-center gap-2">
                  <StatusDot state={u.state} />
                  <Link to={`/servers/${u.serverId}`} className="truncate font-medium text-ink hover:underline">
                    {u.name}
                  </Link>
                </span>
                <span className="text-xs text-muted">
                  {u.released ? 'Released: free for others until this server starts again' : u.role}
                  {!u.released && u.protos.length > 0 && <span className="ml-1.5 font-mono uppercase">{u.protos.join(' + ')}</span>}
                </span>
                {u.primary && (
                  <span className="ml-auto flex gap-1.5">
                    <button className="btn-ghost btn-sm" onClick={() => setAssign({ server: byId.get(u.serverId), slot: u.slot, kind })}>
                      {u.released ? 'Assign' : 'Change'}
                    </button>
                    {!u.released && u.slot === 'port' && (
                      <button className="btn-ghost btn-sm" disabled={isActive(u.state) || releasing === u.serverId} title={isActive(u.state) ? 'Stop the server first' : 'Let other servers use this port'} onClick={() => release(u)}>
                        {releasing === u.serverId ? <Spinner /> : 'Release'}
                      </button>
                    )}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </td>
        <td className="w-28 px-5 py-3 text-right">
          {free && (
            <button className="btn-secondary btn-sm" onClick={() => setAssign({ kind, port })}>
              Assign
            </button>
          )}
        </td>
      </tr>
    );
  };

  const table = (kind: RangeKind | null, ports: number[]) => (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[640px] text-left">
        <thead>
          <tr className="text-[11px] uppercase tracking-wider text-muted">
            <th className="px-5 py-2.5 font-semibold">Port</th>
            <th className="px-2 py-2.5 font-semibold">Status</th>
            <th className="px-2 py-2.5 font-semibold">Server</th>
            <th className="px-5 py-2.5" />
          </tr>
        </thead>
        <tbody>{ports.map((p) => row(p, kind))}</tbody>
      </table>
    </div>
  );
  const span = ([lo, hi]: [number, number]) => Array.from({ length: hi - lo + 1 }, (_, i) => lo + i);
  const freeCount = (range: [number, number]) => span(range).filter((p) => !(usesOf.get(p) ?? []).some((u) => !u.released)).length;

  return (
    <div className="space-y-5">
      <div className="fade-up">
        <h1 className="text-2xl font-semibold tracking-tight">Ports</h1>
        <p className="mt-1 max-w-3xl text-sm text-muted">
          Every server holds its ports even while stopped. Change a port, share one between servers that take turns, or release a stopped server's ports so others can have them.
        </p>
      </div>

      <div className="fade-up flex gap-3 rounded-2xl border border-line bg-white/[0.03] p-4 text-sm text-muted">
        <Info className="mt-0.5 size-4 shrink-0 text-sky-300" />
        <p>
          {map.hostNetwork
            ? 'This install uses host networking, so any port on the machine can be used. The ranges below are only where automatic assignment looks.'
            : 'Only the ranges below are published by Docker. A port outside them works inside the container, but players cannot reach it unless you publish it yourself.'}{' '}
          Bedrock servers and cross-play take two ports in a row.
        </p>
      </div>

      {servers.length === 0 ? (
        <EmptyState icon={Cable} title="No servers yet" description="Ports show up here once you create a server." />
      ) : (
        <>
          <Card padded={false} title={`Java servers · TCP ${map.ranges.java[0]}–${map.ranges.java[1]}`} action={<span className="text-xs text-muted">{freeCount(map.ranges.java)} free</span>}>
            {table('java', span(map.ranges.java))}
          </Card>
          <Card padded={false} title={`Bedrock servers and cross-play · UDP + TCP ${map.ranges.bedrock[0]}–${map.ranges.bedrock[1]}`} action={<span className="text-xs text-muted">{freeCount(map.ranges.bedrock)} free</span>}>
            {table('bedrock', span(map.ranges.bedrock))}
          </Card>
          {outside.length > 0 && (
            <Card padded={false} title="Outside the ranges">
              {table(null, outside.map((p) => p.port))}
            </Card>
          )}
        </>
      )}

      {assign && <AssignModal target={assign} map={map} servers={servers} onClose={() => setAssign(null)} />}
    </div>
  );
}
