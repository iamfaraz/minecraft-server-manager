export type Edition = 'java' | 'bedrock';
export type JavaType = 'VANILLA' | 'PAPER' | 'PURPUR' | 'FABRIC' | 'FORGE' | 'NEOFORGE';
export type ServerType = JavaType | 'BEDROCK';
export type ServerState = 'stopped' | 'installing' | 'starting' | 'running' | 'stopping' | 'crashed' | 'error';
export type JvmPreset = 'aikar' | 'zgc' | 'none';
export type BackupSchedule = 'off' | 'hourly' | '6h' | 'daily';
export type BackupScope = 'world' | 'full';
export type BedrockTransport = 'raknet' | 'nethernet';

export const JAVA_TYPES: JavaType[] = ['VANILLA', 'PAPER', 'PURPUR', 'FABRIC', 'FORGE', 'NEOFORGE'];
export const PLUGIN_TYPES: ServerType[] = ['PAPER', 'PURPUR'];
export const MOD_TYPES: ServerType[] = ['FABRIC', 'FORGE', 'NEOFORGE'];

export type LaunchSpec =
  | { kind: 'jar'; jar: string }
  | { kind: 'argsfile'; file: string }
  | { kind: 'bedrock' };

export interface JavaSettings {
  /** Java major version; 'auto' picks based on the Minecraft version. */
  major: number | 'auto';
  xmxMb: number;
  xmsMb: number;
  preset: JvmPreset;
  extraArgs: string;
}

export interface ServerRecord {
  id: string;
  name: string;
  edition: Edition;
  type: ServerType;
  /** Minecraft version, e.g. 1.21.4 (Java) or 1.21.100.7 (Bedrock). */
  version: string;
  /** Resolved build info from the last install. */
  build?: {
    loaderVersion?: string;
    installerVersion?: string;
    downloadUrl?: string;
    launch?: LaunchSpec;
    installedAt?: string;
  };
  port: number;
  /** Bedrock IPv6 port (RakNet only). */
  portV6?: number;
  /** Bedrock network transport. RakNet is the classic UDP protocol; NetherNet is Mojang's WebRTC transport (BDS default since 2025). */
  transport?: BedrockTransport;
  levelName: string;
  java?: JavaSettings;
  autoStart: boolean;
  restartOnCrash: boolean;
  geyser: boolean;
  geyserPort?: number;
  backup: { schedule: BackupSchedule; keep: number; scope: BackupScope };
  installed: boolean;
  lastRunning: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface OnlinePlayer {
  name: string;
  id?: string; // uuid or xuid
  ip?: string;
  joinedAt: string;
}

export interface StatsSample {
  t: number;
  cpu: number; // percent of one core
  memMb: number; // RSS
  players: number;
  latencyMs: number | null;
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

export interface ServerSummary extends ServerRecord {
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

export interface CreateServerInput {
  name: string;
  edition: Edition;
  type: ServerType;
  version: string;
  port?: number;
  levelName?: string;
  java?: Partial<JavaSettings>;
  properties?: Record<string, string>;
  geyser?: boolean;
  transport?: BedrockTransport;
  autoStart?: boolean;
  restartOnCrash?: boolean;
  importWorld?: { sourceServerId: string; backupId?: string };
  startAfterInstall?: boolean;
}
