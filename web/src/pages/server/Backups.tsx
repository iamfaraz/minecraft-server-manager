import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Archive, Download, Flame, Plus, RotateCcw, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { api } from '../../lib/api';
import { fmtBytes, fmtDate } from '../../lib/format';
import type { BackupMeta, BackupScope, ServerSummary, WsEvent } from '../../lib/types';
import { useWsEvent } from '../../lib/ws';
import { Card, ConfirmModal, EmptyState, Field, Segmented, Spinner } from '../../components/ui';
import { useToast } from '../../components/Toast';

export function Backups({ s }: { s: ServerSummary }) {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['backups', s.id], queryFn: () => api.get<{ backups: BackupMeta[] }>(`/api/servers/${s.id}/backups`) });
  useWsEvent((ev: WsEvent) => {
    if (ev.type === 'backup.changed' && ev.id === s.id) qc.invalidateQueries({ queryKey: ['backups', s.id] });
  });
  const [label, setLabel] = useState('');
  const [scope, setScope] = useState<BackupScope>('world');
  const [restore, setRestore] = useState<BackupMeta | null>(null);

  const create = useMutation({
    mutationFn: () => api.post<BackupMeta>(`/api/servers/${s.id}/backups`, { label: label.trim() || undefined, scope }),
    onSuccess: (m) => {
      toast.success(`Backup created (${fmtBytes(m.bytes)})`);
      setLabel('');
      qc.invalidateQueries({ queryKey: ['backups', s.id] });
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const del = useMutation({
    mutationFn: (id: string) => api.del(`/api/servers/${s.id}/backups/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['backups', s.id] }),
    onError: (e) => toast.error((e as Error).message),
  });
  const doRestore = useMutation({
    mutationFn: (id: string) => api.post(`/api/servers/${s.id}/backups/${id}/restore`),
    onSuccess: () => {
      toast.success('Backup restored');
      setRestore(null);
    },
    onError: (e) => toast.error((e as Error).message),
  });

  const running = s.state === 'running';
  return (
    <div className="fade-up grid gap-5 lg:grid-cols-3">
      <Card title="Create backup" className="lg:col-span-1">
        <div className="space-y-4">
          <Field label="Label (optional)">
            <input className="input" placeholder="before-the-big-build" value={label} onChange={(e) => setLabel(e.target.value)} />
          </Field>
          <Field label="Scope">
            <Segmented value={scope} onChange={setScope} options={[{ value: 'world', label: 'World only' }, { value: 'full', label: 'Full server' }]} className="w-full" />
          </Field>
          <p className="text-xs text-muted">
            {running ? (
              <>
                <Flame className="mr-1 inline size-3.5 text-amber-300" />
                Hot backup: the server is told to flush and pause saving ({s.edition === 'java' ? 'save-off / save-all flush' : 'save hold / save query'}) while files are copied, then resumes. Players stay connected.
              </>
            ) : (
              'The server is offline, so files are copied directly.'
            )}
          </p>
          <button className="btn-primary w-full" disabled={create.isPending || s.state === 'installing'} onClick={() => create.mutate()}>
            {create.isPending ? <Spinner /> : <Plus className="size-4" />} {create.isPending ? 'Backing up…' : 'Back up now'}
          </button>
        </div>
      </Card>

      <Card title={`Backups (${q.data?.backups.length ?? 0})`} className="lg:col-span-2" padded={false}>
        {q.isLoading ? (
          <div className="flex justify-center py-12">
            <Spinner />
          </div>
        ) : !q.data?.backups.length ? (
          <EmptyState icon={Archive} title="No backups yet" description="Create one manually or enable a schedule under Settings." />
        ) : (
          <ul className="divide-y divide-line/60">
            {q.data.backups.map((b) => (
              <li key={b.id} className="flex flex-wrap items-center gap-3 px-5 py-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="truncate text-sm font-medium">{b.label}</p>
                    <span className="chip border-white/10 bg-white/5 text-muted">{b.scope}</span>
                    {b.auto && <span className="chip border-sky-500/30 bg-sky-500/10 text-sky-300">scheduled</span>}
                    {b.hot && <span className={b.consistent ? 'chip border-emerald-500/30 bg-emerald-500/10 text-emerald-300' : 'chip border-amber-500/30 bg-amber-500/10 text-amber-300'}>{b.consistent ? 'hot · consistent' : 'hot · unverified'}</span>}
                  </div>
                  <p className="text-xs text-muted">
                    {fmtDate(b.createdAt)} · {fmtBytes(b.bytes)} · {b.type} {b.version} · {b.levelName}
                    {b.note ? ` · ${b.note}` : ''}
                  </p>
                </div>
                <div className="flex items-center gap-1">
                  <a className="btn-ghost btn-sm" href={`/api/servers/${s.id}/backups/${b.id}/download`} title="Download">
                    <Download className="size-3.5" />
                  </a>
                  <button className="btn-ghost btn-sm" title="Restore" disabled={running || s.state === 'starting'} onClick={() => setRestore(b)}>
                    <RotateCcw className="size-3.5" />
                  </button>
                  <button className="btn-ghost btn-sm text-rose-300" title="Delete" onClick={() => confirm(`Delete backup "${b.label}"?`) && del.mutate(b.id)}>
                    <Trash2 className="size-3.5" />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
        {running && <p className="border-t border-line px-5 py-2 text-xs text-muted">Stop the server to restore a backup.</p>}
      </Card>

      <ConfirmModal
        open={!!restore}
        onClose={() => setRestore(null)}
        onConfirm={() => restore && doRestore.mutate(restore.id)}
        title={`Restore "${restore?.label}"?`}
        body={restore?.scope === 'world' ? `The current world "${s.levelName}" will be replaced with the backup from ${fmtDate(restore?.createdAt)}. Consider taking a backup of the current state first.` : `All server files will be overwritten with the backup from ${fmtDate(restore?.createdAt)}.`}
        confirmLabel="Restore"
        danger
        busy={doRestore.isPending}
      />
    </div>
  );
}
