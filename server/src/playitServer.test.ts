import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGuard, serverPorts, tunnelsOfServer, tunnelView } from './playitServer.js';
import type { PlayitTunnel } from './playit.js';

const tun = (id: string, localPort: number, portType: string): PlayitTunnel => ({
  id,
  name: id,
  tunnelType: null,
  portType,
  localPort,
  localIp: '127.0.0.1',
  address: `${id}.example:1`,
  active: true,
});

const java = { edition: 'java' as const, port: 25565, geyser: false, geyserPort: undefined };

test('java server without geyser has one tcp game port', () => {
  assert.deepEqual(serverPorts(java, []), [{ kind: 'game', port: 25565, protocol: 'tcp', inUse: true, tunnel: null }]);
});

test("bedrock server's game port is udp", () => {
  const ports = serverPorts({ edition: 'bedrock', port: 19132, geyser: false }, []);
  assert.deepEqual(ports, [{ kind: 'game', port: 19132, protocol: 'udp', inUse: true, tunnel: null }]);
});

test('geyser on adds a udp geyser port', () => {
  const ports = serverPorts({ ...java, geyser: true, geyserPort: 19133 }, []);
  assert.deepEqual(ports.map((p) => [p.kind, p.port, p.protocol, p.inUse]), [
    ['game', 25565, 'tcp', true],
    ['geyser', 19133, 'udp', true],
  ]);
});

test('geyser tunnel left after cross-play is off stays listed and not in use', () => {
  const t = tun('g', 19132, 'udp');
  const ports = serverPorts({ ...java, geyser: false, geyserPort: 19132 }, [t]);
  assert.equal(ports.length, 2);
  assert.deepEqual(ports[1], { kind: 'geyser', port: 19132, protocol: 'udp', inUse: false, tunnel: t });
});

test('geyser port without a tunnel is hidden while cross-play is off', () => {
  assert.equal(serverPorts({ ...java, geyser: false, geyserPort: 19132 }, []).length, 1);
});

test('matches tunnels by port and protocol', () => {
  const udp = tun('u', 25565, 'udp');
  const tcp = tun('t', 25565, 'tcp');
  assert.equal(serverPorts(java, [udp])[0].tunnel, null);
  assert.equal(serverPorts(java, [udp, tcp])[0].tunnel, tcp);
});

test('tunnelsOfServer returns game and geyser tunnels only', () => {
  const game = tun('a', 25565, 'tcp');
  const gey = tun('b', 19133, 'udp');
  const other = tun('c', 25566, 'tcp');
  const got = tunnelsOfServer({ ...java, geyser: true, geyserPort: 19133 }, [game, gey, other]);
  assert.deepEqual(got.map((t) => t.id).sort(), ['a', 'b']);
});

test('createGuard refuses when tunnels could not be read', () => {
  assert.throws(() => createGuard(serverPorts(java, []), 'game', 'playit API: down'), /could not check/i);
});

test('createGuard refuses a duplicate and allows a free port', () => {
  assert.throws(() => createGuard(serverPorts(java, [tun('t', 25565, 'tcp')]), 'game', null), /already has a tunnel for port 25565/);
  assert.doesNotThrow(() => createGuard(serverPorts(java, []), 'game', null));
});

const bedrockB = { edition: 'bedrock' as const, port: 19132, geyser: false };

test("a leftover geyser port now used by another server is not shown as this server's", () => {
  const t = tun('b', 19132, 'udp');
  const ports = serverPorts({ ...java, geyser: false, geyserPort: 19132 }, [t], [bedrockB]);
  assert.equal(ports.length, 1);
});

test("deleting a server leaves tunnels another server still uses", () => {
  const shared = tun('s', 25565, 'tcp');
  const gey = tun('b', 19132, 'udp');
  const got = tunnelsOfServer({ ...java, geyser: false, geyserPort: 19132 }, [shared, gey], [java, bedrockB]);
  assert.deepEqual(got, []);
});

test('createGuard refuses a kind this server does not expose', () => {
  assert.throws(() => createGuard(serverPorts(java, []), 'geyser', null), /no cross-play port/i);
});

test('tunnelView hides tunnels while the agent is not running', () => {
  const v = tunnelView(java, { state: 'stopped', enabled: true, claimUrl: null, error: null, tunnels: [tun('t', 25565, 'tcp')], tunnelsError: null }, []);
  assert.equal(v.ports[0].tunnel, null);
  assert.equal(v.agent.state, 'stopped');
});

test('tunnelView shows tunnels while running', () => {
  const t = tun('t', 25565, 'tcp');
  const v = tunnelView(java, { state: 'running', enabled: true, claimUrl: null, error: null, tunnels: [t], tunnelsError: null }, []);
  assert.equal(v.ports[0].tunnel, t);
});
