#!/usr/bin/env node
// Builds blockhost-armor-hud.mcaddon: the behavior pack (script) plus the resource pack (HUD layout).
// The HUD layout is generated here from the same constants the script uses, so the two cannot drift apart.
//   node addons/armor-hud/build.mjs
//
// The JSON UI techniques below were each confirmed on a real device (Android, Bedrock 1.26.62). Things that look
// like they should work but do not, so that nobody "simplifies" them back in:
//   - `source_control_name` finds the first control with that name anywhere on the HUD, not the element's own
//     child. Helpers therefore need a unique name; one shared helper serves every element.
//   - A property_bag default is not seen by other controls, so the helper holds nothing until the first title.
//   - Building the texture path from a long expression in a single binding leaves the image on the missing-texture
//     pattern. Cutting out the name and prefixing `textures/` must be two bindings.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ICON_W, PAD, PREFIX, SLOTS, SLOT_W } from './src/behavior/scripts/layout.js';

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

/* ---- how the HUD reads the hidden title ---- */
const DATA = 'bhud_data';
const byteLength = (s) => Buffer.byteLength(s, 'utf8');

/**
 * The one helper that remembers the last HUD title (the "preserve title text" pattern): it turns visible for a
 * moment when a new title containing PREFIX arrives, and that visibility change copies the title into
 * #preserved_text. Titles without the prefix are ignored, so ordinary titles do not disturb the HUD.
 */
const dataControl = {
  type: 'panel',
  size: [0, 0],
  property_bag: { '#preserved_text': '' },
  bindings: [
    { binding_name: '#hud_title_text_string' },
    { binding_name: '#hud_title_text_string', binding_name_override: '#preserved_text', binding_condition: 'visibility_changed' },
    {
      binding_type: 'view',
      source_property_name: `((not (#hud_title_text_string = #preserved_text)) and (not ((#hud_title_text_string - '${PREFIX}') = #hud_title_text_string)))`,
      target_property_name: '#visible',
    },
  ],
};
const fromData = (expression, target) => ({ binding_type: 'view', source_control_name: DATA, source_property_name: expression, target_property_name: target });

/** Bytes [from, to) of the remembered title: "the first `to` bytes, minus the first `from` bytes". */
const slice = (from, to) => `(('%.${to}s' * #preserved_text) - ('%.${from}s' * #preserved_text))`;
/** Strip the padding from an icon field by removing runs of 32, 16, 8, 4, 2 and 1 pad characters in turn. */
const trimmed = (expr) => [32, 16, 8, 4, 2, 1].reduce((acc, n) => `(${acc} - '${PAD.repeat(n)}')`, expr);

function row(slot, index) {
  const start = byteLength(PREFIX) + index * SLOT_W;
  // Icons sit on the outside and numbers next to the hotbar: icon then number on the left, number then icon on the right.
  const iconSide = slot.side === 'left' ? 'left_middle' : 'right_middle';
  const icon = { type: 'image', size: [ICON, ICON], layer: 2, anchor_from: iconSide, anchor_to: iconSide };
  if (slot.icon) {
    icon.texture = `textures/${slot.icon}`;
  } else {
    icon.texture = '#texture';
    icon.bindings = [
      fromData(trimmed(slice(start, start + ICON_W)), '#icon'),
      { binding_type: 'view', source_property_name: "('textures/' + #icon)", target_property_name: '#texture' },
    ];
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
            bindings: [fromData(slice(start + ICON_W, start + SLOT_W), '#text')],
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
  // Nothing is drawn until the first title has arrived; without this the icons would start out as missing textures.
  bindings: [fromData("(not (#preserved_text = ''))", '#visible')],
  controls: SLOTS.map((slot, index) => (slot.side === side ? row(slot, index) : null)).filter(Boolean),
});

const hudScreen = {
  namespace: 'hud',

  bhud_root: {
    type: 'panel',
    size: ['100%', '100%'],
    controls: [{ [DATA]: dataControl }, { bhud_left: column('left') }, { bhud_right: column('right') }],
  },

  // The HUD data travels as a title; keep that title itself off the screen. Ordinary titles are unaffected.
  hud_title_text: {
    bindings: [
      { binding_name: '#hud_title_text_string' },
      { binding_type: 'view', source_property_name: `((#hud_title_text_string - '${PREFIX}') = #hud_title_text_string)`, target_property_name: '#visible' },
    ],
  },

  root_panel: {
    modifications: [{ array_name: 'controls', operation: 'insert_front', value: [{ 'bhud_root@hud.bhud_root': {} }] }],
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
