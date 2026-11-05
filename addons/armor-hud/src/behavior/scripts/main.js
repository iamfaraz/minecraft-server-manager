// Blockhost Armor HUD: shows each player their held items, armour durability, arrows and free inventory slots
// around the hotbar. This script reads the data on the server and sends it to the player's HUD as a hidden title;
// the companion resource pack draws it.
import { EquipmentSlot, system, world } from '@minecraft/server';
import { buildMessages } from './hud.js';

/**
 * How often each player is looked at, in game ticks (20 per second). At most one message goes out per player per
 * pass: titles replace each other, so two sent together could reach the HUD as one.
 */
const PASS_EVERY = 3;
/** Everything is sent again this often, so a HUD that was rebuilt or missed a message fills back in. */
const RESYNC_EVERY = 600;
/** How long each hidden title stays up: long enough to be seen on a slow frame, shorter than a pass. */
const TITLE_TICKS = 2;

/** player id -> { messages: what the HUD is believed to hold, per channel; syncedAt: tick of the last full resync } */
const sent = new Map();

function itemInfo(item) {
  if (!item) return null;
  const durability = item.getComponent('minecraft:durability');
  return { id: item.typeId, amount: item.amount, maxAmount: item.maxAmount, damage: durability?.damage, maxDurability: durability?.maxDurability };
}

function readPlayer(player) {
  const equipment = player.getComponent('minecraft:equippable');
  const container = player.getComponent('minecraft:inventory')?.container;
  if (!equipment || !container) return null;

  const counts = new Map();
  const add = (item) => item && counts.set(item.typeId, (counts.get(item.typeId) ?? 0) + item.amount);
  let freeSlots = 0;
  for (let i = 0; i < container.size; i++) {
    const item = container.getItem(i);
    if (item) add(item);
    else freeSlots++;
  }
  const offhand = equipment.getEquipment(EquipmentSlot.Offhand);
  add(offhand); // the off hand is not part of the inventory container

  return {
    mainhand: itemInfo(equipment.getEquipment(EquipmentSlot.Mainhand)),
    offhand: itemInfo(offhand),
    head: itemInfo(equipment.getEquipment(EquipmentSlot.Head)),
    chest: itemInfo(equipment.getEquipment(EquipmentSlot.Chest)),
    legs: itemInfo(equipment.getEquipment(EquipmentSlot.Legs)),
    feet: itemInfo(equipment.getEquipment(EquipmentSlot.Feet)),
    counts,
    freeSlots,
  };
}

system.runInterval(() => {
  const now = system.currentTick;
  for (const player of world.getAllPlayers()) {
    try {
      const state = readPlayer(player);
      if (!state) continue;
      const want = buildMessages(state);
      let record = sent.get(player.id);
      if (!record || now - record.syncedAt >= RESYNC_EVERY) {
        record = { messages: [], syncedAt: now };
        sent.set(player.id, record);
      }
      const channel = want.findIndex((message, i) => record.messages[i] !== message);
      if (channel === -1) continue;
      player.onScreenDisplay.setTitle(want[channel], { fadeInDuration: 0, stayDuration: TITLE_TICKS, fadeOutDuration: 0 });
      record.messages[channel] = want[channel];
    } catch {
      // The player left or is changing dimension this tick; try again on the next pass.
    }
  }
}, PASS_EVERY);

// A fresh spawn gets a fresh HUD, so forget what was sent and let the next passes fill it in.
world.afterEvents.playerSpawn.subscribe((event) => sent.delete(event.player.id));
world.afterEvents.playerLeave.subscribe((event) => sent.delete(event.playerId));
