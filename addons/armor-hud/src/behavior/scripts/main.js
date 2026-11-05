// Blockhost Armor HUD: shows each player their held items, armour durability, arrows and free inventory slots
// around the hotbar. This script reads the data on the server and sends it to the player's HUD as a hidden title;
// the companion resource pack draws it.
import { EquipmentSlot, system, world } from '@minecraft/server';
import { buildPayload } from './hud.js';

/** How often each player is checked, in game ticks (20 per second). */
const CHECK_EVERY = 4;
/** Unchanged data is sent again this often, so a HUD that was rebuilt (respawn, new dimension) fills back in. */
const RESEND_EVERY = 200;
/** How long the hidden title stays up: long enough for the HUD to pick it up on a slow frame. */
const TITLE_TICKS = 5;

/** player id -> what was last sent and when */
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
  for (let i = 0; i < container.size; i++) add(container.getItem(i));
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
    freeSlots: container.emptySlotsCount,
  };
}

system.runInterval(() => {
  const now = system.currentTick;
  for (const player of world.getAllPlayers()) {
    try {
      const state = readPlayer(player);
      if (!state) continue;
      const payload = buildPayload(state);
      const last = sent.get(player.id);
      if (last && last.payload === payload && now - last.tick < RESEND_EVERY) continue;
      player.onScreenDisplay.setTitle(payload, { fadeInDuration: 0, stayDuration: TITLE_TICKS, fadeOutDuration: 0 });
      sent.set(player.id, { payload, tick: now });
    } catch {
      // The player left or is changing dimension this tick; try again on the next pass.
    }
  }
}, CHECK_EVERY);

// A fresh spawn gets a fresh HUD, so forget what was sent and let the next pass fill it in.
world.afterEvents.playerSpawn.subscribe((event) => sent.delete(event.player.id));
world.afterEvents.playerLeave.subscribe((event) => sent.delete(event.playerId));
