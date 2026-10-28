import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { loadAppConfig } from './store.js';
import { HttpError } from './util.js';
import { manager } from './servers/manager.js';
import { playit } from './playit.js';
import { authRoutes } from './routes/auth.js';
import { serverRoutes } from './routes/servers.js';
import { miscRoutes } from './routes/misc.js';
import { contentRoutes } from './routes/content.js';
import { wsRoutes } from './ws.js';

async function main() {
  await loadAppConfig();
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL || 'info' }, bodyLimit: 10 * 1024 * 1024, trustProxy: true });

  await app.register(cookie);
  // preservePath keeps "folder/sub/file" names for folder uploads (world imports); other routes basename() what they need.
  await app.register(multipart, { limits: { fileSize: 4 * 1024 * 1024 * 1024, files: 50_000 }, preservePath: true } as any);
  await app.register(websocket, { options: { maxPayload: 1024 * 1024 } });

  app.setErrorHandler((err: any, _req, reply) => {
    if (err instanceof HttpError) return reply.code(err.status).send({ error: err.message });
    const anyErr = err as any;
    if (anyErr.validation || anyErr.statusCode === 400) return reply.code(400).send({ error: err.message });
    if (anyErr.statusCode === 413) return reply.code(413).send({ error: 'Upload too large' });
    app.log.error(err);
    reply.code(500).send({ error: err.message || 'Internal error' });
  });

  await app.register(authRoutes);
  await app.register(serverRoutes);
  await app.register(miscRoutes);
  await app.register(contentRoutes);
  await app.register(wsRoutes);

  if (fs.existsSync(path.join(config.webDist, 'index.html'))) {
    await app.register(fastifyStatic, { root: config.webDist, prefix: '/', wildcard: false });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/')) return reply.code(404).send({ error: 'Not found' });
      return reply.type('text/html').send(fs.createReadStream(path.join(config.webDist, 'index.html')));
    });
  } else {
    app.log.warn(`Web UI build not found at ${config.webDist}; API only (run the Vite dev server for the UI)`);
  }

  await manager.init();
  await playit.init();

  await app.listen({ port: config.port, host: config.host, listenTextResolver: (addr) => `listening on ${addr}` });
  app.log.info(`Blockhost ready on http://${config.host}:${config.port} (data: ${config.dataDir})`);

  let shuttingDown = false;
  const shutdown = async (sig: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info(`${sig} received; stopping servers gracefully`);
    const force = setTimeout(() => process.exit(1), config.stopTimeoutMs + 30_000);
    try {
      await manager.shutdown();
      await playit.stop();
      await app.close();
    } finally {
      clearTimeout(force);
      process.exit(0);
    }
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
