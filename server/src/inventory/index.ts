/** Player inventories and experience, for both editions. See java.ts and bedrock.ts for how each one is reached. */
import { HttpError } from '../util.js';
import type { ServerInstance } from '../servers/instance.js';
import * as bedrock from './bedrock.js';
import * as java from './java.js';
import { emptyInventory, validateOp, type PlayerInventory } from './model.js';

export { init } from './bedrock.js';

const checkName = (player: string): string => {
  const name = String(player || '').trim();
  // Java names, Bedrock gamertags (which may contain spaces) and Floodgate's leading dot; nothing that could alter a command.
  if (!/^[A-Za-z0-9_. -]{1,32}$/.test(name)) throw new HttpError(400, 'That does not look like a player name');
  return name;
};

export async function inventoryStatus(inst: ServerInstance) {
  if (inst.rec.edition === 'java') return { edition: 'java' as const, bridge: null };
  return { edition: 'bedrock' as const, bridge: await bedrock.bridgeStatus(inst) };
}

export async function installBridge(inst: ServerInstance) {
  if (inst.rec.edition !== 'bedrock') throw new HttpError(400, 'Only Bedrock servers need the inventory bridge');
  await bedrock.installBridge(inst);
  return inventoryStatus(inst);
}

export function getInventory(inst: ServerInstance, player: string): Promise<PlayerInventory> {
  const name = checkName(player);
  return inst.rec.edition === 'java' ? java.getInventory(inst, name) : bedrock.getInventory(inst, name);
}

export async function applyInventoryOp(inst: ServerInstance, player: string, raw: unknown): Promise<PlayerInventory> {
  const name = checkName(player);
  let op;
  try {
    op = validateOp(raw);
  } catch (e) {
    throw new HttpError(400, (e as Error).message);
  }
  try {
    return await (inst.rec.edition === 'java' ? java.applyInventoryOp(inst, name, op) : bedrock.applyInventoryOp(inst, name, op));
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(400, (e as Error).message);
  }
}

export async function clearPending(inst: ServerInstance, player: string): Promise<PlayerInventory> {
  const name = checkName(player);
  if (inst.rec.edition !== 'bedrock') throw new HttpError(400, 'Only Bedrock servers queue changes');
  await bedrock.clearQueue(inst, name);
  try {
    return await bedrock.getInventory(inst, name);
  } catch {
    // Nothing was on record besides the queue we just dropped.
    return { player: name, online: false, source: 'snapshot', at: new Date().toISOString(), ...emptyInventory(), pending: 0 };
  }
}
