import type { FastifyInstance } from 'fastify';
import os from 'node:os';
import fsp from 'node:fs/promises';
import { requireAuth } from '../auth.js';
import { config } from '../config.js';
import { manager } from '../servers/manager.js';
import { listJavaVersions, requiredJavaMajor } from '../versions/java.js';
import { bedrockVersions } from '../versions/bedrock.js';
import { bedrockSupport, listJavaRuntimes } from '../versions/runtime.js';
import { JAVA_TYPES, type JavaType } from '../servers/types.js';
import { bad } from '../util.js';
import { playit } from '../playit.js';

async function cgroupMemoryLimit(): Promise<number | null> {
  for (const f of ['/sys/fs/cgroup/memory.max', '/sys/fs/cgroup/memory/memory.limit_in_bytes']) {
    try {
      const raw = (await fsp.readFile(f, 'utf8')).trim();
      if (raw === 'max') return null;
      const n = Number(raw);
      if (Number.isFinite(n) && n > 0 && n < 2 ** 60) return Math.round(n / 1024 / 1024);
    } catch {
      /* next */
    }
  }
  return null;
}

export async function miscRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);

  app.get('/api/system', async () => {
    const [runtimes, bedrock, limitMb] = await Promise.all([listJavaRuntimes(), bedrockSupport(), cgroupMemoryLimit()]);
    const load = os.loadavg();
    return {
      version: config.version,
      arch: config.arch,
      platform: config.platform,
      inDocker: config.inDocker,
      dataDir: config.dataDir,
      ports: { java: config.javaPorts, bedrock: config.bedrockPorts },
      cpu: { cores: os.cpus().length, load1: load[0] },
      memory: { totalMb: Math.round(os.totalmem() / 1024 / 1024), freeMb: Math.round(os.freemem() / 1024 / 1024), limitMb, allocatedXmxMb: manager.totalXmxMb() },
      javaRuntimes: runtimes,
      bedrock,
      uptimeSec: Math.round(process.uptime()),
    };
  });

  app.get<{ Querystring: { type?: string } }>('/api/versions/java', async (req) => {
    const type = String(req.query.type || 'PAPER').toUpperCase() as JavaType;
    if (!JAVA_TYPES.includes(type)) throw bad('Unknown type');
    return listJavaVersions(type);
  });

  app.get<{ Querystring: { version?: string } }>('/api/versions/java-runtime', async (req) => {
    const v = String(req.query.version || '').trim();
    if (!v) throw bad('version is required');
    return { version: v, major: await requiredJavaMajor(v) };
  });

  app.get('/api/versions/bedrock', async () => bedrockVersions());

  app.get('/api/playit', async () => {
    if (playit.status().state === 'running') await playit.refreshTunnels();
    return playit.status();
  });
  app.post('/api/playit/enable', async () => {
    await playit.enable();
    return playit.status();
  });
  app.post('/api/playit/disable', async () => {
    await playit.disable();
    return playit.status();
  });
  app.post('/api/playit/reset', async () => {
    await playit.reset();
    return playit.status();
  });
  app.post('/api/playit/refresh', async () => {
    await playit.refreshTunnels(true);
    return playit.status();
  });
  app.delete<{ Params: { id: string } }>('/api/playit/tunnels/:id', async (req) => {
    await playit.deleteTunnel(req.params.id);
    return playit.status();
  });
}
