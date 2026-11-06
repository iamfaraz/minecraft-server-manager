import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { PackagePlus, Search, Trash2 } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import { ApiError, api } from '../../lib/api';
import { timeAgo } from '../../lib/format';
import type { CatalogueItem, InvItem, InventoryStatus, PlayerInventory, ServerSummary, SlotRef, WornSlot } from '../../lib/types';
import { Modal, Spinner } from '../../components/ui';
import { PlayerBody, PlayerHead } from '../../components/PlayerSkin';
import { useToast } from '../../components/Toast';

const bare = (id: string) => id.replace(/^minecraft:/, '');
const titleCase = (id: string) => bare(id).replace(/_/g, ' ').replace(/\b[a-z]/g, (c) => c.toUpperCase());
const ROMAN = ['', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X'];
const enchantLabel = (e: { id: string; level: number }) => `${titleCase(e.id)} ${ROMAN[e.level] ?? e.level}`;
const WORN_LABEL: Record<WornSlot, string> = { head: 'Helmet', chest: 'Chestplate', legs: 'Leggings', feet: 'Boots', offhand: 'Off hand' };
const slotLabel = (slot: SlotRef) => (typeof slot === 'string' ? WORN_LABEL[slot] : slot < 9 ? `Hotbar ${slot + 1}` : `Inventory slot ${slot - 8}`);

/** An item's picture. Blocks are one face of the block; items without a picture show their initials. */
function ItemIcon({ id, size }: { id: string; size: number }) {
  const [failed, setFailed] = useState(false);
  if (failed) {
    return (
      <span className="flex items-center justify-center rounded-sm bg-black/20 text-center font-semibold leading-none text-black/60" style={{ width: size, height: size, fontSize: Math.max(8, size * 0.3) }}>
        {bare(id).split('_').map((w) => w[0]).join('').slice(0, 3).toUpperCase()}
      </span>
    );
  }
  // Animated textures are tall strips of frames: show the first one.
  return <img src={`/api/icons/${encodeURIComponent(bare(id))}`} alt="" draggable={false} onError={() => setFailed(true)} style={{ width: size, height: size, objectFit: 'cover', objectPosition: 'top', imageRendering: 'pixelated' }} />;
}

const SLOT = 40;

/** One inventory square, drawn like Minecraft's: a sunken grey cell with the item, its count and its wear. */
function Slot({ item, selected, onClick, hint }: { item: InvItem | null; selected: boolean; onClick: () => void; hint?: string }) {
  const wear = item?.maxDamage && item.damage ? 1 - item.damage / item.maxDamage : null;
  const tip = item ? `${item.name ?? titleCase(item.id)}${item.count > 1 ? ` ×${item.count}` : ''}${item.enchants ? ` · ${item.enchants.map(enchantLabel).join(', ')}` : ''}` : hint;
  return (
    <button
      type="button"
      title={tip}
      onClick={onClick}
      className={clsx('relative flex shrink-0 items-center justify-center border-2 bg-[#8b8b8b]', selected ? 'border-white outline outline-2 outline-emerald-400' : 'border-b-white border-l-[#373737] border-r-white border-t-[#373737] hover:bg-[#a0a0a0]')}
      style={{ width: SLOT, height: SLOT }}
    >
      {item ? (
        <>
          <ItemIcon id={item.id} size={SLOT - 10} />
          {item.enchants && <span className="pointer-events-none absolute inset-0.5 bg-fuchsia-400/25 mix-blend-screen" />}
          {item.count > 1 && (
            <span className="pointer-events-none absolute bottom-0 right-0.5 font-mono text-[13px] font-bold leading-none text-white" style={{ textShadow: '1.5px 1.5px 0 #3f3f3f' }}>
              {item.count}
            </span>
          )}
          {wear !== null && (
            <span className="pointer-events-none absolute bottom-0.5 left-1 right-1 h-[3px] bg-black">
              <span className="block h-full" style={{ width: `${Math.max(4, wear * 100)}%`, background: `hsl(${wear * 120} 90% 50%)` }} />
            </span>
          )}
        </>
      ) : (
        hint && <span className="px-0.5 text-center text-[8px] font-semibold uppercase leading-tight text-black/25">{hint}</span>
      )}
    </button>
  );
}

/** Pick an item from the catalogue (or type any id) and a count. */
function ItemPicker({ title, confirmLabel, maxCount, busy, onCancel, onConfirm }: { title: string; confirmLabel: string; maxCount: number; busy: boolean; onCancel: () => void; onConfirm: (id: string, count: number) => void }) {
  const { data } = useQuery({ queryKey: ['items'], queryFn: () => api.get<{ items: CatalogueItem[] }>('/api/items'), staleTime: Infinity });
  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState<string | null>(null);
  const [count, setCount] = useState('1');
  const matches = useMemo(() => {
    const words = query.toLowerCase().replace(/^minecraft:/, '').split(/[\s_]+/).filter(Boolean);
    return (data?.items ?? []).filter((it) => words.every((w) => it.id.includes(w))).slice(0, 80);
  }, [data, query]);
  // Anything that looks like an id can be used even if it is not in the list (items from mods and add-ons).
  const typed = /^([a-z0-9_.-]+:)?[a-z0-9_./-]+$/.test(query.trim().toLowerCase()) && !matches.some((m) => bare(m.id) === bare(query.trim().toLowerCase())) ? query.trim().toLowerCase() : null;
  const n = Number(count);
  const valid = picked && Number.isInteger(n) && n >= 1 && n <= maxCount;
  return (
    <div className="flex h-full flex-col gap-3">
      <p className="text-sm font-semibold text-ink">{title}</p>
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted" />
        <input className="input pl-9" autoFocus placeholder="Search items, e.g. diamond sword" value={query} onChange={(e) => { setQuery(e.target.value); setPicked(null); }} />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto rounded-xl border border-line" style={{ maxHeight: 250 }}>
        {!data && <div className="flex justify-center p-6"><Spinner /></div>}
        {typed && (
          <button type="button" onClick={() => setPicked(typed)} className={clsx('flex w-full items-center gap-3 px-3 py-1.5 text-left text-sm', picked === typed ? 'bg-accent/15 text-ink' : 'text-muted hover:bg-white/5')}>
            <span className="font-mono text-xs">{typed}</span>
            <span className="text-xs">use this id as typed</span>
          </button>
        )}
        {matches.map((it) => (
          <button key={it.id} type="button" onClick={() => setPicked(it.id)} className={clsx('flex w-full items-center gap-3 px-3 py-1.5 text-left text-sm', picked === it.id ? 'bg-accent/15 text-ink' : 'text-muted hover:bg-white/5')}>
            <span className="flex size-7 shrink-0 items-center justify-center rounded bg-[#8b8b8b]">
              <ItemIcon id={it.id} size={22} />
            </span>
            <span className="truncate text-ink">{it.name}</span>
            <span className="ml-auto truncate font-mono text-[11px]">{bare(it.id)}</span>
          </button>
        ))}
        {data && !matches.length && !typed && <p className="p-4 text-sm text-muted">No item matches.</p>}
      </div>
      <div className="flex items-end gap-2">
        <label className="block">
          <span className="label">Count</span>
          <input className="input w-24 font-mono" inputMode="numeric" value={count} onChange={(e) => setCount(e.target.value.replace(/\D/g, ''))} />
        </label>
        <button className="btn-secondary ml-auto" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button className="btn-primary" disabled={!valid || busy} onClick={() => onConfirm(picked!, n)}>
          {busy && <Spinner />}
          {confirmLabel}
        </button>
      </div>
    </div>
  );
}

export function InventoryModal({ s, player, onClose }: { s: ServerSummary; player: string; onClose: () => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const base = `/api/servers/${s.id}/inventory`;
  const key = ['inventory', s.id, player.toLowerCase()];
  const status = useQuery({ queryKey: ['inventory-status', s.id], queryFn: () => api.get<InventoryStatus>(base), refetchInterval: 10_000 });
  const q = useQuery({
    queryKey: key,
    queryFn: () => api.get<PlayerInventory>(`${base}/${encodeURIComponent(player)}`),
    retry: false,
    // A live inventory changes under the admin's hands; saved data does not.
    refetchInterval: (query) => (query.state.data?.online ? 5000 : false),
  });
  const [selected, setSelected] = useState<SlotRef | null>(null);
  const [picker, setPicker] = useState<'give' | 'set' | null>(null);
  const [countText, setCountText] = useState('');
  const [levelText, setLevelText] = useState('');

  const change = useMutation({
    mutationFn: (op: Record<string, unknown>) => api.post<PlayerInventory>(`${base}/${encodeURIComponent(player)}`, op),
    onSuccess: (inv) => {
      qc.setQueryData(key, inv);
      if (inv.note) toast.success(inv.note);
      setPicker(null);
      setCountText('');
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const discard = useMutation({
    mutationFn: () => api.del<PlayerInventory>(`${base}/${encodeURIComponent(player)}/pending`),
    onSuccess: (inv) => qc.setQueryData(key, inv),
    onError: (e) => toast.error((e as Error).message),
  });
  const install = useMutation({
    mutationFn: () => api.post<InventoryStatus>(`${base}/bridge`),
    onSuccess: (st) => {
      qc.setQueryData(['inventory-status', s.id], st);
      toast.success(st.bridge?.running ? 'Installed. Restart the server to turn it on.' : 'Installed. It turns on when the server starts.');
    },
    onError: (e) => toast.error((e as Error).message),
  });

  const inv = q.data;
  const bridge = status.data?.bridge;
  const item = inv && selected !== null ? (typeof selected === 'string' ? inv.equipment[selected] : inv.slots[selected]) : null;
  const busy = change.isPending;

  const sourceNote = !inv
    ? null
    : inv.source === 'live'
      ? { text: 'Online: changes happen in the game right away', cls: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300' }
      : inv.source === 'file'
        ? { text: 'Offline: editing their saved data', cls: 'border-sky-500/30 bg-sky-500/10 text-sky-300' }
        : { text: `Offline: as of ${timeAgo(inv.at)}`, cls: 'border-amber-500/30 bg-amber-500/10 text-amber-300' };

  const slot = (ref: SlotRef, hint?: string) => (
    <Slot key={String(ref)} item={inv ? (typeof ref === 'string' ? inv.equipment[ref] : inv.slots[ref]) : null} selected={selected === ref} hint={hint} onClick={() => { setSelected(ref); setPicker(null); setCountText(''); }} />
  );

  let side: ReactNode;
  if (picker) {
    side = (
      <ItemPicker
        title={picker === 'give' ? `Give ${player} an item` : `Put an item in ${slotLabel(selected!).toLowerCase()}`}
        confirmLabel={picker === 'give' ? 'Give' : 'Put here'}
        maxCount={picker === 'give' ? 2304 : 99}
        busy={busy}
        onCancel={() => setPicker(null)}
        onConfirm={(id, count) => change.mutate(picker === 'give' ? { op: 'give', item: id, count } : { op: 'set', slot: selected, item: id, count })}
      />
    );
  } else {
    side = (
      <div className="space-y-5">
        <section>
          <p className="label">Experience</p>
          <div className="flex items-end gap-2">
            <input className="input w-24 font-mono" inputMode="numeric" placeholder={String(inv?.xp.level ?? 0)} value={levelText} onChange={(e) => setLevelText(e.target.value.replace(/\D/g, ''))} />
            <button className="btn-secondary" disabled={busy || levelText === ''} onClick={() => { change.mutate({ op: 'xp', level: Number(levelText) }); setLevelText(''); }}>
              Set level
            </button>
            {[1, 5, 10].map((n) => (
              <button key={n} className="btn-ghost btn-sm" disabled={busy || !inv} onClick={() => change.mutate({ op: 'xp', level: (inv?.xp.level ?? 0) + n })}>
                +{n}
              </button>
            ))}
          </div>
          <p className="mt-1.5 text-xs text-muted">Now level {inv?.xp.level ?? 0}. Setting a level starts it at zero progress.</p>
        </section>

        <section>
          <p className="label">{selected === null ? 'Slot' : slotLabel(selected)}</p>
          {selected === null ? (
            <p className="text-sm text-muted">Select a slot to change what is in it.</p>
          ) : item ? (
            <div className="space-y-3">
              <div className="flex items-center gap-3">
                <span className="flex size-12 shrink-0 items-center justify-center rounded-lg bg-[#8b8b8b]">
                  <ItemIcon id={item.id} size={36} />
                </span>
                <div className="min-w-0">
                  <p className="truncate font-medium text-ink">{item.name ?? titleCase(item.id)}</p>
                  <p className="truncate font-mono text-[11px] text-muted">{item.id}</p>
                </div>
              </div>
              {item.enchants && <p className="text-xs text-fuchsia-300">{item.enchants.map(enchantLabel).join(', ')}</p>}
              {item.damage !== undefined && item.damage > 0 && (
                <p className="text-xs text-muted">{item.maxDamage ? `Durability ${item.maxDamage - item.damage} of ${item.maxDamage}` : `Wear: ${item.damage} uses`}</p>
              )}
              {item.extra && <p className="text-xs text-muted">This item carries more data than is shown here.</p>}
              <div className="flex items-end gap-2">
                <label className="block">
                  <span className="label">Count</span>
                  <input className="input w-24 font-mono" inputMode="numeric" placeholder={String(item.count)} value={countText} onChange={(e) => setCountText(e.target.value.replace(/\D/g, ''))} />
                </label>
                <button className="btn-secondary" disabled={busy || countText === '' || Number(countText) < 1} onClick={() => change.mutate({ op: 'count', slot: selected, count: Number(countText) })}>
                  Set count
                </button>
              </div>
              <div className="flex flex-wrap gap-2">
                <button className="btn-secondary btn-sm" disabled={busy} onClick={() => setPicker('set')}>
                  Replace…
                </button>
                <button className="btn-danger btn-sm" disabled={busy} onClick={() => change.mutate({ op: 'clear', slot: selected })}>
                  <Trash2 className="size-3.5" /> Remove
                </button>
              </div>
            </div>
          ) : (
            <div className="space-y-3">
              <p className="text-sm text-muted">Empty.</p>
              <button className="btn-secondary btn-sm" disabled={busy} onClick={() => setPicker('set')}>
                Put an item here…
              </button>
            </div>
          )}
        </section>

        <button className="btn-primary" disabled={busy || !inv} onClick={() => setPicker('give')}>
          <PackagePlus className="size-4" /> Give item…
        </button>
      </div>
    );
  }

  const needsBridge = s.edition === 'bedrock' && bridge && !bridge.ready;
  return (
    <Modal
      open
      wide
      onClose={onClose}
      title={
        <span className="flex items-center gap-3">
          <PlayerHead serverId={s.id} player={player} size={28} />
          <span>{player}</span>
          {sourceNote && <span className={clsx('chip font-normal', sourceNote.cls)}>{sourceNote.text}</span>}
        </span>
      }
    >
      <div className="space-y-4">
        {needsBridge && (
          <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-amber-100">
            <p className="font-medium">{bridge.installed ? (bridge.running ? 'Restart the server to turn on inventory management' : 'Inventory management turns on when the server starts') : 'Bedrock needs a small helper to manage inventories'}</p>
            <p className="mt-1 text-xs text-amber-200/80">
              Bedrock has no command that shows an inventory, so Blockhost adds a script that runs inside this server. Nothing is installed on players' devices.
              {bridge.installed ? '' : ' After installing, restart the server once.'}
            </p>
            {(!bridge.installed || bridge.outdated) && (
              <button className="btn-primary btn-sm mt-3" disabled={install.isPending} onClick={() => install.mutate()}>
                {install.isPending && <Spinner />}
                {bridge.installed ? 'Update the helper' : 'Install the helper'}
              </button>
            )}
          </div>
        )}
        {inv?.pending ? (
          <div className="flex flex-wrap items-center gap-3 rounded-xl border border-line bg-white/[0.03] px-4 py-2.5 text-sm text-muted">
            <span>
              {inv.pending} change{inv.pending === 1 ? '' : 's'} waiting. {inv.pending === 1 ? 'It is' : 'They are'} applied when {player} joins; what you see below already includes {inv.pending === 1 ? 'it' : 'them'}.
            </span>
            <button className="btn-ghost btn-sm ml-auto" disabled={discard.isPending} onClick={() => discard.mutate()}>
              Discard
            </button>
          </div>
        ) : null}

        {q.isLoading ? (
          <div className="flex justify-center py-16">
            <Spinner className="size-6" />
          </div>
        ) : q.error && !inv ? (
          <p className="rounded-xl border border-line bg-white/[0.03] p-5 text-sm text-muted">{(q.error as ApiError).message}</p>
        ) : (
          <div className="flex flex-col gap-5 md:flex-row">
            {/* The inventory window, laid out like the one in the game */}
            <div className="shrink-0 self-center rounded-md border-2 border-black bg-[#c6c6c6] p-3 shadow-[inset_2px_2px_0_#fff,inset_-2px_-2px_0_#555] md:self-start">
              <div className="mb-3 flex gap-2">
                <div className="flex flex-col">
                  {slot('head', 'Head')}
                  {slot('chest', 'Chest')}
                  {slot('legs', 'Legs')}
                  {slot('feet', 'Feet')}
                </div>
                <div className="flex items-center justify-center bg-black px-6" style={{ height: SLOT * 4 }}>
                  <PlayerBody serverId={s.id} player={player} scale={4.5} />
                </div>
                <div className="flex flex-1 flex-col justify-between">
                  <div className="text-right text-[11px] font-semibold text-[#404040]">
                    <p className="text-sm">Level {inv!.xp.level}</p>
                    <div className="ml-auto mt-1 h-2 w-28 border border-black bg-[#3a3a3a]">
                      <div className="h-full bg-[#7efc20]" style={{ width: `${Math.round(inv!.xp.progress * 100)}%` }} />
                    </div>
                  </div>
                  <div className="flex items-end justify-end gap-2">
                    <span className="pb-1 text-[11px] font-semibold text-[#404040]">Off hand</span>
                    {slot('offhand')}
                  </div>
                </div>
              </div>
              <div className="grid grid-cols-9">{Array.from({ length: 27 }, (_, i) => slot(i + 9))}</div>
              <div className="mt-2 grid grid-cols-9">{Array.from({ length: 9 }, (_, i) => slot(i))}</div>
            </div>
            <div className="min-w-0 flex-1">{side}</div>
          </div>
        )}
      </div>
    </Modal>
  );
}
