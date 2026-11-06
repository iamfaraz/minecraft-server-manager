/**
 * Which network ports a server uses. One place for the rules, shared by the start-time checks, the allocator and
 * the port manager page.
 */
import type { ServerRecord } from './types.js';

export type PortProto = 'tcp' | 'udp';
/** Which setting a port comes from: the server's own port, or its Geyser (cross-play) port. */
export type PortSlot = 'port' | 'geyserPort';

export interface PortNeed {
  port: number;
  proto: PortProto;
  /** What the port is for, in words. */
  role: string;
  slot: PortSlot;
}

/** The ports a server binds while it runs. */
export function portNeeds(rec: ServerRecord): PortNeed[] {
  if (rec.edition === 'java') {
    const needs: PortNeed[] = [{ port: rec.port, proto: 'tcp', role: 'Java players', slot: 'port' }];
    if (rec.geyser && rec.geyserPort) {
      needs.push(
        { port: rec.geyserPort, proto: 'udp', role: 'Bedrock players (Geyser)', slot: 'geyserPort' },
        { port: rec.geyserPort, proto: 'tcp', role: 'Geyser NetherNet signaling', slot: 'geyserPort' },
        { port: rec.geyserPort + 1, proto: 'udp', role: 'Geyser NetherNet data', slot: 'geyserPort' },
      );
    }
    return needs;
  }
  if (rec.transport === 'nethernet') {
    return [
      { port: rec.port, proto: 'udp', role: 'Bedrock players', slot: 'port' },
      { port: rec.port, proto: 'tcp', role: 'NetherNet signaling', slot: 'port' },
    ];
  }
  return [
    { port: rec.port, proto: 'udp', role: 'Bedrock players', slot: 'port' },
    { port: rec.portV6 ?? rec.port + 1, proto: 'udp', role: 'Bedrock players (IPv6)', slot: 'port' },
  ];
}

/**
 * The port numbers a server holds, in use or not. Bedrock and Geyser always hold two consecutive numbers, so a
 * server can change transport without its second port having been given away.
 */
export function heldPorts(rec: ServerRecord): { port: number; slot: PortSlot }[] {
  const held: { port: number; slot: PortSlot }[] = [{ port: rec.port, slot: 'port' }];
  if (rec.edition === 'bedrock') held.push({ port: rec.portV6 ?? rec.port + 1, slot: 'port' });
  if (rec.geyser && rec.geyserPort) held.push({ port: rec.geyserPort, slot: 'geyserPort' }, { port: rec.geyserPort + 1, slot: 'geyserPort' });
  return held;
}

/** How many consecutive numbers each slot takes. */
export function slotSpan(rec: ServerRecord, slot: PortSlot): number {
  return slot === 'geyserPort' || rec.edition === 'bedrock' ? 2 : 1;
}

export interface PortConflict extends PortNeed {
  /** The Blockhost server that is using the port right now, or null when something outside Blockhost is. */
  holder: { id: string; name: string; state: string } | null;
}
