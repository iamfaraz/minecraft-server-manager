import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, ExternalLink, Globe2, Link2, Plus, RefreshCw, RotateCcw, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useServers } from '../hooks/useServers';
import { api } from '../lib/api';
import { copy } from '../lib/format';
import type { PlayitStatus, WsEvent } from '../lib/types';
import { useWsEvent } from '../lib/ws';
import { Card, EmptyState, Spinner, Toggle } from '../components/ui';
import { useToast } from '../components/Toast';
import { clsx } from 'clsx';

const STATE_LABEL: Record<PlayitStatus['state'], { label: string; cls: string }> = {
  disabled: { label: 'Disabled', cls: 'border-white/10 bg-white/5 text-muted' },
  installing: { label: 'Installing agent', cls: 'border-sky-500/30 bg-sky-500/10 text-sky-300' },
  starting: { label: 'Starting', cls: 'border-amber-500/30 bg-amber-500/10 text-amber-300' },
  claiming: { label: 'Waiting for claim', cls: 'border-amber-500/30 bg-amber-500/10 text-amber-300' },
  running: { label: 'Connected', cls: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300' },
  stopped: { label: 'Stopped', cls: 'border-white/10 bg-white/5 text-muted' },
  error: { label: 'Error', cls: 'border-rose-500/30 bg-rose-500/10 text-rose-300' },
};

export function RemotePlay() {
  const qc = useQueryClient();
  const toast = useToast();
  const { data: servers } = useServers();
  const q = useQuery({ queryKey: ['playit'], queryFn: () => api.get<PlayitStatus>('/api/playit'), refetchInterval: 15_000 });
  useWsEvent((ev: WsEvent) => {
    if (ev.type === 'playit') qc.setQueryData(['playit'], ev.status);
  });
  const [tunnelServer, setTunnelServer] = useState('');
  const [tunnelKind, setTunnelKind] = useState<'game' | 'geyser'>('game');

  const act = useMutation({
    mutationFn: (path: string) => api.post<PlayitStatus>(path),
    onSuccess: (d) => qc.setQueryData(['playit'], d),
    onError: (e) => toast.error((e as Error).message),
  });
  const createTunnel = useMutation({
    mutationFn: () => api.post(`/api/servers/${tunnelServer}/tunnel`, { kind: tunnelKind }),
    onSuccess: () => {
      toast.success('Tunnel created');
      qc.invalidateQueries({ queryKey: ['playit'] });
      qc.invalidateQueries({ queryKey: ['servers'] });
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const delTunnel = useMutation({
    mutationFn: (id: string) => api.del<PlayitStatus>(`/api/playit/tunnels/${id}`),
    onSuccess: (d) => {
      qc.setQueryData(['playit'], d);
      qc.invalidateQueries({ queryKey: ['servers'] });
    },
    onError: (e) => toast.error((e as Error).message),
  });

  const s = q.data;
  const serverForPort = (port: number | null) => servers?.find((x) => x.port === port || (x.geyser && x.geyserPort === port));
  const selected = servers?.find((x) => x.id === tunnelServer);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Remote play</h1>
        <p className="mt-1 max-w-2xl text-sm text-muted">
          Let friends join from anywhere without port forwarding. The <a className="text-accent hover:underline" href="https://playit.gg" target="_blank" rel="noreferrer">playit.gg</a> agent runs inside this container and tunnels traffic to your servers over an outbound connection.
        </p>
      </div>

      <div className="grid gap-5 lg:grid-cols-3">
        <Card className="lg:col-span-1" title="Agent">
          {!s ? (
            <div className="flex justify-center py-8">
              <Spinner />
            </div>
          ) : (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <span className={clsx('chip', STATE_LABEL[s.state].cls)}>{STATE_LABEL[s.state].label}</span>
                {s.state === 'running' && (
                  <button className="btn-ghost btn-sm" onClick={() => act.mutate('/api/playit/refresh')} title="Refresh tunnels">
                    <RefreshCw className={clsx('size-3.5', act.isPending && 'animate-spin')} />
                  </button>
                )}
              </div>
              <Toggle checked={s.enabled} onChange={(v) => act.mutate(v ? '/api/playit/enable' : '/api/playit/disable')} label="Enable playit tunnels" description="Downloads and runs the official playit agent." disabled={act.isPending} />
              {s.state === 'claiming' && (
                <div className="space-y-3 rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 text-sm">
                  <p className="font-medium text-amber-200">Link this agent to your playit account</p>
                  <p className="text-amber-100/80">Open the claim link, sign in (free), and approve the agent. This only needs to happen once.</p>
                  {s.claimUrl ? (
                    <div className="flex gap-2">
                      <a href={s.claimUrl} target="_blank" rel="noreferrer" className="btn-primary btn-sm flex-1">
                        <ExternalLink className="size-3.5" /> Open claim page
                      </a>
                      <button className="btn-secondary btn-sm" onClick={() => copy(s.claimUrl!).then(() => toast.success('Copied'))}>
                        <Copy className="size-3.5" />
                      </button>
                    </div>
                  ) : (
                    <p className="flex items-center gap-2 text-amber-100/70">
                      <Spinner /> Waiting for the agent to print a claim link…
                    </p>
                  )}
                </div>
              )}
              {s.error && <p className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-200">{s.error}</p>}
              {s.enabled && (
                <button className="btn-ghost btn-sm w-full text-muted" onClick={() => confirm('Forget this agent and claim again?') && act.mutate('/api/playit/reset')}>
                  <RotateCcw className="size-3.5" /> Re-claim agent
                </button>
              )}
            </div>
          )}
        </Card>

        <Card
          className="lg:col-span-2"
          title="Tunnels"
          action={
            s?.state === 'running' && (
              <div className="flex items-center gap-2">
                <select className="input py-1.5 text-xs" value={tunnelServer} onChange={(e) => setTunnelServer(e.target.value)}>
                  <option value="">Choose server…</option>
                  {servers?.map((x) => (
                    <option key={x.id} value={x.id}>
                      {x.name}
                    </option>
                  ))}
                </select>
                {selected?.geyser && (
                  <select className="input py-1.5 text-xs" value={tunnelKind} onChange={(e) => setTunnelKind(e.target.value as 'game' | 'geyser')}>
                    <option value="game">Java port</option>
                    <option value="geyser">Geyser (Bedrock) port</option>
                  </select>
                )}
                <button className="btn-primary btn-sm" disabled={!tunnelServer || createTunnel.isPending} onClick={() => createTunnel.mutate()}>
                  {createTunnel.isPending ? <Spinner /> : <Plus className="size-3.5" />} Create tunnel
                </button>
              </div>
            )
          }
          padded={false}
        >
          {!s || s.state !== 'running' ? (
            <EmptyState icon={Globe2} title="Agent not connected" description={s?.enabled ? 'Tunnels appear here once the agent is claimed and connected.' : 'Enable the agent to create tunnels.'} />
          ) : s.tunnels.length === 0 ? (
            <EmptyState icon={Link2} title="No tunnels yet" description={s.tunnelsError ? `Could not list tunnels: ${s.tunnelsError}. You can still manage tunnels on playit.gg.` : 'Create a tunnel for a server to get a public address players can use.'} action={<a className="btn-secondary btn-sm" href="https://playit.gg/account/tunnels" target="_blank" rel="noreferrer"><ExternalLink className="size-3.5" /> Open playit dashboard</a>} />
          ) : (
            <table className="w-full text-sm">
              <thead className="text-left text-[11px] uppercase tracking-wider text-muted">
                <tr className="border-b border-line">
                  <th className="px-5 py-2.5 font-medium">Public address</th>
                  <th className="px-3 py-2.5 font-medium">Type</th>
                  <th className="px-3 py-2.5 font-medium">Routes to</th>
                  <th className="px-3 py-2.5 font-medium" />
                </tr>
              </thead>
              <tbody>
                {s.tunnels.map((t) => {
                  const srv = serverForPort(t.localPort);
                  return (
                    <tr key={t.id} className="border-b border-line/60 last:border-0">
                      <td className="px-5 py-3">
                        <div className="flex items-center gap-2">
                          <span className={clsx('size-1.5 rounded-full', t.active ? 'bg-emerald-400' : 'bg-rose-400')} />
                          <span className="font-mono">{t.address || '(allocating…)'}</span>
                          {t.address && (
                            <button className="btn-ghost btn-sm" onClick={() => copy(t.address!).then(() => toast.success('Address copied'))}>
                              <Copy className="size-3.5" />
                            </button>
                          )}
                        </div>
                        {t.disabledReason && <p className="text-xs text-rose-300">{t.disabledReason}</p>}
                      </td>
                      <td className="px-3 py-3 text-muted">{t.tunnelType || t.portType}</td>
                      <td className="px-3 py-3 text-muted">
                        {srv ? <span className="text-ink">{srv.name}</span> : <span>127.0.0.1:{t.localPort}</span>}
                        {srv && srv.geyser && srv.geyserPort === t.localPort && <span className="ml-1 text-xs">(Geyser)</span>}
                      </td>
                      <td className="px-3 py-3 text-right">
                        <button className="btn-ghost btn-sm text-rose-300" onClick={() => confirm('Delete this tunnel?') && delTunnel.mutate(t.id)}>
                          <Trash2 className="size-3.5" />
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </Card>
      </div>

      {s?.enabled && (
        <Card title="Agent log" padded={false}>
          <pre className="max-h-72 overflow-auto p-4 font-mono text-xs leading-relaxed text-muted">{s.log.length ? s.log.join('\n') : 'No output yet.'}</pre>
        </Card>
      )}

      <Card title="Other ways to play remotely">
        <ul className="space-y-2 text-sm text-muted">
          <li>
            <span className="text-ink">Port forwarding.</span> Forward the server's port on your router to this machine. Java uses TCP, Bedrock uses UDP (two consecutive ports). Players connect to your public IP.
          </li>
          <li>
            <span className="text-ink">VPN meshes</span> such as Tailscale or ZeroTier work with the LAN address shown on each server.
          </li>
          <li>
            <span className="text-ink">Other tunnel providers</span> (ngrok TCP, Cloudflare Tunnel with WARP) can target the same local ports; run their agent alongside this container.
          </li>
        </ul>
      </Card>
    </div>
  );
}
