import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { ArrowUpCircle, Copy, RefreshCw, Search, Wrench } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../../lib/api';
import { JAVA_TYPES, TYPE_LABEL, type JavaType, type ServerSummary, type ServerType } from '../../lib/types';
import { Card, ConfirmModal, Spinner, Toggle } from '../../components/ui';
import { useToast } from '../../components/Toast';

export function Versions({ s }: { s: ServerSummary }) {
  const qc = useQueryClient();
  const toast = useToast();
  const nav = useNavigate();
  const java = s.edition === 'java';
  const [type, setType] = useState<ServerType>(s.type);
  const [picked, setPicked] = useState<string>('');
  const [filter, setFilter] = useState('');
  const [snapshots, setSnapshots] = useState(false);
  const [backupFirst, setBackupFirst] = useState(true);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [custom, setCustom] = useState('');

  const jv = useQuery({
    queryKey: ['versions', 'java', type],
    queryFn: () => api.get<{ versions: string[]; latest: string | null; snapshots?: string[] }>(`/api/versions/java?type=${type}`),
    enabled: java,
    staleTime: 600_000,
  });
  const bv = useQuery({ queryKey: ['versions', 'bedrock'], queryFn: () => api.get<{ latest: { version: string } | null; preview: { version: string } | null }>('/api/versions/bedrock'), enabled: !java, staleTime: 600_000 });

  const list = useMemo(() => {
    const all = [...(jv.data?.versions || []), ...(snapshots ? jv.data?.snapshots || [] : [])];
    return filter ? all.filter((v) => v.includes(filter)) : all;
  }, [jv.data, filter, snapshots]);

  const target = picked || custom;
  const isCurrent = target === s.version && type === s.type;
  const newer = java && jv.data ? jv.data.versions.indexOf(target) !== -1 && jv.data.versions.indexOf(target) < jv.data.versions.indexOf(s.version) : false;
  const latestAvailable = java ? jv.data?.latest : bv.data?.latest?.version;
  const upToDate = latestAvailable === s.version;

  const update = useMutation({
    mutationFn: () => api.post(`/api/servers/${s.id}/version`, { version: target, type, backupFirst }),
    onSuccess: () => {
      toast.success('Update started — follow progress at the top of the page');
      setConfirmOpen(false);
      qc.invalidateQueries({ queryKey: ['servers'] });
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const reinstall = useMutation({
    mutationFn: () => api.post(`/api/servers/${s.id}/reinstall`),
    onSuccess: () => toast.success('Reinstalling server binaries'),
    onError: (e) => toast.error((e as Error).message),
  });

  const busy = s.state === 'installing';

  return (
    <div className="fade-up grid gap-5 lg:grid-cols-5">
      <div className="space-y-5 lg:col-span-2">
        <Card title="Installed">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-lg font-semibold">
                {TYPE_LABEL[s.type]} <span className="font-mono">{s.version}</span>
              </p>
              <p className="text-xs text-muted">
                {s.build?.loaderVersion ? `loader ${s.build.loaderVersion} · ` : ''}
                installed {s.build?.installedAt ? new Date(s.build.installedAt).toLocaleDateString() : '—'}
              </p>
            </div>
            {latestAvailable && (
              <span className={clsx('chip', upToDate ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300' : 'border-amber-500/30 bg-amber-500/10 text-amber-300')}>{upToDate ? 'Up to date' : `${latestAvailable} available`}</span>
            )}
          </div>
          <button className="btn-ghost btn-sm mt-4 text-muted" disabled={busy || reinstall.isPending} onClick={() => confirm('Re-download and reinstall the current version? Worlds and configs are kept.') && reinstall.mutate()}>
            <Wrench className="size-3.5" /> Repair / reinstall current version
          </button>
        </Card>

        <Card title="How updates work">
          <ul className="space-y-2 text-sm text-muted">
            <li>
              <span className="text-ink">Update in place</span> stops the server, backs up the world, swaps the server binaries and restarts. {java ? 'Worlds, server.properties, plugins and mods stay.' : 'Worlds, server.properties, allowlist and permissions stay.'}
            </li>
            <li>
              <span className="text-ink">New server from this world</span> creates a separate server on the new version and copies this world into it, so you can test before switching players over.
            </li>
            {java && <li>Downgrading a world to an older Minecraft version is not supported by the game and will usually fail to load.</li>}
          </ul>
        </Card>
      </div>

      <Card className="lg:col-span-3" title="Choose a version" padded={false} action={java && jv.data?.snapshots?.length ? <button className={clsx('text-xs', snapshots ? 'text-accent' : 'text-muted hover:text-ink')} onClick={() => setSnapshots(!snapshots)}>{snapshots ? 'Hide' : 'Show'} snapshots</button> : undefined}>
        <div className="space-y-4 p-4">
          {java && (
            <div className="flex flex-wrap gap-1.5">
              {JAVA_TYPES.map((t: JavaType) => (
                <button key={t} onClick={() => { setType(t); setPicked(''); }} className={clsx('rounded-lg border px-3 py-1.5 text-xs font-medium transition', type === t ? 'border-accent/40 bg-accent/10 text-ink' : 'border-line text-muted hover:text-ink')}>
                  {TYPE_LABEL[t]}
                  {t === s.type && <span className="ml-1 opacity-60">· current</span>}
                </button>
              ))}
            </div>
          )}
          {java && type !== s.type && <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">Switching flavor in place keeps the world but existing {['PAPER', 'PURPUR'].includes(s.type) ? 'plugins' : 'mods'} will not work on {TYPE_LABEL[type]}.</p>}

          {java ? (
            <>
              <div className="relative">
                <Search className="pointer-events-none absolute top-2.5 left-3 size-4 text-muted" />
                <input className="input pl-9" placeholder="Filter versions…" value={filter} onChange={(e) => setFilter(e.target.value)} />
              </div>
              <div className="max-h-72 space-y-0.5 overflow-y-auto pr-1">
                {jv.isLoading && (
                  <div className="flex justify-center py-8">
                    <Spinner />
                  </div>
                )}
                {list.map((v) => {
                  const cur = v === s.version && type === s.type;
                  return (
                    <button key={v} onClick={() => setPicked(v)} className={clsx('flex w-full items-center justify-between rounded-lg px-3 py-2 text-left font-mono text-sm transition', picked === v ? 'bg-accent/15 text-accent' : 'hover:bg-white/5', cur && 'opacity-60')}>
                      {v}
                      <span className="flex gap-1.5 font-sans">
                        {v === jv.data?.latest && <span className="chip border-accent/30 bg-accent/10 text-accent">latest</span>}
                        {cur && <span className="chip border-white/10 bg-white/5 text-muted">installed</span>}
                      </span>
                    </button>
                  );
                })}
              </div>
            </>
          ) : (
            <div className="space-y-1">
              {[
                { v: 'LATEST', label: 'Latest release', sub: bv.data?.latest?.version },
                { v: 'PREVIEW', label: 'Preview (beta)', sub: bv.data?.preview?.version },
              ].map((o) => (
                <button key={o.v} onClick={() => { setPicked(o.v); setCustom(''); }} className={clsx('flex w-full items-center justify-between rounded-lg px-3 py-2.5 text-left text-sm transition', picked === o.v ? 'bg-accent/15 text-accent' : 'hover:bg-white/5')}>
                  <span>{o.label}</span>
                  <span className="font-mono text-xs opacity-70">{o.sub || '…'}</span>
                </button>
              ))}
              <div className="pt-2">
                <span className="label">Specific version</span>
                <input className="input font-mono" placeholder="1.21.100.7" value={custom} onChange={(e) => { setCustom(e.target.value.trim()); setPicked(''); }} />
              </div>
            </div>
          )}

          <div className="space-y-3 border-t border-line pt-4">
            <Toggle checked={backupFirst} onChange={setBackupFirst} label="Back up the world before updating" description="Recommended. A world backup is stored under Backups." />
            <div className="flex flex-wrap gap-2">
              <button className="btn-primary" disabled={!target || isCurrent || busy} onClick={() => setConfirmOpen(true)}>
                <ArrowUpCircle className="size-4" /> {newer || !java ? 'Update' : 'Switch'} in place
              </button>
              <button className="btn-secondary" disabled={!target || busy} onClick={() => nav(`/new?type=${type}&version=${encodeURIComponent(target)}&importFrom=${s.id}&name=${encodeURIComponent(`${s.name} (${target})`)}`)}>
                <Copy className="size-4" /> New server from this world
              </button>
              {java && (
                <button className="btn-ghost" onClick={() => jv.refetch()}>
                  <RefreshCw className={clsx('size-4', jv.isFetching && 'animate-spin')} />
                </button>
              )}
            </div>
          </div>
        </div>
      </Card>

      <ConfirmModal
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        onConfirm={() => update.mutate()}
        title={`Update to ${TYPE_LABEL[type]} ${target}?`}
        body={
          <div className="space-y-2">
            <p>
              {s.state === 'running' ? 'The server will stop, update and start again. Players online will be disconnected. ' : ''}
              {backupFirst ? 'A world backup is taken first.' : 'No backup will be taken.'}
            </p>
            {java && !newer && target !== s.version && <p className="text-amber-300">This looks like a downgrade or sidegrade. Worlds generally cannot be opened by older versions.</p>}
          </div>
        }
        confirmLabel="Update now"
        busy={update.isPending}
      />
    </div>
  );
}
