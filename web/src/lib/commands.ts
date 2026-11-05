import type { ServerSummary } from './types';

/** One argument position. `then` describes the following position, optionally depending on what was chosen here. */
export interface Arg {
  values?: string[];
  player?: boolean;
  hint?: string;
  then?: Arg | Record<string, Arg>;
}
export interface Cmd {
  name: string;
  desc: string;
  usage?: string;
  args?: Arg;
}
export interface Suggestion {
  label: string;
  detail?: string;
  kind: 'command' | 'value' | 'player';
}
export interface SuggestResult {
  items: Suggestion[];
  /** Text before the token being completed (includes the leading slash if typed). */
  prefix: string;
  token: string;
  usage?: string;
  hint?: string;
}

const P: Arg = { player: true, hint: '<player>' };
const MODES_JAVA = ['survival', 'creative', 'adventure', 'spectator'];
const MODES_BEDROCK = ['survival', 'creative', 'adventure', 'spectator', 'default'];
const DIFF = ['peaceful', 'easy', 'normal', 'hard'];
const TF: Arg = { values: ['true', 'false'] };
const SELECTORS = ['@a', '@p', '@r', '@s', '@e'];

/** Java 26.x / 1.21.11+ game rules (snake_case), as reported by a real 26.3 server. */
const GAMERULES_JAVA = [
  'keep_inventory', 'advance_time', 'advance_weather', 'pvp', 'spawn_mobs', 'spawn_monsters', 'mob_griefing', 'fire_spread_radius_around_player', 'immediate_respawn',
  'players_sleeping_percentage', 'natural_health_regeneration', 'show_death_messages', 'show_advancement_messages', 'spawn_phantoms', 'spawn_patrols', 'spawn_wandering_traders',
  'spawn_wardens', 'raids', 'block_drops', 'mob_drops', 'entity_drops', 'fall_damage', 'fire_damage', 'drowning_damage', 'freeze_damage', 'random_tick_speed', 'reduced_debug_info',
  'locator_bar', 'send_command_feedback', 'command_block_output', 'respawn_radius', 'tnt_explodes', 'forgive_dead_players', 'universal_anger', 'max_entity_cramming',
  'limited_crafting', 'projectiles_can_break_blocks', 'ender_pearls_vanish_on_death', 'water_source_conversion', 'lava_source_conversion', 'command_blocks_work',
  'spawner_blocks_work', 'allow_entering_nether_using_portals', 'global_sound_events', 'log_admin_commands', 'spectators_generate_chunks',
];
/** Older Java versions use camelCase names. */
const GAMERULES_JAVA_LEGACY = [
  'keepInventory', 'doDaylightCycle', 'doWeatherCycle', 'doMobSpawning', 'mobGriefing', 'doFireTick', 'doImmediateRespawn', 'playersSleepingPercentage',
  'randomTickSpeed', 'showDeathMessages', 'naturalRegeneration', 'doInsomnia', 'announceAdvancements', 'commandBlockOutput', 'sendCommandFeedback',
  'spawnRadius', 'fallDamage', 'fireDamage', 'drowningDamage', 'freezeDamage', 'doTileDrops', 'doMobLoot', 'doEntityDrops', 'maxEntityCramming',
  'doPatrolSpawning', 'doTraderSpawning', 'doWardenSpawning', 'disableRaids', 'reducedDebugInfo', 'locatorBar', 'tntExplodes',
];
const GAMERULES_BEDROCK = [
  'keepInventory', 'doDayLightCycle', 'doWeatherCycle', 'doMobSpawning', 'mobGriefing', 'doFireTick', 'doImmediateRespawn', 'playersSleepingPercentage', 'randomTickSpeed',
  'showCoordinates', 'showDaysPlayed', 'showTags', 'showDeathMessages', 'showRecipeMessages', 'showBorderEffect', 'naturalRegeneration', 'doInsomnia',
  'commandBlockOutput', 'commandBlocksEnabled', 'sendCommandFeedback', 'spawnRadius', 'fallDamage', 'fireDamage', 'drowningDamage', 'freezeDamage', 'doTileDrops', 'doMobLoot',
  'doEntityDrops', 'pvp', 'tntExplodes', 'respawnBlocksExplode', 'recipesUnlock', 'doLimitedCrafting', 'projectilesCanBreakBlocks', 'tntExplosionDropDecay', 'playerWaypoints',
  'maxCommandChainLength', 'functionCommandLimit',
];
/** Java game rules were renamed to snake_case in 1.21.11 and the year-based versions. */
function usesNewRuleNames(version: string | undefined): boolean {
  const m = /^(\d+)\.(\d+)(?:\.(\d+))?/.exec(version || '');
  if (!m) return true;
  const [a, b, c] = [+m[1], +m[2], +(m[3] || 0)];
  return a >= 26 || (a === 1 && (b > 21 || (b === 21 && c >= 11)));
}
const EFFECTS = ['speed', 'slowness', 'haste', 'strength', 'instant_health', 'jump_boost', 'regeneration', 'resistance', 'fire_resistance', 'water_breathing', 'invisibility', 'night_vision', 'saturation', 'glowing', 'levitation', 'slow_falling'];

const JAVA: Cmd[] = [
  { name: 'help', desc: 'List commands or explain one', usage: 'help [command]' },
  { name: 'list', desc: 'Show players online', usage: 'list [uuids]', args: { values: ['uuids'] } },
  { name: 'say', desc: 'Broadcast a message to everyone', usage: 'say <message>', args: { hint: '<message>' } },
  { name: 'stop', desc: 'Save and stop the server' },
  { name: 'save-all', desc: 'Save the world to disk', usage: 'save-all [flush]', args: { values: ['flush'] } },
  { name: 'save-off', desc: 'Pause automatic saving' },
  { name: 'save-on', desc: 'Resume automatic saving' },
  { name: 'op', desc: 'Make a player an operator', usage: 'op <player>', args: P },
  { name: 'deop', desc: 'Remove operator status', usage: 'deop <player>', args: P },
  { name: 'kick', desc: 'Disconnect a player', usage: 'kick <player> [reason]', args: { ...P, then: { hint: '[reason]' } } },
  { name: 'ban', desc: 'Ban a player', usage: 'ban <player> [reason]', args: { ...P, then: { hint: '[reason]' } } },
  { name: 'ban-ip', desc: 'Ban an IP address or a player\'s IP', usage: 'ban-ip <address|player> [reason]', args: P },
  { name: 'pardon', desc: 'Unban a player', usage: 'pardon <player>', args: P },
  { name: 'pardon-ip', desc: 'Unban an IP address', usage: 'pardon-ip <address>', args: { hint: '<address>' } },
  { name: 'banlist', desc: 'Show banned players or IPs', usage: 'banlist [ips|players]', args: { values: ['ips', 'players'] } },
  { name: 'whitelist', desc: 'Manage the whitelist', usage: 'whitelist <add|remove|list|on|off|reload> [player]', args: { values: ['add', 'remove', 'list', 'on', 'off', 'reload'], then: { add: P, remove: P } } },
  { name: 'gamemode', desc: 'Change a player\'s game mode', usage: 'gamemode <mode> [player]', args: { values: MODES_JAVA, then: P } },
  { name: 'defaultgamemode', desc: 'Set the mode for new players', usage: 'defaultgamemode <mode>', args: { values: MODES_JAVA } },
  { name: 'difficulty', desc: 'Show or set the difficulty', usage: 'difficulty [peaceful|easy|normal|hard]', args: { values: DIFF } },
  { name: 'gamerule', desc: 'Show or change a game rule', usage: 'gamerule <rule> [value]', args: { values: GAMERULES_JAVA, then: { values: ['true', 'false'], hint: '[value]' } } },
  { name: 'time', desc: 'Change or query the time', usage: 'time <set|add|query> <value>', args: { values: ['set', 'add', 'query'], then: { set: { values: ['day', 'noon', 'night', 'midnight'], hint: '<ticks>' }, add: { hint: '<ticks>' }, query: { values: ['daytime', 'gametime', 'day'] } } } },
  { name: 'weather', desc: 'Set the weather', usage: 'weather <clear|rain|thunder> [duration]', args: { values: ['clear', 'rain', 'thunder'], then: { hint: '[duration]' } } },
  { name: 'tp', desc: 'Teleport players', usage: 'tp <target> <destination | x y z>', args: { player: true, values: SELECTORS, then: { player: true, hint: '<player | x y z>' } } },
  { name: 'teleport', desc: 'Teleport players', usage: 'teleport <target> <destination | x y z>', args: { player: true, values: SELECTORS, then: { player: true, hint: '<player | x y z>' } } },
  { name: 'give', desc: 'Give an item to a player', usage: 'give <player> <item> [count]', args: { player: true, values: SELECTORS, then: { hint: '<item>', values: ['minecraft:diamond', 'minecraft:elytra', 'minecraft:netherite_ingot', 'minecraft:golden_apple', 'minecraft:totem_of_undying'], then: { hint: '[count]' } } } },
  { name: 'clear', desc: 'Remove items from an inventory', usage: 'clear [player] [item]', args: { player: true, values: SELECTORS } },
  { name: 'kill', desc: 'Kill players or entities', usage: 'kill [target]', args: { player: true, values: SELECTORS } },
  { name: 'effect', desc: 'Add or remove status effects', usage: 'effect <give|clear> <player> [effect] [seconds] [amplifier]', args: { values: ['give', 'clear'], then: { player: true, values: SELECTORS, then: { values: EFFECTS.map((e) => `minecraft:${e}`), then: { hint: '[seconds]' } } } } },
  { name: 'enchant', desc: 'Enchant the held item', usage: 'enchant <player> <enchantment> [level]', args: { player: true, values: SELECTORS, then: { hint: '<enchantment>' } } },
  { name: 'xp', desc: 'Give or set experience', usage: 'xp <add|set|query> <player> <amount> [points|levels]', args: { values: ['add', 'set', 'query'], then: { player: true, values: SELECTORS, then: { hint: '<amount>', then: { values: ['points', 'levels'] } } } } },
  { name: 'experience', desc: 'Give or set experience', usage: 'experience <add|set|query> <player> <amount>', args: { values: ['add', 'set', 'query'], then: { player: true, values: SELECTORS } } },
  { name: 'msg', desc: 'Send a private message', usage: 'msg <player> <message>', args: { ...P, then: { hint: '<message>' } } },
  { name: 'tell', desc: 'Send a private message', usage: 'tell <player> <message>', args: { ...P, then: { hint: '<message>' } } },
  { name: 'tellraw', desc: 'Send a JSON text message', usage: 'tellraw <player> <json>', args: { player: true, values: SELECTORS, then: { hint: '<json>' } } },
  { name: 'title', desc: 'Show a title on screen', usage: 'title <player> <title|subtitle|actionbar|clear|reset|times> ...', args: { player: true, values: SELECTORS, then: { values: ['title', 'subtitle', 'actionbar', 'clear', 'reset', 'times'] } } },
  { name: 'me', desc: 'Send an action message', usage: 'me <action>', args: { hint: '<action>' } },
  { name: 'seed', desc: 'Show the world seed' },
  { name: 'setworldspawn', desc: 'Set the world spawn point', usage: 'setworldspawn [x y z]', args: { hint: '[x y z]' } },
  { name: 'spawnpoint', desc: 'Set a player\'s spawn point', usage: 'spawnpoint [player] [x y z]', args: { player: true, values: SELECTORS } },
  { name: 'setidletimeout', desc: 'Kick idle players after N minutes', usage: 'setidletimeout <minutes>', args: { hint: '<minutes>' } },
  { name: 'worldborder', desc: 'Manage the world border', usage: 'worldborder <set|add|center|get|damage|warning> ...', args: { values: ['set', 'add', 'center', 'get', 'damage', 'warning'], then: { set: { hint: '<diameter> [seconds]' }, add: { hint: '<distance> [seconds]' }, center: { hint: '<x> <z>' } } } },
  { name: 'locate', desc: 'Find a structure, biome or point of interest', usage: 'locate <structure|biome|poi> <id>', args: { values: ['structure', 'biome', 'poi'], then: { hint: '<id>' } } },
  { name: 'summon', desc: 'Spawn an entity', usage: 'summon <entity> [x y z]', args: { hint: '<entity>', values: ['minecraft:zombie', 'minecraft:villager', 'minecraft:lightning_bolt', 'minecraft:armor_stand'] } },
  { name: 'setblock', desc: 'Place a block', usage: 'setblock <x y z> <block>', args: { hint: '<x y z> <block>' } },
  { name: 'fill', desc: 'Fill a region with a block', usage: 'fill <from> <to> <block>', args: { hint: '<x1 y1 z1> <x2 y2 z2> <block>' } },
  { name: 'clone', desc: 'Copy blocks from one place to another', usage: 'clone <begin> <end> <destination>', args: { hint: '<begin> <end> <destination>' } },
  { name: 'scoreboard', desc: 'Manage objectives and scores', usage: 'scoreboard <objectives|players> ...', args: { values: ['objectives', 'players'], then: { objectives: { values: ['add', 'remove', 'list', 'setdisplay', 'modify'] }, players: { values: ['add', 'remove', 'set', 'get', 'list', 'reset', 'enable', 'operation'] } } } },
  { name: 'team', desc: 'Manage teams', usage: 'team <add|remove|join|leave|list|modify|empty> ...', args: { values: ['add', 'remove', 'join', 'leave', 'list', 'modify', 'empty'] } },
  { name: 'tag', desc: 'Manage entity tags', usage: 'tag <target> <add|remove|list> [name]', args: { player: true, values: SELECTORS, then: { values: ['add', 'remove', 'list'] } } },
  { name: 'execute', desc: 'Run a command with a changed context', usage: 'execute <as|at|if|unless|in|positioned|run> ...', args: { values: ['as', 'at', 'if', 'unless', 'in', 'positioned', 'rotated', 'facing', 'align', 'anchored', 'store', 'run'] } },
  { name: 'data', desc: 'Read or change NBT data', usage: 'data <get|merge|modify|remove> <block|entity|storage> ...', args: { values: ['get', 'merge', 'modify', 'remove'], then: { values: ['block', 'entity', 'storage'] } } },
  { name: 'datapack', desc: 'Manage data packs', usage: 'datapack <list|enable|disable> [name]', args: { values: ['list', 'enable', 'disable'] } },
  { name: 'reload', desc: 'Reload data packs and functions' },
  { name: 'function', desc: 'Run a function', usage: 'function <name>', args: { hint: '<namespace:path>' } },
  { name: 'forceload', desc: 'Keep chunks loaded', usage: 'forceload <add|remove|query> ...', args: { values: ['add', 'remove', 'query'] } },
  { name: 'tick', desc: 'Control the tick rate', usage: 'tick <query|rate|freeze|unfreeze|step|sprint> ...', args: { values: ['query', 'rate', 'freeze', 'unfreeze', 'step', 'sprint'], then: { rate: { hint: '<ticks per second>' } } } },
  { name: 'playsound', desc: 'Play a sound to players', usage: 'playsound <sound> <source> <player>', args: { hint: '<sound>' } },
  { name: 'particle', desc: 'Create particles', usage: 'particle <name> [pos]', args: { hint: '<name>' } },
  { name: 'spectate', desc: 'Make a spectator watch an entity', usage: 'spectate [target] [player]', args: P },
  { name: 'spreadplayers', desc: 'Scatter players around a point', usage: 'spreadplayers <x z> <distance> <range> <teams> <targets>', args: { hint: '<x z> <spreadDistance> <maxRange> <respectTeams> <targets>' } },
  { name: 'advancement', desc: 'Grant or revoke advancements', usage: 'advancement <grant|revoke> <player> <everything|only|from|through|until>', args: { values: ['grant', 'revoke'], then: { player: true, values: SELECTORS, then: { values: ['everything', 'only', 'from', 'through', 'until'] } } } },
  { name: 'attribute', desc: 'Read or change entity attributes', usage: 'attribute <target> <attribute> <get|base|modifier>', args: { player: true, values: SELECTORS } },
  { name: 'bossbar', desc: 'Manage boss bars', usage: 'bossbar <add|remove|list|set|get> ...', args: { values: ['add', 'remove', 'list', 'set', 'get'] } },
  { name: 'item', desc: 'Modify or replace items in slots', usage: 'item <modify|replace> <block|entity> ...', args: { values: ['modify', 'replace'], then: { values: ['block', 'entity'] } } },
  { name: 'loot', desc: 'Drop loot from a loot table', usage: 'loot <give|insert|spawn|replace> ...', args: { values: ['give', 'insert', 'spawn', 'replace'] } },
  { name: 'recipe', desc: 'Give or take recipes', usage: 'recipe <give|take> <player> <recipe|*>', args: { values: ['give', 'take'], then: { player: true, values: SELECTORS, then: { values: ['*'] } } } },
  { name: 'ride', desc: 'Mount or dismount entities', usage: 'ride <target> <mount|dismount> [vehicle]', args: { player: true, values: SELECTORS, then: { values: ['mount', 'dismount'] } } },
  { name: 'damage', desc: 'Deal damage to an entity', usage: 'damage <target> <amount> [type]', args: { player: true, values: SELECTORS, then: { hint: '<amount>' } } },
  { name: 'transfer', desc: 'Send players to another server', usage: 'transfer <host> [port] [players]', args: { hint: '<host>' } },
  { name: 'stopsound', desc: 'Stop a playing sound', usage: 'stopsound <player> [source] [sound]', args: { player: true, values: SELECTORS } },
  { name: 'trigger', desc: 'Set a trigger objective', usage: 'trigger <objective> [add|set] [value]', args: { hint: '<objective>' } },
];

const PAPER_EXTRA: Cmd[] = [
  { name: 'plugins', desc: 'List installed plugins' },
  { name: 'version', desc: 'Show server or plugin version', usage: 'version [plugin]', args: { hint: '[plugin]' } },
  { name: 'tps', desc: 'Show ticks per second' },
  { name: 'mspt', desc: 'Show milliseconds per tick' },
  { name: 'paper', desc: 'Paper utilities', usage: 'paper <reload|version|heap|entity|chunkinfo|debug|mobcaps> ...', args: { values: ['reload', 'version', 'heap', 'entity', 'chunkinfo', 'debug', 'mobcaps', 'playermobcaps', 'syncloadinfo', 'dumpitem', 'dumplisteners'] } },
  { name: 'spark', desc: 'Performance profiler', usage: 'spark <profiler|tps|health|gc|heapsummary> ...', args: { values: ['profiler', 'tps', 'health', 'gc', 'gcmonitor', 'heapsummary', 'heapdump', 'tickmonitor', 'activity'], then: { profiler: { values: ['start', 'stop', 'info', 'open', 'cancel'] } } } },
  { name: 'lp', desc: 'LuckPerms permissions (if installed)', usage: 'lp <user|group|sync|info|editor> ...', args: { values: ['user', 'group', 'track', 'sync', 'info', 'editor', 'verbose', 'listgroups', 'creategroup', 'deletegroup'], then: { user: { ...P, then: { values: ['info', 'permission', 'parent', 'meta', 'promote', 'demote', 'clear'] } } } } },
  { name: 'restart', desc: 'Restart the server (needs a restart script)' },
];

const GEYSER_EXTRA: Cmd[] = [
  { name: 'geyser', desc: 'Geyser cross-play tools', usage: 'geyser <help|list|reload|offhand|version|dump|connectiontest|statistics> ...', args: { values: ['help', 'list', 'reload', 'offhand', 'version', 'dump', 'connectiontest', 'statistics', 'advancements', 'settings', 'tooltips', 'extensions'] } },
  { name: 'fwhitelist', desc: 'Floodgate whitelist for Bedrock players', usage: 'fwhitelist <add|remove> <gamertag>', args: { values: ['add', 'remove'], then: P } },
  { name: 'linkaccount', desc: 'Floodgate: link a Bedrock and Java account', usage: 'linkaccount [player] [code]' },
  { name: 'unlinkaccount', desc: 'Floodgate: unlink accounts' },
];

const BEDROCK: Cmd[] = [
  { name: 'help', desc: 'List commands or explain one', usage: 'help [command|page]' },
  { name: 'list', desc: 'Show players online' },
  { name: 'say', desc: 'Broadcast a message to everyone', usage: 'say <message>', args: { hint: '<message>' } },
  { name: 'stop', desc: 'Stop the server' },
  { name: 'save', desc: 'Control world saving (used for backups)', usage: 'save <hold|query|resume>', args: { values: ['hold', 'query', 'resume'] } },
  { name: 'allowlist', desc: 'Manage the allowlist', usage: 'allowlist <add|remove|list|on|off|reload> [player]', args: { values: ['add', 'remove', 'list', 'on', 'off', 'reload'], then: { add: P, remove: P } } },
  { name: 'op', desc: 'Make a player an operator', usage: 'op <player>', args: P },
  { name: 'deop', desc: 'Remove operator status', usage: 'deop <player>', args: P },
  { name: 'kick', desc: 'Disconnect a player', usage: 'kick <player> [reason]', args: { ...P, then: { hint: '[reason]' } } },
  { name: 'permission', desc: 'Reload or list permissions', usage: 'permission <list|reload>', args: { values: ['list', 'reload'] } },
  { name: 'gamemode', desc: 'Change a player\'s game mode', usage: 'gamemode <mode> [player]', args: { values: MODES_BEDROCK, then: P } },
  { name: 'difficulty', desc: 'Set the difficulty', usage: 'difficulty <peaceful|easy|normal|hard>', args: { values: DIFF } },
  { name: 'gamerule', desc: 'Show or change a game rule', usage: 'gamerule <rule> [value]', args: { values: GAMERULES_BEDROCK, then: { '*': TF, playerwaypoints: { values: ['everyone', 'off'] } } } },
  { name: 'changesetting', desc: 'Change a server setting while running', usage: 'changesetting <allow-cheats|difficulty> <value>', args: { values: ['allow-cheats', 'difficulty'], then: { 'allow-cheats': TF, difficulty: { values: DIFF } } } },
  { name: 'setmaxplayers', desc: 'Set the player limit for this session', usage: 'setmaxplayers <count>', args: { hint: '<count>' } },
  { name: 'time', desc: 'Change or query the time', usage: 'time <set|add|query> <value>', args: { values: ['set', 'add', 'query'], then: { set: { values: ['day', 'noon', 'sunset', 'night', 'midnight', 'sunrise'], hint: '<ticks>' }, add: { hint: '<ticks>' }, query: { values: ['daytime', 'gametime', 'day'] } } } },
  { name: 'daylock', desc: 'Lock or unlock the day cycle', usage: 'daylock [true|false]', args: TF },
  { name: 'weather', desc: 'Set the weather', usage: 'weather <clear|rain|thunder> [duration]', args: { values: ['clear', 'rain', 'thunder', 'query'] } },
  { name: 'toggledownfall', desc: 'Toggle rain' },
  { name: 'tp', desc: 'Teleport players', usage: 'tp <target> <destination | x y z>', args: { player: true, values: SELECTORS, then: { player: true, hint: '<player | x y z>' } } },
  { name: 'teleport', desc: 'Teleport players', usage: 'teleport <target> <destination | x y z>', args: { player: true, values: SELECTORS, then: { player: true, hint: '<player | x y z>' } } },
  { name: 'give', desc: 'Give an item to a player', usage: 'give <player> <item> [amount]', args: { player: true, values: SELECTORS, then: { hint: '<item>', values: ['diamond', 'elytra', 'netherite_ingot', 'golden_apple', 'totem_of_undying'], then: { hint: '[amount]' } } } },
  { name: 'clear', desc: 'Remove items from an inventory', usage: 'clear [player] [item]', args: { player: true, values: SELECTORS } },
  { name: 'kill', desc: 'Kill players or entities', usage: 'kill [target]', args: { player: true, values: SELECTORS } },
  { name: 'effect', desc: 'Add or remove status effects', usage: 'effect <player> <effect|clear> [seconds] [amplifier]', args: { player: true, values: SELECTORS, then: { values: ['clear', ...EFFECTS], then: { hint: '[seconds]' } } } },
  { name: 'enchant', desc: 'Enchant the held item', usage: 'enchant <player> <enchantment> [level]', args: { player: true, values: SELECTORS, then: { hint: '<enchantment>' } } },
  { name: 'xp', desc: 'Give experience', usage: 'xp <amount>[L] [player]', args: { hint: '<amount>[L]', then: P } },
  { name: 'tell', desc: 'Send a private message', usage: 'tell <player> <message>', args: { ...P, then: { hint: '<message>' } } },
  { name: 'msg', desc: 'Send a private message', usage: 'msg <player> <message>', args: { ...P, then: { hint: '<message>' } } },
  { name: 'tellraw', desc: 'Send a JSON text message', usage: 'tellraw <player> <json>', args: { player: true, values: SELECTORS, then: { hint: '<json>' } } },
  { name: 'title', desc: 'Show a title on screen', usage: 'title <player> <title|subtitle|actionbar|clear|reset|times> ...', args: { player: true, values: SELECTORS, then: { values: ['title', 'subtitle', 'actionbar', 'clear', 'reset', 'times'] } } },
  { name: 'me', desc: 'Send an action message', usage: 'me <action>', args: { hint: '<action>' } },
  { name: 'setworldspawn', desc: 'Set the world spawn point', usage: 'setworldspawn [x y z]', args: { hint: '[x y z]' } },
  { name: 'spawnpoint', desc: 'Set a player\'s spawn point', usage: 'spawnpoint [player] [x y z]', args: { player: true, values: SELECTORS } },
  { name: 'locate', desc: 'Find a structure or biome', usage: 'locate <structure|biome> <id>', args: { values: ['structure', 'biome'], then: { hint: '<id>' } } },
  { name: 'summon', desc: 'Spawn an entity', usage: 'summon <entity> [x y z]', args: { hint: '<entity>', values: ['zombie', 'villager', 'lightning_bolt', 'armor_stand'] } },
  { name: 'setblock', desc: 'Place a block', usage: 'setblock <x y z> <block>', args: { hint: '<x y z> <block>' } },
  { name: 'fill', desc: 'Fill a region with a block', usage: 'fill <from> <to> <block>', args: { hint: '<x1 y1 z1> <x2 y2 z2> <block>' } },
  { name: 'clone', desc: 'Copy blocks from one place to another', usage: 'clone <begin> <end> <destination>', args: { hint: '<begin> <end> <destination>' } },
  { name: 'structure', desc: 'Save or load structures', usage: 'structure <save|load|delete> <name> ...', args: { values: ['save', 'load', 'delete'] } },
  { name: 'tickingarea', desc: 'Keep areas loaded', usage: 'tickingarea <add|remove|remove_all|list|preload> ...', args: { values: ['add', 'remove', 'remove_all', 'list', 'preload'] } },
  { name: 'scoreboard', desc: 'Manage objectives and scores', usage: 'scoreboard <objectives|players> ...', args: { values: ['objectives', 'players'], then: { objectives: { values: ['add', 'remove', 'list', 'setdisplay'] }, players: { values: ['add', 'remove', 'set', 'list', 'reset', 'operation', 'random', 'test'] } } } },
  { name: 'tag', desc: 'Manage entity tags', usage: 'tag <target> <add|remove|list> [name]', args: { player: true, values: SELECTORS, then: { values: ['add', 'remove', 'list'] } } },
  { name: 'execute', desc: 'Run a command with a changed context', usage: 'execute <as|at|if|unless|in|positioned|run> ...', args: { values: ['as', 'at', 'if', 'unless', 'in', 'positioned', 'rotated', 'facing', 'align', 'anchored', 'run'] } },
  { name: 'function', desc: 'Run a function from a behavior pack', usage: 'function <name>', args: { hint: '<name>' } },
  { name: 'reload', desc: 'Reload functions and scripts', usage: 'reload [all]', args: { values: ['all'] } },
  { name: 'script', desc: 'Script debugger and profiler', usage: 'script <debugger|profiler|watchdog> ...', args: { values: ['debugger', 'profiler', 'watchdog'] } },
  { name: 'playsound', desc: 'Play a sound to players', usage: 'playsound <sound> [player]', args: { hint: '<sound>' } },
  { name: 'stopsound', desc: 'Stop a playing sound', usage: 'stopsound <player> [sound]', args: { player: true, values: SELECTORS } },
  { name: 'music', desc: 'Control music tracks', usage: 'music <play|queue|stop|volume> ...', args: { values: ['play', 'queue', 'stop', 'volume'] } },
  { name: 'particle', desc: 'Create particles', usage: 'particle <effect> <x y z>', args: { hint: '<effect> <x y z>' } },
  { name: 'camerashake', desc: 'Shake a player\'s camera', usage: 'camerashake <add|stop> <player> ...', args: { values: ['add', 'stop'], then: P } },
  { name: 'fog', desc: 'Manage fog settings for players', usage: 'fog <player> <push|pop|remove> ...', args: { player: true, values: SELECTORS, then: { values: ['push', 'pop', 'remove'] } } },
  { name: 'inputpermission', desc: 'Enable or disable player input', usage: 'inputpermission <query|set> <player> <permission> [state]', args: { values: ['query', 'set'], then: { player: true, values: SELECTORS } } },
  { name: 'mobevent', desc: 'Enable or disable mob events', usage: 'mobevent <event> [true|false]', args: { values: ['events_enabled', 'minecraft:pillager_patrols_event', 'minecraft:wandering_trader_event', 'minecraft:ender_dragon_event'], then: TF } },
  { name: 'replaceitem', desc: 'Replace items in slots', usage: 'replaceitem <block|entity> ...', args: { values: ['block', 'entity'] } },
  { name: 'loot', desc: 'Drop loot from a loot table', usage: 'loot <give|insert|spawn|replace> ...', args: { values: ['give', 'insert', 'spawn', 'replace'] } },
  { name: 'ride', desc: 'Mount or dismount entities', usage: 'ride <riders> <start_riding|stop_riding|evict_riders|summon_rider|summon_ride> ...', args: { player: true, values: SELECTORS, then: { values: ['start_riding', 'stop_riding', 'evict_riders', 'summon_rider', 'summon_ride'] } } },
  { name: 'damage', desc: 'Deal damage to an entity', usage: 'damage <target> <amount> [cause]', args: { player: true, values: SELECTORS, then: { hint: '<amount>' } } },
  { name: 'spreadplayers', desc: 'Scatter players around a point', usage: 'spreadplayers <x z> <distance> <range> <targets>', args: { hint: '<x z> <spreadDistance> <maxRange> <targets>' } },
  { name: 'testfor', desc: 'Count entities matching a selector', usage: 'testfor <target>', args: { player: true, values: SELECTORS } },
  { name: 'transfer', desc: 'Send a player to another server', usage: 'transfer <player> <host> [port]', args: { ...P, then: { hint: '<host>' } } },
  { name: 'dialogue', desc: 'Open or change NPC dialogue', usage: 'dialogue <open|change> ...', args: { values: ['open', 'change'] } },
  { name: 'schedule', desc: 'Schedule a function', usage: 'schedule <on_area_loaded|delay|clear> ...', args: { values: ['on_area_loaded', 'delay', 'clear'] } },
];

export function commandsFor(s: Pick<ServerSummary, 'edition' | 'type' | 'geyser'> & { version?: string }): Cmd[] {
  if (s.edition === 'bedrock') return BEDROCK;
  const list = JAVA.map((c) => (c.name === 'gamerule' && !usesNewRuleNames(s.version) ? { ...c, args: { ...c.args, values: GAMERULES_JAVA_LEGACY } } : c));
  if (s.type === 'PAPER' || s.type === 'PURPUR') list.push(...PAPER_EXTRA);
  if (s.geyser) list.push(...GEYSER_EXTRA);
  return list.sort((a, b) => a.name.localeCompare(b.name));
}

/** The commands people reach for most, shown first when only "/" has been typed. */
const POPULAR = ['list', 'say', 'op', 'deop', 'kick', 'ban', 'whitelist', 'allowlist', 'gamemode', 'difficulty', 'time', 'weather', 'tp', 'give', 'gamerule', 'save-all', 'save', 'stop'];

function quoteIfNeeded(name: string, edition: string): string {
  return edition === 'bedrock' && /\s/.test(name) ? `"${name}"` : name;
}

export function suggest(s: Pick<ServerSummary, 'edition' | 'type' | 'geyser'> & { version?: string }, input: string, players: string[]): SuggestResult {
  const slash = input.startsWith('/') ? '/' : '';
  const body = input.slice(slash.length);
  const parts = body.split(/\s+/);
  const idx = parts.length - 1;
  const token = parts[idx] ?? '';
  const prefix = slash + (idx > 0 ? parts.slice(0, idx).join(' ') + ' ' : '');
  const cmds = commandsFor(s);
  const low = token.toLowerCase();

  if (idx === 0) {
    let matches = cmds.filter((c) => c.name.startsWith(low));
    if (!low) matches = [...matches].sort((a, b) => (POPULAR.indexOf(a.name) + 1 || 999) - (POPULAR.indexOf(b.name) + 1 || 999));
    else if (!matches.length) matches = cmds.filter((c) => c.name.includes(low));
    return { items: matches.slice(0, 60).map((c) => ({ label: c.name, detail: c.desc, kind: 'command' as const })), prefix, token };
  }

  const cmd = cmds.find((c) => c.name === parts[0].toLowerCase());
  if (!cmd) return { items: [], prefix, token };
  let arg: Arg | undefined = cmd.args;
  for (let i = 1; i < idx && arg; i++) {
    const chosen = parts[i].toLowerCase();
    const next: Arg | Record<string, Arg> | undefined = arg.then;
    if (!next) arg = undefined;
    else if ('values' in next || 'player' in next || 'hint' in next || 'then' in next) arg = next as Arg;
    else arg = (next as Record<string, Arg>)[chosen] ?? (next as Record<string, Arg>)['*'];
  }
  if (!arg) return { items: [], prefix, token, usage: cmd.usage };
  const items: Suggestion[] = [];
  if (arg.player) for (const p of players) if (p.toLowerCase().startsWith(low.replace(/^"/, ''))) items.push({ label: quoteIfNeeded(p, s.edition), kind: 'player', detail: 'player' });
  for (const v of arg.values || []) if (v.toLowerCase().startsWith(low) || (low.length > 1 && v.toLowerCase().includes(low))) items.push({ label: v, kind: 'value' });
  return { items: items.slice(0, 60), prefix, token, usage: cmd.usage, hint: arg.hint };
}

/** Longest common prefix of the suggestions, used when Tab is pressed with several matches. */
export function commonPrefix(items: Suggestion[]): string {
  if (!items.length) return '';
  let p = items[0].label;
  for (const it of items) {
    while (!it.label.toLowerCase().startsWith(p.toLowerCase())) p = p.slice(0, -1);
    if (!p) break;
  }
  return p;
}
