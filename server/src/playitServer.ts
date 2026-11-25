/** Which ports a server exposes to playit, and which tunnels belong to it (matched by local port and protocol). */
import type { PlayitStatus, PlayitTunnel } from './playit.js';
import { HttpError } from './util.js';
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
type Proto = 'tcp' | 'udp';

const matches = (t: PlayitTunnel, port: number, protocol: Proto) =>
  t.localPort === port && (protocol === 'udp' ? t.portType !== 'tcp' : t.portType !== 'udp');

const findTunnel = (tunnels: PlayitTunnel[], port: number, protocol: Proto) => tunnels.find((t) => matches(t, port, protocol)) ?? null;

const gameProto = (rec: Rec): Proto => (rec.edition === 'bedrock' ? 'udp' : 'tcp');

/** Every port a server could claim, including a Geyser port left on the record while cross-play is off. */
const claimed = (rec: Rec): { port: number; protocol: Proto }[] => [
  { port: rec.port, protocol: gameProto(rec) },
  ...(rec.edition === 'java' && rec.geyserPort ? [{ port: rec.geyserPort, protocol: 'udp' as const }] : []),
];

/** Ports other servers are actively using (game ports, and Geyser ports while cross-play is on). */
const inUseByOthers = (others: Rec[], port: number, protocol: Proto) =>
  others.some((o) => (o.port === port && gameProto(o) === protocol) || (o.edition === 'java' && o.geyser && o.geyserPort === port && protocol === 'udp'));

/**
 * The rows for this server's card. `others` are the remaining servers: a Geyser port this server no longer uses
 * may have been given to one of them, and then that tunnel is theirs, not a leftover of ours.
 */
export function serverPorts(rec: Rec, tunnels: PlayitTunnel[], others: Rec[] = []): ServerPort[] {
  const ports: ServerPort[] = [{ kind: 'game', port: rec.port, protocol: gameProto(rec), inUse: true, tunnel: findTunnel(tunnels, rec.port, gameProto(rec)) }];
  if (rec.edition === 'java' && rec.geyserPort) {
    const tunnel = findTunnel(tunnels, rec.geyserPort, 'udp');
    const leftover = !rec.geyser && tunnel && !inUseByOthers(others, rec.geyserPort, 'udp');
    if (rec.geyser || leftover) ports.push({ kind: 'geyser', port: rec.geyserPort, protocol: 'udp', inUse: rec.geyser, tunnel });
  }
  return ports;
}

/** Tunnels to remove with this server: its own, minus any port another server shares or now uses. */
export function tunnelsOfServer(rec: Rec, tunnels: PlayitTunnel[], others: Rec[] = []): PlayitTunnel[] {
  const mine = claimed(rec).filter((p) => !others.some((o) => claimed(o).some((c) => c.port === p.port && c.protocol === p.protocol)));
  return tunnels.filter((t) => mine.some((p) => matches(t, p.port, p.protocol)));
}

/** Before creating a tunnel: refuse a kind this server doesn't expose, an unreadable tunnel list (a duplicate can't be ruled out), or a port that already has one. */
export function createGuard(ports: ServerPort[], kind: PortKind, tunnelsError: string | null): void {
  const p = ports.find((x) => x.kind === kind && x.inUse);
  if (!p) throw new HttpError(400, 'This server has no cross-play port to tunnel; turn cross-play on first');
  if (tunnelsError) throw new HttpError(503, `Could not check this server's existing tunnels: ${tunnelsError}`);
  if (p.tunnel) throw new HttpError(409, `This server already has a tunnel for port ${p.port}`);
}

/** GET /api/servers/:id/tunnels. Tunnels only show while the agent runs: cached ones would look live when they aren't. */
export function tunnelView(rec: Rec, st: Pick<PlayitStatus, 'state' | 'enabled' | 'claimUrl' | 'error' | 'tunnels' | 'tunnelsError'>, others: Rec[]) {
  const running = st.state === 'running';
  return {
    agent: { state: st.state, enabled: st.enabled, claimUrl: st.claimUrl, error: st.error },
    tunnelsError: running ? st.tunnelsError : null,
    ports: serverPorts(rec, running ? st.tunnels : [], others),
  };
}
