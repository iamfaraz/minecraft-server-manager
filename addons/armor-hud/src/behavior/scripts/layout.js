// The wire format between the script (behavior pack) and the HUD (resource pack).
//
// The script sends one title per change: PREFIX followed by one fixed-width field pair per slot. The HUD cuts the
// fields back out by byte position, so every width here is in BYTES and both sides must agree (build.mjs generates
// the HUD from these same constants).

/** Marks a title as HUD data. Bump the number whenever the format changes, so old and new packs never mix. */
export const PREFIX = 'bhud1:';

/** Texture path below `textures/`, right-padded with PAD. */
export const ICON_W = 48;
export const PAD = '~';

/** Colour code (the section sign is 2 bytes, its letter 1) plus TEXT_CHARS characters of text. */
export const TEXT_CHARS = 5;
export const TEXT_W = 3 + TEXT_CHARS;

export const SLOT_W = ICON_W + TEXT_W;

/** Shown for a slot with nothing in it: a transparent texture shipped in the resource pack. */
export const EMPTY_ICON = 'bhud/empty';

/**
 * Slots in wire order. `side` and `row` place them around the hotbar (row 0 is the top one, row 3 sits level with
 * the hotbar), matching the reference layout: weapon and upper armour on the left, off hand and lower armour on the right.
 */
export const SLOTS = [
  { key: 'mainhand', side: 'left', row: 0 },
  { key: 'head', side: 'left', row: 1 },
  { key: 'chest', side: 'left', row: 2 },
  { key: 'arrows', side: 'left', row: 3 },
  { key: 'offhand', side: 'right', row: 0 },
  { key: 'legs', side: 'right', row: 1 },
  { key: 'feet', side: 'right', row: 2 },
  { key: 'free', side: 'right', row: 3 },
];
