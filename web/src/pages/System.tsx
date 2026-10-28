import { useQuery } from '@tanstack/react-query';
import { Coffee, Cpu, HardDrive, Info, KeyRound, MemoryStick, Network } from 'lucide-react';
import { useState } from 'react';
import { api } from '../lib/api';
import { fmtDuration, fmtMb } from '../lib/format';
import type { SystemInfo } from '../lib/types';
import { Card, Field, Spinner } from '../components/ui';
import { useToast } from '../components/Toast';

export function System() {
  const { data: s } = useQuery({ queryKey: ['system'], queryFn: () => api.get<SystemInfo>('/api/system'), refetchInterval: 15_000 });
  const toast = useToast();
  const [pw, setPw] = useState({ current: '', next: '', confirm: '' });
  const [busy, setBusy] = useState(false);

  const changePw = async (e: React.FormEvent) => {
    e.preventDefault();
    if (pw.next !== pw.confirm) return toast.error('Passwords do not match');
    setBusy(true);
    try {
      await api.post('/api/auth/password', { current: pw.current, next: pw.next });
      toast.success('Password updated');
      setPw({ current: '', next: '', confirm: '' });
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!s)
    return (
      <div className="flex justify-center py-20">
        <Spinner />
      </div>
    );
  const cap = s.memory.limitMb || s.memory.totalMb;
  const pct = Math.min(100, Math.round((s.memory.allocatedXmxMb / cap) * 100));

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">System</h1>
        <p className="mt-1 text-sm text-muted">Blockhost {s.version} · {s.platform}/{s.arch} · {s.inDocker ? 'running in Docker' : 'running on host'} · up {fmtDuration(s.uptimeSec * 1000)}</p>
      </div>
      <div className="grid gap-5 lg:grid-cols-2">
        <Card title={<span className="flex items-center gap-2"><MemoryStick className="size-4 text-rose-300" /> Memory budget</span>}>
          <div className="space-y-3 text-sm">
            <div className="flex justify-between">
              <span className="text-muted">Allocated to running Java heaps (-Xmx)</span>
              <span className="font-mono">{fmtMb(s.memory.allocatedXmxMb)}</span>
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-white/10">
              <div className={pct > 85 ? 'h-full bg-rose-400' : pct > 65 ? 'h-full bg-amber-400' : 'h-full bg-accent'} style={{ width: `${pct}%` }} />
            </div>
            <div className="flex justify-between text-muted">
              <span>{s.memory.limitMb ? 'Container limit' : 'Host memory'}</span>
              <span className="font-mono">{fmtMb(cap)}</span>
            </div>
            <p className="text-xs text-muted">
              Each JVM needs 1–2 GB above its -Xmx for metaspace, threads and the OS. Bedrock servers typically use 0.5–2 GB. If the sum exceeds the container limit, the Linux OOM killer will terminate a server. {s.memory.limitMb ? '' : 'Set a memory limit in docker-compose.yml to make this explicit.'}
            </p>
          </div>
        </Card>
        <Card title={<span className="flex items-center gap-2"><Network className="size-4 text-sky-300" /> Published ports</span>}>
          <div className="space-y-3 text-sm">
            <div className="flex justify-between">
              <span className="text-muted">Java (TCP)</span>
              <span className="font-mono">{s.ports.java[0]}–{s.ports.java[1]}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted">Bedrock &amp; Geyser (UDP)</span>
              <span className="font-mono">{s.ports.bedrock[0]}–{s.ports.bedrock[1]}</span>
            </div>
            <p className="text-xs text-muted">New servers are assigned ports from these ranges. They must match the ports published in docker-compose.yml (MCSM_JAVA_PORTS / MCSM_BEDROCK_PORTS). Bedrock servers use two consecutive UDP ports (IPv4 + IPv6).</p>
          </div>
        </Card>
        <Card title={<span className="flex items-center gap-2"><Coffee className="size-4 text-orange-300" /> Java runtimes</span>} padded={false}>
          <table className="w-full text-sm">
            <tbody>
              {s.javaRuntimes.map((r) => (
                <tr key={r.major} className="border-b border-line/60 last:border-0">
                  <td className="px-5 py-2.5 font-medium">Java {r.major}</td>
                  <td className="px-3 py-2.5 font-mono text-xs text-muted">{r.version}</td>
                  <td className="px-3 py-2.5 text-xs text-muted">{r.source}</td>
                </tr>
              ))}
              {!s.javaRuntimes.length && (
                <tr>
                  <td className="px-5 py-4 text-muted">None detected yet — runtimes are downloaded from Adoptium when a server needs them.</td>
                </tr>
              )}
            </tbody>
          </table>
        </Card>
        <Card title={<span className="flex items-center gap-2"><Cpu className="size-4 text-violet-300" /> Host</span>}>
          <dl className="grid grid-cols-2 gap-3 text-sm">
            <dt className="text-muted">CPU cores</dt>
            <dd className="text-right font-mono">{s.cpu.cores}</dd>
            <dt className="text-muted">Load (1 min)</dt>
            <dd className="text-right font-mono">{s.cpu.load1.toFixed(2)}</dd>
            <dt className="text-muted">Bedrock support</dt>
            <dd className="text-right">{s.bedrock.supported ? (s.bedrock.emulated ? 'Yes (box64 emulation)' : 'Yes (native x86_64)') : <span className="text-amber-300">No</span>}</dd>
            <dt className="text-muted">Data directory</dt>
            <dd className="truncate text-right font-mono text-xs" title={s.dataDir}>{s.dataDir}</dd>
          </dl>
          {!s.bedrock.supported && s.bedrock.reason && (
            <p className="mt-3 flex items-start gap-2 text-xs text-amber-300">
              <Info className="mt-0.5 size-3.5 shrink-0" /> {s.bedrock.reason}
            </p>
          )}
        </Card>
        <Card title={<span className="flex items-center gap-2"><KeyRound className="size-4 text-accent" /> Change password</span>}>
          <form onSubmit={changePw} className="space-y-3">
            <Field label="Current password">
              <input className="input" type="password" value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} autoComplete="current-password" />
            </Field>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="New password">
                <input className="input" type="password" value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} autoComplete="new-password" />
              </Field>
              <Field label="Confirm">
                <input className="input" type="password" value={pw.confirm} onChange={(e) => setPw({ ...pw, confirm: e.target.value })} autoComplete="new-password" />
              </Field>
            </div>
            <button className="btn-primary" disabled={busy || !pw.current || !pw.next}>
              {busy && <Spinner />} Update password
            </button>
          </form>
        </Card>
        <Card title={<span className="flex items-center gap-2"><HardDrive className="size-4 text-muted" /> Where things live</span>}>
          <ul className="space-y-1.5 font-mono text-xs text-muted">
            <li>{s.dataDir}/servers/&lt;id&gt;/root — server files (worlds, configs, plugins)</li>
            <li>{s.dataDir}/servers/&lt;id&gt;/backups — backup archives</li>
            <li>{s.dataDir}/runtimes — downloaded Java runtimes and the playit agent</li>
            <li>{s.dataDir}/cache — downloaded server jars and BDS zips</li>
          </ul>
        </Card>
      </div>
    </div>
  );
}
