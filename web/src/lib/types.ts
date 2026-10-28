export type Edition = 'java' | 'bedrock';
export type JavaType = 'VANILLA' | 'PAPER' | 'PURPUR' | 'FABRIC' | 'FORGE' | 'NEOFORGE';
export type ServerType = JavaType | 'BEDROCK';
export type ServerState = 'stopped' | 'installing' | 'starting' | 'running' | 'stopping' | 'crashed' | 'error';
export type JvmPreset = 'aikar' | 'zgc' | 'none';
export type BackupSchedule = 'off' | 'hourly' | '6h' | 'daily';
export type BackupScope = 'world' | 'full';

export const JAVA_TYPES: JavaType[] = ['VANILLA', 'PAPER', 'PURPUR', 'FABRIC', 'FORGE', 'NEOFORGE'];
export const TYPE_LABEL: Record<ServerType, string> = {
  VANILLA: 'Vanilla',
  PAPER: 'Paper',
  PURPUR: 'Purpur',
  FABRIC: 'Fabric',
  FORGE: 'Forge',
  NEOFORGE: 'NeoForge',
  BEDROCK: 'Bedrock',
};
export const TYPE_BLURB: Record<ServerType, string> = {
  VANILLA: 'Official Mojang server. No plugins or mods.',
  PAPER: 'High-performance fork with plugin support. Best default.',
  PURPUR: 'Paper fork with extra gameplay toggles.',
  FABRIC: 'Lightweight mod loader for modern versions.',
  FORGE: 'Classic mod loader with the largest mod library.',
  NEOFORGE: 'Modern Forge successor for 1.20.2+.',
  BEDROCK: 'Official Bedrock Dedicated Server for phones, consoles and Windows 10/11.',
};

export interface JavaSettings {
  major: number | 'auto';
  xmxMb: number;
  xmsMb: number;
  preset: JvmPreset;
  extraArgs: string;
}

export interface StatsSample {
  t: number;
  cpu: number;
  memMb: number;
  players: number;
  latencyMs: number | null;
}

export interface OnlinePlayer {
  name: string;
  id?: string;
  ip?: string;
  joinedAt: string;
}

export interface PingResult {
  ok: boolean;
  motd?: string;
  version?: string;
  online?: number;
  max?: number;
  latencyMs?: number;
  players?: string[];
  levelName?: string;
}

export interface ServerSummary {
  id: string;
  name: string;
  edition: Edition;
  type: ServerType;
  version: string;
  build?: { loaderVersion?: string; installedAt?: string; launch?: { kind: string } };
  port: number;
  portV6?: number;
  transport?: 'raknet' | 'nethernet';
  advertiseIp?: string;
  levelName: string;
  java?: JavaSettings;
  autoStart: boolean;
  restartOnCrash: boolean;
  geyser: boolean;
  geyserPort?: number;
  backup: { schedule: BackupSchedule; keep: number; scope: BackupScope };
  installed: boolean;
  createdAt: string;
  updatedAt: string;
  state: ServerState;
  pid: number | null;
  startedAt: string | null;
  players: OnlinePlayer[];
  ping: PingResult | null;
  lastExit: { code: number | null; signal: string | null; at: string; oom: boolean } | null;
  diskBytes: number;
  lastStats: StatsSample | null;
  install: { pct: number | null; message: string } | null;
  address: { remote: string[] };
}

export interface SystemInfo {
  version: string;
  arch: string;
  platform: string;
  inDocker: boolean;
  dataDir: string;
  ports: { java: [number, number]; bedrock: [number, number] };
  network?: { advertiseIp: string | null; hostNetwork: boolean };
  cpu: { cores: number; load1: number };
  memory: { totalMb: number; freeMb: number; limitMb: number | null; allocatedXmxMb: number };
  javaRuntimes: { major: number; path: string; source: string; version?: string }[];
  bedrock: { supported: boolean; emulated: boolean; reason?: string };
  uptimeSec: number;
}

export interface BackupMeta {
  id: string;
  label: string;
  scope: BackupScope;
  createdAt: string;
  bytes: number;
  edition: Edition;
  type: ServerType;
  version: string;
  levelName: string;
  auto: boolean;
  hot: boolean;
  consistent: boolean;
  note?: string;
}

export interface PlayitTunnel {
  id: string;
  name: string;
  tunnelType: string | null;
  portType: string;
  localPort: number | null;
  localIp: string | null;
  address: string | null;
  active: boolean;
  disabledReason?: string | null;
}
export interface PlayitStatus {
  state: 'disabled' | 'installing' | 'starting' | 'claiming' | 'running' | 'stopped' | 'error';
  enabled: boolean;
  claimed: boolean;
  claimUrl: string | null;
  binary: string | null;
  error: string | null;
  tunnels: PlayitTunnel[];
  tunnelsError: string | null;
  log: string[];
  startedAt: string | null;
}

export type WsEvent =
  | { type: 'hello'; servers: ServerSummary[]; playit: PlayitStatus }
  | { type: 'server.state'; id: string; state: ServerState; detail?: string }
  | { type: 'server.log'; id: string; line: string }
  | { type: 'server.backlog'; id: string; lines: string[] }
  | { type: 'server.progress'; id: string; pct: number | null; message: string; done?: boolean; error?: string }
  | { type: 'server.stats'; id: string; sample: StatsSample }
  | { type: 'server.players'; id: string; players: OnlinePlayer[] }
  | { type: 'server.changed'; id?: string }
  | { type: 'playit'; status: PlayitStatus }
  | { type: 'backup.changed'; id: string }
  | { type: 'pong' };
