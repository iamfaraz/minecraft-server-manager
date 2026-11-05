// Turns what a player is wearing and carrying into the HUD payload. No Minecraft imports here, so it can be tested
// outside the game (see ../../../test.mjs).
import { EMPTY_ICON, SLOTS, TEXT_CHARS, TEXT_KEY, iconKey } from './layout.js';
import { BLOCK_TEXTURES, ITEM_TEXTURES } from './textures.js';

/** Item ids whose sprite file is not simply the id (or the id with golden_/wooden_ shortened). */
const SPRITE_ALIASES = {
  totem_of_undying: 'totem',
  bow: 'bow_standby',
  crossbow: 'crossbow_standby',
  fishing_rod: 'fishing_rod_uncast',
  firework_rocket: 'fireworks',
  golden_apple: 'apple_golden',
  enchanted_golden_apple: 'apple_golden',
  filled_map: 'map_filled',
  empty_map: 'map_empty',
  nautilus_shell: 'nautilus',
  bucket: 'bucket_empty',
  water_bucket: 'bucket_water',
  lava_bucket: 'bucket_lava',
  milk_bucket: 'bucket_milk',
  powder_snow_bucket: 'bucket_powder_snow',
  compass: 'compass_item',
  clock: 'clock_item',
  torch: 'blocks/torch_on',
  shield: 'ui/empty_armor_slot_shield', // shields are 3D models with no sprite; the slot outline stands in
};

/** Used when an item has no texture we can name (most blocks with several faces, items from other add-ons). */
const UNKNOWN_ICON = 'ui/inventory_icon';
const ARROW_ICON = 'items/arrow';

/** Texture path below `textures/` for an item id such as `minecraft:diamond_sword`. */
export function iconFor(typeId) {
  if (!typeId.startsWith('minecraft:')) return UNKNOWN_ICON;
  const id = typeId.slice('minecraft:'.length);
  const alias = SPRITE_ALIASES[id];
  if (alias) return alias.includes('/') ? alias : `items/${alias}`;
  for (const name of [id, id.replace(/^golden_/, 'gold_'), id.replace(/^wooden_/, 'wood_')]) {
    if (ITEM_TEXTURES.has(name)) return `items/${name}`;
  }
  if (BLOCK_TEXTURES.has(id)) return `blocks/${id}`;
  return UNKNOWN_ICON;
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

/** The longest texture path we will send; anything else falls back to the generic icon. */
const MAX_ICON_LENGTH = 64;

function iconPath(entry) {
  const icon = entry?.icon ?? EMPTY_ICON;
  return icon.length <= MAX_ICON_LENGTH && /^[a-z0-9_/]+$/.test(icon) ? icon : UNKNOWN_ICON;
}

/** One number on the wire: plain ASCII after the colour code, so byte positions are predictable. */
function textField(entry) {
  const text = (entry?.text ?? '').replace(/[^\x20-\x7e]/g, '').slice(0, TEXT_CHARS);
  // Right-aligned on both sides of the hotbar, so the numbers line up under each other.
  return '\u00a7' + (entry?.color ?? 'f') + text.padStart(TEXT_CHARS);
}

/**
 * The titles that put this player's HUD in the right state, one per channel: index 0 is the text message, then one
 * icon message per slot that has a changing icon. Sending a message again is harmless.
 */
export function buildMessages(state) {
  const entries = describe(state);
  const messages = [TEXT_KEY + SLOTS.map((slot) => textField(entries[slot.key])).join('')];
  SLOTS.forEach((slot, index) => {
    if (!slot.icon) messages.push(iconKey(index) + iconPath(entries[slot.key]));
  });
  return messages;
}

/** What the HUD holds before the first messages arrive: no numbers, transparent icons. */
export function initialText() {
  return TEXT_KEY + SLOTS.map(() => textField(null)).join('');
}
export function initialIcon(index) {
  return iconKey(index) + EMPTY_ICON;
}
