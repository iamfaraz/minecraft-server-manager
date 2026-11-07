import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowUpCircle, RefreshCw } from 'lucide-react';
import { useState } from 'react';
import { api } from '../lib/api';
import { timeAgo } from '../lib/format';
import type { ServerSummary, UpdateCheck } from '../lib/types';
import { Card, ConfirmModal, Spinner } from './ui';
import { useToast } from './Toast';

/** Checks on demand whether a newer server executable exists, and installs it. */
export function UpdatesCard({ s }: { s: ServerSummary }) {
  const toast = useToast();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['updates', s.id], queryFn: () => api.get<UpdateCheck>(`/api/servers/${s.id}/updates`), enabled: false, retry: false });
  const [plan, setPlan] = useState<{ target: 'build' | 'version'; version?: string; label: string } | null>(null);
  const apply = useMutation({
    mutationFn: (p: { target: 'build' | 'version'; version?: string }) => api.post<{ wasRunning: boolean }>(`/api/servers/${s.id}/updates/apply`, p),
    onSuccess: (r) => {
      toast.success(r.wasRunning ? 'Stopping the server, installing, then starting it again. Follow the console.' : 'Installing. Follow the console.');
      setPlan(null);
      qc.removeQueries({ queryKey: ['updates', s.id] });
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const running = s.state === 'running' || s.state === 'starting';
  const busy = s.state === 'installing' || s.state === 'stopping' || apply.isPending;
  const r = q.data;

  return (
    <Card
      title="Updates"
      action={
        <button className="btn-secondary btn-sm" disabled={q.isFetching || busy} onClick={() => q.refetch()}>
          {q.isFetching ? <Spinner /> : <RefreshCw className="size-3.5" />} Check for updates
        </button>
      }
    >
      {q.error ? (
        <p className="text-sm text-rose-300">{(q.error as Error).message}</p>
      ) : !r ? (
        <p className="text-sm text-muted">Compares what is installed with what the download servers offer. Nothing is checked until you ask.</p>
      ) : (
        <div className="space-y-3">
          {r.build && (
            <div className="flex flex-wrap items-center gap-3 text-sm">
              <span className={r.build.available ? 'text-amber-300' : 'text-muted'}>
                {r.build.available ? `A newer build is available: ${r.build.label}.` : r.build.label.endsWith('.') ? r.build.label : `${r.build.label}.`}
              </span>
              {(r.build.available || r.build.unknown) && (
                <button className="btn-primary btn-sm ml-auto" disabled={busy} onClick={() => setPlan({ target: 'build', label: r.build!.available ? `the newest build of ${s.version}` : `${s.version} again, which fetches the newest build` })}>
                  <ArrowUpCircle className="size-3.5" /> {r.build.available ? 'Install' : 'Reinstall'}
                </button>
              )}
            </div>
          )}
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <span className={r.version.available ? 'text-amber-300' : 'text-muted'}>{r.version.available ? `A newer version is available: ${r.version.label}.` : `${r.version.label}.`}</span>
            {r.version.available && (
              <button className="btn-primary btn-sm ml-auto" disabled={busy} onClick={() => setPlan({ target: 'version', version: r.version.latest!, label: r.version.label })}>
                <ArrowUpCircle className="size-3.5" /> Update to {r.version.latest}
              </button>
            )}
          </div>
          <p className="text-xs text-muted">Checked {timeAgo(r.checkedAt)}.</p>
        </div>
      )}
      <ConfirmModal
        open={!!plan}
        onClose={() => setPlan(null)}
        onConfirm={() => plan && apply.mutate({ target: plan.target, version: plan.version })}
        title={plan?.target === 'version' ? `Update to ${plan.label}?` : 'Install the update?'}
        confirmLabel={running ? 'Stop, update and start' : 'Install'}
        busy={apply.isPending}
        body={
          <div className="space-y-2">
            <p>This installs {plan?.label}.</p>
            {running && (
              <p className="text-amber-300">
                The server is running. Installing stops it, which disconnects everyone, and starts it again when the install is done.
              </p>
            )}
            {plan?.target === 'version' && <p>Moving to a new Minecraft version upgrades the world on first start, which cannot be undone. A backup of the world is taken first.</p>}
          </div>
        }
      />
    </Card>
  );
}
