import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { Activity, BookOpen, Check, Copy, KeyRound, Plus, ShieldAlert, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { api } from '../lib/api';
import { fmtDate, timeAgo } from '../lib/format';
import type { ApiActivity, ApiEndpoint, ApiPreset, ApiRisk, ApiScope, ApiTokenView, ServerSummary } from '../lib/types';
import { useServers } from '../hooks/useServers';
import { Card, ConfirmModal, EmptyState, Field, Modal, Segmented, Spinner } from '../components/ui';
import { useToast } from '../components/Toast';

type TokensResponse = { tokens: ApiTokenView[]; scopes: ApiScope[]; presets: ApiPreset[] };

const RISK: Record<ApiRisk, { label: string; cls: string }> = {
  harmless: { label: 'Harmless', cls: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300' },
  sensitive: { label: 'Sensitive', cls: 'border-sky-500/30 bg-sky-500/10 text-sky-300' },
  changes: { label: 'Changes things', cls: 'border-amber-500/30 bg-amber-500/10 text-amber-300' },
  destructive: { label: 'Destructive', cls: 'border-rose-500/30 bg-rose-500/10 text-rose-300' },
};

function RiskBadge({ risk }: { risk: ApiRisk }) {
  return <span className={clsx('inline-block whitespace-nowrap rounded-md border px-1.5 py-0.5 text-[11px] font-medium', RISK[risk].cls)}>{RISK[risk].label}</span>;
}

function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="btn-secondary btn-sm shrink-0"
      onClick={() => {
        navigator.clipboard.writeText(text).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        });
      }}
    >
      {done ? <Check className="size-3.5" /> : <Copy className="size-3.5" />} {done ? 'Copied' : label}
    </button>
  );
}

const EXPIRY = [
  { value: 'never', label: 'Never' },
  { value: '30', label: '30 days' },
  { value: '90', label: '90 days' },
  { value: '365', label: '1 year' },
] as const;

/** The permission table: one row per scope, grouped, with what it allows, example endpoints and a risk label. */
function PermissionTable({ scopes, picked, onChange, limited }: { scopes: ApiScope[]; picked: Set<string>; onChange: (next: Set<string>) => void; limited: boolean }) {
  const groups = useMemo(() => {
    const m = new Map<string, ApiScope[]>();
    for (const s of scopes) m.set(s.group, [...(m.get(s.group) ?? []), s]);
    return [...m.entries()];
  }, [scopes]);
  const usable = (s: ApiScope) => !(limited && s.global);
  const toggle = (id: string, on: boolean) => {
    const n = new Set(picked);
    if (on) n.add(id);
    else n.delete(id);
    onChange(n);
  };
  return (
    <div className="overflow-x-auto rounded-xl border border-line">
      <table className="w-full min-w-[720px] text-left text-sm">
        <thead className="bg-white/[0.03] text-xs uppercase tracking-wider text-muted">
          <tr>
            <th className="w-10 px-3 py-2" />
            <th className="px-3 py-2">Permission</th>
            <th className="px-3 py-2">What it allows</th>
            <th className="px-3 py-2">Example endpoints</th>
            <th className="px-3 py-2">Risk</th>
          </tr>
        </thead>
        {groups.map(([group, list]) => {
          const allOn = list.filter(usable).every((s) => picked.has(s.id));
          return (
            <tbody key={group} className="border-t border-line">
              <tr className="bg-white/[0.015]">
                <td className="px-3 py-1.5">
                  <input
                    type="checkbox"
                    aria-label={`All ${group} permissions`}
                    checked={allOn && list.some(usable)}
                    disabled={!list.some(usable)}
                    onChange={(e) => {
                      const n = new Set(picked);
                      for (const s of list.filter(usable)) e.target.checked ? n.add(s.id) : n.delete(s.id);
                      onChange(n);
                    }}
                  />
                </td>
                <td colSpan={4} className="px-3 py-1.5 text-xs font-semibold uppercase tracking-wider text-muted">
                  {group}
                </td>
              </tr>
              {list.map((s) => (
                <tr key={s.id} className={clsx('border-t border-line/50 align-top', !usable(s) && 'opacity-40')}>
                  <td className="px-3 py-2">
                    <input type="checkbox" aria-label={s.label} checked={picked.has(s.id)} disabled={!usable(s)} onChange={(e) => toggle(s.id, e.target.checked)} />
                  </td>
                  <td className="px-3 py-2">
                    <div className="font-medium">{s.label}</div>
                    <code className="text-[11px] text-muted">{s.id}</code>
                    {s.global && <div className="text-[11px] text-muted">Whole manager{limited ? ': not for server-limited tokens' : ''}</div>}
                  </td>
                  <td className="px-3 py-2 text-xs text-ink/80">{s.description}</td>
                  <td className="px-3 py-2">
                    {s.examples.map((e) => (
                      <code key={e} className="block whitespace-nowrap text-[11px] text-muted">
                        {e}
                      </code>
                    ))}
                  </td>
                  <td className="px-3 py-2">
                    <RiskBadge risk={s.risk} />
                  </td>
                </tr>
              ))}
            </tbody>
          );
        })}
      </table>
    </div>
  );
}

function CreateTokenModal({ open, onClose, data, servers, onCreated }: { open: boolean; onClose: () => void; data: TokensResponse; servers: ServerSummary[]; onCreated: (token: string, info: ApiTokenView) => void }) {
  const toast = useToast();
  const [name, setName] = useState('');
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [limit, setLimit] = useState<'all' | 'some'>('all');
  const [only, setOnly] = useState<Set<string>>(new Set());
  const [expiry, setExpiry] = useState<(typeof EXPIRY)[number]['value']>('never');
  const limited = limit === 'some';
  const scopeById = new Map(data.scopes.map((s) => [s.id, s]));
  const effective = [...picked].filter((id) => !(limited && scopeById.get(id)?.global));
  const risky = effective.filter((id) => scopeById.get(id)?.risk === 'destructive');

  const create = useMutation({
    mutationFn: () =>
      api.post<{ token: string; info: ApiTokenView }>('/api/tokens', {
        name: name.trim(),
        scopes: effective,
        servers: limited ? [...only] : null,
        expiresAt: expiry === 'never' ? null : new Date(Date.now() + Number(expiry) * 86_400_000).toISOString(),
      }),
    onSuccess: (r) => {
      onCreated(r.token, r.info);
      setName('');
      setPicked(new Set());
      setLimit('all');
      setOnly(new Set());
      setExpiry('never');
    },
    onError: (e) => toast.error((e as Error).message),
  });

  const ready = !!name.trim() && effective.length > 0 && (!limited || only.size > 0);
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New access token"
      xwide
      footer={
        <>
          <button className="btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn-primary" disabled={!ready || create.isPending} onClick={() => create.mutate()}>
            {create.isPending && <Spinner />} Create token
          </button>
        </>
      }
    >
      <div className="space-y-5">
        <Field label="Name" hint="Where this token is used, so you can recognise it later.">
          <input className="input" value={name} maxLength={60} placeholder="e.g. Discord bot" onChange={(e) => setName(e.target.value)} />
        </Field>

        <div>
          <p className="mb-2 text-sm font-medium">Start from a preset</p>
          <div className="grid gap-2 sm:grid-cols-4">
            {data.presets.map((p) => (
              <button
                key={p.id}
                type="button"
                className="rounded-xl border border-line px-3 py-2 text-left transition hover:bg-white/[0.04]"
                onClick={() => {
                  setPicked(new Set(p.scopes));
                  if (!name.trim()) setName(p.label);
                }}
              >
                <span className="block text-sm font-medium">{p.label}</span>
                <span className="block text-[11px] text-muted">{p.description}</span>
              </button>
            ))}
          </div>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Servers">
            <Segmented
              value={limit}
              onChange={setLimit}
              options={[
                { value: 'all', label: 'All servers' },
                { value: 'some', label: 'Only these' },
              ]}
            />
            {limited && (
              <div className="mt-2 max-h-40 space-y-1 overflow-y-auto rounded-xl border border-line p-2">
                {servers.length === 0 && <p className="text-xs text-muted">No servers yet.</p>}
                {servers.map((s) => (
                  <label key={s.id} className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={only.has(s.id)}
                      onChange={(e) => {
                        const n = new Set(only);
                        e.target.checked ? n.add(s.id) : n.delete(s.id);
                        setOnly(n);
                      }}
                    />
                    {s.name}
                  </label>
                ))}
              </div>
            )}
          </Field>
          <Field label="Expires">
            <Segmented value={expiry} onChange={setExpiry} options={EXPIRY.map((e) => ({ value: e.value, label: e.label }))} />
          </Field>
        </div>

        <div>
          <div className="mb-2 flex items-baseline justify-between gap-2">
            <p className="text-sm font-medium">Permissions</p>
            <span className="text-xs text-muted">
              {effective.length} of {data.scopes.length} selected
            </span>
          </div>
          <PermissionTable scopes={data.scopes} picked={picked} onChange={setPicked} limited={limited} />
          {risky.length > 0 && (
            <p className="mt-2 flex items-start gap-1.5 text-xs text-rose-300">
              <ShieldAlert className="mt-0.5 size-3.5 shrink-0" /> This token can do destructive things ({risky.join(', ')}). Keep it somewhere safe.
            </p>
          )}
        </div>
      </div>
    </Modal>
  );
}

function RevealModal({ token, info, onClose }: { token: string; info: ApiTokenView; onClose: () => void }) {
  const origin = window.location.origin;
  const curl = `curl -H "Authorization: Bearer ${token}" ${origin}/api/v1/me`;
  return (
    <Modal open onClose={onClose} title={`Token created: ${info.name}`} footer={<button className="btn-primary" onClick={onClose}>Done</button>}>
      <div className="space-y-4">
        <p className="flex items-start gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-200">
          <ShieldAlert className="mt-0.5 size-4 shrink-0" /> Copy it now. It is shown only once; Blockhost keeps only a fingerprint of it.
        </p>
        <div className="flex items-center gap-2">
          <code className="min-w-0 flex-1 break-all rounded-lg bg-black/30 px-3 py-2 font-mono text-xs">{token}</code>
          <CopyButton text={token} />
        </div>
        <div>
          <p className="mb-1 text-xs text-muted">Try it:</p>
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 break-all rounded-lg bg-black/30 px-3 py-2 font-mono text-[11px]">{curl}</code>
            <CopyButton text={curl} />
          </div>
        </div>
      </div>
    </Modal>
  );
}

function ActivityModal({ token, onClose }: { token: ApiTokenView; onClose: () => void }) {
  const q = useQuery({ queryKey: ['token-activity', token.id], queryFn: () => api.get<{ activity: ApiActivity[] }>(`/api/tokens/${token.id}/activity`), refetchInterval: 10_000 });
  return (
    <Modal open onClose={onClose} title={`Recent activity: ${token.name}`} wide>
      {!q.data ? (
        <div className="flex justify-center py-8">
          <Spinner />
        </div>
      ) : q.data.activity.length === 0 ? (
        <p className="text-sm text-muted">Not used yet.</p>
      ) : (
        <table className="w-full text-left text-xs">
          <thead className="text-muted">
            <tr>
              <th className="py-1 pr-3">When</th>
              <th className="py-1 pr-3">Request</th>
              <th className="py-1 pr-3">Result</th>
              <th className="py-1">From</th>
            </tr>
          </thead>
          <tbody>
            {q.data.activity.map((a, i) => (
              <tr key={i} className="border-t border-line/50">
                <td className="py-1 pr-3 whitespace-nowrap text-muted" title={fmtDate(a.at)}>
                  {timeAgo(a.at)}
                </td>
                <td className="py-1 pr-3 font-mono">
                  {a.method} {a.path}
                </td>
                <td className={clsx('py-1 pr-3 font-mono', a.status >= 400 ? 'text-rose-300' : 'text-emerald-300')}>{a.status}</td>
                <td className="py-1 font-mono text-muted">{a.ip ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Modal>
  );
}

function TokensTab() {
  const qc = useQueryClient();
  const toast = useToast();
  const { data: servers = [] } = useServers();
  const q = useQuery({ queryKey: ['tokens'], queryFn: () => api.get<TokensResponse>('/api/tokens'), refetchInterval: 30_000 });
  const [creating, setCreating] = useState(false);
  const [revealed, setRevealed] = useState<{ token: string; info: ApiTokenView } | null>(null);
  const [activity, setActivity] = useState<ApiTokenView | null>(null);
  const [revoking, setRevoking] = useState<ApiTokenView | null>(null);
  const revoke = useMutation({
    mutationFn: (id: string) => api.del(`/api/tokens/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['tokens'] });
      setRevoking(null);
      toast.success('Token revoked');
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const nameOf = (id: string) => servers.find((s) => s.id === id)?.name ?? id;

  if (!q.data) {
    return (
      <div className="flex justify-center py-20">
        <Spinner className="size-6" />
      </div>
    );
  }
  const d = q.data;
  return (
    <>
      <Card
        title="Access tokens"
        action={
          <button className="btn-primary btn-sm" onClick={() => setCreating(true)}>
            <Plus className="size-4" /> New token
          </button>
        }
      >
        {d.tokens.length === 0 ? (
          <EmptyState icon={KeyRound} title="No tokens yet" description="Create a token for each bot, Home Assistant, script or app that should talk to Blockhost." />
        ) : (
          <div className="divide-y divide-line/60">
            {d.tokens.map((t) => (
              <div key={t.id} className="flex flex-wrap items-center gap-3 py-3">
                <KeyRound className="size-4 shrink-0 text-muted" />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{t.name}</span>
                    <code className="text-xs text-muted">{t.prefix}…</code>
                    {t.expired && <span className="chip border-rose-500/30 text-rose-300">Expired</span>}
                  </div>
                  <div className="mt-0.5 text-xs text-muted">
                    {t.scopes.length} permission{t.scopes.length === 1 ? '' : 's'} · {t.servers ? (t.servers.length ? t.servers.map(nameOf).join(', ') : 'no servers left') : 'all servers'} · {t.lastUsedAt ? `used ${timeAgo(t.lastUsedAt)}` : 'never used'}
                    {t.expiresAt && !t.expired && ` · expires ${fmtDate(t.expiresAt)}`}
                  </div>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {t.scopes.map((s) => (
                      <code key={s} className="rounded bg-white/5 px-1.5 py-0.5 text-[10px] text-muted">
                        {s}
                      </code>
                    ))}
                  </div>
                </div>
                <button className="btn-ghost btn-sm" onClick={() => setActivity(t)}>
                  <Activity className="size-3.5" /> Activity
                </button>
                <button className="btn-ghost btn-sm text-rose-300" onClick={() => setRevoking(t)}>
                  <Trash2 className="size-3.5" /> Revoke
                </button>
              </div>
            ))}
          </div>
        )}
      </Card>
      <CreateTokenModal
        open={creating}
        onClose={() => setCreating(false)}
        data={d}
        servers={servers}
        onCreated={(token, info) => {
          setCreating(false);
          setRevealed({ token, info });
          qc.invalidateQueries({ queryKey: ['tokens'] });
        }}
      />
      {revealed && <RevealModal {...revealed} onClose={() => setRevealed(null)} />}
      {activity && <ActivityModal token={activity} onClose={() => setActivity(null)} />}
      <ConfirmModal
        open={!!revoking}
        onClose={() => setRevoking(null)}
        onConfirm={() => revoking && revoke.mutate(revoking.id)}
        title={`Revoke "${revoking?.name}"?`}
        body="Anything using this token stops working at once, and its open event connections are closed."
        confirmLabel="Revoke"
        danger
        busy={revoke.isPending}
      />
    </>
  );
}

function curlFor(e: ApiEndpoint, origin: string): string {
  const path = e.path.replace(/:(\w+)/g, (_m, p) => `{${p}}`);
  const q = e.query ? `?${new URLSearchParams(e.query)}` : '';
  if (e.websocket) return `websocat -H "Authorization: Bearer $TOKEN" ${origin.replace(/^http/, 'ws')}${path}`;
  const parts = [`curl -H "Authorization: Bearer $TOKEN"`];
  if (e.method !== 'GET') parts.push(`-X ${e.method}`);
  if (e.body) parts.push(`-H "Content-Type: application/json" -d '${JSON.stringify(e.body)}'`);
  parts.push(`"${origin}${path}${q}"`);
  return parts.join(' ');
}

function ReferenceTab() {
  const q = useQuery({ queryKey: ['api-reference'], queryFn: () => api.get<{ endpoints: ApiEndpoint[]; scopes: ApiScope[] }>('/api/tokens/reference') });
  const origin = window.location.origin;
  if (!q.data) {
    return (
      <div className="flex justify-center py-20">
        <Spinner className="size-6" />
      </div>
    );
  }
  const label = new Map(q.data.scopes.map((s) => [s.id, s]));
  return (
    <div className="space-y-4">
      <Card title="Using the API">
        <div className="space-y-2 text-sm text-ink/85">
          <p>
            Send the token in an <code>Authorization: Bearer &lt;token&gt;</code> header. Responses are JSON. Errors look like{' '}
            <code>{'{"error":{"code":"forbidden","message":"…"}}'}</code>; codes are <code>bad_request</code>, <code>unauthorized</code>, <code>forbidden</code>, <code>not_found</code>, <code>conflict</code> and{' '}
            <code>rate_limited</code> (120 requests a minute per token, with a <code>Retry-After</code> header).
          </p>
          <p>
            <strong>/api/v1</strong> is stable: fields may be added, never renamed or removed. Tokens also work on the internal <code>/api/…</code> endpoints the web app uses (each needs the permission listed in the
            token dialog); those can change between releases.
          </p>
          <p>
            The events websocket accepts the header, or a first message <code>{'{"type":"auth","token":"…"}'}</code> within 5 seconds. Messages look like <code>{'{"event":"server.state","serverId":"…","data":{…}}'}</code>.
          </p>
        </div>
      </Card>
      {q.data.endpoints.map((e) => {
        const s = e.scope ? label.get(e.scope) : undefined;
        const curl = curlFor(e, origin);
        return (
          <div key={`${e.method} ${e.path}`} className="card p-4">
            <div className="flex flex-wrap items-center gap-2">
              <span className={clsx('rounded-md px-1.5 py-0.5 font-mono text-[11px] font-semibold', e.websocket ? 'bg-violet-500/15 text-violet-300' : e.method === 'GET' ? 'bg-emerald-500/15 text-emerald-300' : 'bg-sky-500/15 text-sky-300')}>
                {e.websocket ? 'WS' : e.method}
              </span>
              <code className="text-sm">{e.path.replace(/:(\w+)/g, '{$1}')}</code>
              <span className="ml-auto flex items-center gap-2 text-xs text-muted">
                {e.scope === '*' ? 'any token' : s ? <><code>{s.id}</code> <RiskBadge risk={s.risk} /></> : e.websocket ? 'per event' : null}
              </span>
            </div>
            <p className="mt-1.5 text-sm text-ink/80">{e.summary}</p>
            <div className="mt-2 flex items-start gap-2">
              <code className="min-w-0 flex-1 break-all rounded-lg bg-black/30 px-3 py-2 font-mono text-[11px] text-muted">{curl}</code>
              <CopyButton text={curl} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function ApiAccess() {
  const [tab, setTab] = useState<'tokens' | 'reference'>('tokens');
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">API access</h1>
          <p className="text-sm text-muted">Let bots, Home Assistant, scripts and apps use Blockhost, each with only the permissions you give it.</p>
        </div>
        <Segmented
          value={tab}
          onChange={setTab}
          options={[
            { value: 'tokens', label: <span className="flex items-center gap-1.5"><KeyRound className="size-3.5" /> Tokens</span> },
            { value: 'reference', label: <span className="flex items-center gap-1.5"><BookOpen className="size-3.5" /> Reference</span> },
          ]}
        />
      </div>
      {tab === 'tokens' ? <TokensTab /> : <ReferenceTab />}
    </div>
  );
}
