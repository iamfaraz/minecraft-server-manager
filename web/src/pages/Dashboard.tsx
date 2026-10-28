import { Activity, Cpu, MemoryStick, Plus, Server, Users, Play, Square, ArrowRight } from 'lucide-react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Area, AreaChart, ResponsiveContainer } from 'recharts';
import { useServers } from '../hooks/useServers';
import { api } from '../lib/api';
import { fmtMb, hostAddress } from '../lib/format';
import { TYPE_LABEL, type ServerSummary, type SystemInfo } from '../lib/types';
import { EditionBadge, EmptyState, ProgressBar, Stat, StatusPill } from '../components/ui';
import { useToast } from '../components/Toast';

function Sparkline({ id }: { id: string }) {
  const { data } = useQuery({ queryKey: ['stats', id], queryFn: () => api.get<{ samples: { t: number; cpu: number }[] }>(`/api/servers/${id}/stats`), refetchInterval: 10_000 });
  const samples = data?.samples.slice(-40) || [];
  if (samples.length < 2) return <div className="h-10" />;
  return (
    <div className="h-10">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={samples} margin={{ top: 2, bottom: 0, left: 0, right: 0 }}>
          <defs>
            <linearGradient id={`sg-${id}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#34d399" stopOpacity={0.5} />
              <stop offset="100%" stopColor="#34d399" stopOpacity={0} />
            </linearGradient>
          </defs>
          <Area type="monotone" dataKey="cpu" stroke="#34d399" strokeWidth={1.5} fill={`url(#sg-${id})`} isAnimationActive={false} />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

function ServerCard({ s }: { s: ServerSummary }) {
  const nav = useNavigate();
  const toast = useToast();
  const busy = s.state === 'starting' || s.state === 'stopping' || s.state === 'installing';
  const act = async (e: React.MouseEvent, action: 'start' | 'stop') => {
    e.preventDefault();
    e.stopPropagation();
    try {
      await api.post(`/api/servers/${s.id}/${action}`);
    } catch (err) {
      toast.error((err as Error).message);
    }
  };
  return (
    <Link to={`/servers/${s.id}`} className="card card-hover fade-up group flex flex-col gap-4 p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h3 className="truncate text-base font-semibold tracking-tight">{s.name}</h3>
            <EditionBadge edition={s.edition} />
          </div>
          <p className="mt-0.5 text-xs text-muted">
            {TYPE_LABEL[s.type]} {s.version} · <span className="font-mono">{hostAddress(s.port)}</span>
          </p>
        </div>
        <StatusPill state={s.state} />
      </div>
      {s.state === 'installing' && s.install ? (
        <div>
          <p className="mb-1.5 truncate text-xs text-muted">{s.install.message}</p>
          <ProgressBar pct={s.install.pct} />
        </div>
      ) : (
        <Sparkline id={s.id} />
      )}
      <div className="flex items-center justify-between text-xs text-muted">
        <div className="flex items-center gap-4">
          <span className="inline-flex items-center gap-1.5">
            <Users className="size-3.5" /> {s.players.length}
            {s.ping?.max ? ` / ${s.ping.max}` : ''}
          </span>
          <span className="inline-flex items-center gap-1.5">
            <Cpu className="size-3.5" /> {s.lastStats && s.state === 'running' ? `${s.lastStats.cpu.toFixed(0)}%` : '—'}
          </span>
          <span className="inline-flex items-center gap-1.5">
            <MemoryStick className="size-3.5" /> {s.lastStats && s.state === 'running' ? fmtMb(s.lastStats.memMb) : '—'}
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          {s.state === 'running' || s.state === 'starting' ? (
            <button className="btn-secondary btn-sm" disabled={busy} onClick={(e) => act(e, 'stop')}>
              <Square className="size-3" /> Stop
            </button>
          ) : (
            <button className="btn-primary btn-sm" disabled={busy || !s.installed} onClick={(e) => act(e, 'start')}>
              <Play className="size-3" /> Start
            </button>
          )}
          <span className="btn-ghost btn-sm opacity-0 transition group-hover:opacity-100" onClick={(e) => { e.preventDefault(); nav(`/servers/${s.id}`); }}>
            <ArrowRight className="size-3.5" />
          </span>
        </div>
      </div>
    </Link>
  );
}

export function Dashboard() {
  const { data: servers, isLoading } = useServers();
  const { data: sys } = useQuery({ queryKey: ['system'], queryFn: () => api.get<SystemInfo>('/api/system'), refetchInterval: 30_000 });
  const running = servers?.filter((s) => s.state === 'running') || [];
  const players = servers?.reduce((n, s) => n + s.players.length, 0) || 0;
  const cpu = servers?.reduce((n, s) => n + (s.state === 'running' ? s.lastStats?.cpu || 0 : 0), 0) || 0;
  const mem = servers?.reduce((n, s) => n + (s.state === 'running' ? s.lastStats?.memMb || 0 : 0), 0) || 0;
  const memCap = sys?.memory.limitMb || sys?.memory.totalMb;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
          <p className="mt-1 text-sm text-muted">
            {servers?.length ? `${running.length} of ${servers.length} servers online` : 'No servers yet'}
          </p>
        </div>
        <Link to="/new" className="btn-primary">
          <Plus className="size-4" /> New server
        </Link>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Servers online" value={`${running.length}`} sub={`${servers?.length || 0} total`} icon={Server} tone="accent" />
        <Stat label="Players" value={players} sub="across all servers" icon={Users} tone="violet" />
        <Stat label="CPU" value={`${cpu.toFixed(0)}%`} sub={sys ? `${sys.cpu.cores} cores available` : undefined} icon={Activity} tone="amber" />
        <Stat label="Memory" value={fmtMb(mem)} sub={memCap ? `of ${fmtMb(memCap)} ${sys?.memory.limitMb ? 'container limit' : 'host memory'}` : undefined} icon={MemoryStick} tone="rose" />
      </div>

      {isLoading ? null : servers?.length ? (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {servers.map((s) => (
            <ServerCard key={s.id} s={s} />
          ))}
        </div>
      ) : (
        <div className="card">
          <EmptyState
            icon={Server}
            title="Create your first server"
            description="Spin up a Java (Vanilla, Paper, Fabric, Forge…) or Bedrock server in a few clicks. Versions, backups, players and addons are all managed here."
            action={
              <Link to="/new" className="btn-primary">
                <Plus className="size-4" /> New server
              </Link>
            }
          />
        </div>
      )}
    </div>
  );
}
