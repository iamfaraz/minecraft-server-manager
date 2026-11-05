#!/usr/bin/env node
// Checks the parts of the add-on that can be checked outside the game:
//   1. the script turns player states into the expected slots,
//   2. the generated HUD, fed the script's titles, ends up showing the right icon and number per slot, and
//   3. the HUD keeps to the rules learned on a real device (see the notes at the top of build.mjs).
// The HUD's expressions are evaluated by a small interpreter of the JSON UI operators, under both possible readings
// of string subtraction (remove the first match / remove every match), with `%.Ns` counting bytes as documented.
//   node addons/armor-hud/build.mjs && node addons/armor-hud/test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPayload, describe, durabilityPercent, iconFor } from './src/behavior/scripts/hud.js';
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

/**
 * A stand-in for the HUD, following the pack's bindings: one helper remembers the last HUD title, and every element
 * computes its properties from it. `receive` plays one title; `shown` evaluates what each slot displays.
 */
function createHud(removeAll) {
  const root = hud.bhud_root.controls.map((c) => Object.entries(c)[0]);
  const [, helper] = root.find(([name]) => name === 'bhud_data');
  let preserved = helper.property_bag['#preserved_text'];
  const properties = (control) => {
    // Bindings run in order; a later one may use a property an earlier one set.
    const own = {};
    for (const b of control.bindings ?? []) {
      const vars = b.source_control_name ? { '#preserved_text': preserved } : own;
      if (b.source_control_name) assert.equal(b.source_control_name, 'bhud_data');
      own[b.target_property_name] = evaluate(b.source_property_name, vars, removeAll);
    }
    return own;
  };
  return {
    receive(title) {
      const flicker = evaluate(helper.bindings[2].source_property_name, { '#hud_title_text_string': title, '#preserved_text': preserved }, removeAll);
      if (flicker) preserved = title; // the visibility change copies the title
    },
    shown() {
      const out = {};
      for (const [name, columnDef] of root) {
        if (name === 'bhud_data') continue;
        const visible = properties(columnDef)['#visible'];
        for (const control of columnDef.controls) {
          const [rowName, rowDef] = Object.entries(control)[0];
          const icon = rowDef.controls[0].icon;
          const value = rowDef.controls[1].value;
          out[rowName.replace('bhud_', '')] = {
            visible,
            texture: icon.bindings ? properties(icon)['#texture'] : icon.texture,
            text: properties(value)['#text'],
          };
        }
      }
      return out;
    },
  };
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
assert.equal(describe(naked).arrows, null);

/* ---- wire format and HUD ---- */
assert.deepEqual(entries.free, { text: '6', color: 'f' });
const expectedBytes = Buffer.byteLength(PREFIX) + SLOTS.length * SLOT_W;
const states = { reference, naked, builder };
for (const removeAll of [false, true]) {
  // One HUD lives through all three states in turn, like a player changing gear.
  const screen = createHud(removeAll);
  for (const slot of SLOTS) assert.equal(screen.shown()[slot.key].visible, false, 'nothing is drawn before the first title');
  for (const [label, state] of Object.entries(states)) {
    const payload = buildPayload(state);
    assert.equal(Buffer.byteLength(payload, 'utf8'), expectedBytes, `${label}: payload must be fixed-width`);
    assert.ok(/^[\x20-\x7e\u00a7]+$/.test(payload), 'printable ASCII plus the colour sign only');
    screen.receive(payload);
    screen.receive('Welcome to the server!'); // an ordinary title must not disturb anything
    screen.receive('');
    const want = describe(state);
    const shown = screen.shown();
    for (const slot of SLOTS) {
      const entry = want[slot.key];
      assert.equal(shown[slot.key].visible, true);
      assert.equal(shown[slot.key].texture, `textures/${slot.icon ?? entry?.icon ?? 'bhud/empty'}`, `${label}/${slot.key} texture (removeAll=${removeAll})`);
      assert.equal(shown[slot.key].text, `\u00a7${entry ? entry.color : 'f'}${(entry ? entry.text : '').padStart(5)}`, `${label}/${slot.key} text (removeAll=${removeAll})`);
    }
  }
}

// HUD titles are hidden from the normal title display; ordinary titles are not.
const titleVisible = hud.hud_title_text.bindings[1].source_property_name;
for (const removeAll of [false, true]) {
  assert.equal(evaluate(titleVisible, { '#hud_title_text_string': buildPayload(reference) }, removeAll), false);
  assert.equal(evaluate(titleVisible, { '#hud_title_text_string': 'Welcome!' }, removeAll), true);
}

/* ---- rules learned on a real device ---- */
const names = new Map(); // control name -> how many controls carry it
const sources = [];
(function walk(node) {
  if (Array.isArray(node)) return node.forEach(walk);
  if (!node || typeof node !== 'object') return;
  for (const b of node.bindings ?? []) {
    if (b.source_control_name) sources.push(b);
    // A texture path built straight from another control's data stays on the missing-texture pattern.
    if (b.target_property_name === '#texture') assert.equal(b.source_control_name, undefined, '#texture must be computed from the image\'s own property');
  }
  for (const control of node.controls ?? []) {
    const name = Object.keys(control)[0].split('@')[0];
    names.set(name, (names.get(name) ?? 0) + 1);
    walk(control[Object.keys(control)[0]]);
  }
  for (const [key, value] of Object.entries(node)) if (key !== 'controls' && key !== 'bindings') walk(value);
})(hud);
assert.ok(sources.length > 0);
// `source_control_name` resolves to the first control with that name anywhere on the HUD, so it must be unambiguous.
for (const b of sources) assert.equal(names.get(b.source_control_name), 1, `control name "${b.source_control_name}" must be unique`);

console.log(`ok: ${SLOTS.length} slots, ${expectedBytes}-byte payload, HUD simulation and device rules verified`);
