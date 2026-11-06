/** The shape of a player's inventory as the manager and the UI see it, for both editions. */

export interface InvItem {
  /** Namespaced id, e.g. `minecraft:diamond_sword`. */
  id: string;
  count: number;
  /** Largest stack this item allows, when known. */
  maxCount?: number;
  /** Durability used up, and the total, when the item wears out and the server tells us. */
  damage?: number;
  maxDamage?: number;
  /** Custom name given on an anvil. */
  name?: string;
  enchants?: { id: string; level: number }[];
  /** The item carries data beyond what is listed here (lore, contents, attributes...). Changing its count is not offered. */
  extra?: boolean;
}

export const WORN_SLOTS = ['head', 'chest', 'legs', 'feet', 'offhand'] as const;
export type WornSlot = (typeof WORN_SLOTS)[number];
/** 0-8 is the hotbar, 9-35 the rest of the inventory; names are the worn slots. */
export type SlotRef = number | WornSlot;

export interface PlayerInventory {
  player: string;
  online: boolean;
  /**
   * live: asked from the running server just now.
   * file: read from the player's data file (Java, player offline).
   * snapshot: as it was when the player was last seen (Bedrock, player offline), with queued changes already applied.
   */
  source: 'live' | 'file' | 'snapshot';
  /** When the data was current. */
  at: string;
  slots: (InvItem | null)[];
  equipment: Record<WornSlot, InvItem | null>;
  xp: { level: number; progress: number };
  /** Changes waiting for the player to join (Bedrock, offline). */
  pending?: number;
  /** Something worth telling the admin about the last change. */
  note?: string;
}

export type InvOp =
  | { op: 'give'; item: string; count: number }
  | { op: 'set'; slot: SlotRef; item: string; count: number }
  | { op: 'clear'; slot: SlotRef }
  | { op: 'count'; slot: SlotRef; count: number }
  | { op: 'xp'; level: number };

export const MAX_LEVEL = 24791; // Bedrock's cap; Java accepts more but nothing useful lives up there

const isWorn = (slot: SlotRef): slot is WornSlot => typeof slot === 'string';
const withNamespace = (id: string) => (id.includes(':') ? id : `minecraft:${id}`);

/** Check a change request coming from the UI and normalise it. Throws a readable message when it makes no sense. */
export function validateOp(raw: any): InvOp {
  const fail = (msg: string): never => {
    throw new Error(msg);
  };
  const slot = (v: any): SlotRef => {
    if (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 35) return v;
    if (typeof v === 'string' && (WORN_SLOTS as readonly string[]).includes(v)) return v as WornSlot;
    return fail('Unknown inventory slot');
  };
  const item = (v: any): string => {
    const id = String(v ?? '').trim().toLowerCase();
    if (!/^([a-z0-9_.-]+:)?[a-z0-9_./-]+$/.test(id)) fail('Item ids look like "diamond_sword" or "minecraft:diamond_sword"');
    return withNamespace(id);
  };
  const count = (v: any, max = 2304): number => {
    const n = Number(v);
    if (!Number.isInteger(n) || n < 1 || n > max) fail(`Count must be a whole number from 1 to ${max}`);
    return n;
  };
  switch (raw?.op) {
    case 'give':
      return { op: 'give', item: item(raw.item), count: count(raw.count ?? 1) };
    case 'set':
      return { op: 'set', slot: slot(raw.slot), item: item(raw.item), count: count(raw.count ?? 1, 99) };
    case 'clear':
      return { op: 'clear', slot: slot(raw.slot) };
    case 'count':
      return { op: 'count', slot: slot(raw.slot), count: count(raw.count, 99) };
    case 'xp': {
      const level = Number(raw.level);
      if (!Number.isInteger(level) || level < 0 || level > MAX_LEVEL) fail(`Level must be a whole number from 0 to ${MAX_LEVEL}`);
      return { op: 'xp', level };
    }
    default:
      return fail('Unknown inventory operation');
  }
}

/**
 * Apply a change to an inventory we hold in memory (a Bedrock snapshot, or a Java data file being edited), the
 * way the game would. Returns how many items of a `give` did not fit.
 */
export function applyOp(inv: Pick<PlayerInventory, 'slots' | 'equipment' | 'xp'>, op: InvOp): { overflow: number } {
  const get = (slot: SlotRef) => (isWorn(slot) ? inv.equipment[slot] : inv.slots[slot]);
  const put = (slot: SlotRef, item: InvItem | null) => {
    if (isWorn(slot)) inv.equipment[slot] = item;
    else inv.slots[slot] = item;
  };
  switch (op.op) {
    case 'give': {
      let left = op.count;
      const stackSize = inv.slots.find((s) => s?.id === op.item)?.maxCount ?? 64;
      for (const s of inv.slots) {
        if (!left) break;
        if (s?.id === op.item && !s.extra && !s.enchants && !s.name && s.count < (s.maxCount ?? stackSize)) {
          const add = Math.min(left, (s.maxCount ?? stackSize) - s.count);
          s.count += add;
          left -= add;
        }
      }
      for (let i = 0; i < inv.slots.length && left; i++) {
        if (inv.slots[i]) continue;
        const add = Math.min(left, stackSize);
        inv.slots[i] = { id: op.item, count: add, maxCount: stackSize };
        left -= add;
      }
      return { overflow: left };
    }
    case 'set':
      put(op.slot, { id: op.item, count: op.count });
      break;
    case 'clear':
      put(op.slot, null);
      break;
    case 'count': {
      const item = get(op.slot);
      if (!item) throw new Error('That slot is empty');
      item.count = Math.min(op.count, item.maxCount ?? 99);
      break;
    }
    case 'xp':
      inv.xp = { level: op.level, progress: 0 };
      break;
  }
  return { overflow: 0 };
}

export const emptyInventory = (): Pick<PlayerInventory, 'slots' | 'equipment' | 'xp'> => ({
  slots: Array.from({ length: 36 }, () => null),
  equipment: { head: null, chest: null, legs: null, feet: null, offhand: null },
  xp: { level: 0, progress: 0 },
});
