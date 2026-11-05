import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { CloudLightning, CloudRain, Megaphone, Moon, RefreshCw, Save, SlidersHorizontal, Sun, Sunrise, Sunset, Zap } from 'lucide-react';
import { useState } from 'react';
import { api } from '../../lib/api';
import { timeAgo } from '../../lib/format';
import type { ServerSummary } from '../../lib/types';
import { Card, MiniSwitch, Spinner } from '../../components/ui';
import { useToast } from '../../components/Toast';

interface Rule {
  key: string;
  name: string;
  label: string;
  desc?: string;
  group: string;
  type: 'bool' | 'int' | 'text';
  value: string;
}
interface World {
  running: boolean;
  edition: 'java' | 'bedrock';
  difficulty: string | null;
  weather: string | null;
  rules: Rule[];
  readAt: string | null;
  canSave: boolean;
}

const GROUP_ORDER = ['Display', 'Gameplay', 'World', 'Mobs', 'Damage', 'Drops', 'Advanced'];
const GROUP_BLURB: Record<string, string> = {
  Display: 'What players see on screen',
  Gameplay: 'Rules that affect players directly',
  World: 'Time, weather and how the world behaves',
  Mobs: 'Which creatures spawn',
  Damage: 'Sources of damage',
  Drops: 'What drops items',
  Advanced: 'Other rules reported by the server',
};

const Switch = MiniSwitch;

/** Live world controls for a running server: quick actions plus game rule toggles read back from the console. */
export function WorldControls({ s }: { s: ServerSummary }) {
  const qc = useQueryClient();
  const toast = useToast();
  const running = s.state === 'running';
  const q = useQuery({ queryKey: ['world', s.id], queryFn: () => api.get<World>(`/api/servers/${s.id}/world`), enabled: running, refetchInterval: 60_000, staleTime: 15_000 });
  const [pending, setPending] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const [openGroups, setOpenGroups] = useState<Set<string>>(new Set(['Display', 'Gameplay']));
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  const act = useMutation({
    mutationFn: (body: Record<string, unknown>) => api.post<{ message: string }>(`/api/servers/${s.id}/world`, body),
    onMutate: (body) => setPending(String(body.name ?? body.type) + String(body.value ?? '')),
    onSuccess: (r, body) => {
      qc.setQueryData<World>(['world', s.id], (old) => {
        if (!old) return old;
        if (body.type === 'gamerule') return { ...old, rules: old.rules.map((x) => (x.name === body.name ? { ...x, value: String(body.value) } : x)) };
        if (body.type === 'difficulty') return { ...old, difficulty: String(body.value) };
        if (body.type === 'weather') return { ...old, weather: String(body.value) };
        return old;
      });
      if (body.type !== 'gamerule') toast.success(r.message);
    },
    onError: (e) => {
      toast.error((e as Error).message);
      qc.invalidateQueries({ queryKey: ['world', s.id] });
    },
    onSettled: () => setPending(null),
  });
  const refresh = useMutation({
    mutationFn: () => api.get<World>(`/api/servers/${s.id}/world?refresh=1`),
    onSuccess: (d) => qc.setQueryData(['world', s.id], d),
  });

  if (!running)
    return (
      <Card title={<span className="flex items-center gap-2"><SlidersHorizontal className="size-4 text-accent" /> Live controls</span>}>
        <p className="text-sm text-muted">Start the server to change the time, weather, difficulty and game rules while it runs. Settings that apply at startup are under Settings.</p>
      </Card>
    );

  const w = q.data;
  const groups = GROUP_ORDER.map((g) => ({ g, rules: (w?.rules || []).filter((r) => r.group === g) })).filter((x) => x.rules.length);
  const toggleGroup = (g: string) => {
    const n = new Set(openGroups);
    if (n.has(g)) n.delete(g);
    else n.add(g);
    setOpenGroups(n);
  };
  const TimeBtn = ({ v, icon: Icon, label }: { v: string; icon: typeof Sun; label: string }) => (
    <button className="btn-secondary btn-sm" disabled={act.isPending} onClick={() => act.mutate({ type: 'time', value: v })}>
      <Icon className="size-3.5" /> {label}
    </button>
  );

  return (
    <div className="grid gap-5 lg:grid-cols-3">
      <Card className="lg:col-span-1" title={<span className="flex items-center gap-2"><Zap className="size-4 text-amber-300" /> Live controls</span>}>
        <div className="space-y-4 text-sm">
          <div>
            <span className="label">Time of day</span>
            <div className="flex flex-wrap gap-1.5">
              <TimeBtn v="day" icon={Sunrise} label="Day" />
              <TimeBtn v="noon" icon={Sun} label="Noon" />
              <TimeBtn v="night" icon={Sunset} label="Night" />
              <TimeBtn v="midnight" icon={Moon} label="Midnight" />
            </div>
          </div>
          <div>
            <span className="label">Weather{w?.weather ? ` · now ${w.weather}` : ''}</span>
            <div className="flex flex-wrap gap-1.5">
              {[
                { v: 'clear', icon: Sun, label: 'Clear' },
                { v: 'rain', icon: CloudRain, label: 'Rain' },
                { v: 'thunder', icon: CloudLightning, label: 'Thunder' },
              ].map((o) => (
                <button key={o.v} className={clsx('btn-sm', w?.weather === o.v ? 'btn-primary' : 'btn-secondary')} disabled={act.isPending} onClick={() => act.mutate({ type: 'weather', value: o.v })}>
                  <o.icon className="size-3.5" /> {o.label}
                </button>
              ))}
            </div>
          </div>
          <div>
            <span className="label">Difficulty</span>
            <div className="inline-flex rounded-xl border border-line bg-black/30 p-1">
              {['peaceful', 'easy', 'normal', 'hard'].map((d) => (
                <button key={d} disabled={act.isPending} onClick={() => act.mutate({ type: 'difficulty', value: d })} className={clsx('rounded-lg px-2.5 py-1 text-xs font-medium capitalize transition', w?.difficulty === d ? 'bg-white/10 text-ink shadow' : 'text-muted hover:text-ink')}>
                  {d}
                </button>
              ))}
            </div>
          </div>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (!message.trim()) return;
              act.mutate({ type: 'say', message });
              setMessage('');
            }}
          >
            <span className="label">Broadcast a message</span>
            <div className="flex gap-2">
              <input className="input" placeholder="Server restarting in 5 minutes" value={message} maxLength={240} onChange={(e) => setMessage(e.target.value)} />
              <button className="btn-secondary" disabled={!message.trim() || act.isPending}>
                <Megaphone className="size-4" />
              </button>
            </div>
          </form>
          {w?.canSave && (
            <button className="btn-secondary w-full" disabled={act.isPending} onClick={() => act.mutate({ type: 'save' })}>
              <Save className="size-4" /> Save world now
            </button>
          )}
        </div>
      </Card>

      <Card
        className="lg:col-span-2"
        padded={false}
        title={<span className="flex items-center gap-2"><SlidersHorizontal className="size-4 text-accent" /> Game rules</span>}
        action={
          <div className="flex items-center gap-2 text-xs text-muted">
            {w?.readAt && <span>read {timeAgo(w.readAt)}</span>}
            <button className="btn-ghost btn-sm" onClick={() => refresh.mutate()} disabled={refresh.isPending} title="Read values from the server again">
              <RefreshCw className={clsx('size-3.5', (refresh.isPending || q.isFetching) && 'animate-spin')} />
            </button>
          </div>
        }
      >
        {q.isLoading ? (
          <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted">
            <Spinner /> Reading game rules from the server…
          </div>
        ) : !groups.length ? (
          <p className="px-5 py-6 text-sm text-muted">The server did not report any game rules yet. It may still be starting; press refresh in a moment.</p>
        ) : (
          <div className="divide-y divide-line/60">
            {groups.map(({ g, rules }) => (
              <section key={g}>
                <button className="flex w-full items-center justify-between px-5 py-3 text-left hover:bg-white/[0.02]" onClick={() => toggleGroup(g)}>
                  <span>
                    <span className="text-sm font-semibold">{g}</span>
                    <span className="ml-2 text-xs text-muted">{GROUP_BLURB[g]}</span>
                  </span>
                  <span className="text-xs text-muted">{openGroups.has(g) ? 'Hide' : `${rules.length} rules`}</span>
                </button>
                {openGroups.has(g) && (
                  <ul className="grid gap-x-6 px-5 pb-3 sm:grid-cols-2">
                    {rules.map((r) => {
                      const busy = pending === r.name + (r.type === 'bool' ? String(r.value !== 'true') : drafts[r.name] ?? '');
                      return (
                        <li key={r.name} className="flex items-center justify-between gap-3 border-t border-line/40 py-2.5 first:border-t-0 sm:[&:nth-child(2)]:border-t-0">
                          <div className="min-w-0">
                            <p className="truncate text-sm">{r.label}</p>
                            <p className="truncate text-[11px] text-muted" title={r.desc}>
                              <span className="font-mono">{r.name}</span>
                              {r.desc ? ` · ${r.desc}` : ''}
                            </p>
                          </div>
                          {r.type === 'bool' ? (
                            <Switch on={r.value === 'true'} busy={busy || act.isPending} onChange={(v) => act.mutate({ type: 'gamerule', name: r.name, value: v })} />
                          ) : (
                            <form
                              className="flex shrink-0 items-center gap-1"
                              onSubmit={(e) => {
                                e.preventDefault();
                                const v = drafts[r.name];
                                if (v === undefined || v === r.value) return;
                                act.mutate({ type: 'gamerule', name: r.name, value: r.type === 'int' ? Number(v) : v });
                                setDrafts((d) => {
                                  const n = { ...d };
                                  delete n[r.name];
                                  return n;
                                });
                              }}
                            >
                              <input className="input w-20 py-1 text-right font-mono text-xs" inputMode={r.type === 'int' ? 'numeric' : 'text'} value={drafts[r.name] ?? r.value} onChange={(e) => setDrafts({ ...drafts, [r.name]: r.type === 'int' ? e.target.value.replace(/[^\d-]/g, '') : e.target.value })} />
                              {drafts[r.name] !== undefined && drafts[r.name] !== r.value && <button className="btn-primary btn-sm">Set</button>}
                            </form>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                )}
              </section>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
