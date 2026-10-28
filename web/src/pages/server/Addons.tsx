import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { Download, ExternalLink, Package, Power, Search, Trash2, Upload } from 'lucide-react';
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

  return (
    <div className="fade-up grid gap-5 lg:grid-cols-2">
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
