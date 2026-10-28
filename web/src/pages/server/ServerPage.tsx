import { clsx } from 'clsx';
import { AlertTriangle, Copy, Globe2, Play, RotateCw, Skull, Square } from 'lucide-react';
import { useState } from 'react';
import { NavLink, Navigate, Route, Routes, useParams } from 'react-router-dom';
import { useServer } from '../../hooks/useServers';
import { api } from '../../lib/api';
import { copy, hostAddress } from '../../lib/format';
import { TYPE_LABEL } from '../../lib/types';
import { ConfirmModal, EditionBadge, ProgressBar, Spinner, StatusPill } from '../../components/ui';
import { useToast } from '../../components/Toast';
import { Overview } from './Overview';
import { Console } from './Console';
import { Players } from './Players';
import { Settings } from './Settings';
import { Versions } from './Versions';
import { Backups } from './Backups';
import { Addons } from './Addons';
import { Files } from './Files';

const TABS = [
  { to: '', label: 'Overview' },
  { to: 'console', label: 'Console' },
  { to: 'players', label: 'Players' },
  { to: 'addons', label: 'Addons' },
  { to: 'backups', label: 'Backups' },
  { to: 'versions', label: 'Versions' },
  { to: 'files', label: 'Files' },
  { to: 'settings', label: 'Settings' },
];

export function ServerPage() {
  const { id } = useParams();
  const { server: s, isLoading } = useServer(id);
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const [killOpen, setKillOpen] = useState(false);

  if (isLoading && !s)
    return (
      <div className="flex justify-center py-20">
        <Spinner />
      </div>
    );
  if (!s) return <Navigate to="/" replace />;

  const act = async (action: 'start' | 'stop' | 'restart' | 'kill') => {
    setBusy(action);
    try {
      await api.post(`/api/servers/${s.id}/${action}`);
      if (action === 'kill') toast.success('Process killed');
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(null);
      setKillOpen(false);
    }
  };

  const active = s.state === 'running' || s.state === 'starting' || s.state === 'stopping';
  const transitional = s.state === 'starting' || s.state === 'stopping' || s.state === 'installing';
  const lan = hostAddress(s.port);

  return (
    <div className="space-y-5">
      <div className="fade-up flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2.5">
            <h1 className="truncate text-2xl font-semibold tracking-tight">{s.name}</h1>
            <EditionBadge edition={s.edition} />
            <StatusPill state={s.state} />
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-sm text-muted">
            <span>
              {TYPE_LABEL[s.type]} <span className="font-mono text-ink">{s.version}</span>
            </span>
            <button className="group inline-flex items-center gap-1.5 font-mono hover:text-ink" onClick={() => copy(lan).then(() => toast.success('LAN address copied'))} title="Copy LAN address">
              {lan}
              <Copy className="size-3 opacity-0 transition group-hover:opacity-100" />
            </button>
            {s.geyser && s.geyserPort && (
              <span className="inline-flex items-center gap-1.5 font-mono">
                <Globe2 className="size-3.5 text-sky-300" /> Bedrock via Geyser :{s.geyserPort}
              </span>
            )}
            {s.address.remote.map((a) => (
              <button key={a} className="group inline-flex items-center gap-1.5 font-mono text-accent hover:text-emerald-200" onClick={() => copy(a.split(' ')[0]).then(() => toast.success('Public address copied'))} title="Copy public address">
                <Globe2 className="size-3.5" /> {a}
                <Copy className="size-3 opacity-0 transition group-hover:opacity-100" />
              </button>
            ))}
          </div>
        </div>
        <div className="flex items-center gap-2">
          {active ? (
            <>
              <button className="btn-secondary" disabled={busy !== null || transitional} onClick={() => act('restart')}>
                {busy === 'restart' ? <Spinner /> : <RotateCw className="size-4" />} Restart
              </button>
              <button className="btn-danger" disabled={busy !== null || s.state === 'stopping'} onClick={() => act('stop')}>
                {busy === 'stop' ? <Spinner /> : <Square className="size-4" />} Stop
              </button>
              {s.state === 'stopping' && (
                <button className="btn-ghost" title="Force kill" onClick={() => setKillOpen(true)}>
                  <Skull className="size-4" />
                </button>
              )}
            </>
          ) : (
            <button className="btn-primary" disabled={busy !== null || transitional || !s.installed} onClick={() => act('start')}>
              {busy === 'start' ? <Spinner /> : <Play className="size-4" />} Start
            </button>
          )}
        </div>
      </div>

      {s.state === 'installing' && s.install && (
        <div className="card fade-up p-4">
          <div className="mb-2 flex items-center justify-between text-sm">
            <span className="flex items-center gap-2">
              <Spinner className="size-4 animate-spin text-sky-300" /> {s.install.message}
            </span>
            {s.install.pct != null && <span className="font-mono text-muted">{s.install.pct}%</span>}
          </div>
          <ProgressBar pct={s.install.pct} />
        </div>
      )}
      {(s.state === 'crashed' || s.state === 'error') && (
        <div className="fade-up flex items-start gap-3 rounded-xl border border-rose-500/30 bg-rose-500/10 p-4 text-sm text-rose-100">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          <div>
            <p className="font-medium">{s.state === 'crashed' ? 'The server crashed' : 'Something went wrong'}</p>
            <p className="text-rose-200/80">
              {s.lastExit?.oom ? 'The process ran out of memory. Raise -Xmx or the container memory limit, and make sure the sum of all heaps leaves headroom.' : 'Check the console for details.'}
              {s.lastExit && ` Exit code ${s.lastExit.code ?? 'n/a'}${s.lastExit.signal ? `, signal ${s.lastExit.signal}` : ''}.`}
            </p>
          </div>
        </div>
      )}

      <nav className="flex gap-1 overflow-x-auto border-b border-line">
        {TABS.map((t) => (
          <NavLink key={t.to} to={t.to} end={t.to === ''} className={({ isActive }) => clsx('tab', isActive && 'tab-active')}>
            {t.label}
          </NavLink>
        ))}
      </nav>

      <Routes>
        <Route index element={<Overview s={s} />} />
        <Route path="console" element={<Console s={s} />} />
        <Route path="players" element={<Players s={s} />} />
        <Route path="addons" element={<Addons s={s} />} />
        <Route path="backups" element={<Backups s={s} />} />
        <Route path="versions" element={<Versions s={s} />} />
        <Route path="files" element={<Files s={s} />} />
        <Route path="settings" element={<Settings s={s} />} />
        <Route path="*" element={<Navigate to="" replace />} />
      </Routes>

      <ConfirmModal open={killOpen} onClose={() => setKillOpen(false)} onConfirm={() => act('kill')} title="Force kill the server?" body="SIGKILL skips the graceful save. Only use this if the server is hung. Unsaved chunks may be lost." confirmLabel="Kill process" danger busy={busy === 'kill'} />
    </div>
  );
}
