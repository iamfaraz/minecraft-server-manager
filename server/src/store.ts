import path from 'node:path';
import fsp from 'node:fs/promises';
import crypto from 'node:crypto';
import { config } from './config.js';
import { readJson, writeJson } from './util.js';

export interface AppConfig {
  secret: string;
  admin?: { username: string; passwordHash: string };
  playit: { enabled: boolean };
  createdAt: string;
}

let appConfig: AppConfig | null = null;

export async function loadAppConfig(): Promise<AppConfig> {
  if (appConfig) return appConfig;
  const fallback: AppConfig = {
    secret: crypto.randomBytes(32).toString('hex'),
    playit: { enabled: false },
    createdAt: new Date().toISOString(),
  };
  appConfig = await readJson<AppConfig>(config.configFile, fallback);
  if (!appConfig.secret) appConfig.secret = fallback.secret;
  if (!appConfig.playit) appConfig.playit = { enabled: false };
  await writeJson(config.configFile, appConfig);
  return appConfig;
}

export function getAppConfig(): AppConfig {
  if (!appConfig) throw new Error('config not loaded');
  return appConfig;
}

export async function saveAppConfig(): Promise<void> {
  await writeJson(config.configFile, getAppConfig());
}

export const serverDir = (id: string) => path.join(config.serversDir, id);
export const serverRoot = (id: string) => path.join(config.serversDir, id, 'root');
export const serverBackupsDir = (id: string) => path.join(config.serversDir, id, 'backups');
export const serverRecordFile = (id: string) => path.join(config.serversDir, id, 'server.json');

export async function listServerIds(): Promise<string[]> {
  try {
    const entries = await fsp.readdir(config.serversDir, { withFileTypes: true });
    const ids: string[] = [];
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      try {
        await fsp.access(serverRecordFile(e.name));
        ids.push(e.name);
      } catch {
        /* skip */
      }
    }
    return ids;
  } catch {
    return [];
  }
}
