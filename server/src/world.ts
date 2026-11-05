import path from 'node:path';
import { PropertiesFile, bad, HttpError, sleep } from './util.js';
import type { ServerInstance } from './servers/instance.js';

/**
 * Live world controls: game rules, difficulty, time, weather, broadcast.
 * Values are read back from the running server's console, so the UI shows the truth rather than what we last sent.
 *
 * Game rule names differ per platform and era:
 *   java    26.x / 1.21.11+  snake_case   (keep_inventory, advance_time)
 *   legacy  older Java       camelCase    (keepInventory, doDaylightCycle)
 *   bedrock                  camelCase, case-insensitive (keepInventory, showCoordinates)
 */
export type RuleGroup = 'Display' | 'Gameplay' | 'World' | 'Mobs' | 'Damage' | 'Drops' | 'Advanced';
interface RuleDef {
  key: string;
  label: string;
  desc?: string;
  group: RuleGroup;
  type?: 'bool' | 'int';
  java?: string;
  legacy?: string;
  bedrock?: string;
  /** Type override where a platform models the rule differently. */
  javaType?: 'bool' | 'int';
  /** Bedrock rules that are on/off in spirit but use words: maps the switch to the server's values. */
  bedrockMap?: { on: string; off: string };
}

/** Rules Bedrock prints in its list but refuses to change through the gamerule command. */
const BEDROCK_READ_ONLY = new Set(['locatorbar']);

const R = (key: string, label: string, group: RuleGroup, names: { java?: string; legacy?: string; bedrock?: string }, extra: Partial<RuleDef> = {}): RuleDef => ({ key, label, group, type: 'bool', ...names, ...extra });

export const RULES: RuleDef[] = [
  // What players see
  R('show_coordinates', 'Show coordinates', 'Display', { bedrock: 'showCoordinates' }, { desc: 'Displays each player\'s position on screen.' }),
  R('show_days_played', 'Show days played', 'Display', { bedrock: 'showDaysPlayed' }, { desc: 'Displays the number of in-game days on screen.' }),
  // Bedrock exposes "locatorbar" read-only; the switch that actually controls it is playerWaypoints (everyone | off).
  R('locator_bar', 'Locator bar', 'Display', { java: 'locator_bar', legacy: 'locatorBar', bedrock: 'playerWaypoints' }, { desc: 'Shows the direction of other players on the HUD.', bedrockMap: { on: 'everyone', off: 'off' } }),
  R('reduced_debug_info', 'Hide coordinates in debug screen', 'Display', { java: 'reduced_debug_info', legacy: 'reducedDebugInfo' }, { desc: 'Reduces the F3 screen so players cannot read their position.' }),
  R('show_death_messages', 'Death messages', 'Display', { java: 'show_death_messages', legacy: 'showDeathMessages', bedrock: 'showDeathMessages' }),
  R('show_advancement_messages', 'Advancement messages', 'Display', { java: 'show_advancement_messages', legacy: 'announceAdvancements' }),
  R('show_tags', 'Show item restriction tags', 'Display', { bedrock: 'showTags' }),
  R('show_recipe_messages', 'Recipe unlock messages', 'Display', { bedrock: 'showRecipeMessages' }),
  R('show_border_effect', 'World border effect', 'Display', { bedrock: 'showBorderEffect' }),
  R('send_command_feedback', 'Command feedback', 'Display', { java: 'send_command_feedback', legacy: 'sendCommandFeedback', bedrock: 'sendCommandFeedback' }, { desc: 'Shows command results. On Bedrock, turning this off also silences the console, so live values here can no longer be read or confirmed.' }),
  // Gameplay
  R('keep_inventory', 'Keep inventory on death', 'Gameplay', { java: 'keep_inventory', legacy: 'keepInventory', bedrock: 'keepInventory' }),
  R('pvp', 'PvP', 'Gameplay', { java: 'pvp', bedrock: 'pvp' }, { desc: 'Players can damage each other.' }),
  R('immediate_respawn', 'Respawn immediately', 'Gameplay', { java: 'immediate_respawn', legacy: 'doImmediateRespawn', bedrock: 'doImmediateRespawn' }),
  R('natural_regeneration', 'Natural health regeneration', 'Gameplay', { java: 'natural_health_regeneration', legacy: 'naturalRegeneration', bedrock: 'naturalRegeneration' }),
  R('sleeping_percentage', 'Players needed to skip the night (%)', 'Gameplay', { java: 'players_sleeping_percentage', legacy: 'playersSleepingPercentage', bedrock: 'playersSleepingPercentage' }, { type: 'int' }),
  R('limited_crafting', 'Only craft unlocked recipes', 'Gameplay', { java: 'limited_crafting', legacy: 'doLimitedCrafting', bedrock: 'doLimitedCrafting' }),
  R('recipes_unlock', 'Recipes must be unlocked', 'Gameplay', { bedrock: 'recipesUnlock' }),
  R('respawn_radius', 'Spawn radius (blocks)', 'Gameplay', { java: 'respawn_radius', legacy: 'spawnRadius', bedrock: 'spawnRadius' }, { type: 'int' }),
  // World
  R('daylight_cycle', 'Daylight cycle', 'World', { java: 'advance_time', legacy: 'doDaylightCycle', bedrock: 'doDayLightCycle' }, { desc: 'Time passes. Turn off to freeze the time of day.' }),
  R('weather_cycle', 'Weather cycle', 'World', { java: 'advance_weather', legacy: 'doWeatherCycle', bedrock: 'doWeatherCycle' }),
  R('fire_spread', 'Fire spreads', 'World', { java: 'fire_spread_radius_around_player', legacy: 'doFireTick', bedrock: 'doFireTick' }, { javaType: 'int', desc: 'On Java 26+ this is a radius around players in blocks (0 turns fire spread off).' }),
  R('tnt_explodes', 'TNT explodes', 'World', { java: 'tnt_explodes', legacy: 'tntExplodes', bedrock: 'tntExplodes' }),
  R('respawn_blocks_explode', 'Beds and anchors explode in the wrong dimension', 'World', { bedrock: 'respawnBlocksExplode' }),
  R('mob_griefing', 'Mobs can change blocks', 'World', { java: 'mob_griefing', legacy: 'mobGriefing', bedrock: 'mobGriefing' }, { desc: 'Creeper craters, endermen picking blocks, villagers farming.' }),
  R('random_tick_speed', 'Random tick speed', 'World', { java: 'random_tick_speed', legacy: 'randomTickSpeed', bedrock: 'randomTickSpeed' }, { type: 'int', desc: 'Crop growth and similar. Default 3 on Java, 1 on Bedrock.' }),
  R('command_blocks', 'Command blocks work', 'World', { java: 'command_blocks_work', bedrock: 'commandBlocksEnabled' }),
  R('projectiles_break_blocks', 'Projectiles can break blocks', 'World', { java: 'projectiles_can_break_blocks', legacy: 'projectilesCanBreakBlocks', bedrock: 'projectilesCanBreakBlocks' }),
  // Mobs
  R('spawn_mobs', 'Mobs spawn', 'Mobs', { java: 'spawn_mobs', legacy: 'doMobSpawning', bedrock: 'doMobSpawning' }),
  R('spawn_monsters', 'Monsters spawn', 'Mobs', { java: 'spawn_monsters' }),
  R('spawn_phantoms', 'Phantoms spawn', 'Mobs', { java: 'spawn_phantoms', legacy: 'doInsomnia', bedrock: 'doInsomnia' }),
  R('spawn_patrols', 'Pillager patrols', 'Mobs', { java: 'spawn_patrols', legacy: 'doPatrolSpawning' }),
  R('spawn_traders', 'Wandering traders', 'Mobs', { java: 'spawn_wandering_traders', legacy: 'doTraderSpawning' }),
  R('spawn_wardens', 'Wardens', 'Mobs', { java: 'spawn_wardens', legacy: 'doWardenSpawning' }),
  R('raids', 'Raids', 'Mobs', { java: 'raids' }),
  // Damage
  R('fall_damage', 'Fall damage', 'Damage', { java: 'fall_damage', legacy: 'fallDamage', bedrock: 'fallDamage' }),
  R('fire_damage', 'Fire damage', 'Damage', { java: 'fire_damage', legacy: 'fireDamage', bedrock: 'fireDamage' }),
  R('drowning_damage', 'Drowning damage', 'Damage', { java: 'drowning_damage', legacy: 'drowningDamage', bedrock: 'drowningDamage' }),
  R('freeze_damage', 'Freeze damage', 'Damage', { java: 'freeze_damage', legacy: 'freezeDamage', bedrock: 'freezeDamage' }),
  // Drops
  R('block_drops', 'Blocks drop items', 'Drops', { java: 'block_drops', legacy: 'doTileDrops', bedrock: 'doTileDrops' }),
  R('mob_drops', 'Mobs drop loot', 'Drops', { java: 'mob_drops', legacy: 'doMobLoot', bedrock: 'doMobLoot' }),
  R('entity_drops', 'Entities drop items', 'Drops', { java: 'entity_drops', legacy: 'doEntityDrops', bedrock: 'doEntityDrops' }),
];

export interface RuleState {
  key: string;
  name: string;
  label: string;
  desc?: string;
  group: RuleGroup;
  type: 'bool' | 'int' | 'text';
  value: string;
}
export interface WorldState {
  running: boolean;
  edition: 'java' | 'bedrock';
  difficulty: string | null;
  weather: string | null;
  rules: RuleState[];
  readAt: string | null;
  canSave: boolean;
  /** The server is not answering console queries (Bedrock with sendCommandFeedback off); values shown are the last known ones. */
  silent: boolean;
}

const DIFFICULTIES = ['peaceful', 'easy', 'normal', 'hard'];
const TIMES = ['day', 'noon', 'night', 'midnight'];
const WEATHERS = ['clear', 'rain', 'thunder'];

interface Cache {
  at: number;
  state: WorldState;
  scheme: 'java' | 'legacy' | 'bedrock';
}
const cache = new Map<string, Cache>();

/** Guess whether a Java version uses the snake_case rule names; verified against the server on first read. */
function guessScheme(version: string): 'java' | 'legacy' {
  const m = /^(\d+)\.(\d+)(?:\.(\d+))?/.exec(version);
  if (!m) return 'java';
  const [a, b, c] = [+m[1], +m[2], +(m[3] || 0)];
  if (a >= 26) return 'java';
  return a === 1 && (b > 21 || (b === 21 && c >= 11)) ? 'java' : 'legacy';
}

const JAVA_VALUE = /Game ?rule (\S+) is (?:currently|now) set to:? (\S+)/i;
const BEDROCK_PAIR = /^([A-Za-z]+) = (\S+?)$/;
const QUERY_NOISE = /Game ?rule \S+ is currently set to|Incorrect argument for command|gamerule .*<--\[HERE\]|The difficulty is |^\[[^\]]*\] (?:[A-Za-z]+ = \S+)(?:, [A-Za-z]+ = \S+)*$|Weather state is:/i;

async function readJava(inst: ServerInstance, scheme: 'java' | 'legacy'): Promise<{ values: Map<string, string>; difficulty: string | null; ok: boolean }> {
  const defs = RULES.filter((r) => r[scheme]);
  const values = new Map<string, string>();
  let difficulty: string | null = null;
  let rejected = 0;
  inst.muteOutput(QUERY_NOISE, 4000);
  const untap = inst.tap((line) => {
    const m = JAVA_VALUE.exec(line);
    if (m) values.set(m[1].replace(/^minecraft:/, ''), m[2]);
    const d = /The difficulty is (\w+)/.exec(line);
    if (d) difficulty = d[1].toLowerCase();
    if (/Incorrect argument for command|Unknown or incomplete command/.test(line)) rejected++;
  });
  try {
    inst.sendSilent('difficulty');
    for (const r of defs) inst.sendSilent(`gamerule ${r[scheme]}`);
    const deadline = Date.now() + 3500;
    while (Date.now() < deadline && values.size + rejected < defs.length) await sleep(60);
    await sleep(80);
  } finally {
    untap();
    inst.muteOutput(QUERY_NOISE, 0);
  }
  return { values, difficulty, ok: values.size > 0 };
}

async function readBedrock(inst: ServerInstance): Promise<{ values: Map<string, string>; weather: string | null }> {
  const values = new Map<string, string>();
  let weather: string | null = null;
  inst.muteOutput(QUERY_NOISE, 3000);
  const untap = inst.tap((line) => {
    const body = line.replace(/^\[[^\]]*\]\s*/, '');
    if (body.includes(' = ')) {
      for (const part of body.split(', ')) {
        const m = BEDROCK_PAIR.exec(part.trim());
        if (m) values.set(m[1].toLowerCase(), m[2]);
      }
    }
    const w = /Weather state is: (\w+)/.exec(line);
    if (w) weather = w[1].toLowerCase();
  });
  try {
    inst.sendSilent('gamerule');
    inst.sendSilent('weather query');
    const deadline = Date.now() + 2500;
    while (Date.now() < deadline && (!values.size || !weather)) await sleep(60);
    await sleep(60);
  } finally {
    untap();
    inst.muteOutput(QUERY_NOISE, 0);
  }
  return { values, weather };
}

export async function getWorld(inst: ServerInstance, force = false): Promise<WorldState> {
  const edition = inst.rec.edition;
  const running = inst.state === 'running';
  const props = await PropertiesFile.load(path.join(inst.root, 'server.properties'));
  if (!running) {
    cache.delete(inst.id);
    return { running, edition, difficulty: props.get('difficulty') || null, weather: null, rules: [], readAt: null, canSave: false, silent: false };
  }
  const c = cache.get(inst.id);
  if (!force && c && Date.now() - c.at < 20_000) return c.state;

  let rules: RuleState[] = [];
  let difficulty: string | null = props.get('difficulty') || null;
  let weather: string | null = null;
  let scheme: Cache['scheme'];

  if (edition === 'bedrock') {
    scheme = 'bedrock';
    const r = await readBedrock(inst);
    if (!r.values.size) {
      // No answer at all: command feedback is off, so the console prints nothing. Keep showing the last known values.
      const last = c?.state;
      const state: WorldState = { running, edition, difficulty, weather: last?.weather ?? null, rules: last?.rules ?? [], readAt: last?.readAt ?? null, canSave: false, silent: true };
      cache.set(inst.id, { at: Date.now(), state, scheme: 'bedrock' });
      return state;
    }
    weather = r.weather;
    const known = new Set<string>();
    for (const def of RULES) {
      if (!def.bedrock) continue;
      const v = r.values.get(def.bedrock.toLowerCase());
      if (v === undefined) continue;
      known.add(def.bedrock.toLowerCase());
      const value = def.bedrockMap ? String(v.toLowerCase() !== def.bedrockMap.off) : v;
      rules.push({ key: def.key, name: def.bedrock, label: def.label, desc: def.desc, group: def.group, type: def.type || 'bool', value });
    }
    // Anything else the server reports is still shown, under Advanced.
    for (const [name, v] of r.values) {
      if (known.has(name) || BEDROCK_READ_ONLY.has(name)) continue;
      rules.push({ key: name, name, label: name, group: 'Advanced', type: v === 'true' || v === 'false' ? 'bool' : /^-?\d+$/.test(v) ? 'int' : 'text', value: v });
    }
  } else {
    scheme = c?.scheme === 'legacy' || c?.scheme === 'java' ? c.scheme : guessScheme(inst.rec.version);
    let r = await readJava(inst, scheme);
    if (!r.ok) {
      // Wrong naming era for this server (e.g. a modded or snapshot build): try the other one.
      scheme = scheme === 'java' ? 'legacy' : 'java';
      r = await readJava(inst, scheme);
    }
    if (r.difficulty) difficulty = r.difficulty;
    for (const def of RULES) {
      const name = def[scheme as 'java' | 'legacy'];
      if (!name) continue;
      const v = r.values.get(name);
      if (v === undefined) continue;
      const type = scheme === 'java' && def.javaType ? def.javaType : def.type || 'bool';
      rules.push({ key: def.key, name, label: def.label, desc: def.desc, group: def.group, type, value: v });
    }
  }
  const state: WorldState = { running, edition, difficulty, weather, rules, readAt: new Date().toISOString(), canSave: edition === 'java', silent: false };
  cache.set(inst.id, { at: Date.now(), state, scheme });
  return state;
}

export type WorldAction =
  | { type: 'gamerule'; name: string; value: string | boolean | number }
  | { type: 'difficulty'; value: string }
  | { type: 'time'; value: string }
  | { type: 'weather'; value: string }
  | { type: 'say'; message: string }
  | { type: 'save' };

export async function applyWorld(inst: ServerInstance, a: WorldAction): Promise<{ message: string; unconfirmed?: boolean }> {
  if (inst.state !== 'running') throw new HttpError(409, 'Start the server to change live settings');
  const bedrock = inst.rec.edition === 'bedrock';
  switch (a.type) {
    case 'gamerule': {
      const name = String(a.name || '');
      if (!/^[A-Za-z_:]{2,64}$/.test(name)) throw bad('Invalid game rule');
      let value = String(a.value);
      if (!/^(true|false|-?\d{1,9}|[a-z_]{1,32})$/.test(value)) throw bad('Invalid value');
      const shown = value;
      if (bedrock) {
        if (BEDROCK_READ_ONLY.has(name.toLowerCase())) throw new HttpError(409, `Bedrock reports "${name}" but does not allow changing it`);
        const def = RULES.find((r) => r.bedrock?.toLowerCase() === name.toLowerCase());
        if (def?.bedrockMap && (value === 'true' || value === 'false')) value = value === 'true' ? def.bedrockMap.on : def.bedrockMap.off;
      }
      const confirmed = inst.waitFor((_ev, line) => new RegExp(`Game ?rule ${name.replace(/^minecraft:/, '')} (is now set to|has been updated to)`, 'i').test(line), 2000).then(() => 'ok' as const).catch(() => 'silent' as const);
      const rejected = inst.waitFor((_ev, line) => /Incorrect argument|Unknown or incomplete|Syntax error|Unknown command|Invalid (bool|integer|value)/i.test(line), 2000).then(() => 'rejected' as const).catch(() => 'silent' as const);
      inst.send(`gamerule ${name} ${value}`);
      // First definite answer wins; if the server says nothing (Bedrock with command feedback off) the change is sent but unconfirmed.
      const first = await Promise.race([confirmed.then((r) => (r === 'ok' ? r : new Promise<'silent'>((res) => setTimeout(() => res('silent'), 50)))), rejected.then((r) => (r === 'rejected' ? r : new Promise<'silent'>((res) => setTimeout(() => res('silent'), 50))))]);
      if (first === 'rejected') throw new HttpError(409, `The server refused to set ${name} to "${value}". It may list this rule without allowing changes, or the value is not valid for it.`);
      const c = cache.get(inst.id);
      if (c) {
        const rule = c.state.rules.find((r) => r.name.toLowerCase() === name.toLowerCase());
        if (rule) rule.value = shown;
        // Turning feedback back on makes the server talk again: force a fresh read next time.
        if (/^send_?command_?feedback$/i.test(name)) c.at = 0;
      }
      if (first === 'silent') return { message: `${name} sent as ${value}; the server gave no confirmation (command feedback is off)`, unconfirmed: true };
      return { message: `${name} set to ${value}` };
    }
    case 'difficulty': {
      const v = String(a.value).toLowerCase();
      if (!DIFFICULTIES.includes(v)) throw bad('Invalid difficulty');
      inst.send(`difficulty ${v}`);
      // Keep server.properties in step so the choice survives a restart (Bedrock reads it on boot).
      const pf = await PropertiesFile.load(path.join(inst.root, 'server.properties'));
      pf.set('difficulty', v);
      await pf.save();
      const c = cache.get(inst.id);
      if (c) c.state.difficulty = v;
      return { message: `Difficulty set to ${v}` };
    }
    case 'time': {
      const v = String(a.value).toLowerCase();
      if (!TIMES.includes(v)) throw bad('Invalid time');
      inst.send(`time set ${v}`);
      return { message: `Time set to ${v}` };
    }
    case 'weather': {
      const v = String(a.value).toLowerCase();
      if (!WEATHERS.includes(v)) throw bad('Invalid weather');
      inst.send(`weather ${v}`);
      const c = cache.get(inst.id);
      if (c) c.state.weather = v;
      return { message: `Weather set to ${v}` };
    }
    case 'say': {
      const msg = String(a.message || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 240);
      if (!msg) throw bad('Message is empty');
      inst.send(`say ${msg}`);
      return { message: 'Message sent' };
    }
    case 'save': {
      if (bedrock) throw bad('Bedrock saves automatically; use Backups for a snapshot');
      inst.send('save-all');
      return { message: 'Saving the world' };
    }
    default:
      throw bad('Unknown action');
  }
}
