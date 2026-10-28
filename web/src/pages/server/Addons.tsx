import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { ArrowUpCircle, Download, ExternalLink, Laptop, Package, Power, RefreshCw, Search, Trash2, Upload } from 'lucide-react';
import { hostAddress, timeAgo } from '../../lib/format';
import { Toggle } from '../../components/ui';
import { useEffect, useRef, useState } from 'react';
import { api } from '../../lib/api';
import { fmtBytes } from '../../lib/format';
import type { ServerSummary } from '../../lib/types';
import { Card, EmptyState, Spinner } from '../../components/ui';
import { useToast } from '../../components/Toast';

interface Jar {
  fileName: string;
  size: number;
  enabled: boolean;
  modrinth?: { projectId: string; title: string; icon?: string; slug?: string };
  managed?: string;
}
interface Pack {
  folder: string;
  kind: 'behavior' | 'resource';
  uuid: string;
  name: string;
  version: number[];
  description?: string;
  active: boolean;
}
type Listing = { kind: 'jars'; dir: string | null; addons: Jar[] } | { kind: 'packs'; packs: Pack[] };
interface Hit {
  projectId: string;
  slug: string;
  title: string;
  description: string;
  icon?: string;
  downloads: number;
  author: string;
  installed: boolean;
}

interface UpdateInfo {
  fileName: string;
  enabled: boolean;
  managed?: string;
  size: number;
  onModrinth: boolean;
  projectId?: string;
  slug?: string;
  title?: string;
  icon?: string;
  clientSide: 'required' | 'optional' | 'unsupported' | 'unknown';
  serverSide: 'required' | 'optional' | 'unsupported' | 'unknown';
  recommendedForClient: boolean;
  isLibrary: boolean;
  currentVersion?: string;
  latestVersion?: string;
  latestDate?: string;
  updateAvailable: boolean;
}
interface UpdatesReport {
  checkedAt: string;
  addons: UpdateInfo[];
  updatesAvailable: number;
  clientRequired: number;
}
interface ClientPack {
  id: string;
  bytes: number;
  createdAt: string;
  mods: string[];
  installer?: string;
  loader: string;
  gameVersion: string;
}

const SIDE_LABEL: Record<UpdateInfo['clientSide'], { text: string; cls: string }> = {
  required: { text: 'needed on client', cls: 'border-amber-500/30 bg-amber-500/10 text-amber-300' },
  optional: { text: 'optional on client', cls: 'border-sky-500/30 bg-sky-500/10 text-sky-300' },
  unsupported: { text: 'server only', cls: 'border-white/10 bg-white/5 text-muted' },
  unknown: { text: 'unknown side', cls: 'border-white/10 bg-white/5 text-muted' },
};

function ModTools({ s, isMods }: { s: ServerSummary; isMods: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [checked, setChecked] = useState(false);
  const updates = useQuery({
    queryKey: ['addon-updates', s.id],
    queryFn: () => api.get<UpdatesReport>(`/api/servers/${s.id}/addons/updates`),
    enabled: checked,
    staleTime: 10 * 60_000,
  });
  const packs = useQuery({ queryKey: ['client-packs', s.id], queryFn: () => api.get<{ packs: ClientPack[] }>(`/api/servers/${s.id}/addons/client-packs`), enabled: isMods });
  const [selected, setSelected] = useState<Set<string> | null>(null);
  const [includeInstaller, setIncludeInstaller] = useState(true);
  const applyUpdates = useMutation({
    mutationFn: (files: string[] | 'all') => api.post<{ updated: { from: string; to: string; version: string }[] }>(`/api/servers/${s.id}/addons/updates/apply`, { files }),
    onSuccess: (r) => {
      toast.success(r.updated.length ? `Updated ${r.updated.length} ${isMods ? 'mod' : 'plugin'}${r.updated.length === 1 ? '' : 's'}${s.state === 'running' ? ' — restart to load them' : ''}` : 'Nothing to update');
      qc.invalidateQueries({ queryKey: ['addon-updates', s.id] });
      qc.invalidateQueries({ queryKey: ['addons', s.id] });
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const build = useMutation({
    mutationFn: () => api.post<ClientPack>(`/api/servers/${s.id}/addons/client-packs`, { files: [...(selected || [])], includeInstaller, serverAddress: s.address.remote[0]?.split(' ')[0] || hostAddress(s.port) }),
    onSuccess: (p) => {
      toast.success(`Client pack ready (${fmtBytes(p.bytes)})`);
      qc.invalidateQueries({ queryKey: ['client-packs', s.id] });
      window.location.assign(`/api/servers/${s.id}/addons/client-packs/${p.id}/download`);
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const delPack = useMutation({
    mutationFn: (id: string) => api.del(`/api/servers/${s.id}/addons/client-packs/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['client-packs', s.id] }),
  });

  const report = updates.data;
  const clientMods = (report?.addons || []).filter((a) => a.enabled && !a.fileName.endsWith('.disabled') && a.clientSide !== 'unsupported');
  const effectiveSelected = selected ?? new Set(clientMods.filter((a) => a.recommendedForClient).map((a) => a.fileName));
  const toggleSel = (f: string) => {
    const n = new Set(effectiveSelected);
    if (n.has(f)) n.delete(f);
    else n.add(f);
    setSelected(n);
  };

  return (
    <>
      <Card
        className="lg:col-span-2"
        title={<span className="flex items-center gap-2"><ArrowUpCircle className="size-4 text-accent" /> Updates{report ? <span className={clsx('chip', report.updatesAvailable ? 'border-amber-500/30 bg-amber-500/10 text-amber-300' : 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300')}>{report.updatesAvailable ? `${report.updatesAvailable} available` : 'all up to date'}</span> : null}</span>}
        padded={false}
        action={
          <div className="flex items-center gap-2">
            {report && <span className="text-xs text-muted">checked {timeAgo(report.checkedAt)}</span>}
            <button className="btn-secondary btn-sm" disabled={updates.isFetching} onClick={() => { setChecked(true); if (checked) updates.refetch(); }}>
              <RefreshCw className={clsx('size-3.5', updates.isFetching && 'animate-spin')} /> {checked ? 'Re-check' : 'Check for updates'}
            </button>
            {report && report.updatesAvailable > 0 && (
              <button className="btn-primary btn-sm" disabled={applyUpdates.isPending} onClick={() => applyUpdates.mutate('all')}>
                {applyUpdates.isPending ? <Spinner /> : <ArrowUpCircle className="size-3.5" />} Update all
              </button>
            )}
          </div>
        }
      >
        {!checked ? (
          <p className="px-5 py-4 text-sm text-muted">Every installed jar is identified on Modrinth by its file hash (even ones you uploaded by hand), then compared with the newest build for {s.type.toLowerCase()} {s.version}. This also reveals which mods players need on their own game.</p>
        ) : updates.isLoading ? (
          <div className="flex justify-center py-10"><Spinner /></div>
        ) : updates.error ? (
          <p className="px-5 py-4 text-sm text-rose-300">{(updates.error as Error).message}</p>
        ) : !report?.addons.length ? (
          <p className="px-5 py-4 text-sm text-muted">Nothing installed yet.</p>
        ) : (
          <ul className="divide-y divide-line/60">
            {report.addons.map((a) => (
              <li key={a.fileName} className={clsx('flex items-center gap-3 px-5 py-2.5 text-sm', !a.enabled && 'opacity-50')}>
                {a.icon ? <img src={a.icon} className="size-7 rounded-md" alt="" /> : <div className="size-7 rounded-md bg-white/5" />}
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-2 truncate font-medium">
                    {a.title || a.fileName}
                    {a.slug && <a className="text-muted hover:text-ink" href={`https://modrinth.com/${isMods ? 'mod' : 'plugin'}/${a.slug}`} target="_blank" rel="noreferrer"><ExternalLink className="size-3" /></a>}
                    {isMods && a.onModrinth && <span className={clsx('chip', a.recommendedForClient ? 'border-amber-500/30 bg-amber-500/10 text-amber-300' : SIDE_LABEL[a.clientSide].cls)}>{a.isLibrary && a.clientSide !== 'required' ? 'library · needed on client' : SIDE_LABEL[a.clientSide].text}</span>}
                  </p>
                  <p className="truncate font-mono text-[11px] text-muted">
                    {a.onModrinth ? (
                      <>
                        {a.currentVersion}
                        {a.updateAvailable && <span className="text-amber-300"> → {a.latestVersion}{a.latestDate ? ` (${new Date(a.latestDate).toLocaleDateString()})` : ''}</span>}
                      </>
                    ) : (
                      <span>{a.fileName} · not found on Modrinth{a.managed === 'geyser' ? ' (managed by Cross-play)' : ''}</span>
                    )}
                  </p>
                </div>
                {a.updateAvailable ? (
                  <button className="btn-secondary btn-sm" disabled={applyUpdates.isPending} onClick={() => applyUpdates.mutate([a.fileName])}>
                    <ArrowUpCircle className="size-3.5" /> Update
                  </button>
                ) : a.onModrinth ? (
                  <span className="text-xs text-emerald-300">latest</span>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Card>

      {isMods && (
        <Card
          className="lg:col-span-2"
          title={<span className="flex items-center gap-2"><Laptop className="size-4 text-violet-300" /> Client pack{report && report.clientRequired > 0 && <span className="chip border-amber-500/30 bg-amber-500/10 text-amber-300">{report.clientRequired} mod{report.clientRequired === 1 ? '' : 's'} players must install</span>}</span>}
        >
          {!checked || !report ? (
            <p className="text-sm text-muted">Run <span className="text-ink">Check for updates</span> first. Mods are then sorted into ones players must install on their own game (for example Fabric API or content mods), optional client additions, and server-only mods.</p>
          ) : !clientMods.length ? (
            <p className="text-sm text-muted">None of the installed mods need to be on the client. Players only need {s.type === 'FABRIC' ? 'Fabric' : s.type === 'FORGE' ? 'Forge' : 'NeoForge'} for Minecraft {s.version}.</p>
          ) : (
            <div className="space-y-4">
              <p className="text-sm text-muted">
                Players need {s.type === 'FABRIC' ? 'Fabric' : s.type === 'FORGE' ? 'Forge' : 'NeoForge'} for Minecraft {s.version}
                {s.build?.loaderVersion ? ` (loader ${s.build.loaderVersion})` : ''} plus the mods marked <span className="text-amber-300">needed on client</span>. Pick what to bundle; the zip includes a README with install steps{includeInstaller ? ' and the loader installer' : ''}.
              </p>
              <ul className="divide-y divide-line/60 rounded-xl border border-line">
                {clientMods.map((a) => (
                  <li key={a.fileName} className="flex items-center gap-3 px-4 py-2 text-sm">
                    <input type="checkbox" className="size-4 accent-emerald-400" checked={effectiveSelected.has(a.fileName)} onChange={() => toggleSel(a.fileName)} />
                    {a.icon ? <img src={a.icon} className="size-6 rounded" alt="" /> : <div className="size-6 rounded bg-white/5" />}
                    <span className="min-w-0 flex-1 truncate">{a.title || a.fileName} <span className="font-mono text-[11px] text-muted">{a.currentVersion}</span></span>
                    <span className={clsx('chip', a.isLibrary && a.clientSide !== 'required' ? 'border-amber-500/30 bg-amber-500/10 text-amber-300' : SIDE_LABEL[a.clientSide].cls)}>{a.isLibrary && a.clientSide !== 'required' ? 'library · needed with other mods' : SIDE_LABEL[a.clientSide].text}</span>
                  </li>
                ))}
              </ul>
              <Toggle checked={includeInstaller} onChange={setIncludeInstaller} label={`Include the ${s.type === 'FABRIC' ? 'Fabric' : s.type === 'FORGE' ? 'Forge' : 'NeoForge'} installer`} description="Downloaded from the official Maven so players can set up the loader offline." />
              <div className="flex flex-wrap items-center gap-2">
                <button className="btn-primary" disabled={build.isPending || !effectiveSelected.size} onClick={() => build.mutate()}>
                  {build.isPending ? <Spinner /> : <Download className="size-4" />} Build &amp; download client pack ({effectiveSelected.size})
                </button>
                <button className="btn-ghost btn-sm" onClick={() => setSelected(new Set(clientMods.map((a) => a.fileName)))}>Select all</button>
                <button className="btn-ghost btn-sm" onClick={() => setSelected(new Set(clientMods.filter((a) => a.recommendedForClient).map((a) => a.fileName)))}>Recommended only</button>
              </div>
            </div>
          )}
          {packs.data?.packs.length ? (
            <div className="mt-4 border-t border-line pt-3">
              <span className="label">Previous packs</span>
              <ul className="divide-y divide-line/60">
                {packs.data.packs.map((p) => (
                  <li key={p.id} className="flex items-center gap-3 py-2 text-sm">
                    <span className="min-w-0 flex-1 truncate text-muted">{new Date(p.createdAt).toLocaleString()} · {p.mods.length} mods · {fmtBytes(p.bytes)}{p.installer ? ' · installer' : ''}</span>
                    <a className="btn-ghost btn-sm" href={`/api/servers/${s.id}/addons/client-packs/${p.id}/download`}><Download className="size-3.5" /></a>
                    <button className="btn-ghost btn-sm text-rose-300" onClick={() => delPack.mutate(p.id)}><Trash2 className="size-3.5" /></button>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </Card>
      )}
    </>
  );
}

export function Addons({ s }: { s: ServerSummary }) {
  const qc = useQueryClient();
  const toast = useToast();
  const java = s.edition === 'java';
  const q = useQuery({ queryKey: ['addons', s.id], queryFn: () => api.get<Listing>(`/api/servers/${s.id}/addons`) });
  const fileRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setDebounced(query), 350);
    return () => clearTimeout(t);
  }, [query]);
  const supportsAddons = !java || s.type !== 'VANILLA';
  const search = useQuery({
    queryKey: ['modrinth', s.id, debounced],
    queryFn: () => api.get<{ total: number; hits: Hit[] }>(`/api/servers/${s.id}/addons/search?q=${encodeURIComponent(debounced)}`),
    enabled: java && supportsAddons,
    staleTime: 60_000,
  });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['addons', s.id] });
    qc.invalidateQueries({ queryKey: ['modrinth', s.id] });
  };
  const upload = useMutation({
    mutationFn: (f: File) => api.upload<{ installed: string[] }>(`/api/servers/${s.id}/addons/upload`, f),
    onSuccess: (r) => {
      toast.success(`Installed ${r.installed.join(', ')}`);
      invalidate();
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const install = useMutation({
    mutationFn: (projectId: string) => api.post<{ installed: string[] }>(`/api/servers/${s.id}/addons/install`, { projectId }),
    onSuccess: (r) => {
      toast.success(r.installed.length ? `Installed ${r.installed.join(', ')}` : 'Already installed');
      invalidate();
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const remove = useMutation({
    mutationFn: (qs: string) => api.del(`/api/servers/${s.id}/addons?${qs}`),
    onSuccess: invalidate,
    onError: (e) => toast.error((e as Error).message),
  });
  const toggle = useMutation({
    mutationFn: (body: Record<string, unknown>) => api.post(`/api/servers/${s.id}/addons/toggle`, body),
    onSuccess: invalidate,
    onError: (e) => toast.error((e as Error).message),
  });

  const label = java ? (s.type === 'PAPER' || s.type === 'PURPUR' ? 'Plugins' : 'Mods') : 'Packs';
  const accept = java ? '.jar' : '.mcpack,.mcaddon,.zip';

  if (!supportsAddons)
    return (
      <div className="card fade-up">
        <EmptyState icon={Package} title="Vanilla servers do not load plugins or mods" description="Switch to Paper for plugins or Fabric/Forge for mods under Versions. Your world carries over." />
      </div>
    );

  const isMods = java && ['FABRIC', 'FORGE', 'NEOFORGE'].includes(s.type);
  return (
    <div className="fade-up grid gap-5 lg:grid-cols-2">
      {java && <ModTools s={s} isMods={isMods} />}
      <Card
        title={`Installed ${label.toLowerCase()}`}
        padded={false}
        action={
          <>
            <input ref={fileRef} type="file" accept={accept} className="hidden" onChange={(e) => e.target.files?.[0] && upload.mutate(e.target.files[0])} />
            <button className="btn-secondary btn-sm" disabled={upload.isPending} onClick={() => fileRef.current?.click()}>
              {upload.isPending ? <Spinner /> : <Upload className="size-3.5" />} Upload {accept.split(',')[0]}
            </button>
          </>
        }
      >
        {q.isLoading ? (
          <div className="flex justify-center py-12">
            <Spinner />
          </div>
        ) : q.data?.kind === 'jars' ? (
          q.data.addons.length ? (
            <ul className="divide-y divide-line/60">
              {q.data.addons.map((a) => (
                <li key={a.fileName} className={clsx('flex items-center gap-3 px-5 py-3', !a.enabled && 'opacity-50')}>
                  {a.modrinth?.icon ? <img src={a.modrinth.icon} className="size-8 rounded-lg" alt="" /> : <div className="flex size-8 items-center justify-center rounded-lg bg-white/5"><Package className="size-4 text-muted" /></div>}
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{a.modrinth?.title || a.fileName.replace(/\.jar(\.disabled)?$/, '')}</p>
                    <p className="truncate font-mono text-[11px] text-muted">
                      {a.fileName} · {fmtBytes(a.size)}
                      {a.managed === 'geyser' && ' · managed by Cross-play setting'}
                    </p>
                  </div>
                  <button className="btn-ghost btn-sm" title={a.enabled ? 'Disable' : 'Enable'} onClick={() => toggle.mutate({ file: a.fileName })}>
                    <Power className={clsx('size-3.5', a.enabled ? 'text-emerald-300' : '')} />
                  </button>
                  <button className="btn-ghost btn-sm text-rose-300" onClick={() => confirm(`Delete ${a.fileName}?`) && remove.mutate(`file=${encodeURIComponent(a.fileName)}`)}>
                    <Trash2 className="size-3.5" />
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState icon={Package} title={`No ${label.toLowerCase()} installed`} description={`Search Modrinth on the right or upload a .jar into /${q.data.dir}.`} />
          )
        ) : q.data?.kind === 'packs' ? (
          q.data.packs.length ? (
            <ul className="divide-y divide-line/60">
              {q.data.packs.map((p) => (
                <li key={p.kind + p.folder} className={clsx('flex items-center gap-3 px-5 py-3', !p.active && 'opacity-60')}>
                  <div className={clsx('flex size-8 items-center justify-center rounded-lg', p.kind === 'behavior' ? 'bg-violet-500/15 text-violet-300' : 'bg-sky-500/15 text-sky-300')}>
                    <Package className="size-4" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{p.name}</p>
                    <p className="truncate text-[11px] text-muted">
                      {p.kind} pack · v{p.version.join('.')} · {p.folder}
                    </p>
                  </div>
                  <button className="btn-ghost btn-sm" title={p.active ? 'Deactivate on this world' : 'Activate on this world'} onClick={() => toggle.mutate({ folder: p.folder, kind: p.kind, active: !p.active })}>
                    <Power className={clsx('size-3.5', p.active ? 'text-emerald-300' : '')} />
                  </button>
                  <button className="btn-ghost btn-sm text-rose-300" onClick={() => confirm(`Remove pack ${p.name}?`) && remove.mutate(`folder=${encodeURIComponent(p.folder)}&kind=${p.kind}`)}>
                    <Trash2 className="size-3.5" />
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState icon={Package} title="No packs installed" description="Upload a .mcpack or .mcaddon. Packs are extracted and activated on the current world; restart to apply." />
          )
        ) : null}
        {s.state === 'running' && <p className="border-t border-line px-5 py-2 text-xs text-muted">Changes take effect after a restart.</p>}
      </Card>

      {java ? (
        <Card title={<span className="flex items-center gap-2">Browse Modrinth <span className="chip border-white/10 bg-white/5 text-muted">{s.type.toLowerCase()} · {s.version}</span></span>} padded={false}>
          <div className="border-b border-line p-3">
            <div className="relative">
              <Search className="pointer-events-none absolute top-2.5 left-3 size-4 text-muted" />
              <input className="input pl-9" placeholder={`Search ${label.toLowerCase()} compatible with ${s.version}…`} value={query} onChange={(e) => setQuery(e.target.value)} />
            </div>
          </div>
          {search.isLoading ? (
            <div className="flex justify-center py-12">
              <Spinner />
            </div>
          ) : search.error ? (
            <p className="p-5 text-sm text-rose-300">{(search.error as Error).message}</p>
          ) : (
            <ul className="max-h-[60vh] divide-y divide-line/60 overflow-y-auto">
              {search.data?.hits.map((h) => (
                <li key={h.projectId} className="flex items-center gap-3 px-5 py-3">
                  {h.icon ? <img src={h.icon} className="size-9 rounded-lg" alt="" /> : <div className="size-9 rounded-lg bg-white/5" />}
                  <div className="min-w-0 flex-1">
                    <p className="flex items-center gap-2 text-sm font-medium">
                      {h.title}
                      <a href={`https://modrinth.com/${java && (s.type === 'PAPER' || s.type === 'PURPUR') ? 'plugin' : 'mod'}/${h.slug}`} target="_blank" rel="noreferrer" className="text-muted hover:text-ink">
                        <ExternalLink className="size-3" />
                      </a>
                    </p>
                    <p className="truncate text-xs text-muted">{h.description}</p>
                    <p className="text-[11px] text-muted">
                      {h.author} · {Intl.NumberFormat(undefined, { notation: 'compact' }).format(h.downloads)} downloads
                    </p>
                  </div>
                  <button className={h.installed ? 'btn-ghost btn-sm' : 'btn-secondary btn-sm'} disabled={h.installed || install.isPending} onClick={() => install.mutate(h.projectId)}>
                    {install.isPending && install.variables === h.projectId ? <Spinner /> : <Download className="size-3.5" />} {h.installed ? 'Installed' : 'Install'}
                  </button>
                </li>
              ))}
              {search.data && !search.data.hits.length && <EmptyState icon={Search} title="No results" description={`Nothing on Modrinth matches "${debounced}" for ${s.type} ${s.version}.`} />}
            </ul>
          )}
        </Card>
      ) : (
        <Card title="About Bedrock packs">
          <ul className="space-y-2 text-sm text-muted">
            <li>
              <span className="text-ink">.mcpack</span> contains a single behavior or resource pack; <span className="text-ink">.mcaddon</span> bundles several.
            </li>
            <li>Packs are extracted into behavior_packs/ or resource_packs/ and registered in the current world's world_behavior_packs.json / world_resource_packs.json.</li>
            <li>Toggle the power icon to activate or deactivate a pack on this world without deleting it.</li>
            <li>Many packs require experimental toggles that can only be set from a Bedrock client with cheats enabled, then re-uploaded as a world.</li>
          </ul>
        </Card>
      )}
    </div>
  );
}
