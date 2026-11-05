import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { Ban, Crown, Search, ShieldCheck, UserPlus, UserX, Users } from 'lucide-react';
import { useMemo, useState } from 'react';
import { api } from '../../lib/api';
import { timeAgo } from '../../lib/format';
import type { ServerSummary, WsEvent } from '../../lib/types';
import { useWsEvent } from '../../lib/ws';
import { Card, EmptyState, MiniSwitch, Spinner, Toggle } from '../../components/ui';
import { useToast } from '../../components/Toast';

interface RosterEntry {
  name: string;
  id?: string;
  online: boolean;
  joinedAt?: string;
  lastSeen?: string;
  ip?: string;
  allowlisted: boolean;
  permission: string;
  opLevel?: number;
  blocked: boolean;
  blockReason?: string;
}
interface View {
  roster: RosterEntry[];
  permissionLevels: string[];
  defaultPermission: string | null;
  whitelistEnabled: boolean;
  running: boolean;
}
type Filter = 'all' | 'online' | 'allowlisted' | 'operators' | 'blocked';

const PERM_LABEL: Record<string, string> = { player: 'Player', operator: 'Operator', member: 'Member', visitor: 'Visitor', default: 'Default' };

export function Players({ s }: { s: ServerSummary }) {
  const qc = useQueryClient();
  const toast = useToast();
  const java = s.edition === 'java';
  const listName = java ? 'Whitelist' : 'Allowlist';
  const q = useQuery({ queryKey: ['players', s.id], queryFn: () => api.get<View>(`/api/servers/${s.id}/players`), refetchInterval: 15_000 });
  useWsEvent((ev: WsEvent) => {
    if ((ev.type === 'server.players' || ev.type === 'server.state') && ev.id === s.id) qc.invalidateQueries({ queryKey: ['players', s.id] });
  });
  const [busy, setBusy] = useState<string | null>(null);
  const act = useMutation({
    mutationFn: (b: { action: string; name: string; reason?: string; level?: string }) => api.post<{ message: string }>(`/api/servers/${s.id}/players/action`, b),
    onMutate: (b) => setBusy(`${b.action}:${b.name}`),
    onSuccess: (r) => {
      toast.success(r.message);
      // Console commands take a moment to reach the server's files.
      setTimeout(() => qc.invalidateQueries({ queryKey: ['players', s.id] }), 700);
    },
    onError: (e) => toast.error((e as Error).message),
    onSettled: () => setBusy(null),
  });
  const [name, setName] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [search, setSearch] = useState('');

  const v = q.data;
  const counts = useMemo(() => {
    const r = v?.roster || [];
    return { all: r.length, online: r.filter((p) => p.online).length, allowlisted: r.filter((p) => p.allowlisted).length, operators: r.filter((p) => p.permission === 'operator').length, blocked: r.filter((p) => p.blocked).length };
  }, [v]);
  const rows = useMemo(() => {
    let r = v?.roster || [];
    if (filter === 'online') r = r.filter((p) => p.online);
    if (filter === 'allowlisted') r = r.filter((p) => p.allowlisted);
    if (filter === 'operators') r = r.filter((p) => p.permission === 'operator');
    if (filter === 'blocked') r = r.filter((p) => p.blocked);
    const t = search.trim().toLowerCase();
    if (t) r = r.filter((p) => p.name.toLowerCase().includes(t) || (p.id || '').toLowerCase().includes(t));
    return r;
  }, [v, filter, search]);

  if (!v)
    return (
      <div className="flex justify-center py-16">
        <Spinner />
      </div>
    );

  const add = (action: string, extra: Record<string, string> = {}) => {
    const n = name.trim();
    if (!n) return;
    act.mutate({ action, name: n, ...extra });
    setName('');
  };
  const permOptions = java ? ['player', 'operator'] : ['default', 'visitor', 'member', 'operator'];

  return (
    <div className="fade-up space-y-5">
      <div className="grid gap-5 lg:grid-cols-3">
        <Card className="lg:col-span-2" title={<span className="flex items-center gap-2"><UserPlus className="size-4 text-accent" /> Add a player</span>}>
          <div className="space-y-3">
            <div className="flex flex-wrap gap-2">
              <input className="input min-w-48 flex-1" placeholder={java ? 'Minecraft username' : 'Xbox gamertag'} value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && add('whitelist-add')} />
              <button className="btn-secondary" disabled={!name.trim() || act.isPending} onClick={() => add('whitelist-add')}>
                <ShieldCheck className="size-4" /> {listName}
              </button>
              <button className="btn-secondary" disabled={!name.trim() || act.isPending} onClick={() => add('permission', { level: 'operator' })}>
                <Crown className="size-4" /> Operator
              </button>
              <button className="btn-danger" disabled={!name.trim() || act.isPending} onClick={() => add('block')}>
                <Ban className="size-4" /> Block
              </button>
            </div>
            <p className="text-xs text-muted">
              {java
                ? 'Works while the server is running or stopped. Offline, usernames are resolved through Mojang (or as offline-mode IDs when online-mode is off).'
                : 'Works while the server is running or stopped. Operator and permission changes need the player to have joined at least once, so their Xbox ID is known.'}
            </p>
          </div>
        </Card>
        <Card title={<span className="flex items-center gap-2"><ShieldCheck className="size-4 text-accent" /> Access</span>}>
          <div className="space-y-3">
            <Toggle checked={v.whitelistEnabled} onChange={(on) => act.mutate({ action: on ? 'whitelist-on' : 'whitelist-off', name: '' })} label={`${listName} required`} description={java ? 'Only listed players can join.' : 'Only listed players can join. Bedrock applies this on restart.'} />
            {!java && <p className="text-xs text-muted">New players get the <span className="text-ink">{v.defaultPermission}</span> permission (change <span className="font-mono">default-player-permission-level</span> under Settings).</p>}
          </div>
        </Card>
      </div>

      <Card
        padded={false}
        title={
          <div className="flex flex-wrap items-center gap-1.5">
            {(
              [
                ['all', 'All'],
                ['online', 'Online'],
                ['allowlisted', listName],
                ['operators', 'Operators'],
                ['blocked', 'Blocked'],
              ] as [Filter, string][]
            ).map(([f, label]) => (
              <button key={f} onClick={() => setFilter(f)} className={clsx('rounded-full border px-3 py-1 text-xs font-medium transition', filter === f ? 'border-accent/40 bg-accent/10 text-ink' : 'border-line text-muted hover:text-ink')}>
                {f === 'online' && <span className={clsx('mr-1.5 inline-block size-1.5 rounded-full align-middle', counts.online ? 'bg-emerald-400' : 'bg-slate-500')} />}
                {label} <span className="opacity-60">{counts[f]}</span>
              </button>
            ))}
          </div>
        }
        action={
          <div className="relative">
            <Search className="pointer-events-none absolute top-2 left-2.5 size-3.5 text-muted" />
            <input className="input w-44 py-1.5 pl-8 text-xs" placeholder="Search players" value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
        }
      >
        {!rows.length ? (
          <EmptyState icon={Users} title={v.roster.length ? 'No players match this filter' : 'No players yet'} description={v.roster.length ? undefined : 'Players appear here once they join, or when you add them above.'} />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-sm">
              <thead className="text-left text-[11px] uppercase tracking-wider text-muted">
                <tr className="border-b border-line">
                  <th className="px-5 py-2.5 font-medium">Player</th>
                  <th className="px-3 py-2.5 font-medium">Status</th>
                  <th className="px-3 py-2.5 font-medium">{listName}</th>
                  <th className="px-3 py-2.5 font-medium">Permission</th>
                  <th className="px-3 py-2.5 text-right font-medium">Actions</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((p) => (
                  <tr key={p.name} className={clsx('border-b border-line/60 last:border-0', p.blocked && 'bg-rose-500/[0.04]')}>
                    <td className="px-5 py-2.5">
                      <div className="flex items-center gap-3">
                        <span className={clsx('size-2 shrink-0 rounded-full', p.online ? 'bg-emerald-400 dot-live' : 'bg-slate-600')} />
                        {java ? <img src={`https://mc-heads.net/avatar/${encodeURIComponent(p.name)}/28`} className="size-7 rounded-md" alt="" loading="lazy" /> : <div className="flex size-7 items-center justify-center rounded-md bg-sky-500/15 text-xs font-semibold text-sky-300">{p.name.slice(0, 1).toUpperCase()}</div>}
                        <div className="min-w-0">
                          <p className={clsx('truncate font-medium', p.blocked && 'text-rose-200 line-through decoration-rose-400/50')}>{p.name}</p>
                          <p className="truncate font-mono text-[11px] text-muted">{p.id || (java ? 'UUID resolved when added' : 'Xbox ID unknown until they join')}</p>
                        </div>
                      </div>
                    </td>
                    <td className="px-3 py-2.5 text-xs">
                      {p.online ? (
                        <span className="text-emerald-300">Online · joined {timeAgo(p.joinedAt)}</span>
                      ) : p.lastSeen ? (
                        <span className="text-muted">Last seen {timeAgo(p.lastSeen)}</span>
                      ) : (
                        <span className="text-muted">Never joined</span>
                      )}
                      {p.blocked && <p className="text-rose-300">Blocked{p.blockReason ? `: ${p.blockReason}` : ''}</p>}
                    </td>
                    <td className="px-3 py-2.5">
                      <MiniSwitch on={p.allowlisted} busy={busy === `whitelist-add:${p.name}` || busy === `whitelist-remove:${p.name}`} onChange={(on) => act.mutate({ action: on ? 'whitelist-add' : 'whitelist-remove', name: p.name })} title={p.allowlisted ? `Remove from ${listName.toLowerCase()}` : `Add to ${listName.toLowerCase()}`} />
                    </td>
                    <td className="px-3 py-2.5">
                      <select
                        className={clsx('input w-32 py-1 text-xs', p.permission === 'operator' && 'border-amber-500/40 text-amber-200')}
                        value={p.permission}
                        disabled={busy === `permission:${p.name}`}
                        onChange={(e) => act.mutate({ action: 'permission', name: p.name, level: e.target.value })}
                      >
                        {permOptions.map((o) => (
                          <option key={o} value={o}>
                            {PERM_LABEL[o]}
                            {o === 'default' && v.defaultPermission ? ` (${v.defaultPermission})` : ''}
                            {o === 'operator' && java && p.opLevel ? ` · level ${p.opLevel}` : ''}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="px-3 py-2.5">
                      <div className="flex items-center justify-end gap-1">
                        {p.online && (
                          <button className="btn-ghost btn-sm" title="Kick" disabled={act.isPending} onClick={() => act.mutate({ action: 'kick', name: p.name, reason: 'Kicked by an operator' })}>
                            <UserX className="size-3.5" /> Kick
                          </button>
                        )}
                        {p.blocked ? (
                          <button className="btn-secondary btn-sm" disabled={act.isPending} onClick={() => act.mutate({ action: 'unblock', name: p.name })}>
                            Unblock
                          </button>
                        ) : (
                          <button
                            className="btn-ghost btn-sm text-rose-300"
                            disabled={act.isPending}
                            onClick={() => {
                              const reason = prompt(`Block ${p.name}? Optional reason shown to the player:`, '');
                              if (reason !== null) act.mutate({ action: 'block', name: p.name, reason: reason || undefined });
                            }}
                          >
                            <Ban className="size-3.5" /> Block
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="border-t border-line px-5 py-2 text-xs text-muted">
          {java
            ? 'Blocking uses the server\'s ban list. Operators can run every command; the level comes from op-permission-level in server.properties.'
            : 'Bedrock has no ban command, so Blockhost keeps the blocklist itself and removes blocked players the moment they join. Visitors can look but not build; members play normally; operators can run commands.'}
        </p>
      </Card>
    </div>
  );
}
