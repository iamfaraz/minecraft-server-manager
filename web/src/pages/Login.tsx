import { useState } from 'react';
import { api } from '../lib/api';
import { Logo } from '../components/layout/Shell';
import { Field, Spinner } from '../components/ui';

export function Login({ setupRequired, onDone }: { setupRequired: boolean; onDone: (user: string) => void }) {
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mfaToken, setMfaToken] = useState<string | null>(null);
  const [code, setCode] = useState('');

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (setupRequired && password !== confirm) return setError('Passwords do not match');
    setBusy(true);
    try {
      if (mfaToken) {
        const r = await api.post<{ user: string }>('/api/auth/login/2fa', { mfaToken, code });
        onDone(r.user);
        return;
      }
      const r = await api.post<{ ok: boolean; user?: string; mfaRequired?: boolean; mfaToken?: string }>(setupRequired ? '/api/auth/setup' : '/api/auth/login', { username, password });
      if (r.mfaRequired && r.mfaToken) {
        setMfaToken(r.mfaToken);
        setCode('');
        return;
      }
      onDone(r.user!);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-full items-center justify-center p-6">
      <div className="fade-up w-full max-w-sm">
        <div className="mb-8 flex justify-center">
          <Logo />
        </div>
        {mfaToken ? (
          <form onSubmit={submit} className="card space-y-4 p-6">
            <div>
              <h1 className="text-lg font-semibold tracking-tight">Two-factor authentication</h1>
              <p className="mt-1 text-sm text-muted">Enter the 6-digit code from your authenticator app, or one of your recovery codes.</p>
            </div>
            <Field label="Authentication code">
              <input className="input text-center font-mono text-lg tracking-[0.3em]" value={code} onChange={(e) => setCode(e.target.value)} autoComplete="one-time-code" inputMode="numeric" autoFocus placeholder="123456" />
            </Field>
            {error && <p className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-200">{error}</p>}
            <button className="btn-primary w-full" disabled={busy || !code.trim()}>
              {busy && <Spinner />} Verify
            </button>
            <button type="button" className="btn-ghost w-full" onClick={() => { setMfaToken(null); setError(null); }}>
              Back to password
            </button>
          </form>
        ) : (
        <form onSubmit={submit} className="card space-y-4 p-6">
          <div>
            <h1 className="text-lg font-semibold tracking-tight">{setupRequired ? 'Create your admin account' : 'Welcome back'}</h1>
            <p className="mt-1 text-sm text-muted">{setupRequired ? 'This is a fresh install. Choose the credentials you will use to manage your servers.' : 'Sign in to manage your Minecraft servers.'}</p>
          </div>
          <Field label="Username">
            <input className="input" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" autoFocus />
          </Field>
          <Field label="Password" hint={setupRequired ? 'At least 8 characters.' : undefined}>
            <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete={setupRequired ? 'new-password' : 'current-password'} />
          </Field>
          {setupRequired && (
            <Field label="Confirm password">
              <input className="input" type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" />
            </Field>
          )}
          {error && <p className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-200">{error}</p>}
          <button className="btn-primary w-full" disabled={busy}>
            {busy && <Spinner />}
            {setupRequired ? 'Create account' : 'Sign in'}
          </button>
        </form>
        )}
      </div>
    </div>
  );
}
