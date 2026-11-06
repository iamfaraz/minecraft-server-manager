#!/usr/bin/env node
// Generates src/behavior/scripts/icons.js: for every vanilla item id, the texture the HUD should show for it.
//
// Sources (downloaded once into a cache folder, pass --refresh to fetch again):
//   Mojang/bedrock-samples  blocks.json            block id -> texture short names per face
//                           terrain_texture.json   short name -> file under textures/blocks
//                           the list of files under textures/items and textures/blocks
//   @minecraft/vanilla-data  the list of item ids
// Blocks are looked up exactly through Mojang's own tables. Items have no public id -> sprite table, so they are
// matched by name (same words in any order, known renames) and the rest is listed in OVERRIDES below.
//   node addons/armor-hud/generate-icons.mjs [--refresh] [--report]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(here, 'src', 'behavior', 'scripts', 'icons.js');
const args = process.argv.slice(2);
const cacheDir = process.env.BHUD_VANILLA_CACHE || path.join(os.tmpdir(), 'bhud-vanilla');
const SAMPLES = 'https://raw.githubusercontent.com/Mojang/bedrock-samples/main';

async function cached(name, url) {
  const file = path.join(cacheDir, name);
  if (!fs.existsSync(file) || args.includes('--refresh')) {
    const res = await fetch(url, { headers: { 'User-Agent': 'blockhost-armor-hud' } });
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  }
  return fs.readFileSync(file, 'utf8');
}
const looseJson = (text) => JSON.parse(text.replace(/^\s*\/\/.*$/gm, ''));

const version = JSON.parse(await cached('version.json', `${SAMPLES}/version.json`)).latest.version;
const blocks = looseJson(await cached('blocks.json', `${SAMPLES}/resource_pack/blocks.json`));
const terrain = looseJson(await cached('terrain_texture.json', `${SAMPLES}/resource_pack/textures/terrain_texture.json`)).texture_data;
const tree = JSON.parse(await cached('tree.json', 'https://api.github.com/repos/Mojang/bedrock-samples/git/trees/main?recursive=1')).tree;
const itemIds = [...(await cached('mojang-item.d.ts', 'https://unpkg.com/@minecraft/vanilla-data/lib/mojang-item.d.ts')).matchAll(/"minecraft:([a-z0-9_]+)"/g)].map((m) => m[1]);

/** Every texture file, as a path below textures/ without extension. */
const files = new Set();
for (const { path: p } of tree) {
  const m = /^resource_pack\/textures\/((?:items|blocks|ui)\/.+)\.(?:png|tga)$/.exec(p);
  if (m && !/_mers?$/.test(m[1])) files.add(m[1]);
}
/** Item sprite name -> path. Sprites in subfolders (spawn eggs, spears, ...) count too; top-level ones win. */
const spritePath = new Map();
for (const f of [...files].filter((f) => f.startsWith('items/')).sort((a, b) => a.split('/').length - b.split('/').length)) {
  const name = f.split('/').pop();
  if (!spritePath.has(name)) spritePath.set(name, f);
}

/* ---- items: match by name ---- */
const RENAMES = { golden: 'gold', wooden: 'wood' };
const words = (name) => name.split('_').map((w) => RENAMES[w] ?? w).sort().join(' ');
const spritesByWords = new Map();
for (const sprite of spritePath.keys()) {
  const key = words(sprite);
  if (!spritesByWords.has(key)) spritesByWords.set(key, sprite);
}

const DYES = { black: 'black_new', blue: 'blue_new', brown: 'brown_new', white: 'white_new', light_gray: 'silver' };
const DISCS = ['11', '13', '5', 'blocks', 'cat', 'chirp', 'far', 'mall', 'mellohi', 'otherside', 'pigstep', 'stal', 'strad', 'wait', 'ward'];

/**
 * Items whose sprite cannot be found from the name. Values are paths below textures/, or a bare sprite name under
 * textures/items. Every value is checked against the file list at generation time.
 */
const OVERRIDES = {
  // raw food and fish keep their old sprite names
  beef: 'beef_raw', chicken: 'chicken_raw', porkchop: 'porkchop_raw', mutton: 'mutton_raw', rabbit: 'rabbit_raw',
  cod: 'fish_raw', salmon: 'fish_salmon_raw', cooked_cod: 'fish_cooked', cooked_salmon: 'fish_salmon_cooked',
  tropical_fish: 'fish_clownfish_raw', pufferfish: 'fish_pufferfish_raw', tropical_fish_bucket: 'bucket_tropical',
  melon_slice: 'melon', glistering_melon_slice: 'melon_speckled', enchanted_golden_apple: 'apple_golden',
  // dyes and the items that used to be dyes
  ...Object.fromEntries(['black', 'blue', 'brown', 'cyan', 'gray', 'green', 'light_blue', 'light_gray', 'lime', 'magenta', 'orange', 'pink', 'purple', 'red', 'white', 'yellow'].map((c) => [`${c}_dye`, `dye_powder_${DYES[c] ?? c}`])),
  ink_sac: 'dye_powder_black', glow_ink_sac: 'dye_powder_glow', bone_meal: 'dye_powder_white', cocoa_beans: 'dye_powder_brown', lapis_lazuli: 'dye_powder_blue',
  ...Object.fromEntries(DISCS.map((d) => [`music_disc_${d}`, `record_${d}`])),
  // tools and things with a state in their sprite name
  bow: 'bow_standby', crossbow: 'crossbow_standby', fishing_rod: 'fishing_rod_uncast', bucket: 'bucket_empty',
  clock: 'clock_item', compass: 'compass_item', lodestone_compass: 'lodestonecompass_item', recovery_compass: 'recovery_compass_item',
  book: 'book_normal', minecart: 'minecart_normal', totem_of_undying: 'totem', nautilus_shell: 'nautilus',
  fire_charge: 'fireball', firework_rocket: 'fireworks', firework_star: 'fireworks_charge', dragon_breath: 'dragons_breath',
  glass_bottle: 'potion_bottle_empty', potion: 'potion_bottle_drinkable', splash_potion: 'potion_bottle_splash', lingering_potion: 'potion_bottle_lingering',
  heart_of_the_sea: 'heartofthesea_closed', redstone: 'redstone_dust', slime_ball: 'slimeball', turtle_scute: 'turtle_shell_piece',
  sugar_cane: 'reeds', oak_sign: 'sign', dark_oak_sign: 'sign_darkoak', iron_chain: 'chain', bed: 'bed_red',
  // blocks whose id is not their key in Mojang's block table
  grass_block: 'blocks/grass_side_carried', sea_lantern: 'blocks/sea_lantern', rail: 'blocks/rail_normal',
  red_shrub: 'blocks/red_shrub', shelf_mushroom: 'blocks/shelf_mushroom_large', barrel: 'blocks/barrel_side',
  ...Object.fromEntries(['', '_slab', '_stairs', '_wall'].flatMap((part) => [[`sandstone${part}`, 'blocks/sandstone_normal'], [`red_sandstone${part}`, 'blocks/red_sandstone_normal']])),
  // 3D models with no sprite: the slot outline stands in
  shield: 'ui/empty_armor_slot_shield',
};

/** Items Mojang's block table gives a misleading texture for (mob heads map to soul sand); they get the generic icon. */
const NO_ICON = new Set(['skeleton_skull', 'wither_skeleton_skull', 'zombie_head', 'player_head', 'creeper_head', 'dragon_head', 'piglin_head']);

function itemSprite(id) {
  if (spritePath.has(id)) return spritePath.get(id);
  const byWords = spritesByWords.get(words(id));
  if (byWords) return spritePath.get(byWords);
  // Spawn eggs without a sprite of their own share the plain egg.
  if (id.endsWith('_spawn_egg') && spritePath.has('spawn_egg')) return spritePath.get('spawn_egg');
  return null;
}

/* ---- blocks: Mojang's tables ---- */
const FACE_ORDER = ['side', 'south', 'north', 'east', 'west', 'up', 'down'];
function blockFace(id) {
  const def = blocks[id];
  if (!def?.textures) return null;
  let short = def.textures;
  if (typeof short !== 'string') {
    const faces = Object.entries(short);
    short = (faces.find(([, s]) => /front/.test(s)) ?? FACE_ORDER.map((f) => [f, short[f]]).find(([, s]) => s) ?? faces[0])[1];
  }
  let tex = (terrain[short] ?? terrain[short.replace(/^flattened_/, '')])?.textures;
  if (Array.isArray(tex)) tex = tex[0];
  if (tex && typeof tex === 'object') tex = tex.path;
  if (typeof tex !== 'string') return null;
  const file = tex.replace(/^textures\//, '').replace(/\.(png|tga)$/, '');
  return files.has(file) ? file : null;
}

const icons = {};
const report = { override: [], sprite: [], block: [], missing: [] };
for (const id of [...new Set(itemIds)].sort()) {
  let icon = null;
  let how = 'missing';
  if (NO_ICON.has(id)) {
    report.missing.push(id);
    continue;
  }
  if (OVERRIDES[id]) {
    icon = OVERRIDES[id].includes('/') ? OVERRIDES[id] : spritePath.get(OVERRIDES[id]) ?? `items/${OVERRIDES[id]}`;
    if (!files.has(icon)) throw new Error(`OVERRIDES.${id}: no such texture ${icon}`);
    how = 'override';
  } else if ((icon = itemSprite(id))) how = 'sprite';
  else if ((icon = blockFace(id))) how = 'block';
  report[how].push(id);
  if (icon) {
    if (!/^[A-Za-z0-9_/]+$/.test(icon)) throw new Error(`${id}: unsupported characters in ${icon}`);
    icons[id] = icon;
  }
}

const longest = Math.max(...Object.values(icons).map((i) => i.length));
fs.writeFileSync(
  OUT,
  `// Generated by generate-icons.mjs from Mojang/bedrock-samples ${version} and @minecraft/vanilla-data. Do not edit by hand.
// Item id (without "minecraft:") -> texture path below textures/. Names only: the textures come from the player's game.

/** Longest path in the table, for the wire format. */
export const LONGEST_ICON = ${longest};

export const ICONS = ${JSON.stringify(icons, null, 0).replace(/","/g, '",\n"').replace(/^\{/, '{\n').replace(/\}$/, '\n}')};
`,
);
console.log(`${Object.keys(icons).length}/${new Set(itemIds).size} items mapped (override ${report.override.length}, sprite ${report.sprite.length}, block ${report.block.length}); longest path ${longest}; missing ${report.missing.length}`);
if (args.includes('--report')) console.log('missing:', report.missing.join(' '));
