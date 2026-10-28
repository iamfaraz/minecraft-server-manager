import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Ban, Crown, Plus, ShieldCheck, UserMinus, UserX, Users } from 'lucide-react';
import { useState } from 'react';
import { api } from '../../lib/api';
import { timeAgo } from '../../lib/format';
import type { ServerSummary, WsEvent } from '../../lib/types';
import { useWsEvent } from '../../lib/ws';
import { Card, EmptyState, Spinner, Toggle } from '../../components/ui';
import { useToast } from '../../components/Toast';

interface Listed {
  name: string;
  id?: string;
  level?: number;
  reason?: string;
}
interface View {
  online: { name: string; id?: string; ip?: string; joinedAt: string }[];
  whitelist: Listed[];
  whitelistEnabled: boolean;
  ops: Listed[];
  banned: Listed[];
  seen: { name: string; id?: string; lastSeen: string }[];
  running: boolean;
}

export function Players({ s }: { s: ServerSummary }) {
  const qc = useQueryClient();
  const toast = useToast();
  const java = s.edition === 'java';
  const q = useQuery({ queryKey: ['players', s.id], queryFn: () => api.get<View>(`/api/servers/${s.id}/players`), refetchInterval: 15_000 });
  useWsEvent((ev: WsEvent) => {
    if ((ev.type === 'server.players' || ev.type === 'server.state') && ev.id === s.id) qc.invalidateQueries({ queryKey: ['players', s.id] });
  });
  const act = useMutation({
    mutationFn: (b: { action: string; name: string; reason?: string }) => api.post<{ message: string }>(`/api/servers/${s.id}/players/action`, b),
    onSuccess: (r) => {
      toast.success(r.message);
      setTimeout(() => qc.invalidateQueries({ queryKey: ['players', s.id] }), 600);
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const [wl, setWl] = useState('');
  const [op, setOp] = useState('');
  const v = q.data;
  const listName = java ? 'Whitelist' : 'Allowlist';

  if (!v)
    return (
      <div className="flex justify-center py-16">
        <Spinner />
      </div>
    );

  return (
    <div className="fade-up grid gap-5 lg:grid-cols-2">
      <Card title={`Online (${v.online.length})`} padded={false}>
        {v.online.length ? (
          <ul className="divide-y divide-line/60">
            {v.online.map((p) => (
              <li key={p.name} className="flex items-center gap-3 px-5 py-3">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">{p.name}</p>
                  <p className="font-mono text-[11px] text-muted">{p.id || ''} {p.ip ? `· ${p.ip}` : ''} · joined {timeAgo(p.joinedAt)}</p>
                </div>
                <button className="btn-ghost btn-sm" title="Make operator" onClick={() => act.mutate({ action: 'op', name: p.name })}>
                  <Crown className="size-3.5" />
                </button>
                <button className="btn-ghost btn-sm" title="Kick" onClick={() => act.mutate({ action: 'kick', name: p.name, reason: 'Kicked by an operator' })}>
                  <UserX className="size-3.5" />
                </button>
                {java && (
                  <button className="btn-ghost btn-sm text-rose-300" title="Ban" onClick={() => confirm(`Ban ${p.name}?`) && act.mutate({ action: 'ban', name: p.name })}>
                    <Ban className="size-3.5" />
                  </button>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState icon={Users} title={v.running ? 'Nobody online right now' : 'Server is offline'} />
        )}
      </Card>

      <Card title={<span className="flex items-center gap-2"><ShieldCheck className="size-4 text-accent" /> {listName} ({v.whitelist.length})</span>}>
        <div className="space-y-3">
          <Toggle checked={v.whitelistEnabled} onChange={(on) => act.mutate({ action: on ? 'whitelist-on' : 'whitelist-off', name: '' })} label={`${listName} enabled`} description={java ? 'Only listed players can join.' : 'Only listed players can join. Bedrock applies this on restart.'} />
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (wl.trim()) act.mutate({ action: 'whitelist-add', name: wl.trim() });
              setWl('');
            }}
          >
            <input className="input" placeholder={java ? 'Minecraft username' : 'Xbox gamertag'} value={wl} onChange={(e) => setWl(e.target.value)} />
            <button className="btn-secondary" disabled={!wl.trim() || act.isPending}>
              <Plus className="size-4" /> Add
            </button>
          </form>
          <PlayerList items={v.whitelist} empty="Nobody listed yet" onRemove={(n) => act.mutate({ action: 'whitelist-remove', name: n })} />
        </div>
      </Card>

      <Card title={<span className="flex items-center gap-2"><Crown className="size-4 text-amber-300" /> Operators ({v.ops.length})</span>}>
        <div className="space-y-3">
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (op.trim()) act.mutate({ action: 'op', name: op.trim() });
              setOp('');
            }}
          >
            <input className="input" placeholder={java ? 'Minecraft username' : 'Gamertag (must have joined before)'} value={op} onChange={(e) => setOp(e.target.value)} />
            <button className="btn-secondary" disabled={!op.trim() || act.isPending}>
              <Plus className="size-4" /> Op
            </button>
          </form>
          <PlayerList items={v.ops} empty="No operators" onRemove={(n) => act.mutate({ action: 'deop', name: n })} removeLabel="Deop" />
        </div>
      </Card>

      {java ? (
        <Card title={<span className="flex items-center gap-2"><Ban className="size-4 text-rose-300" /> Banned ({v.banned.length})</span>}>
          <PlayerList items={v.banned} empty="No banned players" onRemove={(n) => act.mutate({ action: 'pardon', name: n })} removeLabel="Pardon" />
        </Card>
      ) : null}

      <Card title="Recently seen" padded={false} className={java ? '' : 'lg:col-span-1'}>
        {v.seen.length ? (
          <ul className="max-h-72 divide-y divide-line/60 overflow-y-auto">
            {v.seen.map((p) => (
              <li key={p.name} className="flex items-center justify-between px-5 py-2.5 text-sm">
                <div className="min-w-0">
                  <span className="font-medium">{p.name}</span>
                  <span className="ml-2 font-mono text-[11px] text-muted">{p.id}</span>
                </div>
                <div className="flex items-center gap-1">
                  <span className="mr-2 text-xs text-muted">{timeAgo(p.lastSeen)}</span>
                  <button className="btn-ghost btn-sm" title={`Add to ${listName.toLowerCase()}`} onClick={() => act.mutate({ action: 'whitelist-add', name: p.name })}>
                    <ShieldCheck className="size-3.5" />
                  </button>
                  <button className="btn-ghost btn-sm" title="Op" onClick={() => act.mutate({ action: 'op', name: p.name })}>
                    <Crown className="size-3.5" />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState icon={Users} title="No players have joined yet" />
        )}
      </Card>
    </div>
  );
}

function PlayerList({ items, empty, onRemove, removeLabel = 'Remove' }: { items: Listed[]; empty: string; onRemove: (name: string) => void; removeLabel?: string }) {
  if (!items.length) return <p className="py-2 text-sm text-muted">{empty}</p>;
  return (
    <ul className="divide-y divide-line/60 rounded-xl border border-line">
      {items.map((p) => (
        <li key={p.name + (p.id || '')} className="flex items-center justify-between px-4 py-2.5 text-sm">
          <div className="min-w-0">
            <span className="font-medium">{p.name}</span>
            {p.id && <span className="ml-2 font-mono text-[11px] text-muted">{p.id}</span>}
            {p.reason && <p className="text-xs text-muted">{p.reason}</p>}
          </div>
          <button className="btn-ghost btn-sm" onClick={() => onRemove(p.name)}>
            <UserMinus className="size-3.5" /> {removeLabel}
          </button>
        </li>
      ))}
    </ul>
  );
}
