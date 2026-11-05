import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { Copy, ExternalLink, Gamepad2, LogOut, RotateCw } from 'lucide-react';
import { useState } from 'react';
import { api } from '../../lib/api';
import { copy } from '../../lib/format';
import type { ServerSummary, WsEvent } from '../../lib/types';
import { useWsEvent } from '../../lib/ws';
import { Card, Spinner, Toggle } from '../../components/ui';
import { useToast } from '../../components/Toast';

export interface BroadcastStatus {
  enabled: boolean;
  state: 'off' | 'waiting' | 'installing' | 'starting' | 'auth' | 'online' | 'error';
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

const STATE: Record<BroadcastStatus['state'], { label: string; cls: string }> = {
  off: { label: 'Off', cls: 'border-white/10 bg-white/5 text-muted' },
  waiting: { label: 'Waiting for server', cls: 'border-white/10 bg-white/5 text-muted' },
  installing: { label: 'Downloading', cls: 'border-sky-500/30 bg-sky-500/10 text-sky-300' },
  starting: { label: 'Connecting to Xbox Live', cls: 'border-amber-500/30 bg-amber-500/10 text-amber-300' },
  auth: { label: 'Sign-in required', cls: 'border-amber-500/30 bg-amber-500/10 text-amber-300' },
  online: { label: 'Live on Xbox', cls: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300' },
  error: { label: 'Error', cls: 'border-rose-500/30 bg-rose-500/10 text-rose-300' },
};

/** Per-server toggle that lets Switch / Xbox / PlayStation players join through the Xbox Live Friends tab. */
export function ConsoleBroadcast({ s }: { s: ServerSummary }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [showLog, setShowLog] = useState(false);
  const q = useQuery({ queryKey: ['broadcast', s.id], queryFn: () => api.get<BroadcastStatus>(`/api/servers/${s.id}/broadcast`), refetchInterval: 20_000 });
  useWsEvent((ev: WsEvent) => {
    if (ev.type === 'broadcast' && ev.id === s.id) qc.setQueryData(['broadcast', s.id], ev.status);
  });
  const set = useMutation({
    mutationFn: (body: { enabled: boolean; switchTransport?: boolean }) => api.post<BroadcastStatus>(`/api/servers/${s.id}/broadcast`, body),
    onSuccess: (d, v) => {
      qc.setQueryData(['broadcast', s.id], d);
      qc.invalidateQueries({ queryKey: ['servers'] });
      if (v.switchTransport) toast.success('Switched to NetherNet. Restart the server to apply, then the broadcast starts.');
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const act = useMutation({
    mutationFn: (a: 'restart' | 'signout') => api.post<BroadcastStatus>(`/api/servers/${s.id}/broadcast/${a}`),
    onSuccess: (d) => qc.setQueryData(['broadcast', s.id], d),
    onError: (e) => toast.error((e as Error).message),
  });

  const b = q.data;
  const viaGeyser = s.edition === 'java';
  const needsTransport = !viaGeyser && s.transport !== 'nethernet';

  return (
    <Card
      title={
        <span className="flex items-center gap-2">
          <Gamepad2 className="size-4 text-emerald-300" /> Console players (Switch, Xbox, PlayStation)
          {b && b.enabled && <span className={clsx('chip', STATE[b.state].cls)}>{STATE[b.state].label}</span>}
        </span>
      }
    >
      {!b ? (
        <div className="flex justify-center py-6">
          <Spinner />
        </div>
      ) : (
        <div className="space-y-4 text-sm">
          <Toggle
            checked={b.enabled}
            disabled={set.isPending}
            onChange={(v) => set.mutate({ enabled: v, switchTransport: v && needsTransport })}
            label="Show this server in the Xbox Live Friends tab"
            description={
              needsTransport && !b.enabled
                ? 'Consoles cannot enter a server address. Turning this on switches the server to the NetherNet transport and broadcasts it through a Microsoft account.'
                : viaGeyser
                  ? 'Consoles cannot enter a server address. A Microsoft account you sign in below advertises this server through Geyser; its friends can join from the Friends tab.'
                  : 'Consoles cannot enter a server address. A Microsoft account you sign in below advertises this server; its friends can join from the Friends tab.'
            }
          />

          {b.enabled && s.state !== 'running' && <p className="text-muted">The broadcast starts automatically when the server is running{needsTransport ? ' on NetherNet' : ''}.</p>}

          {b.enabled && b.state === 'auth' && b.authCode && (
            <div className="space-y-3 rounded-xl border border-amber-500/30 bg-amber-500/10 p-4">
              <p className="font-medium text-amber-200">Sign in with the Microsoft account that will host the session</p>
              <p className="text-amber-100/80">Use a spare account rather than your main one. Open the link and enter this code:</p>
              <div className="flex flex-wrap items-center gap-2">
                <code className="rounded-lg border border-amber-500/40 bg-black/40 px-4 py-2 font-mono text-lg tracking-[0.25em] text-amber-100">{b.authCode}</code>
                <button className="btn-secondary btn-sm" onClick={() => copy(b.authCode!).then(() => toast.success('Code copied'))}>
                  <Copy className="size-3.5" /> Copy
                </button>
                <a className="btn-primary btn-sm" href={b.authUrl || 'https://www.microsoft.com/link'} target="_blank" rel="noreferrer">
                  <ExternalLink className="size-3.5" /> Open {(b.authUrl || 'microsoft.com/link').replace(/^https?:\/\/(www\.)?/, '')}
                </a>
              </div>
              <p className="text-xs text-amber-100/70">The code expires after about 15 minutes; restart the broadcast for a new one. Sign in with a password, not a passwordless method.</p>
            </div>
          )}

          {b.enabled && b.state === 'online' && (
            <div className="space-y-2 rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-4">
              <p className="font-medium text-emerald-200">Live{b.gamertag ? <> as <span className="font-mono">{b.gamertag}</span></> : ''}</p>
              <ol className="list-decimal space-y-1 pl-5 text-emerald-100/80">
                <li>On the console, add {b.gamertag ? <span className="font-mono text-emerald-100">{b.gamertag}</span> : 'the signed-in account'} as a friend (requests are accepted automatically).</li>
                <li>Open Minecraft → Play → Friends. This server appears under joinable friends within a minute.</li>
                <li>Switch needs a linked Microsoft account and Nintendo Switch Online.</li>
              </ol>
            </div>
          )}

          {b.enabled && b.gamertag && b.state !== 'online' && b.state !== 'auth' && <p className="text-muted">Signed in as <span className="font-mono text-ink">{b.gamertag}</span>.</p>}
          {b.warning && b.enabled && <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">{b.warning}</p>}
          {b.error && b.enabled && <p className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-200">{b.error}</p>}

          {b.enabled && (
            <div className="flex flex-wrap items-center gap-2">
              <button className="btn-secondary btn-sm" disabled={act.isPending || s.state !== 'running'} onClick={() => act.mutate('restart')}>
                <RotateCw className={clsx('size-3.5', act.isPending && 'animate-spin')} /> Restart broadcast
              </button>
              {b.signedIn && (
                <button className="btn-ghost btn-sm" disabled={act.isPending} onClick={() => confirm('Forget the Microsoft account used for this server?') && act.mutate('signout')}>
                  <LogOut className="size-3.5" /> Sign out account
                </button>
              )}
              <button className="btn-ghost btn-sm" onClick={() => setShowLog(!showLog)}>
                {showLog ? 'Hide' : 'Show'} log
              </button>
            </div>
          )}
          {showLog && b.enabled && <pre className="max-h-56 overflow-auto rounded-xl border border-line bg-black/30 p-3 font-mono text-[11px] leading-relaxed text-muted">{b.log.length ? b.log.join('\n') : 'No output yet.'}</pre>}

          <p className="text-xs text-muted">
            Powered by{' '}
            <a className="text-accent hover:underline" href="https://github.com/MCXboxBroadcast/Broadcaster" target="_blank" rel="noreferrer">
              MCXboxBroadcast
            </a>{' '}
            {b.version}. It emulates parts of a game client on Xbox Live, so its authors recommend an alternate account. Players on your network connect straight to this machine; remote players also need the server's UDP port reachable from the internet.
          </p>
        </div>
      )}
    </Card>
  );
}
