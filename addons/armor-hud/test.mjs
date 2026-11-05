#!/usr/bin/env node
// Checks the parts of the add-on that can be checked outside the game:
//   1. the script turns player states into the expected slots, and
//   2. the generated HUD expressions cut every field back out of the payload correctly.
// The expressions are evaluated by a small interpreter of the JSON UI operators, under both possible readings of
// string subtraction (remove the first match / remove every match), with `%.Ns` counting bytes as documented.
//   node addons/armor-hud/build.mjs && node addons/armor-hud/test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPayload, describe, durabilityPercent, emptyPayload, iconFor } from './src/behavior/scripts/hud.js';
import { PREFIX, SLOTS, SLOT_W } from './src/behavior/scripts/layout.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const hud = JSON.parse(fs.readFileSync(path.join(here, 'build', 'BlockhostArmorHUD_RP', 'ui', 'hud_screen.json'), 'utf8'));

/* ---- a tiny JSON UI expression interpreter ---- */
function evaluate(source, vars, removeAll) {
  let pos = 0;
  const ws = () => { while (source[pos] === ' ') pos++; };
  const operand = () => {
    ws();
    if (source[pos] === '(') {
      pos++;
      let left = expr();
      ws();
      assert.equal(source[pos], ')', `expected ) at ${pos} in ${source}`);
      pos++;
      return left;
    }
    if (source[pos] === "'") {
      const end = source.indexOf("'", pos + 1);
      const s = source.slice(pos + 1, end);
      pos = end + 1;
      return s;
    }
    if (source.startsWith('not ', pos)) {
      pos += 4;
      return !operand();
    }
    const m = /^#[a-z_]+/.exec(source.slice(pos));
    assert.ok(m, `unexpected token at ${pos} in ${source}`);
    pos += m[0].length;
    assert.ok(m[0] in vars, `unknown binding ${m[0]}`);
    return vars[m[0]];
  };
  const apply = (op, a, b) => {
    if (op === '+') return a + b;
    if (op === '=') return a === b;
    if (op === 'and') return a && b;
    if (op === '-') return removeAll ? a.split(b === '' ? '\u0000' : b).join('') : a.replace(b, '');
    if (op === '*') {
      const n = Number(/^%\.(\d+)s$/.exec(a)[1]);
      return Buffer.from(b, 'utf8').subarray(0, n).toString('utf8');
    }
    throw new Error(`operator ${op}`);
  };
  const expr = () => {
    let left = operand();
    for (;;) {
      ws();
      const m = /^(and|[-+*=])/.exec(source.slice(pos));
      if (!m) return left;
      pos += m[0].length;
      left = apply(m[0], left, operand());
    }
  };
  const result = expr();
  ws();
  assert.equal(pos, source.length, `trailing input in ${source}`);
  return result;
}

/** What the HUD would show for a stored title: { slotKey: { texture, text } }. */
function render(title, removeAll) {
  const out = {};
  for (const side of ['bhud_left', 'bhud_right']) {
    for (const control of hud[side].controls) {
      const [name, rowDef] = Object.entries(control)[0];
      const icon = rowDef.controls[0].icon;
      const value = rowDef.controls[1].value;
      out[name.replace('bhud_', '')] = {
        texture: evaluate(icon.bindings[0].source_property_name, { '#preserved_text': title }, removeAll),
        text: evaluate(value.bindings[0].source_property_name, { '#preserved_text': title }, removeAll),
      };
    }
  }
  return out;
}

/* ---- script logic ---- */
assert.equal(iconFor('minecraft:diamond_sword'), 'items/diamond_sword');
assert.equal(iconFor('minecraft:golden_helmet'), 'items/gold_helmet');
assert.equal(iconFor('minecraft:wooden_pickaxe'), 'items/wood_pickaxe');
assert.equal(iconFor('minecraft:leather_boots'), 'items/leather_boots');
assert.equal(iconFor('minecraft:totem_of_undying'), 'items/totem');
assert.equal(iconFor('minecraft:bow'), 'items/bow_standby');
assert.equal(iconFor('minecraft:elytra'), 'items/elytra');
assert.equal(iconFor('minecraft:cobblestone'), 'blocks/cobblestone');
assert.equal(iconFor('minecraft:shield'), 'ui/empty_armor_slot_shield');
assert.equal(iconFor('someaddon:laser'), 'ui/inventory_icon');
assert.equal(durabilityPercent(0, 1561), 100);
assert.equal(durabilityPercent(1, 1561), 99);
assert.equal(durabilityPercent(1560, 1561), 1);
assert.equal(durabilityPercent(1561, 1561), 0);

const tool = (id, damage, maxDurability) => ({ id, amount: 1, maxAmount: 1, damage, maxDurability });
const stack = (id, amount, maxAmount = 64) => ({ id, amount, maxAmount });
const reference = {
  // The player in examples/armor.png
  mainhand: tool('minecraft:diamond_sword', 0, 1561),
  head: tool('minecraft:iron_helmet', 101, 165),
  chest: tool('minecraft:iron_chestplate', 0, 240),
  legs: tool('minecraft:diamond_leggings', 104, 495),
  feet: tool('minecraft:leather_boots', 65, 65),
  offhand: stack('minecraft:totem_of_undying', 1, 1),
  counts: new Map([['minecraft:diamond_sword', 1], ['minecraft:bow', 1], ['minecraft:arrow', 144], ['minecraft:totem_of_undying', 5], ['minecraft:golden_apple', 8], ['minecraft:cobblestone', 64]]),
  freeSlots: 6,
};
const naked = { mainhand: null, offhand: null, head: null, chest: null, legs: null, feet: null, counts: new Map(), freeSlots: 36 };
const builder = { ...naked, mainhand: stack('minecraft:cobblestone', 64), counts: new Map([['minecraft:cobblestone', 2304]]), freeSlots: 0 };

const entries = describe(reference);
assert.deepEqual(entries.mainhand, { icon: 'items/diamond_sword', text: '100%', color: 'a' });
assert.deepEqual(entries.head, { icon: 'items/iron_helmet', text: '39%', color: 'e' });
assert.deepEqual(entries.legs, { icon: 'items/diamond_leggings', text: '79%', color: 'b' });
assert.deepEqual(entries.feet, { icon: 'items/leather_boots', text: '0%', color: 'c' });
assert.deepEqual(entries.offhand, { icon: 'items/totem', text: '5', color: 'f' });
assert.deepEqual(entries.arrows, { icon: 'items/arrow', text: '144', color: 'f' });
assert.deepEqual(entries.free, { icon: 'items/bundle', text: '6', color: 'f' });
assert.equal(describe(naked).arrows, null);

/* ---- wire format and HUD expressions ---- */
const expectedBytes = Buffer.byteLength(PREFIX) + SLOTS.length * SLOT_W;
for (const [label, state] of Object.entries({ reference, naked, builder })) {
  const payload = buildPayload(state);
  assert.equal(Buffer.byteLength(payload, 'utf8'), expectedBytes, `${label}: payload must be fixed-width`);
  const want = describe(state);
  for (const removeAll of [false, true]) {
    const shown = render(payload, removeAll);
    for (const slot of SLOTS) {
      const entry = want[slot.key];
      const got = shown[slot.key];
      assert.equal(got.texture, `textures/${entry ? entry.icon : 'bhud/empty'}`, `${label}/${slot.key} texture (removeAll=${removeAll})`);
      assert.equal(got.text.trim(), `§${entry ? entry.color : 'f'}${entry ? entry.text.padStart(5) : '     '}`.trim(), `${label}/${slot.key} text (removeAll=${removeAll})`);
    }
  }
}

// Before any update the HUD shows nothing rather than a broken texture.
for (const removeAll of [false, true]) {
  const initial = render(hud.bhud_data.property_bag['#preserved_text'], removeAll);
  for (const slot of SLOTS) assert.equal(initial[slot.key].texture, 'textures/bhud/empty');
}
assert.equal(hud.bhud_data.property_bag['#preserved_text'], emptyPayload());

// The data title is recognised, and hidden from the normal title display; ordinary titles are not.
const dataVisible = hud.bhud_data.bindings[2].source_property_name;
const titleVisible = hud.hud_title_text.bindings[1].source_property_name;
const sample = buildPayload(reference);
for (const removeAll of [false, true]) {
  assert.equal(evaluate(dataVisible, { '#hud_title_text_string': sample, '#preserved_text': emptyPayload() }, removeAll), true);
  assert.equal(evaluate(dataVisible, { '#hud_title_text_string': sample, '#preserved_text': sample }, removeAll), false);
  assert.equal(evaluate(dataVisible, { '#hud_title_text_string': 'Welcome!', '#preserved_text': sample }, removeAll), false);
  assert.equal(evaluate(titleVisible, { '#hud_title_text_string': sample }, removeAll), false);
  assert.equal(evaluate(titleVisible, { '#hud_title_text_string': 'Welcome!' }, removeAll), true);
}

console.log(`ok: ${SLOTS.length} slots, ${expectedBytes}-byte payload, HUD expressions verified under both subtraction semantics`);
