// Turns what a player is wearing and carrying into the HUD payload. No Minecraft imports here, so it can be tested
// outside the game (see ../../../test.mjs).
import { EMPTY_ICON, ICON_W, PAD, PREFIX, SLOTS, TEXT_CHARS } from './layout.js';
import { ICONS } from './icons.js';

/** Shown for anything the table has no texture for: items from other add-ons and a few 3D-only vanilla items. */
const UNKNOWN_ICON = 'ui/missing_item';
const ARROW_ICON = 'items/arrow';

/** Texture path below `textures/` for an item id such as `minecraft:diamond_sword`. */
export function iconFor(typeId) {
  return (typeId.startsWith('minecraft:') && ICONS[typeId.slice('minecraft:'.length)]) || UNKNOWN_ICON;
}

/** Remaining durability in percent. Never 100 once damaged, never 0 while the item still works. */
export function durabilityPercent(damage, max) {
  if (!max || max <= 0) return 100;
  const left = max - damage;
  if (left >= max) return 100;
  if (left <= 0) return 0;
  return Math.min(99, Math.max(1, Math.round((left / max) * 100)));
}

const durabilityColor = (pct) => (pct >= 90 ? 'a' : pct >= 60 ? 'b' : pct >= 30 ? 'e' : pct >= 10 ? '6' : 'c');

/** Armour piece or held item: durability if it wears out, otherwise how many of it the player carries. */
function describeItem(item, counts) {
  if (!item) return null;
  const icon = iconFor(item.id);
  if (item.maxDurability > 0) {
    const pct = durabilityPercent(item.damage ?? 0, item.maxDurability);
    return { icon, text: `${pct}%`, color: durabilityColor(pct) };
  }
  return { icon, text: String(counts.get(item.id) ?? item.amount), color: 'f' };
}

/**
 * @param state {{
 *   mainhand, offhand, head, chest, legs, feet: null | { id: string, amount: number, maxAmount: number, damage?: number, maxDurability?: number },
 *   counts: Map<string, number>,   // every item id the player carries -> total amount
 *   freeSlots: number,
 * }}
 * @returns {Record<string, null | { icon?: string, text: string, color: string }>} one entry per slot key
 */
export function describe(state) {
  const { counts } = state;
  const arrows = counts.get('minecraft:arrow') ?? 0;
  const hasLauncher = counts.has('minecraft:bow') || counts.has('minecraft:crossbow');
  return {
    mainhand: describeItem(state.mainhand, counts),
    offhand: describeItem(state.offhand, counts),
    head: describeItem(state.head, counts),
    chest: describeItem(state.chest, counts),
    legs: describeItem(state.legs, counts),
    feet: describeItem(state.feet, counts),
    arrows: arrows > 0 || hasLauncher ? { icon: ARROW_ICON, text: String(arrows), color: arrows === 0 ? 'c' : arrows < 16 ? 'e' : 'f' } : null,
    free: { text: String(state.freeSlots), color: state.freeSlots === 0 ? 'c' : state.freeSlots <= 3 ? 'e' : 'f' },
  };
}

/** Icon field: the texture path, padded to a fixed width. Letters, digits, _ and / only, so the pad character never appears in one. */
function iconField(entry) {
  const icon = entry?.icon ?? EMPTY_ICON;
  return (icon.length <= ICON_W && /^[A-Za-z0-9_/]+$/.test(icon) ? icon : UNKNOWN_ICON).padEnd(ICON_W, PAD);
}

/** Text field: plain ASCII after the colour code, so byte positions are predictable. */
function textField(entry) {
  const text = (entry?.text ?? '').replace(/[^\x20-\x7e]/g, '').slice(0, TEXT_CHARS);
  // Right-aligned on both sides of the hotbar, so the numbers line up under each other.
  return '\u00a7' + (entry?.color ?? 'f') + text.padStart(TEXT_CHARS);
}

/** The title text that puts this player's HUD in the right state. Sending it again is harmless. */
export function buildPayload(state) {
  const entries = describe(state);
  return PREFIX + SLOTS.map((slot) => iconField(entries[slot.key]) + textField(entries[slot.key])).join('');
}
