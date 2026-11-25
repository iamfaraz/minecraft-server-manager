import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowUpCircle, RefreshCw } from 'lucide-react';
import { useState } from 'react';
import { api } from '../lib/api';
import { timeAgo } from '../lib/format';
import type { PackUpdateResult, ServerSummary, UpdateCheck } from '../lib/types';
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
  const [packPlan, setPackPlan] = useState<{ versionId: string; versionNumber: string; mc: string; changesMc: boolean } | null>(null);
  const [packResult, setPackResult] = useState<PackUpdateResult | null>(null);
  const packUpdate = useMutation({
    mutationFn: (versionId: string) => api.post<PackUpdateResult>(`/api/servers/${s.id}/modpack/update`, { versionId }),
    onSuccess: (r) => {
      setPackResult(r);
      setPackPlan(null);
      toast.success(`Updated to ${s.modpack?.title} ${r.to}`);
      qc.removeQueries({ queryKey: ['updates', s.id] });
      qc.invalidateQueries({ queryKey: ['servers'] });
    },
    onError: (e) => {
      setPackPlan(null);
      toast.error((e as Error).message);
    },
  });
  const packAction = async (path: 'skip' | 'mode', body: object, msg: string) => {
    try {
      await api.post(`/api/servers/${s.id}/modpack/${path}`, body);
      toast.success(msg);
      qc.invalidateQueries({ queryKey: ['servers'] });
      q.refetch();
    } catch (e) {
      toast.error((e as Error).message);
    }
  };
  const running = s.state === 'running' || s.state === 'starting';
  const busy = s.state === 'installing' || s.state === 'stopping' || apply.isPending || packUpdate.isPending;
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
          {s.modpack && (
            <div className="space-y-2 text-sm">
              {r.modpack?.available && r.modpack.latest ? (
                <>
                  <p className="text-amber-300">
                    A newer version of {s.modpack.title} is available: <span className="font-mono">{r.modpack.latest.versionNumber}</span>
                    {r.modpack.changesMcVersion ? ` (Minecraft ${r.modpack.latest.mc})` : ''}.
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <button className="btn-primary btn-sm" disabled={busy} onClick={() => setPackPlan({ versionId: r.modpack!.latest!.versionId, versionNumber: r.modpack!.latest!.versionNumber, mc: r.modpack!.latest!.mc, changesMc: r.modpack!.changesMcVersion })}>
                      {packUpdate.isPending ? <Spinner /> : <ArrowUpCircle className="size-3.5" />} Update
                    </button>
                    <button className="btn-secondary btn-sm" disabled={busy} onClick={() => packAction('skip', { versionId: r.modpack!.latest!.versionId }, `Skipped ${r.modpack!.latest!.versionNumber}`)}>
                      Skip this version
                    </button>
                    <button className="btn-ghost btn-sm" disabled={busy} onClick={() => packAction('mode', { mode: 'ignore' }, 'Pack update checks turned off. Turn them back on in Settings.')}>
                      Ignore updates
                    </button>
                  </div>
                </>
              ) : (
                <p className="text-muted">
                  {!s.modpack.projectId
                    ? "This pack isn't linked to Modrinth, so updates can't be checked."
                    : s.modpack.updates.mode === 'ignore'
                      ? 'Pack update checks are off. Turn them on in Settings.'
                      : `${s.modpack.title} ${s.modpack.versionNumber} is the newest version.`}
                </p>
              )}
            </div>
          )}
          {packResult && (
            <div className="rounded-xl border border-line bg-white/[0.02] p-3 text-xs">
              <p className="font-medium text-ink">
                {packResult.from} → {packResult.to}: {packResult.added} added, {packResult.updated} updated, {packResult.removed} removed, {packResult.configsUpdated} configs updated.
              </p>
              {packResult.configsKept.length > 0 && <p className="mt-1 text-muted">Kept your version of: {packResult.configsKept.join(', ')}</p>}
              {packResult.startError && <p className="mt-1 text-amber-300">The update is installed, but the server did not start: {packResult.startError}</p>}
              {packResult.adminKept.length > 0 && <p className="mt-1 text-muted">Left alone because you changed them: {packResult.adminKept.join(', ')}</p>}
            </div>
          )}
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
        open={!!packPlan}
        onClose={() => setPackPlan(null)}
        onConfirm={() => packPlan && packUpdate.mutate(packPlan.versionId)}
        title={`Update ${s.modpack?.title ?? 'the modpack'} to ${packPlan?.versionNumber}?`}
        confirmLabel={running ? 'Stop, update and start' : 'Update'}
        busy={packUpdate.isPending}
        body={
          <div className="space-y-2">
            <p>Everything is downloaded first; then the server is updated. Mods and configs you changed are kept. If anything fails, the server is put back the way it was.</p>
            {packPlan?.changesMc && <p className="text-amber-300">The world will be upgraded to Minecraft {packPlan.mc}. A full backup is taken first.</p>}
            {!packPlan?.changesMc && <p>A full backup is taken first.</p>}
            {running && <p className="text-amber-300">The server is running. Updating stops it, which disconnects everyone, and starts it again afterwards.</p>}
            <p className="text-muted">Players will need to update their copy of the pack too.</p>
          </div>
        }
      />
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
