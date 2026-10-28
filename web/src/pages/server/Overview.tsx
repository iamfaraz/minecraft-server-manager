import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Clock, Cpu, Gauge, HardDrive, MemoryStick, Users } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { api } from '../../lib/api';
import { fmtBytes, fmtDuration, fmtMb, timeAgo } from '../../lib/format';
import type { ServerSummary, StatsSample, WsEvent } from '../../lib/types';
import { useWsEvent } from '../../lib/ws';
import { Card, EmptyState, Stat } from '../../components/ui';
import { TYPE_LABEL } from '../../lib/types';

function Chart({ data, keyName, color, unit, max }: { data: StatsSample[]; keyName: 'cpu' | 'memMb'; color: string; unit: string; max?: number }) {
  if (data.length < 2) return <div className="flex h-44 items-center justify-center text-sm text-muted">Collecting samples…</div>;
  return (
    <div className="h-44">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -16 }}>
          <defs>
            <linearGradient id={`g-${keyName}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity={0.45} />
              <stop offset="100%" stopColor={color} stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid stroke="rgba(255,255,255,0.05)" vertical={false} />
          <XAxis dataKey="t" tickFormatter={(t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} stroke="rgba(255,255,255,0.15)" tick={{ fill: '#8b98a5', fontSize: 11 }} minTickGap={40} />
          <YAxis domain={[0, max || 'auto']} stroke="rgba(255,255,255,0.15)" tick={{ fill: '#8b98a5', fontSize: 11 }} tickFormatter={(v) => `${v}${unit}`} width={60} />
          <Tooltip contentStyle={{ background: '#0f141b', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 12, fontSize: 12 }} labelFormatter={(t) => new Date(Number(t)).toLocaleTimeString()} formatter={(v: number) => [`${v}${unit}`, keyName === 'cpu' ? 'CPU' : 'Memory']} />
          <Area type="monotone" dataKey={keyName} stroke={color} strokeWidth={2} fill={`url(#g-${keyName})`} isAnimationActive={false} />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

export function Overview({ s }: { s: ServerSummary }) {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ['stats', s.id], queryFn: () => api.get<{ samples: StatsSample[] }>(`/api/servers/${s.id}/stats`) });
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, []);
  useWsEvent((ev: WsEvent) => {
    if (ev.type === 'server.stats' && ev.id === s.id) {
      qc.setQueryData<{ samples: StatsSample[] }>(['stats', s.id], (old) => ({ samples: [...(old?.samples || []), ev.sample].slice(-180) }));
    }
  });
  const samples = data?.samples || [];
  const running = s.state === 'running';
  const uptime = s.startedAt ? fmtDuration(Date.now() - new Date(s.startedAt).getTime()) : '—';

  return (
    <div className="fade-up space-y-5">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Uptime" value={uptime} sub={running ? 'online' : s.lastExit ? `stopped ${timeAgo(s.lastExit.at)}` : 'offline'} icon={Clock} tone="accent" />
        <Stat label="Players" value={`${s.players.length}${s.ping?.max ? ` / ${s.ping.max}` : ''}`} sub={s.ping?.latencyMs != null ? `${s.ping.latencyMs} ms ping` : s.transport === 'nethernet' ? 'NetherNet: no player count in ping' : 'no ping yet'} icon={Users} tone="violet" />
        <Stat label="CPU" value={running && s.lastStats ? `${s.lastStats.cpu.toFixed(0)}%` : '—'} sub="of one core" icon={Cpu} tone="amber" />
        <Stat label="Memory" value={running && s.lastStats ? fmtMb(s.lastStats.memMb) : '—'} sub={s.java ? `heap limit ${fmtMb(s.java.xmxMb)}` : 'resident set size'} icon={MemoryStick} tone="rose" />
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        <Card title="CPU usage" action={<span className="text-xs text-muted">last 15 min</span>}>
          <Chart data={samples} keyName="cpu" color="#34d399" unit="%" />
        </Card>
        <Card title="Memory" action={<span className="text-xs text-muted">last 15 min</span>}>
          <Chart data={samples} keyName="memMb" color="#a78bfa" unit=" MB" max={s.java ? Math.round(s.java.xmxMb * 1.3) : undefined} />
        </Card>
      </div>

      <div className="grid gap-5 lg:grid-cols-3">
        <Card title="Online players" padded={false} className="lg:col-span-1">
          {s.players.length ? (
            <ul className="divide-y divide-line/60">
              {s.players.map((p) => (
                <li key={p.name} className="flex items-center gap-3 px-5 py-2.5">
                  <img src={s.edition === 'java' ? `https://mc-heads.net/avatar/${encodeURIComponent(p.name)}/32` : 'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 32 32%22%3E%3Crect width=%2232%22 height=%2232%22 rx=%226%22 fill=%22%230ea5e9%22 opacity=%220.3%22/%3E%3C/svg%3E'} className="size-7 rounded-md" alt="" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{p.name}</p>
                    <p className="truncate font-mono text-[11px] text-muted">{p.id || p.ip || ''}</p>
                  </div>
                  <span className="text-xs text-muted">{timeAgo(p.joinedAt)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState icon={Users} title={running ? 'Nobody online' : 'Server offline'} />
          )}
        </Card>
        <Card title="Details" className="lg:col-span-2">
          <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm sm:grid-cols-3">
            <Item label="Software" value={`${TYPE_LABEL[s.type]} ${s.version}`} />
            <Item label="World" value={s.levelName} />
            <Item label="Disk usage" value={fmtBytes(s.diskBytes)} icon={HardDrive} />
            {s.java && <Item label="Java" value={s.java.major === 'auto' ? 'Automatic' : `Java ${s.java.major}`} />}
            {s.java && <Item label="JVM flags" value={s.java.preset === 'aikar' ? "Aikar's" : s.java.preset === 'zgc' ? 'Generational ZGC' : 'None'} />}
            {s.build?.loaderVersion && <Item label="Loader" value={s.build.loaderVersion} />}
            <Item label="Port" value={s.edition === 'bedrock' ? (s.transport === 'nethernet' ? `${s.port} UDP + TCP` : `${s.port} / ${s.portV6} UDP`) : `${s.port} TCP`} />
            {s.edition === 'bedrock' && <Item label="Transport" value={s.transport === 'nethernet' ? 'NetherNet (WebRTC)' : 'RakNet'} />}
            {s.ping?.motd && <Item label="MOTD" value={s.ping.motd} />}
            {s.ping?.version && <Item label="Reported version" value={s.ping.version} icon={Gauge} />}
            <Item label="Auto start" value={s.autoStart ? 'On' : 'Off'} />
            <Item label="Crash restart" value={s.restartOnCrash ? 'On' : 'Off'} />
            <Item label="Backups" value={s.backup.schedule === 'off' ? 'Manual' : `${s.backup.schedule}, keep ${s.backup.keep}`} />
          </dl>
        </Card>
      </div>
    </div>
  );
}

function Item({ label, value, icon: Icon }: { label: string; value: string; icon?: typeof HardDrive }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] font-medium uppercase tracking-wider text-muted">{label}</dt>
      <dd className="mt-0.5 flex items-center gap-1.5 truncate font-medium" title={value}>
        {Icon && <Icon className="size-3.5 text-muted" />}
        {value}
      </dd>
    </div>
  );
}
