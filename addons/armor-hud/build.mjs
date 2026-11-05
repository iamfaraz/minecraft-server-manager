#!/usr/bin/env node
// Builds blockhost-armor-hud.mcaddon: the behavior pack (script) plus the resource pack (HUD layout).
// The HUD layout is generated here from the same constants the script uses, so the two cannot drift apart.
//   node addons/armor-hud/build.mjs
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MARKER, SLOTS, TEXT_KEY, TEXT_W, iconKey } from './src/behavior/scripts/layout.js';
import { initialIcon, initialText } from './src/behavior/scripts/hud.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(here, 'blockhost-armor-hud.mcaddon');

/* ---- layout, in GUI pixels (the hotbar is 182 wide and 22 high, centred at the bottom) ---- */
const ICON = 16;
const TEXT_BOX = 30; // fits "100%" and four-digit counts
const GAP = 2;
const COLUMN_W = ICON + GAP + TEXT_BOX;
const ROW_H = 18;
const ROWS = 4;
/** Distance from the screen centre to the inner edge of each column: clears the hotbar and the touch "..." button. */
const FROM_CENTRE = 106;
/** Lifts the columns so the bottom row is level with the hotbar. */
const BOTTOM = -2;

/* ---- how the HUD reads the hidden titles ---- */
const byteLength = (s) => Buffer.byteLength(s, 'utf8');

/**
 * Hidden helper that remembers the last title containing `key` (the documented "preserve title text" pattern).
 * It becomes visible for one frame when such a title arrives, and that visibility change copies the title.
 */
const remember = (key, initial) => ({
  data_control: {
    type: 'panel',
    size: [0, 0],
    property_bag: { '#preserved_text': initial },
    bindings: [
      { binding_name: '#hud_title_text_string' },
      { binding_name: '#hud_title_text_string', binding_name_override: '#preserved_text', binding_condition: 'visibility_changed' },
      {
        binding_type: 'view',
        source_property_name: `(not (#hud_title_text_string = #preserved_text) and not ((#hud_title_text_string - '${key}') = #hud_title_text_string))`,
        target_property_name: '#visible',
      },
    ],
  },
});
const fromData = (expression, target) => ({ binding_type: 'view', source_control_name: 'data_control', source_property_name: expression, target_property_name: target });

/** Bytes [from, to) of the remembered text message: "the first `to` bytes, minus the first `from` bytes". */
const slice = (from, to) => `(('%.${to}s' * #preserved_text) - ('%.${from}s' * #preserved_text))`;

function row(slot, index) {
  const start = byteLength(TEXT_KEY) + index * TEXT_W;
  // Icons sit on the outside and numbers next to the hotbar: icon then number on the left, number then icon on the right.
  const iconSide = slot.side === 'left' ? 'left_middle' : 'right_middle';
  const icon = { type: 'image', size: [ICON, ICON], layer: 2, anchor_from: iconSide, anchor_to: iconSide };
  if (slot.icon) {
    icon.texture = `textures/${slot.icon}`;
  } else {
    // The icon message is the key followed by the texture path, so removing the key leaves the path.
    Object.assign(icon, {
      texture: '#texture',
      controls: [remember(iconKey(index), initialIcon(index))],
      bindings: [fromData(`('textures/' + (#preserved_text - '${iconKey(index)}'))`, '#texture')],
    });
  }
  return {
    [`bhud_${slot.key}`]: {
      type: 'panel',
      size: [COLUMN_W, ROW_H],
      anchor_from: 'top_left',
      anchor_to: 'top_left',
      offset: [0, slot.row * ROW_H],
      controls: [
        { icon },
        {
          value: {
            type: 'label',
            text: '#text',
            size: [TEXT_BOX, 10],
            layer: 2,
            anchor_from: 'left_middle',
            anchor_to: 'left_middle',
            offset: slot.side === 'left' ? [ICON + GAP, 0] : [0, 0],
            text_alignment: 'right',
            shadow: true,
            localize: false,
            enable_profanity_filter: false,
            controls: [remember(TEXT_KEY, initialText())],
            bindings: [fromData(slice(start, start + TEXT_W), '#text')],
          },
        },
      ],
    },
  };
}

const column = (side) => ({
  type: 'panel',
  size: [COLUMN_W, ROW_H * ROWS],
  anchor_from: 'bottom_middle',
  anchor_to: side === 'left' ? 'bottom_right' : 'bottom_left',
  offset: [side === 'left' ? -FROM_CENTRE : FROM_CENTRE, BOTTOM],
  controls: SLOTS.map((slot, index) => (slot.side === side ? row(slot, index) : null)).filter(Boolean),
});

const hudScreen = {
  namespace: 'hud',

  bhud_left: column('left'),
  bhud_right: column('right'),

  // The HUD data travels as titles; keep those off the screen. Ordinary titles are unaffected.
  hud_title_text: {
    bindings: [
      { binding_name: '#hud_title_text_string' },
      { binding_type: 'view', source_property_name: `((#hud_title_text_string - '${MARKER}') = #hud_title_text_string)`, target_property_name: '#visible' },
    ],
  },

  root_panel: {
    modifications: [
      {
        array_name: 'controls',
        operation: 'insert_front',
        value: [{ 'bhud_left@hud.bhud_left': {} }, { 'bhud_right@hud.bhud_right': {} }],
      },
    ],
  },
};

/* ---- assemble and zip ---- */
const stage = path.join(here, 'build');
fs.rmSync(stage, { recursive: true, force: true });
fs.cpSync(path.join(here, 'src', 'behavior'), path.join(stage, 'BlockhostArmorHUD_BP'), { recursive: true });
fs.cpSync(path.join(here, 'src', 'resource'), path.join(stage, 'BlockhostArmorHUD_RP'), { recursive: true });
fs.mkdirSync(path.join(stage, 'BlockhostArmorHUD_RP', 'ui'), { recursive: true });
fs.writeFileSync(path.join(stage, 'BlockhostArmorHUD_RP', 'ui', 'hud_screen.json'), JSON.stringify(hudScreen, null, 2) + '\n');

fs.rmSync(OUT, { force: true });
execFileSync('zip', ['-q', '-r', '-X', OUT, 'BlockhostArmorHUD_BP', 'BlockhostArmorHUD_RP'], { cwd: stage });
console.log(`Built ${path.relative(process.cwd(), OUT)} (${fs.statSync(OUT).size} bytes)`);
