/** Which ports a server exposes to playit, and which tunnels belong to it (matched by local port and protocol). */
import type { PlayitTunnel } from './playit.js';
import type { ServerRecord } from './servers/types.js';

export type PortKind = 'game' | 'geyser';

export interface ServerPort {
  kind: PortKind;
  port: number;
  protocol: 'tcp' | 'udp';
  /** False for a Geyser port while cross-play is off (its tunnel is kept but unused). */
  inUse: boolean;
  tunnel: PlayitTunnel | null;
}

type Rec = Pick<ServerRecord, 'edition' | 'port' | 'geyser' | 'geyserPort'>;

const matches = (t: PlayitTunnel, port: number, protocol: 'tcp' | 'udp') =>
  t.localPort === port && (protocol === 'udp' ? t.portType !== 'tcp' : t.portType !== 'udp');

const findTunnel = (tunnels: PlayitTunnel[], port: number, protocol: 'tcp' | 'udp') => tunnels.find((t) => matches(t, port, protocol)) ?? null;

export function serverPorts(rec: Rec, tunnels: PlayitTunnel[]): ServerPort[] {
  const gameProto = rec.edition === 'bedrock' ? 'udp' : 'tcp';
  const ports: ServerPort[] = [{ kind: 'game', port: rec.port, protocol: gameProto, inUse: true, tunnel: findTunnel(tunnels, rec.port, gameProto) }];
  if (rec.edition === 'java' && rec.geyserPort) {
    const tunnel = findTunnel(tunnels, rec.geyserPort, 'udp');
    if (rec.geyser || tunnel) ports.push({ kind: 'geyser', port: rec.geyserPort, protocol: 'udp', inUse: rec.geyser, tunnel });
  }
  return ports;
}

export function tunnelsOfServer(rec: Rec, tunnels: PlayitTunnel[]): PlayitTunnel[] {
  const ports = serverPorts(rec, []);
  return tunnels.filter((t) => ports.some((p) => matches(t, p.port, p.protocol)));
}
