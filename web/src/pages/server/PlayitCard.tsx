import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { Copy, ExternalLink, Plus, Power, Radio, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../lib/api';
import { copy } from '../../lib/format';
import type { ServerPort, ServerSummary, ServerTunnels, WsEvent } from '../../lib/types';
import { useWsEvent } from '../../lib/ws';
import { Card, ConfirmModal, Spinner } from '../../components/ui';
import { useToast } from '../../components/Toast';
import { STATE_LABEL } from '../RemotePlay';

const portLabel = (p: ServerPort, edition: ServerSummary['edition']) =>
  p.kind === 'geyser' ? 'Bedrock (Geyser)' : edition === 'bedrock' ? 'Bedrock' : 'Java';

/** This server's playit tunnels, on its Settings tab. The agent itself is shared and managed on the Remote play page. */
export function PlayitCard({ s }: { s: ServerSummary }) {
  const qc = useQueryClient();
  const toast = useToast();
  const key = ['server-tunnels', s.id];
  const q = useQuery({ queryKey: key, queryFn: () => api.get<ServerTunnels>(`/api/servers/${s.id}/tunnels`), refetchInterval: 30_000 });
  useWsEvent((ev: WsEvent) => {
    if (ev.type === 'playit') qc.invalidateQueries({ queryKey: key });
  });
  const [del, setDel] = useState<ServerPort | null>(null);

  const done = () => {
    qc.invalidateQueries({ queryKey: key });
    qc.invalidateQueries({ queryKey: ['playit'] });
    qc.invalidateQueries({ queryKey: ['servers'] });
  };
  const fail = (e: Error) => toast.error(e.message);
  const create = useMutation({
    mutationFn: (kind: ServerPort['kind']) => api.post(`/api/servers/${s.id}/tunnel`, { kind }),
    onSuccess: () => (toast.success('Tunnel created'), done()),
    onError: fail,
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.del(`/api/playit/tunnels/${id}`),
    onSuccess: () => (toast.success('Tunnel deleted'), setDel(null), done()),
    onError: fail,
  });
  const enable = useMutation({ mutationFn: () => api.post('/api/playit/enable'), onSuccess: done, onError: fail });

  const d = q.data;
  const running = d?.agent.state === 'running';
  const busy = create.isPending || remove.isPending;

  return (
    <Card
      title={<span className="flex items-center gap-2"><Radio className="size-4 text-emerald-300" /> Remote play (playit)</span>}
      action={d && <span className={clsx('chip', STATE_LABEL[d.agent.state].cls)}>{STATE_LABEL[d.agent.state].label}</span>}
    >
      {!d ? (
        <div className="flex justify-center py-6">{q.error ? <p className="text-sm text-rose-300">{(q.error as Error).message}</p> : <Spinner />}</div>
      ) : (
        <div className="space-y-4">
          {!d.agent.enabled ? (
            <div className="space-y-3 text-sm text-muted">
              <p>Remote play is off. Turn on the playit agent to give this server a public address friends can join from anywhere.</p>
              <button className="btn-primary btn-sm" disabled={enable.isPending} onClick={() => enable.mutate()}>
                {enable.isPending ? <Spinner /> : <Power className="size-3.5" />} Turn on playit
              </button>
              <p className="text-xs">This turns on the shared agent for all servers.</p>
            </div>
          ) : d.agent.state === 'claiming' ? (
            <div className="space-y-3 rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 text-sm">
              <p className="font-medium text-amber-200">Link the agent to your playit account</p>
              <p className="text-amber-100/80">Open the claim link, sign in (free), and approve the agent. This only needs to happen once for all servers.</p>
              {d.agent.claimUrl ? (
                <div className="flex gap-2">
                  <a href={d.agent.claimUrl} target="_blank" rel="noreferrer" className="btn-primary btn-sm flex-1">
                    <ExternalLink className="size-3.5" /> Open claim page
                  </a>
                  <button className="btn-secondary btn-sm" onClick={() => copy(d.agent.claimUrl!).then(() => toast.success('Copied'))}>
                    <Copy className="size-3.5" />
                  </button>
                </div>
              ) : (
                <p className="flex items-center gap-2 text-amber-100/70"><Spinner /> Waiting for the agent to print a claim link…</p>
              )}
            </div>
          ) : !running ? (
            <p className="text-sm text-muted">
              {d.agent.error || 'The playit agent is not connected yet.'}{' '}
              <Link className="text-accent hover:underline" to="/remote">Open Remote play</Link>
            </p>
          ) : null}

          {running && d.tunnelsError && (
            <p className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-200">Could not read tunnels from playit: {d.tunnelsError}</p>
          )}

          {d.agent.enabled && (
            <ul className="divide-y divide-line/60 rounded-xl border border-line">
              {d.ports.map((p) => {
                const t = p.tunnel;
                return (
                  <li key={p.kind} className="flex flex-wrap items-center gap-3 px-4 py-3 text-sm">
                    <span className={clsx('size-1.5 shrink-0 rounded-full', t ? (t.active ? 'bg-emerald-400' : 'bg-rose-400') : 'bg-white/20')} />
                    <div className="min-w-0 flex-1">
                      <div className="text-xs text-muted">
                        {portLabel(p, s.edition)} · {p.protocol.toUpperCase()} {p.port}
                        {!p.inUse && <span className="ml-1 text-amber-300">· not used while cross-play is off</span>}
                      </div>
                      {t ? (
                        <div className="flex items-center gap-1">
                          <span className="truncate font-mono">{t.address || '(allocating…)'}</span>
                          {t.address && (
                            <button className="btn-ghost btn-sm" title="Copy address" onClick={() => copy(t.address!).then(() => toast.success('Address copied'))}>
                              <Copy className="size-3.5" />
                            </button>
                          )}
                        </div>
                      ) : (
                        <span className="text-muted">{d.tunnelsError ? 'Unknown' : 'No tunnel'}</span>
                      )}
                      {t?.disabledReason && <p className="text-xs text-rose-300">{t.disabledReason}</p>}
                    </div>
                    {t ? (
                      <button className="btn-ghost btn-sm text-rose-300" disabled={!running || busy} title="Delete tunnel" onClick={() => setDel(p)}>
                        <Trash2 className="size-3.5" />
                      </button>
                    ) : (
                      running && !d.tunnelsError && p.inUse && (
                        <button className="btn-secondary btn-sm" disabled={busy} onClick={() => create.mutate(p.kind)}>
                          {create.isPending && create.variables === p.kind ? <Spinner /> : <Plus className="size-3.5" />} Create tunnel
                        </button>
                      )
                    )}
                  </li>
                );
              })}
            </ul>
          )}

          {d.agent.enabled && (
            <p className="text-xs text-muted">
              The agent is shared by all servers. <Link className="text-accent hover:underline" to="/remote">Manage it on Remote play</Link>
            </p>
          )}
        </div>
      )}
      <ConfirmModal
        open={!!del}
        onClose={() => setDel(null)}
        onConfirm={() => del?.tunnel && remove.mutate(del.tunnel.id)}
        title="Delete this tunnel?"
        body={`Players using ${del?.tunnel?.address ?? 'this address'} will no longer be able to join. A new tunnel gets a different address.`}
        confirmLabel="Delete tunnel"
        danger
        busy={remove.isPending}
      />
    </Card>
  );
}
