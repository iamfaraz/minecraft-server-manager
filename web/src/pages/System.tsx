import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Coffee, Copy, Cpu, HardDrive, Info, KeyRound, MemoryStick, Network, ShieldCheck } from 'lucide-react';
import { useState } from 'react';
import { api } from '../lib/api';
import { fmtDuration, fmtMb } from '../lib/format';
import type { SystemInfo } from '../lib/types';
import { Card, Field, Modal, Spinner } from '../components/ui';
import { copy } from '../lib/format';
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

  const qc = useQueryClient();
  const tfa = useQuery({ queryKey: ['2fa'], queryFn: () => api.get<{ enabled: boolean; recoveryCodesLeft: number; enabledAt?: string }>('/api/auth/2fa') });
  const [setup, setSetup] = useState<{ secret: string; otpauthUrl: string; qrDataUrl: string; account: string } | null>(null);
  const [confirmCode, setConfirmCode] = useState('');
  const [recovery, setRecovery] = useState<string[] | null>(null);
  const [disable, setDisable] = useState<{ password: string; code: string } | null>(null);
  const [regenCode, setRegenCode] = useState<string | null>(null);
  const [tfaBusy, setTfaBusy] = useState(false);
  const run = async (fn: () => Promise<void>) => {
    setTfaBusy(true);
    try {
      await fn();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setTfaBusy(false);
    }
  };
  const beginSetup = () => run(async () => { setSetup(await api.post('/api/auth/2fa/setup')); setConfirmCode(''); });
  const confirmSetup = () =>
    run(async () => {
      const r = await api.post<{ recoveryCodes: string[] }>('/api/auth/2fa/confirm', { code: confirmCode });
      setSetup(null);
      setRecovery(r.recoveryCodes);
      qc.invalidateQueries({ queryKey: ['2fa'] });
      toast.success('Two-factor authentication enabled');
    });
  const doDisable = () =>
    run(async () => {
      await api.post('/api/auth/2fa/disable', disable);
      setDisable(null);
      qc.invalidateQueries({ queryKey: ['2fa'] });
      toast.success('Two-factor authentication disabled');
    });
  const doRegen = () =>
    run(async () => {
      const r = await api.post<{ recoveryCodes: string[] }>('/api/auth/2fa/recovery-codes', { code: regenCode });
      setRegenCode(null);
      setRecovery(r.recoveryCodes);
      qc.invalidateQueries({ queryKey: ['2fa'] });
    });

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
              <span className="text-muted">Bedrock &amp; Geyser (UDP, plus TCP for NetherNet)</span>
              <span className="font-mono">{s.ports.bedrock[0]}–{s.ports.bedrock[1]}</span>
            </div>
            <p className="text-xs text-muted">New servers are assigned ports from these ranges. They must match the ports published in docker-compose.yml (MCSM_JAVA_PORTS / MCSM_BEDROCK_PORTS). RakNet servers use two consecutive UDP ports (IPv4 + IPv6); NetherNet servers use one port on both UDP and TCP.</p>
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
        <Card title={<span className="flex items-center gap-2"><ShieldCheck className="size-4 text-sky-300" /> Two-factor authentication</span>}>
          {tfa.data?.enabled ? (
            <div className="space-y-3 text-sm">
              <p className="flex items-center gap-2 text-emerald-300">
                <ShieldCheck className="size-4" /> Enabled{tfa.data.enabledAt ? ` since ${new Date(tfa.data.enabledAt).toLocaleDateString()}` : ''}
              </p>
              <p className="text-muted">Logging in requires a code from your authenticator app. {tfa.data.recoveryCodesLeft} recovery code{tfa.data.recoveryCodesLeft === 1 ? '' : 's'} left.</p>
              <div className="flex flex-wrap gap-2">
                <button className="btn-secondary btn-sm" onClick={() => setRegenCode('')}>New recovery codes</button>
                <button className="btn-danger btn-sm" onClick={() => setDisable({ password: '', code: '' })}>Disable 2FA</button>
              </div>
            </div>
          ) : setup ? (
            <div className="space-y-4 text-sm">
              <p className="text-muted">Scan this QR code with Google Authenticator, Authy, 1Password, Bitwarden or any TOTP app, or enter the setup key manually.</p>
              <div className="flex flex-col items-center gap-3 sm:flex-row sm:items-start">
                <img src={setup.qrDataUrl} alt="2FA QR code" className="size-44 rounded-xl border border-line" />
                <div className="min-w-0 flex-1 space-y-2">
                  <span className="label">Setup key</span>
                  <div className="flex items-center gap-2">
                    <code className="flex-1 break-all rounded-lg border border-line bg-black/30 px-3 py-2 font-mono text-xs tracking-wider">{setup.secret.replace(/(.{4})/g, '$1 ').trim()}</code>
                    <button className="btn-ghost btn-sm" onClick={() => copy(setup.secret).then(() => toast.success('Setup key copied'))}><Copy className="size-3.5" /></button>
                  </div>
                  <p className="text-xs text-muted">Type: time-based (TOTP) · SHA1 · 6 digits · 30 s · account {setup.account}</p>
                </div>
              </div>
              <Field label="Enter the 6-digit code shown in the app to confirm">
                <div className="flex gap-2">
                  <input className="input font-mono tracking-[0.3em]" inputMode="numeric" autoComplete="one-time-code" placeholder="123456" value={confirmCode} onChange={(e) => setConfirmCode(e.target.value)} />
                  <button className="btn-primary" disabled={tfaBusy || confirmCode.replace(/\s/g, '').length !== 6} onClick={confirmSetup}>{tfaBusy ? <Spinner /> : 'Enable'}</button>
                </div>
              </Field>
              <button className="btn-ghost btn-sm" onClick={() => setSetup(null)}>Cancel</button>
            </div>
          ) : (
            <div className="space-y-3 text-sm">
              <p className="text-muted">Add a second step to sign-in with a time-based one-time code (TOTP) from an authenticator app. You will also get recovery codes in case you lose the device.</p>
              <button className="btn-primary" onClick={beginSetup} disabled={tfaBusy}>{tfaBusy ? <Spinner /> : <ShieldCheck className="size-4" />} Set up two-factor authentication</button>
            </div>
          )}
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

      <Modal open={!!recovery} onClose={() => setRecovery(null)} title="Recovery codes" footer={<button className="btn-primary" onClick={() => setRecovery(null)}>I have saved them</button>}>
        <div className="space-y-3 text-sm">
          <p className="text-muted">Each code works once if you lose access to your authenticator. Store them somewhere safe; they are not shown again.</p>
          <div className="grid grid-cols-2 gap-2 rounded-xl border border-line bg-black/30 p-3 font-mono text-sm">
            {recovery?.map((c) => <span key={c}>{c}</span>)}
          </div>
          <button className="btn-secondary btn-sm" onClick={() => copy((recovery || []).join('\n')).then(() => toast.success('Recovery codes copied'))}><Copy className="size-3.5" /> Copy all</button>
        </div>
      </Modal>
      <Modal open={!!disable} onClose={() => setDisable(null)} title="Disable two-factor authentication" footer={<><button className="btn-secondary" onClick={() => setDisable(null)}>Cancel</button><button className="btn-danger" disabled={tfaBusy || !disable?.password || !disable?.code} onClick={doDisable}>{tfaBusy ? <Spinner /> : 'Disable'}</button></>}>
        <div className="space-y-3">
          <Field label="Password"><input className="input" type="password" value={disable?.password || ''} onChange={(e) => setDisable({ ...disable!, password: e.target.value })} autoComplete="current-password" /></Field>
          <Field label="Authentication or recovery code"><input className="input font-mono" value={disable?.code || ''} onChange={(e) => setDisable({ ...disable!, code: e.target.value })} autoComplete="one-time-code" /></Field>
        </div>
      </Modal>
      <Modal open={regenCode !== null} onClose={() => setRegenCode(null)} title="Generate new recovery codes" footer={<><button className="btn-secondary" onClick={() => setRegenCode(null)}>Cancel</button><button className="btn-primary" disabled={tfaBusy || !regenCode} onClick={doRegen}>{tfaBusy ? <Spinner /> : 'Generate'}</button></>}>
        <Field label="Confirm with an authentication code" hint="Existing recovery codes stop working."><input className="input font-mono" value={regenCode || ''} onChange={(e) => setRegenCode(e.target.value)} autoComplete="one-time-code" /></Field>
      </Modal>
    </div>
  );
}
