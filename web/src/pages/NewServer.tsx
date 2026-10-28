import { clsx } from 'clsx';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, ArrowRight, Check, Coffee, Gamepad2, Globe2, HardDriveDownload, Search, Sparkles } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useServers } from '../hooks/useServers';
import { api } from '../lib/api';
import { fmtMb } from '../lib/format';
import { JAVA_TYPES, TYPE_BLURB, TYPE_LABEL, type BackupMeta, type Edition, type JavaType, type ServerType, type SystemInfo } from '../lib/types';
import { Field, Segmented, Spinner, Toggle } from '../components/ui';
import { useToast } from '../components/Toast';
import { fmtBytes } from '../lib/format';
import { FolderOpen, Trash2, Upload } from 'lucide-react';

type Step = 0 | 1 | 2;

interface Form {
  edition: Edition;
  type: ServerType;
  version: string;
  name: string;
  port: string;
  xmxMb: number;
  javaMajor: 'auto' | number;
  preset: 'aikar' | 'zgc' | 'none';
  geyser: boolean;
  transport: 'raknet' | 'nethernet';
  autoStart: boolean;
  restartOnCrash: boolean;
  startAfterInstall: boolean;
  worldMode: 'new' | 'import';
  importSource: 'server' | 'upload' | 'folder' | 'existing';
  importId: string;
  sourceServerId: string;
  backupId: string;
  levelName: string;
  seed: string;
  motd: string;
  maxPlayers: number;
  gamemode: string;
  difficulty: string;
  onlineMode: boolean;
  whitelist: boolean;
  cheats: boolean;
  pvp: boolean;
}

const GEYSER_OK: ServerType[] = ['PAPER', 'PURPUR', 'FABRIC', 'NEOFORGE'];

export function NewServer() {
  const nav = useNavigate();
  const toast = useToast();
  const [params] = useSearchParams();
  const { data: servers } = useServers();
  const { data: sys } = useQuery({ queryKey: ['system'], queryFn: () => api.get<SystemInfo>('/api/system') });

  const [step, setStep] = useState<Step>(params.get('type') ? 1 : 0);
  const [busy, setBusy] = useState(false);
  const [versionQuery, setVersionQuery] = useState('');
  const [showSnapshots, setShowSnapshots] = useState(false);
  const [f, setF] = useState<Form>(() => {
    const type = (params.get('type') as ServerType) || 'PAPER';
    const edition: Edition = type === 'BEDROCK' ? 'bedrock' : 'java';
    const source = params.get('importFrom') || '';
    return {
      edition,
      type,
      version: params.get('version') || '',
      name: params.get('name') || '',
      port: '',
      xmxMb: 2048,
      javaMajor: 'auto',
      preset: 'aikar',
      geyser: false,
      transport: 'raknet',
      autoStart: false,
      restartOnCrash: true,
      startAfterInstall: true,
      worldMode: source ? 'import' : 'new',
      importSource: 'server',
      importId: '',
      sourceServerId: source,
      backupId: '',
      levelName: '',
      seed: '',
      motd: '',
      maxPlayers: 20,
      gamemode: 'survival',
      difficulty: 'normal',
      onlineMode: true,
      whitelist: false,
      cheats: false,
      pvp: true,
    };
  });
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setF((x) => ({ ...x, [k]: v }));

  const isJava = f.edition === 'java';
  const javaVersions = useQuery({
    queryKey: ['versions', 'java', f.type],
    queryFn: () => api.get<{ versions: string[]; latest: string | null; snapshots?: string[] }>(`/api/versions/java?type=${f.type}`),
    enabled: isJava,
    staleTime: 600_000,
  });
  const bedrockVersions = useQuery({
    queryKey: ['versions', 'bedrock'],
    queryFn: () => api.get<{ latest: { version: string } | null; preview: { version: string } | null }>('/api/versions/bedrock'),
    enabled: !isJava,
    staleTime: 600_000,
  });

  useEffect(() => {
    if (f.version) return;
    if (isJava && javaVersions.data?.latest) set('version', javaVersions.data.latest);
    if (!isJava && bedrockVersions.data) set('version', 'LATEST');
  }, [isJava, javaVersions.data, bedrockVersions.data, f.version]);

  const versionList = useMemo(() => {
    const all = [...(javaVersions.data?.versions || []), ...(showSnapshots ? javaVersions.data?.snapshots || [] : [])];
    return versionQuery ? all.filter((v) => v.includes(versionQuery)) : all;
  }, [javaVersions.data, versionQuery, showSnapshots]);

  const sameEdition = (servers || []).filter((s) => s.edition === f.edition && s.installed);
  const source = sameEdition.find((s) => s.id === f.sourceServerId);
  const backups = useQuery({
    queryKey: ['backups', f.sourceServerId],
    queryFn: () => api.get<{ backups: BackupMeta[] }>(`/api/servers/${f.sourceServerId}/backups`),
    enabled: !!f.sourceServerId,
  });

  interface WorldImport { id: string; name: string; edition: Edition; levelName: string; bytes: number; createdAt: string; source: string; hasNether?: boolean; hasEnd?: boolean }
  interface ImportsView { imports: WorldImport[]; folders: { name: string; edition: Edition | null; levelName: string | null }[] }
  const imports = useQuery({ queryKey: ['imports'], queryFn: () => api.get<ImportsView>('/api/imports'), enabled: f.worldMode === 'import' });
  const [uploading, setUploading] = useState<string | null>(null);
  const zipRef = useRef<HTMLInputElement>(null);
  const dirRef = useRef<HTMLInputElement>(null);
  const selectedImport = imports.data?.imports.find((i) => i.id === f.importId);

  const uploadWorld = async (files: FileList | null, folder: boolean) => {
    if (!files?.length) return;
    const fd = new FormData();
    let total = 0;
    for (const file of Array.from(files)) {
      total += file.size;
      fd.append('files', file, folder ? (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name : file.name);
    }
    setUploading(`Uploading ${files.length} file${files.length > 1 ? 's' : ''} (${fmtBytes(total)})…`);
    try {
      const res = await fetch('/api/imports/upload', { method: 'POST', body: fd, credentials: 'same-origin' });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Upload failed');
      toast.success(`Imported ${data.name} (${data.edition} world "${data.levelName}")`);
      await imports.refetch();
      set('importId', data.id);
      if (data.edition !== f.edition) toast.error(`This is a ${data.edition} world; switch the server type to match before creating`);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setUploading(null);
      if (zipRef.current) zipRef.current.value = '';
      if (dirRef.current) dirRef.current.value = '';
    }
  };
  const registerFolder = async (folder: string) => {
    try {
      const data = await api.post<WorldImport>('/api/imports/register', { folder });
      toast.success(`Registered ${data.name}`);
      await imports.refetch();
      set('importId', data.id);
    } catch (e) {
      toast.error((e as Error).message);
    }
  };
  const deleteImport = async (id: string) => {
    if (!confirm('Delete this imported world? Servers already created from it are not affected.')) return;
    try {
      await api.del(`/api/imports/${id}`);
      if (f.importId === id) set('importId', '');
      imports.refetch();
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  const chooseType = (type: ServerType) => {
    const edition: Edition = type === 'BEDROCK' ? 'bedrock' : 'java';
    setF((x) => ({ ...x, type, edition, version: '', geyser: GEYSER_OK.includes(type) ? x.geyser : false, sourceServerId: x.edition === edition ? x.sourceServerId : '', worldMode: x.edition === edition ? x.worldMode : 'new', importId: x.edition === edition ? x.importId : '' }));
    setVersionQuery('');
  };

  const canNext = step === 0 ? true : step === 1 ? !!f.version && !!f.name.trim() : true;

  const create = async () => {
    setBusy(true);
    try {
      const properties: Record<string, string> = {};
      if (isJava) {
        if (f.motd) properties.motd = f.motd;
        properties['max-players'] = String(f.maxPlayers);
        properties.gamemode = f.gamemode;
        properties.difficulty = f.difficulty;
        properties['online-mode'] = String(f.onlineMode);
        properties['white-list'] = String(f.whitelist);
        properties.pvp = String(f.pvp);
        if (f.seed) properties['level-seed'] = f.seed;
      } else {
        properties['server-name'] = f.motd || f.name;
        properties['max-players'] = String(f.maxPlayers);
        properties.gamemode = f.gamemode;
        properties.difficulty = f.difficulty;
        properties['online-mode'] = String(f.onlineMode);
        properties['allow-list'] = String(f.whitelist);
        properties['allow-cheats'] = String(f.cheats);
        if (f.seed) properties['level-seed'] = f.seed;
      }
      const r = await api.post<{ id: string }>('/api/servers', {
        name: f.name.trim(),
        edition: f.edition,
        type: f.type,
        version: f.version,
        port: f.port ? Number(f.port) : undefined,
        levelName: f.worldMode === 'import' && f.importSource === 'server' ? undefined : f.levelName || undefined,
        java: isJava ? { xmxMb: f.xmxMb, xmsMb: f.xmxMb, major: f.javaMajor, preset: f.preset, extraArgs: '' } : undefined,
        properties,
        geyser: f.geyser,
        transport: isJava ? undefined : f.transport,
        autoStart: f.autoStart,
        restartOnCrash: f.restartOnCrash,
        startAfterInstall: f.startAfterInstall,
        importWorld:
          f.worldMode !== 'import'
            ? undefined
            : f.importSource === 'server'
              ? f.sourceServerId
                ? { sourceServerId: f.sourceServerId, backupId: f.backupId || undefined }
                : undefined
              : f.importId
                ? { importId: f.importId }
                : undefined,
      });
      toast.success('Server created — installing now');
      nav(`/servers/${r.id}`);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const steps = ['Flavor', 'Version & resources', 'World & gameplay'];
  const runtimeQ = useQuery({
    queryKey: ['java-runtime', f.version],
    queryFn: () => api.get<{ major: number }>(`/api/versions/java-runtime?version=${encodeURIComponent(f.version)}`),
    enabled: isJava && !!f.version,
    staleTime: 3_600_000,
  });
  const recommended = isJava ? runtimeQ.data?.major : undefined;
  const memCap = sys?.memory.limitMb || sys?.memory.totalMb || 0;

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div>
        <button className="btn-ghost btn-sm -ml-2 mb-2" onClick={() => nav(-1)}>
          <ArrowLeft className="size-4" /> Back
        </button>
        <h1 className="text-2xl font-semibold tracking-tight">New server</h1>
        <p className="mt-1 text-sm text-muted">Pick a flavor, choose a version, and optionally bring an existing world along.</p>
      </div>

      <ol className="flex items-center gap-2 text-sm">
        {steps.map((label, i) => (
          <li key={label} className="flex items-center gap-2">
            <button
              onClick={() => i < step && setStep(i as Step)}
              className={clsx('flex items-center gap-2 rounded-full border px-3 py-1.5 transition', i === step ? 'border-accent/40 bg-accent/10 text-ink' : i < step ? 'border-line text-muted hover:text-ink' : 'border-line text-muted/60')}
            >
              <span className={clsx('flex size-5 items-center justify-center rounded-full text-[11px] font-semibold', i < step ? 'bg-accent text-emerald-950' : i === step ? 'bg-white/15' : 'bg-white/5')}>{i < step ? <Check className="size-3" /> : i + 1}</span>
              {label}
            </button>
            {i < steps.length - 1 && <span className="h-px w-6 bg-line" />}
          </li>
        ))}
      </ol>

      {step === 0 && (
        <div className="fade-up space-y-5">
          <div>
            <div className="mb-3 flex items-center gap-2 text-sm font-semibold">
              <Coffee className="size-4 text-orange-300" /> Java Edition
            </div>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {JAVA_TYPES.map((t: JavaType) => (
                <TypeCard key={t} type={t} selected={f.type === t} onClick={() => chooseType(t)} />
              ))}
            </div>
          </div>
          <div>
            <div className="mb-3 flex items-center gap-2 text-sm font-semibold">
              <Gamepad2 className="size-4 text-sky-300" /> Bedrock Edition
            </div>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              <TypeCard type="BEDROCK" selected={f.type === 'BEDROCK'} onClick={() => chooseType('BEDROCK')} disabled={sys ? !sys.bedrock.supported : false} note={sys && !sys.bedrock.supported ? sys.bedrock.reason : sys?.bedrock.emulated ? 'Runs through box64 emulation on this ARM host' : undefined} />
            </div>
          </div>
        </div>
      )}

      {step === 1 && (
        <div className="fade-up grid gap-5 lg:grid-cols-5">
          <div className="card lg:col-span-2">
            <header className="flex items-center justify-between border-b border-line px-4 py-3">
              <h3 className="text-sm font-semibold">{TYPE_LABEL[f.type]} version</h3>
              {isJava && javaVersions.data?.snapshots?.length ? (
                <button className={clsx('text-xs', showSnapshots ? 'text-accent' : 'text-muted hover:text-ink')} onClick={() => setShowSnapshots(!showSnapshots)}>
                  {showSnapshots ? 'Hide' : 'Show'} snapshots
                </button>
              ) : null}
            </header>
            {isJava ? (
              <div className="p-3">
                <div className="relative mb-2">
                  <Search className="pointer-events-none absolute top-2.5 left-3 size-4 text-muted" />
                  <input className="input pl-9" placeholder="Filter versions…" value={versionQuery} onChange={(e) => setVersionQuery(e.target.value)} />
                </div>
                <div className="max-h-80 space-y-0.5 overflow-y-auto pr-1">
                  {javaVersions.isLoading && (
                    <div className="flex justify-center py-8 text-muted">
                      <Spinner />
                    </div>
                  )}
                  {javaVersions.error && <p className="p-3 text-sm text-rose-300">Could not load versions: {(javaVersions.error as Error).message}</p>}
                  {versionList.map((v) => (
                    <button key={v} onClick={() => set('version', v)} className={clsx('flex w-full items-center justify-between rounded-lg px-3 py-2 text-left font-mono text-sm transition', f.version === v ? 'bg-accent/15 text-accent' : 'hover:bg-white/5')}>
                      {v}
                      {v === javaVersions.data?.latest && <span className="chip border-accent/30 bg-accent/10 font-sans text-accent">latest</span>}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <div className="space-y-1 p-3">
                {bedrockVersions.isLoading && (
                  <div className="flex justify-center py-8 text-muted">
                    <Spinner />
                  </div>
                )}
                {[
                  { v: 'LATEST', label: 'Latest release', sub: bedrockVersions.data?.latest?.version },
                  { v: 'PREVIEW', label: 'Preview (beta)', sub: bedrockVersions.data?.preview?.version },
                ].map((o) => (
                  <button key={o.v} onClick={() => set('version', o.v)} className={clsx('flex w-full items-center justify-between rounded-lg px-3 py-2.5 text-left text-sm transition', f.version === o.v ? 'bg-accent/15 text-accent' : 'hover:bg-white/5')}>
                    <span>{o.label}</span>
                    <span className="font-mono text-xs opacity-70">{o.sub || '…'}</span>
                  </button>
                ))}
                <div className="px-3 pt-2">
                  <span className="label">Or a specific version</span>
                  <input className="input font-mono" placeholder="1.21.100.7" value={/^\d/.test(f.version) ? f.version : ''} onChange={(e) => set('version', e.target.value.trim())} />
                  <p className="mt-1.5 text-xs text-muted">Mojang only publishes download links for the current release and preview; older versions may not be available.</p>
                </div>
              </div>
            )}
          </div>

          <div className="space-y-4 lg:col-span-3">
            <div className="card space-y-4 p-5">
              <Field label="Server name">
                <input className="input" placeholder="Survival with friends" value={f.name} onChange={(e) => set('name', e.target.value)} autoFocus />
              </Field>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Port" hint={sys ? `Auto-assigns from ${isJava ? sys.ports.java.join('–') + ' (TCP)' : sys.ports.bedrock.join('–') + ' (UDP)'}` : undefined}>
                  <input className="input font-mono" placeholder="auto" value={f.port} onChange={(e) => set('port', e.target.value.replace(/\D/g, ''))} />
                </Field>
                {isJava && (
                  <Field label="Java runtime" hint={recommended ? `Mojang requires Java ${recommended} for ${f.version}` : undefined}>
                    <select className="input" value={String(f.javaMajor)} onChange={(e) => set('javaMajor', e.target.value === 'auto' ? 'auto' : Number(e.target.value))}>
                      <option value="auto">Automatic{recommended ? ` (Java ${recommended})` : ''}</option>
                      {[8, 11, 17, 21, 25].map((m) => (
                        <option key={m} value={m}>
                          Java {m}
                          {sys?.javaRuntimes.some((r) => r.major === m) ? ' · installed' : ' · will download'}
                        </option>
                      ))}
                    </select>
                  </Field>
                )}
              </div>
              {!isJava && (
                <Field label="Network transport" hint={f.transport === 'raknet' ? 'Classic UDP protocol. Works with every Bedrock client, status pings, LAN discovery and playit tunnels. Uses two UDP ports (IPv4 + IPv6).' : "Mojang's WebRTC-based transport, the default in recent BDS builds. Uses one port on UDP and TCP; pings only report reachability, and behind NAT the server must advertise the IP players use (set automatically from MCSM_ADVERTISE_IP, editable in Settings)."}>
                  <Segmented value={f.transport} onChange={(v) => set('transport', v)} options={[{ value: 'raknet', label: 'RakNet (recommended)' }, { value: 'nethernet', label: 'NetherNet' }]} />
                </Field>
              )}
              {isJava && (
                <>
                  <div>
                    <div className="mb-1.5 flex items-center justify-between">
                      <span className="label mb-0">Memory (-Xmx)</span>
                      <span className="font-mono text-sm text-accent">{fmtMb(f.xmxMb)}</span>
                    </div>
                    <input type="range" min={1024} max={Math.max(4096, Math.min(32768, memCap - 1024))} step={512} value={f.xmxMb} onChange={(e) => set('xmxMb', Number(e.target.value))} className="w-full accent-emerald-400" />
                    <p className="mt-1.5 text-xs text-muted">
                      {memCap ? `${fmtMb(memCap)} available in this container. ` : ''}
                      Leave 1–2 GB headroom per server for the JVM itself.
                      {memCap && f.xmxMb + 1024 > memCap ? <span className="text-amber-300"> This allocation may be killed by the OOM killer.</span> : null}
                    </p>
                  </div>
                  <Field label="JVM flags">
                    <Segmented
                      value={f.preset}
                      onChange={(v) => set('preset', v)}
                      options={[
                        { value: 'aikar', label: "Aikar's flags" },
                        { value: 'zgc', label: 'Generational ZGC' },
                        { value: 'none', label: 'None' },
                      ]}
                    />
                  </Field>
                  {GEYSER_OK.includes(f.type) && (
                    <Toggle checked={f.geyser} onChange={(v) => set('geyser', v)} label={<span className="flex items-center gap-2"><Globe2 className="size-4 text-sky-300" /> Cross-play with Bedrock (Geyser + Floodgate)</span>} description="Lets phones, consoles and Windows 10/11 players join this Java server. Adds a UDP port." />
                  )}
                </>
              )}
            </div>
            <div className="card space-y-2 p-5">
              <Toggle checked={f.startAfterInstall} onChange={(v) => set('startAfterInstall', v)} label="Start when installation finishes" />
              <Toggle checked={f.autoStart} onChange={(v) => set('autoStart', v)} label="Start automatically when the manager boots" />
              <Toggle checked={f.restartOnCrash} onChange={(v) => set('restartOnCrash', v)} label="Restart on crash" description="Up to 3 restarts in 10 minutes." />
            </div>
          </div>
        </div>
      )}

      {step === 2 && (
        <div className="fade-up grid gap-5 lg:grid-cols-2">
          <div className="card space-y-4 p-5">
            <h3 className="flex items-center gap-2 text-sm font-semibold">
              <HardDriveDownload className="size-4 text-accent" /> World
            </h3>
            <Segmented
              value={f.worldMode}
              onChange={(v) => set('worldMode', v)}
              options={[
                { value: 'new', label: 'Generate new world' },
                { value: 'import', label: 'Import existing world' },
              ]}
            />
            {f.worldMode === 'new' ? (
              <>
                <Field label="Level name" hint="Folder name of the world.">
                  <input className="input" placeholder={isJava ? 'world' : 'Bedrock level'} value={f.levelName} onChange={(e) => set('levelName', e.target.value)} />
                </Field>
                <Field label="Seed" hint="Leave empty for a random seed.">
                  <input className="input font-mono" value={f.seed} onChange={(e) => set('seed', e.target.value)} />
                </Field>
              </>
            ) : (
              <>
                <Segmented
                  className="flex-wrap"
                  value={f.importSource}
                  onChange={(v) => set('importSource', v)}
                  options={[
                    { value: 'server', label: 'Another server' },
                    { value: 'upload', label: 'Upload .zip / .mcworld' },
                    { value: 'folder', label: 'Upload folder' },
                    { value: 'existing', label: 'On the server' },
                  ]}
                />
                {f.importSource === 'server' && (
                  <>
                    <Field label={`Source server (${isJava ? 'Java' : 'Bedrock'})`} hint="The source server's world is copied; the original is left untouched. Running servers are snapshotted safely first.">
                      <select className="input" value={f.sourceServerId} onChange={(e) => { set('sourceServerId', e.target.value); set('backupId', ''); }}>
                        <option value="">Select a server…</option>
                        {sameEdition.map((s) => (
                          <option key={s.id} value={s.id}>
                            {s.name} — {TYPE_LABEL[s.type]} {s.version}
                          </option>
                        ))}
                      </select>
                    </Field>
                    {!sameEdition.length && <p className="text-xs text-amber-300">No {isJava ? 'Java' : 'Bedrock'} servers to import from. Worlds cannot be converted between editions.</p>}
                    {source && (
                      <Field label="Snapshot" hint="Use the live world or one of the source server's backups.">
                        <select className="input" value={f.backupId} onChange={(e) => set('backupId', e.target.value)}>
                          <option value="">Current world ({source.levelName})</option>
                          {backups.data?.backups.map((b) => (
                            <option key={b.id} value={b.id}>
                              Backup: {b.label} · {new Date(b.createdAt).toLocaleString()} · {b.version}
                            </option>
                          ))}
                        </select>
                      </Field>
                    )}
                    {source && isJava && source.type !== f.type && <p className="text-xs text-muted">Switching from {TYPE_LABEL[source.type]} to {TYPE_LABEL[f.type]}: worlds carry over, but plugins/mods and their data do not.</p>}
                  </>
                )}
                {f.importSource === 'upload' && (
                  <div className="space-y-2">
                    <input ref={zipRef} type="file" accept=".zip,.mcworld" className="hidden" onChange={(e) => uploadWorld(e.target.files, false)} />
                    <button type="button" className="btn-secondary w-full" disabled={!!uploading} onClick={() => zipRef.current?.click()}>
                      {uploading ? <Spinner /> : <Upload className="size-4" />} {uploading || 'Choose a .zip or .mcworld'}
                    </button>
                    <p className="text-xs text-muted">{isJava ? 'A zipped world folder (the one containing level.dat and region/). Paper-style world_nether / world_the_end folders next to it are picked up too.' : 'A .mcworld export from the game, or a zipped world folder (level.dat + db/).'}</p>
                  </div>
                )}
                {f.importSource === 'folder' && (
                  <div className="space-y-2">
                    <input ref={dirRef} type="file" className="hidden" {...({ webkitdirectory: '', directory: '' } as Record<string, string>)} multiple onChange={(e) => uploadWorld(e.target.files, true)} />
                    <button type="button" className="btn-secondary w-full" disabled={!!uploading} onClick={() => dirRef.current?.click()}>
                      {uploading ? <Spinner /> : <FolderOpen className="size-4" />} {uploading || 'Choose a world folder'}
                    </button>
                    <p className="text-xs text-muted">Uploads every file in the folder. For very large worlds, zip it first or copy it to the server's data/imports directory and use "On the server".</p>
                  </div>
                )}
                {f.importSource === 'existing' && (
                  <div className="space-y-2">
                    <p className="text-xs text-muted">
                      Copy a world folder (or a .zip / .mcworld) into <span className="font-mono text-ink">data/imports/</span> on the host, then register it here.
                    </p>
                    {imports.data?.folders.length ? (
                      <ul className="divide-y divide-line/60 rounded-xl border border-line">
                        {imports.data.folders.map((d) => (
                          <li key={d.name} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
                            <span className="min-w-0 truncate font-mono text-xs">
                              {d.name}
                              <span className="ml-2 text-muted">{d.edition ? `${d.edition} · ${d.levelName}` : 'no level.dat found'}</span>
                            </span>
                            <button type="button" className="btn-secondary btn-sm" disabled={!d.edition && !/\.(zip|mcworld)$/i.test(d.name)} onClick={() => registerFolder(d.name)}>
                              Register
                            </button>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="text-xs text-muted">Nothing new found in data/imports.</p>
                    )}
                  </div>
                )}
                {f.importSource !== 'server' && (
                  <div className="space-y-2 border-t border-line pt-3">
                    <span className="label">Imported worlds</span>
                    {imports.isLoading ? (
                      <Spinner />
                    ) : imports.data?.imports.length ? (
                      <ul className="divide-y divide-line/60 rounded-xl border border-line">
                        {imports.data.imports.map((w) => {
                          const mismatch = w.edition !== f.edition;
                          return (
                            <li key={w.id} className={clsx('flex items-center gap-3 px-3 py-2 text-sm', f.importId === w.id && 'bg-accent/[0.08]')}>
                              <button type="button" className="flex min-w-0 flex-1 items-center gap-3 text-left" disabled={mismatch} onClick={() => set('importId', w.id)} title={mismatch ? `This is a ${w.edition} world` : undefined}>
                                <span className={clsx('size-2 shrink-0 rounded-full', f.importId === w.id ? 'bg-accent' : 'bg-white/20')} />
                                <span className="min-w-0">
                                  <span className={clsx('block truncate font-medium', mismatch && 'opacity-50')}>{w.name}</span>
                                  <span className="block truncate text-xs text-muted">
                                    {w.edition} · level "{w.levelName}" · {fmtBytes(w.bytes)}{w.hasNether ? ' · nether' : ''}{w.hasEnd ? ' · end' : ''}
                                  </span>
                                </span>
                              </button>
                              <button type="button" className="btn-ghost btn-sm text-rose-300" onClick={() => deleteImport(w.id)}>
                                <Trash2 className="size-3.5" />
                              </button>
                            </li>
                          );
                        })}
                      </ul>
                    ) : (
                      <p className="text-xs text-muted">No imported worlds yet.</p>
                    )}
                    {selectedImport && (
                      <Field label="Level name" hint={isJava ? 'Folder name the world is copied to.' : 'Folder under worlds/ and the level-name property.'}>
                        <input className="input" placeholder={selectedImport.levelName} value={f.levelName} onChange={(e) => set('levelName', e.target.value)} />
                      </Field>
                    )}
                  </div>
                )}
              </>
            )}
          </div>

          <div className="card space-y-4 p-5">
            <h3 className="flex items-center gap-2 text-sm font-semibold">
              <Sparkles className="size-4 text-violet-300" /> Gameplay
            </h3>
            <Field label={isJava ? 'MOTD' : 'Server name shown in the friends list'}>
              <input className="input" placeholder={isJava ? 'A Minecraft Server' : f.name || 'Dedicated Server'} value={f.motd} onChange={(e) => set('motd', e.target.value)} />
            </Field>
            <div className="grid grid-cols-3 gap-3">
              <Field label="Players">
                <input className="input" type="number" min={1} max={1000} value={f.maxPlayers} onChange={(e) => set('maxPlayers', Number(e.target.value))} />
              </Field>
              <Field label="Mode">
                <select className="input" value={f.gamemode} onChange={(e) => set('gamemode', e.target.value)}>
                  {['survival', 'creative', 'adventure', ...(isJava ? ['spectator'] : [])].map((g) => (
                    <option key={g}>{g}</option>
                  ))}
                </select>
              </Field>
              <Field label="Difficulty">
                <select className="input" value={f.difficulty} onChange={(e) => set('difficulty', e.target.value)}>
                  {['peaceful', 'easy', 'normal', 'hard'].map((g) => (
                    <option key={g}>{g}</option>
                  ))}
                </select>
              </Field>
            </div>
            <div className="space-y-2">
              <Toggle checked={f.onlineMode} onChange={(v) => set('onlineMode', v)} label="Online mode" description={isJava ? 'Require authenticated Mojang/Microsoft accounts. Turn off only for offline networks or when using a proxy.' : 'Require Xbox Live authentication.'} />
              <Toggle checked={f.whitelist} onChange={(v) => set('whitelist', v)} label={isJava ? 'Whitelist' : 'Allowlist'} description="Only approved players can join." />
              {isJava ? <Toggle checked={f.pvp} onChange={(v) => set('pvp', v)} label="PvP" /> : <Toggle checked={f.cheats} onChange={(v) => set('cheats', v)} label="Allow cheats" description="Enables commands for operators." />}
            </div>
          </div>
        </div>
      )}

      <div className="flex items-center justify-between border-t border-line pt-5">
        <button className="btn-secondary" onClick={() => (step === 0 ? nav(-1) : setStep((step - 1) as Step))}>
          <ArrowLeft className="size-4" /> {step === 0 ? 'Cancel' : 'Back'}
        </button>
        {step < 2 ? (
          <button className="btn-primary" disabled={!canNext} onClick={() => setStep((step + 1) as Step)}>
            Continue <ArrowRight className="size-4" />
          </button>
        ) : (
          <button className="btn-primary" disabled={busy || (f.worldMode === 'import' && (f.importSource === 'server' ? !f.sourceServerId : !f.importId))} onClick={create}>
            {busy && <Spinner />} Create {TYPE_LABEL[f.type]} {f.version && isJava ? f.version : ''} server
          </button>
        )}
      </div>
    </div>
  );
}

function TypeCard({ type, selected, onClick, disabled, note }: { type: ServerType; selected: boolean; onClick: () => void; disabled?: boolean; note?: string }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={clsx('card card-hover relative flex flex-col items-start gap-1.5 p-4 text-left transition disabled:cursor-not-allowed disabled:opacity-50', selected && 'border-accent/50 bg-accent/[0.06] ring-2 ring-accent/20')}
    >
      {selected && (
        <span className="absolute top-3 right-3 flex size-5 items-center justify-center rounded-full bg-accent text-emerald-950">
          <Check className="size-3" />
        </span>
      )}
      <span className="text-sm font-semibold">{TYPE_LABEL[type]}</span>
      <span className="text-xs text-muted">{TYPE_BLURB[type]}</span>
      {note && <span className="text-[11px] text-amber-300">{note}</span>}
    </button>
  );
}
