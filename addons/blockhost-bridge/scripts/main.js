// Blockhost Bridge: the manager's hands inside a Bedrock server.
//
// Bedrock has no console command that prints a player's inventory, so the manager talks to this script instead:
//   manager -> script   console command:  scriptevent blockhost:rpc {"id":"ab12","op":"get","player":"Steve"}
//   script  -> manager  log lines:        BHRPC ab12 1/3 <part of a JSON document>
// Replies are split into parts because log lines have a length limit. The script also reports, unasked:
//   BHEVT 0 1/1 {"event":"spawn","player":"Steve"}            when a player has fully joined
//   BHEVT 0 1/2 {"event":"snapshot","inventory":{...}}        a player's inventory as they leave, and every few minutes
// The manager needs `content-log-console-output-enabled=true` to see any of this; it sets that when installing.
import { EquipmentSlot, ItemStack, system, world } from '@minecraft/server';

const PART = 900;
const EQUIPMENT = { head: EquipmentSlot.Head, chest: EquipmentSlot.Chest, legs: EquipmentSlot.Legs, feet: EquipmentSlot.Feet, offhand: EquipmentSlot.Offhand };

function send(tag, id, payload) {
  const text = JSON.stringify(payload);
  const total = Math.max(1, Math.ceil(text.length / PART));
  for (let i = 0; i < total; i++) console.warn(`${tag} ${id} ${i + 1}/${total} ${text.slice(i * PART, (i + 1) * PART)}`);
}

function describe(item) {
  if (!item) return null;
  const out = { id: item.typeId, count: item.amount, maxCount: item.maxAmount };
  if (item.nameTag) out.name = item.nameTag;
  const durability = item.getComponent('minecraft:durability');
  if (durability) {
    out.damage = durability.damage;
    out.maxDamage = durability.maxDurability;
  }
  try {
    const enchants = item.getComponent('minecraft:enchantable')?.getEnchantments() ?? [];
    if (enchants.length) out.enchants = enchants.map((e) => ({ id: e.type.id, level: e.level }));
  } catch {
    /* not enchantable */
  }
  if (item.getLore().length) out.lore = item.getLore();
  return out;
}

function readInventory(player) {
  const container = player.getComponent('minecraft:inventory').container;
  const equipment = player.getComponent('minecraft:equippable');
  const slots = [];
  for (let i = 0; i < container.size; i++) slots.push(describe(container.getItem(i)));
  const worn = {};
  for (const [key, slot] of Object.entries(EQUIPMENT)) worn[key] = describe(equipment.getEquipment(slot));
  return {
    player: player.name,
    slots,
    equipment: worn,
    xp: { level: player.level, progress: player.totalXpNeededForNextLevel ? player.xpEarnedAtCurrentLevel / player.totalXpNeededForNextLevel : 0 },
  };
}

const findPlayer = (name) => world.getAllPlayers().find((p) => p.name.toLowerCase() === String(name).toLowerCase());

function newStack(id, count) {
  const stack = new ItemStack(id, 1);
  stack.amount = Math.max(1, Math.min(Math.floor(count), stack.maxAmount));
  return stack;
}

/** Put an item in a numbered inventory slot or a worn slot; `undefined` empties it. */
function place(player, slot, item) {
  if (typeof slot === 'number') player.getComponent('minecraft:inventory').container.setItem(slot, item);
  else if (EQUIPMENT[slot]) player.getComponent('minecraft:equippable').setEquipment(EQUIPMENT[slot], item);
  else throw new Error(`Unknown slot ${slot}`);
}
function itemAt(player, slot) {
  if (typeof slot === 'number') return player.getComponent('minecraft:inventory').container.getItem(slot);
  if (EQUIPMENT[slot]) return player.getComponent('minecraft:equippable').getEquipment(EQUIPMENT[slot]);
  throw new Error(`Unknown slot ${slot}`);
}

const OPS = {
  get: () => {},
  give(player, r) {
    const container = player.getComponent('minecraft:inventory').container;
    let left = Math.max(1, Math.floor(r.count ?? 1));
    let dropped = 0;
    while (left > 0) {
      const stack = newStack(r.item, left);
      left -= stack.amount;
      const overflow = container.addItem(stack);
      if (overflow) {
        dropped += overflow.amount + left;
        break;
      }
    }
    if (dropped) return { note: `${dropped} did not fit in the inventory` };
  },
  set: (player, r) => place(player, r.slot, newStack(r.item, r.count ?? 1)),
  clear: (player, r) => place(player, r.slot, undefined),
  count(player, r) {
    const item = itemAt(player, r.slot);
    if (!item) throw new Error('That slot is empty');
    item.amount = Math.max(1, Math.min(Math.floor(r.count), item.maxAmount));
    place(player, r.slot, item);
  },
  xp(player, r) {
    const level = Math.max(0, Math.min(Math.floor(r.level), 24791));
    player.resetLevel();
    if (level) player.addLevels(level);
  },
};

system.afterEvents.scriptEventReceive.subscribe((event) => {
  if (event.id !== 'blockhost:rpc') return;
  let request;
  try {
    request = JSON.parse(event.message);
  } catch {
    return;
  }
  const reply = (body) => send('BHRPC', request.id, body);
  try {
    const run = OPS[request.op];
    if (!run) throw new Error(`Unknown operation ${request.op}`);
    const player = findPlayer(request.player);
    if (!player) return reply({ ok: false, offline: true, error: `${request.player} is not online` });
    const extra = run(player, request) ?? {};
    reply({ ok: true, ...extra, inventory: readInventory(player) });
  } catch (e) {
    reply({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
});

const snapshot = (player) => {
  try {
    send('BHEVT', '0', { event: 'snapshot', inventory: readInventory(player) });
  } catch {
    /* player already gone */
  }
};
world.beforeEvents.playerLeave.subscribe((event) => snapshot(event.player));
world.afterEvents.playerSpawn.subscribe((event) => {
  if (event.initialSpawn) send('BHEVT', '0', { event: 'spawn', player: event.player.name });
});
system.runInterval(() => world.getAllPlayers().forEach(snapshot), 6000);
system.run(() => send('BHEVT', '0', { event: 'ready', version: 1 }));
