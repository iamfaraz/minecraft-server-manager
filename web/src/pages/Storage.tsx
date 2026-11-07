import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { HardDrive, Trash2 } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { fmtBytes, timeAgo } from '../lib/format';
import type { StorageOverview } from '../lib/types';
import { Card, ConfirmModal, EditionBadge, Spinner, StatusDot } from '../components/ui';
import { useToast } from '../components/Toast';

/** A horizontal share bar: how much of the data folder each part takes. */
function Share({ parts, total }: { parts: { label: string; bytes: number; cls: string }[]; total: number }) {
  return (
    <div>
      <div className="flex h-3 w-full overflow-hidden rounded-full bg-white/5">
        {parts.map((p) => p.bytes > 0 && <div key={p.label} className={p.cls} style={{ width: `${Math.max(0.5, (p.bytes / Math.max(1, total)) * 100)}%` }} title={`${p.label}: ${fmtBytes(p.bytes)}`} />)}
      </div>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
        {parts.map((p) => (
          <span key={p.label} className="flex items-center gap-1.5">
            <span className={`inline-block size-2 rounded-sm ${p.cls}`} /> {p.label} {fmtBytes(p.bytes)}
          </span>
        ))}
      </div>
    </div>
  );
}

export function Storage() {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['storage'], queryFn: () => api.get<StorageOverview>('/api/storage'), refetchInterval: 30_000 });
  const [confirm, setConfirm] = useState<{ title: string; body: ReactNode; run: () => Promise<unknown> } | null>(null);
  const act = useMutation({
    mutationFn: (run: () => Promise<unknown>) => run(),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['storage'] });
      qc.invalidateQueries({ queryKey: ['imports'] });
      setConfirm(null);
      toast.success('Removed');
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const d = q.data;
  if (!d) {
    return (
      <div className="flex justify-center py-20">
        <Spinner className="size-6" />
      </div>
    );
  }
  const serversBytes = d.servers.reduce((n, s) => n + s.files + s.other, 0);
  const backupsBytes = d.servers.reduce((n, s) => n + s.backups, 0);
  const runtimesBytes = d.runtimes.reduce((n, r) => n + r.bytes, 0);
  const importsBytes = d.imports.reduce((n, i) => n + i.bytes, 0);
  const row = (label: ReactNode, bytes: number, action?: ReactNode, sub?: ReactNode) => (
    <div className="flex items-center gap-3 border-t border-line/60 py-2.5 first:border-0">
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm text-ink">{label}</div>
        {sub && <div className="truncate text-xs text-muted">{sub}</div>}
      </div>
      <span className="w-20 shrink-0 text-right font-mono text-sm text-muted">{fmtBytes(bytes)}</span>
      <span className="w-24 shrink-0 text-right">{action}</span>
    </div>
  );
  const trash = (title: string, body: ReactNode, run: () => Promise<unknown>, disabled?: string) => (
    <button className="btn-ghost btn-sm text-rose-300" disabled={!!disabled || act.isPending} title={disabled} onClick={() => setConfirm({ title, body, run })}>
      <Trash2 className="size-3.5" /> Clear
    </button>
  );

  return (
    <div className="space-y-5">
      <div className="fade-up">
        <h1 className="text-2xl font-semibold tracking-tight">Storage</h1>
        <p className="mt-1 text-sm text-muted">
          What the data folder holds, and what you can clear. Everything cleared here is either fetched again when needed or no longer in use.
        </p>
      </div>

      <Card title={<span className="flex items-center gap-2"><HardDrive className="size-4 text-sky-300" /> Data folder: {fmtBytes(d.total)}</span>} action={d.disk && <span className="text-xs text-muted">{fmtBytes(d.disk.free)} free of {fmtBytes(d.disk.total)} on this disk</span>}>
        <Share
          total={d.total}
          parts={[
            { label: 'Servers', bytes: serversBytes, cls: 'bg-emerald-400' },
            { label: 'Backups', bytes: backupsBytes, cls: 'bg-sky-400' },
            { label: 'Downloads', bytes: d.cache.bytes, cls: 'bg-amber-400' },
            { label: 'Runtimes', bytes: runtimesBytes, cls: 'bg-violet-400' },
            { label: 'Imports', bytes: importsBytes, cls: 'bg-pink-400' },
            { label: 'Other', bytes: Math.max(0, d.total - serversBytes - backupsBytes - d.cache.bytes - runtimesBytes - importsBytes), cls: 'bg-white/20' },
          ]}
        />
        <p className="mt-3 font-mono text-xs text-muted">{d.dataDir}</p>
      </Card>

      <Card title="Servers" padded={false}>
        <div className="px-5">
          {d.servers.map((s) =>
            row(
              <span className="flex items-center gap-2">
                <StatusDot state={s.state} />
                <Link to={`/servers/${s.id}`} className="font-medium hover:underline">
                  {s.name}
                </Link>
                <EditionBadge edition={s.edition} />
              </span>,
              s.files + s.backups + s.other,
              s.backupCount > 0 && trash(`Delete all ${s.backupCount} backups of ${s.name}?`, 'The world files are not touched, only the backups. This cannot be undone.', () => api.del(`/api/servers/${s.id}/backups`)),
              `${fmtBytes(s.files)} world and server files · ${fmtBytes(s.backups)} in ${s.backupCount} backup${s.backupCount === 1 ? '' : 's'}${s.other > 1024 * 1024 ? ` · ${fmtBytes(s.other)} other` : ''}`,
            ),
          )}
          {!d.servers.length && <p className="py-4 text-sm text-muted">No servers.</p>}
        </div>
      </Card>

      <Card
        title={`Downloaded server files · ${fmtBytes(d.cache.bytes)}`}
        padded={false}
        action={d.cache.files.length > 0 && trash('Clear all downloaded files?', 'Server jars, Bedrock archives and Java downloads are fetched again the next time a server is installed or updated.', () => api.del('/api/storage/cache'))}
      >
        <div className="px-5">
          {d.cache.files.map((f) => row(<span className="font-mono text-xs">{f.name}</span>, f.bytes, trash(`Delete ${f.name}?`, 'It is downloaded again if a server needs it.', () => api.del(`/api/storage/cache/${encodeURIComponent(f.name)}`)), `downloaded ${timeAgo(f.modifiedAt)}`))}
          {row('Item pictures for the inventory editor', d.icons, d.icons > 0 && trash('Clear item pictures?', 'They are fetched again as the inventory editor needs them.', () => api.del('/api/storage/icons')))}
        </div>
      </Card>

      <Card title={`Runtimes · ${fmtBytes(runtimesBytes)}`} padded={false}>
        <div className="px-5">
          {d.runtimes.map((r) => row(r.name, r.bytes, trash(`Remove ${r.name}?`, 'It is downloaded again the next time a server needs it.', () => api.del(`/api/storage/runtimes/${r.key}`), r.inUse ? 'In use by a running server' : undefined), r.inUse ? 'In use' : 'Downloaded on demand'))}
          {!d.runtimes.length && <p className="py-4 text-sm text-muted">Nothing downloaded; the bundled Java versions live in the image.</p>}
        </div>
      </Card>

      <Card title={`World imports · ${fmtBytes(importsBytes)}`} padded={false}>
        <div className="px-5">
          {d.imports.map((i) => row(<span className="flex items-center gap-2">{i.name} <EditionBadge edition={i.edition} /></span>, i.bytes, trash(`Delete the import "${i.name}"?`, 'Servers already created from it keep their copy of the world.', () => api.del(`/api/imports/${i.id}`)), `uploaded ${timeAgo(i.createdAt)}`))}
          {!d.imports.length && <p className="py-4 text-sm text-muted">No uploaded worlds waiting to be imported.</p>}
        </div>
      </Card>

      <ConfirmModal open={!!confirm} onClose={() => setConfirm(null)} onConfirm={() => confirm && act.mutate(confirm.run)} title={confirm?.title ?? ''} body={confirm?.body} confirmLabel="Delete" danger busy={act.isPending} />
    </div>
  );
}
