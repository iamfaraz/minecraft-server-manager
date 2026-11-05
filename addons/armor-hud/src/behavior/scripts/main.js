// Blockhost Armor HUD: shows each player their held items, armour durability, arrows and free inventory slots
// around the hotbar. This script reads the data on the server and sends it to the player's HUD as a hidden title;
// the companion resource pack draws it.
import { EquipmentSlot, system, world } from '@minecraft/server';
import { buildPayload } from './hud.js';

/** How often each player is checked, in game ticks (20 per second). */
const CHECK_EVERY = 2;
/**
 * Unchanged data is sent again after these delays (ticks since the previous send), then at the last one forever.
 * A title that arrives in the same instant as another one can be missed by the HUD, and a HUD that is still loading
 * misses everything, so: several early repeats after a spawn, one after an ordinary change, then a slow heartbeat.
 * Repeats are kept sparse because every send replaces whatever ordinary title is on screen.
 */
const RESEND_AFTER_SPAWN = [40, 60, 100, 600];
const RESEND_AFTER_CHANGE = [60, 600];
/** How long the hidden title stays up. */
const TITLE_TICKS = 5;

/** player id -> { payload, tick, repeats, delays }: what was last sent, when, how often unchanged, on which schedule */
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
      const payload = buildPayload(state);
      const last = sent.get(player.id);
      if (last && last.payload === payload) {
        if (now - last.tick < last.delays[Math.min(last.repeats, last.delays.length - 1)]) continue;
        last.tick = now;
        last.repeats++;
      } else {
        sent.set(player.id, { payload, tick: now, repeats: 0, delays: last ? RESEND_AFTER_CHANGE : RESEND_AFTER_SPAWN });
      }
      player.onScreenDisplay.setTitle(payload, { fadeInDuration: 0, stayDuration: TITLE_TICKS, fadeOutDuration: 0 });
    } catch {
      // The player left or is changing dimension this tick; try again on the next pass.
    }
  }
}, CHECK_EVERY);

// A fresh spawn or a new dimension can mean a fresh HUD, so start the send schedule over.
world.afterEvents.playerSpawn.subscribe((event) => sent.delete(event.player.id));
world.afterEvents.playerDimensionChange.subscribe((event) => sent.delete(event.player.id));
world.afterEvents.playerLeave.subscribe((event) => sent.delete(event.playerId));
