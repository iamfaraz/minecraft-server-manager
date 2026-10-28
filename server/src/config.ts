import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const inDocker = fs.existsSync('/.dockerenv') || !!process.env.MCSM_IN_DOCKER;

function parseRange(s: string, fallback: [number, number]): [number, number] {
  const m = /^(\d+)\s*-\s*(\d+)$/.exec(s.trim());
  if (!m) return fallback;
  const a = +m[1], b = +m[2];
  return a <= b ? [a, b] : [b, a];
}

const dataDir = path.resolve(
  process.env.MCSM_DATA_DIR || (inDocker ? '/data' : path.resolve(here, '..', '..', 'data')),
);

export const config = {
  port: Number(process.env.MCSM_PORT || 8080),
  host: process.env.MCSM_HOST || '0.0.0.0',
  dataDir,
  serversDir: path.join(dataDir, 'servers'),
  runtimesDir: path.join(dataDir, 'runtimes'),
  cacheDir: path.join(dataDir, 'cache'),
  playitDir: path.join(dataDir, 'playit'),
  configFile: path.join(dataDir, 'config.json'),
  inDocker,
  javaPorts: parseRange(process.env.MCSM_JAVA_PORTS || '25565-25574', [25565, 25574]),
  bedrockPorts: parseRange(process.env.MCSM_BEDROCK_PORTS || '19132-19141', [19132, 19141]),
  /** LAN/public IP that NetherNet (WebRTC) Bedrock servers advertise to clients; needed when the container is NAT'd (bridge network). */
  advertiseIp: (process.env.MCSM_ADVERTISE_IP || '').trim(),
  hostNetwork: !!process.env.MCSM_HOST_NETWORK,
  playitBin: process.env.MCSM_PLAYIT_BIN || '',
  playitArgs: process.env.MCSM_PLAYIT_ARGS || '',
  /** Where the built web UI lives (served in production). */
  webDist: process.env.MCSM_WEB_DIST || path.resolve(here, '..', '..', 'web', 'dist'),
  arch: os.arch(), // 'x64' | 'arm64'
  platform: os.platform(), // 'linux' | 'darwin'
  version: process.env.MCSM_VERSION || '0.1.0',
  stopTimeoutMs: Number(process.env.MCSM_STOP_TIMEOUT_MS || 60_000),
};

for (const d of [config.dataDir, config.serversDir, config.runtimesDir, config.cacheDir, config.playitDir]) {
  fs.mkdirSync(d, { recursive: true });
}
