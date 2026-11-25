import { useQuery } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { ArrowLeft, ChevronDown, ChevronRight, Download, Package, Search, Upload, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Spinner } from '../../components/ui';
import { useToast } from '../../components/Toast';
import { api, uploadWithProgress } from '../../lib/api';
import { fmtBytes } from '../../lib/format';
import { TYPE_LABEL, type PackHit, type PackVersion, type SkipReason, type StagedPack } from '../../lib/types';

const REASON: Record<SkipReason, string> = {
  'pack-env': 'the pack marks it client-only',
  'modrinth-server-unsupported': 'Modrinth says it does not run on servers',
  'mod-metadata-client': 'the mod says it is client-only',
  admin: 'you chose to skip it',
};

const compact = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));
const fileName = (p: string) => p.split('/').pop() || p;

function useDebounced<T>(v: T, ms: number): T {
  const [d, setD] = useState(v);
  useEffect(() => {
    const t = setTimeout(() => setD(v), ms);
    return () => clearTimeout(t);
  }, [v, ms]);
  return d;
}

export interface ModpackChoice {
  pack: StagedPack | null;
  skipOverrides: Record<string, boolean>;
  link: boolean;
}

/** Choose a modpack: upload a .mrpack, search Modrinth, or pick from the popular list; then review it. */
export function ModpackStep({ value, onChange }: { value: ModpackChoice; onChange: (v: ModpackChoice) => void }) {
  const toast = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const [q, setQ] = useState('');
  const dq = useDebounced(q, 300);
  const [project, setProject] = useState<PackHit | null>(null);
  const [versionId, setVersionId] = useState('');
  const [uploadPct, setUploadPct] = useState<number | null>(null);
  const [staging, setStaging] = useState(false);

  const search = useQuery({
    queryKey: ['modpack-search', dq],
    queryFn: () => api.get<{ hits: PackHit[]; total: number }>(`/api/modpacks/search?q=${encodeURIComponent(dq)}`),
    enabled: !value.pack && !project,
    staleTime: 300_000,
  });
  const versions = useQuery({
    queryKey: ['modpack-versions', project?.projectId],
    queryFn: () => api.get<{ versions: PackVersion[]; defaultIndex: number }>(`/api/modpacks/project/${project!.projectId}/versions`),
    enabled: !!project,
    staleTime: 300_000,
  });
  useEffect(() => {
    const d = versions.data;
    if (d && d.defaultIndex >= 0 && !versionId) setVersionId(d.versions[d.defaultIndex].id);
  }, [versions.data, versionId]);

  const setPack = (pack: StagedPack | null) => onChange({ pack, skipOverrides: {}, link: true });

  const upload = async (files: FileList | null) => {
    const file = files?.[0];
    if (!file) return;
    setUploadPct(0);
    try {
      setPack(await uploadWithProgress<StagedPack>('/api/modpacks/upload', file, setUploadPct));
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setUploadPct(null);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const stage = async () => {
    setStaging(true);
    try {
      setPack(await api.post<StagedPack>('/api/modpacks/stage', { versionId }));
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setStaging(false);
    }
  };

  const reset = () => {
    if (value.pack) api.del(`/api/modpacks/staged/${value.pack.id}`).catch(() => {});
    setPack(null);
    setProject(null);
    setVersionId('');
  };

  /* ---------------- Preview ---------------- */
  if (value.pack) {
    const p = value.pack;
    const isSkipped = (f: StagedPack['files'][number]) => value.skipOverrides[f.path] ?? f.skip;
    // Skipped mods first, so the ones that need a look are at the top.
    const ordered = [...p.files].sort((a, b) => Number(b.skip) - Number(a.skip) || a.path.localeCompare(b.path));
    const installed = p.files.filter((f) => !isSkipped(f));
    const bytes = installed.reduce((a, f) => a + f.size, 0);
    return (
      <div className="card space-y-4 p-5">
        <div className="flex items-start gap-3">
          {p.link?.icon ? <img src={p.link.icon} alt="" className="size-12 rounded-xl" /> : <div className="flex size-12 items-center justify-center rounded-xl bg-white/5"><Package className="size-6 text-muted" /></div>}
          <div className="min-w-0 flex-1">
            <p className="truncate font-semibold">{p.link && value.link ? p.link.title : p.index.name}</p>
            <p className="text-sm text-muted">
              Version <span className="font-mono text-ink">{p.link && value.link ? p.link.versionNumber : p.index.versionId}</span> · Minecraft <span className="font-mono text-ink">{p.loader.mc}</span> ·{' '}
              {p.loader.type === 'VANILLA' ? 'Vanilla' : `${TYPE_LABEL[p.loader.type]} ${p.loader.loaderVersion ?? ''}`}
            </p>
          </div>
          <button className="btn-ghost btn-sm shrink-0" onClick={reset} title="Choose another pack">
            <X className="size-4" /> Change
          </button>
        </div>

        {p.link?.confidence === 'name-version' && (
          <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-sky-400/20 bg-sky-400/[0.06] p-3 text-sm">
            <input type="checkbox" className="mt-0.5 accent-sky-400" checked={value.link} onChange={(e) => onChange({ ...value, link: e.target.checked })} />
            <span>
              This looks like <b>{p.link.title} v{p.link.versionNumber}</b> on Modrinth — link it?
              <span className="block text-xs text-muted">Linking lets the app check for pack updates and gives players a direct install link.</span>
            </span>
          </label>
        )}
        {!p.link && <p className="rounded-xl border border-line bg-white/[0.02] p-3 text-xs text-muted">This pack is not on Modrinth, so there are no update checks. Players will need the pack file from you (you can download it from the server page).</p>}

        <div className="grid grid-cols-3 gap-3 text-center">
          <div className="rounded-xl bg-white/[0.03] p-3">
            <p className="text-lg font-semibold">{installed.length}</p>
            <p className="text-xs text-muted">server mods</p>
          </div>
          <div className="rounded-xl bg-white/[0.03] p-3">
            <p className="text-lg font-semibold">{p.files.length - installed.length}</p>
            <p className="text-xs text-muted">client-only skipped</p>
          </div>
          <div className="rounded-xl bg-white/[0.03] p-3">
            <p className="text-lg font-semibold">{fmtBytes(bytes)}</p>
            <p className="text-xs text-muted">to download</p>
          </div>
        </div>
        {p.sidesChecked === false && <p className="text-xs text-amber-300">Couldn't reach Modrinth to check which mods are client-only. Each mod's own metadata is still checked during install.</p>}
        <SkipList files={ordered} isSkipped={isSkipped} onToggle={(path, skip) => onChange({ ...value, skipOverrides: { ...value.skipOverrides, [path]: skip } })} />
        {p.overrideCount > 0 && <p className="text-xs text-muted">Plus {p.overrideCount} config and extra files from the pack.</p>}
      </div>
    );
  }

  /* ---------------- Versions of a chosen project ---------------- */
  if (project) {
    return (
      <div className="card space-y-3 p-5">
        <button className="btn-ghost btn-sm -ml-2" onClick={() => (setProject(null), setVersionId(''))}>
          <ArrowLeft className="size-4" /> Back to packs
        </button>
        <div className="flex items-center gap-3">
          {project.icon ? <img src={project.icon} alt="" className="size-10 rounded-lg" /> : <Package className="size-8 text-muted" />}
          <p className="font-semibold">{project.title}</p>
        </div>
        <div className="max-h-80 space-y-0.5 overflow-y-auto pr-1">
          {versions.isLoading && <div className="flex justify-center py-6"><Spinner /></div>}
          {versions.error && <p className="text-sm text-rose-300">{(versions.error as Error).message}</p>}
          {versions.data?.versions.map((v, i) => (
            <button key={v.id} onClick={() => setVersionId(v.id)} className={clsx('flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm transition', versionId === v.id ? 'bg-accent/15 text-accent' : 'hover:bg-white/5')}>
              <span className="min-w-0 flex-1 truncate font-mono">{v.versionNumber}</span>
              {v.type !== 'release' && <span className="chip border-amber-300/30 bg-amber-300/10 text-amber-200">{v.type}</span>}
              {i === versions.data!.defaultIndex && <span className="chip border-accent/30 bg-accent/10 text-accent">recommended</span>}
              <span className="shrink-0 text-xs text-muted">MC {v.mc.join(', ')} · {v.loaders.join(', ')}</span>
            </button>
          ))}
        </div>
        <button className="btn-primary w-full" disabled={!versionId || staging} onClick={stage}>
          {staging ? <Spinner /> : <Download className="size-4" />} {staging ? 'Fetching pack…' : 'Use this version'}
        </button>
      </div>
    );
  }

  /* ---------------- Pick a pack ---------------- */
  return (
    <div className="card space-y-4 p-5">
      <input ref={fileRef} type="file" accept=".mrpack,application/zip,application/x-modrinth-modpack+zip,application/octet-stream" className="hidden" onChange={(e) => upload(e.target.files)} />
      <button type="button" className="btn-secondary w-full" disabled={uploadPct !== null} onClick={() => fileRef.current?.click()}>
        {uploadPct !== null ? <Spinner /> : <Upload className="size-4" />} {uploadPct !== null ? `Uploading… ${uploadPct}%` : 'Upload a .mrpack file'}
      </button>
      <p className="-mt-2 text-xs text-muted">From modrinth.com, or exported from Prism Launcher or the Modrinth App.</p>
      <div className="relative">
        <Search className="pointer-events-none absolute top-2.5 left-3 size-4 text-muted" />
        <input className="input pl-9" placeholder="Search Modrinth modpacks…" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <div>
        <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted">{dq.trim() ? 'Results' : 'Popular on Modrinth'}</p>
        <div className="max-h-96 space-y-0.5 overflow-y-auto pr-1">
          {search.isLoading && <div className="flex justify-center py-6"><Spinner /></div>}
          {search.error && <p className="text-sm text-rose-300">{(search.error as Error).message}</p>}
          {search.data?.hits.map((h) => (
            <button key={h.projectId} onClick={() => setProject(h)} className="flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left transition hover:bg-white/5">
              {h.icon ? <img src={h.icon} alt="" className="size-9 shrink-0 rounded-lg" loading="lazy" /> : <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-white/5"><Package className="size-4 text-muted" /></div>}
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">{h.title}</span>
                <span className="block truncate text-xs text-muted">
                  {h.mcVersions.at(-1) ? `MC ${h.mcVersions.at(-1)}` : ''} {h.loaders.length ? `· ${h.loaders.join(', ')}` : ''}
                </span>
              </span>
              <span className="shrink-0 text-xs text-muted">{compact(h.downloads)} ↓</span>
            </button>
          ))}
          {search.data && !search.data.hits.length && <p className="py-4 text-center text-sm text-muted">No server-compatible packs found.</p>}
        </div>
      </div>
    </div>
  );
}

function SkipList({ files, isSkipped, onToggle }: { files: StagedPack['files']; isSkipped: (f: StagedPack['files'][number]) => boolean; onToggle: (path: string, skip: boolean) => void }) {
  const [open, setOpen] = useState(false);
  if (!files.length) return null;
  const skipped = files.filter(isSkipped).length;
  return (
    <div className="rounded-xl border border-line">
      <button className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm" onClick={() => setOpen((o) => !o)}>
        {open ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
        Mods ({files.length}) · {files.length - skipped} to install · {skipped} skipped
        <span className="ml-auto text-xs text-muted">ticked mods are installed</span>
      </button>
      {open && (
        <ul className="divide-y divide-line/60 border-t border-line">
          {files.map((f) => (
            <li key={f.path} className="flex items-start gap-3 px-3 py-2 text-sm">
              <input type="checkbox" className="mt-1 accent-emerald-400" checked={!isSkipped(f)} onChange={(e) => onToggle(f.path, !e.target.checked)} />
              <span className="min-w-0">
                <span className="block truncate font-mono text-xs">{fileName(f.path)}</span>
                <span className="block text-xs text-muted">{isSkipped(f) ? (f.reason && f.skip ? `Skipped because ${REASON[f.reason]}` : 'Skipped by you') : f.skip ? 'Installing anyway' : 'Will be installed'}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

