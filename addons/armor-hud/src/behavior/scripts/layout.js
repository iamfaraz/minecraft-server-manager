// The wire format between the script (behavior pack) and the HUD (resource pack).
//
// The script talks to the HUD through hidden titles. Each title is one message, recognised by the key it starts with:
//   TEXT_KEY  + one fixed-width text field per slot   (all the numbers at once)
//   iconKey(i) + a texture path                        (the icon of one slot)
// Numbers are cut out of the text message by byte position, so those widths are in BYTES and both sides must agree
// (build.mjs generates the HUD from these same constants). Icons get a message each so the texture path reaches
// the HUD exactly and only its key has to be removed. Version 1 packed padded paths into the text message and
// trimmed them inside the HUD; on a real device every icon then showed the missing-texture pattern.

/** Every message contains this, which is how the HUD keeps them out of the normal title display. */
export const MARKER = 'bhud2';

export const TEXT_KEY = `${MARKER}t:`;
export const iconKey = (index) => `${MARKER}i${index}:`;

/** Colour code (the section sign is 2 bytes, its letter 1) plus TEXT_CHARS characters of text. */
export const TEXT_CHARS = 5;
export const TEXT_W = 3 + TEXT_CHARS;

/** Shown for a slot with nothing in it: a transparent texture shipped in the resource pack. */
export const EMPTY_ICON = 'bhud/empty';

/**
 * Slots in wire order. `side` and `row` place them around the hotbar (row 0 is the top one, row 3 sits level with
 * the hotbar), matching the reference layout: weapon and upper armour on the left, off hand and lower armour on the
 * right. A slot with `icon` always shows that texture, so it needs no icon messages.
 */
export const SLOTS = [
  { key: 'mainhand', side: 'left', row: 0 },
  { key: 'head', side: 'left', row: 1 },
  { key: 'chest', side: 'left', row: 2 },
  { key: 'arrows', side: 'left', row: 3 },
  { key: 'offhand', side: 'right', row: 0 },
  { key: 'legs', side: 'right', row: 1 },
  { key: 'feet', side: 'right', row: 2 },
  { key: 'free', side: 'right', row: 3, icon: 'items/bundle' },
];
