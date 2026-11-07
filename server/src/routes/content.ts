import { deleteAllBackups } from '../storage.js';
import { checkUpdates } from '../updates.js';
import * as assets from '../inventory/assets.js';
import * as inventory from '../inventory/index.js';
import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../auth.js';
import { manager } from '../servers/manager.js';
import { bad, fmtBytes } from '../util.js';
import { backupFile, createBackup, deleteBackup, listBackups, restoreBackup } from '../backups.js';
import { getPlayers, playerAction, type PlayerAction } from '../players.js';
import * as addons from '../addons.js';
import * as mods from '../modupdates.js';
import * as world from '../world.js';
import * as files from '../files.js';
import fs from 'node:fs';
import type { BackupScope } from '../servers/types.js';

async function readUpload(req: any): Promise<{ filename: string; data: Buffer; fields: Record<string, string> }> {
  const parts = req.parts();
  let file: { filename: string; data: Buffer } | null = null;
  const fields: Record<string, string> = {};
  for await (const part of parts) {
    if (part.type === 'file') {
      if (file) {
        await part.toBuffer();
        continue;
      }
      file = { filename: part.filename, data: await part.toBuffer() };
    } else fields[part.fieldname] = String(part.value);
  }
  if (!file) throw bad('No file uploaded');
  return { ...file, fields };
}

export async function contentRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);

  /* ---------------- Players ---------------- */
  app.get<{ Params: { id: string } }>('/api/servers/:id/players', async (req) => getPlayers(manager.get(req.params.id)));
  app.post<{ Params: { id: string }; Body: { action: PlayerAction; name: string; reason?: string; level?: string } }>('/api/servers/:id/players/action', async (req) =>
    playerAction(manager.get(req.params.id), req.body?.action, req.body?.name, req.body?.reason, req.body?.level),
  );

  /* ---------------- Live world controls ---------------- */
  app.get<{ Params: { id: string }; Querystring: { refresh?: string } }>('/api/servers/:id/world', async (req) => world.getWorld(manager.get(req.params.id), req.query.refresh === '1'));
  app.post<{ Params: { id: string }; Body: world.WorldAction }>('/api/servers/:id/world', async (req) => world.applyWorld(manager.get(req.params.id), req.body));

  /* ---------------- Backups ---------------- */
  app.get<{ Params: { id: string } }>('/api/servers/:id/backups', async (req) => {
    manager.get(req.params.id);
    return { backups: await listBackups(req.params.id) };
  });
  app.post<{ Params: { id: string }; Body: { label?: string; scope?: BackupScope } }>('/api/servers/:id/backups', async (req) => {
    const inst = manager.get(req.params.id);
    const meta = await createBackup(inst, { label: req.body?.label, scope: req.body?.scope || 'world' });
    inst.pushLog(`[Blockhost] Backup "${meta.label}" created (${fmtBytes(meta.bytes)})`);
    return meta;
  });
  app.delete<{ Params: { id: string } }>('/api/servers/:id/backups', async (req) => ({ deleted: await deleteAllBackups(req.params.id) }));
  app.post<{ Params: { id: string; bid: string } }>('/api/servers/:id/backups/:bid/restore', async (req) => {
    await restoreBackup(manager.get(req.params.id), req.params.bid);
    return { ok: true };
  });
  app.delete<{ Params: { id: string; bid: string } }>('/api/servers/:id/backups/:bid', async (req) => {
    manager.get(req.params.id);
    await deleteBackup(req.params.id, req.params.bid);
    return { ok: true };
  });
  app.get<{ Params: { id: string; bid: string } }>('/api/servers/:id/backups/:bid/download', async (req, reply) => {
    manager.get(req.params.id);
    if (!/^[a-zA-Z0-9_-]+$/.test(req.params.bid)) throw bad('Invalid backup id');
    const f = backupFile(req.params.id, req.params.bid);
    const st = await fs.promises.stat(f);
    reply.header('Content-Type', 'application/gzip');
    reply.header('Content-Length', st.size);
    reply.header('Content-Disposition', `attachment; filename="${req.params.bid}.tar.gz"`);
    return reply.send(fs.createReadStream(f));
  });

  /* ---------------- Updates ---------------- */
  app.get<{ Params: { id: string } }>('/api/servers/:id/updates', async (req) => checkUpdates(manager.get(req.params.id)));
  app.post<{ Params: { id: string }; Body: { target: 'build' | 'version'; version?: string } }>('/api/servers/:id/updates/apply', async (req) => {
    const inst = manager.get(req.params.id);
    const wasRunning = inst.isActive;
    if (req.body?.target === 'version') {
      if (!req.body.version) throw bad('version is required');
      await manager.changeVersion(inst.id, { version: req.body.version, backupFirst: true });
    } else await manager.changeVersion(inst.id, { version: inst.rec.version, backupFirst: false });
    return { ok: true, wasRunning };
  });

  /* ---------------- Inventories ---------------- */
  app.get('/api/items', async () => ({ items: assets.itemCatalogue() }));
  app.get<{ Params: { id: string } }>('/api/icons/:id', async (req, reply) => {
    const png = await assets.itemIcon(req.params.id.replace(/\.png$/, ''));
    if (!png) return reply.code(404).send({ error: 'No icon' });
    return reply.header('Content-Type', 'image/png').header('Cache-Control', 'private, max-age=604800').send(png);
  });
  app.get<{ Params: { id: string; player: string } }>('/api/servers/:id/players/:player/skin', async (req) => ({ url: await assets.playerSkin(manager.get(req.params.id), req.params.player) }));
  app.get<{ Params: { id: string } }>('/api/servers/:id/inventory', async (req) => inventory.inventoryStatus(manager.get(req.params.id)));
  app.post<{ Params: { id: string } }>('/api/servers/:id/inventory/bridge', async (req) => inventory.installBridge(manager.get(req.params.id)));
  app.get<{ Params: { id: string; player: string } }>('/api/servers/:id/inventory/:player', async (req) => inventory.getInventory(manager.get(req.params.id), req.params.player));
  app.post<{ Params: { id: string; player: string }; Body: unknown }>('/api/servers/:id/inventory/:player', async (req) =>
    inventory.applyInventoryOp(manager.get(req.params.id), req.params.player, req.body),
  );
  app.delete<{ Params: { id: string; player: string } }>('/api/servers/:id/inventory/:player/pending', async (req) => inventory.clearPending(manager.get(req.params.id), req.params.player));

  /* ---------------- Addons ---------------- */
  app.get<{ Params: { id: string } }>('/api/servers/:id/addons', async (req) => {
    const inst = manager.get(req.params.id);
    if (inst.rec.edition === 'bedrock') return { kind: 'packs', packs: await addons.listPacks(inst) };
    const r = await addons.listAddons(inst);
    return { kind: 'jars', ...r };
  });
  app.post<{ Params: { id: string } }>('/api/servers/:id/addons/upload', async (req) => {
    const inst = manager.get(req.params.id);
    const { filename, data } = await readUpload(req);
    if (inst.rec.edition === 'bedrock') return { installed: await addons.installPackArchive(inst, filename, data) };
    await addons.saveAddonUpload(inst, filename, data);
    return { installed: [filename] };
  });
  app.delete<{ Params: { id: string }; Querystring: { file?: string; folder?: string; kind?: 'behavior' | 'resource' } }>('/api/servers/:id/addons', async (req) => {
    const inst = manager.get(req.params.id);
    if (inst.rec.edition === 'bedrock') await addons.removePack(inst, req.query.folder || '', req.query.kind || 'behavior');
    else await addons.deleteAddon(inst, req.query.file || '');
    return { ok: true };
  });
  app.post<{ Params: { id: string }; Body: { file?: string; folder?: string; kind?: 'behavior' | 'resource'; active?: boolean } }>('/api/servers/:id/addons/toggle', async (req) => {
    const inst = manager.get(req.params.id);
    if (inst.rec.edition === 'bedrock') await addons.togglePack(inst, req.body.folder || '', req.body.kind || 'behavior', !!req.body.active);
    else await addons.toggleAddon(inst, req.body.file || '');
    return { ok: true };
  });
  app.get<{ Params: { id: string }; Querystring: { q?: string; offset?: string } }>('/api/servers/:id/addons/search', async (req) =>
    addons.searchModrinth(manager.get(req.params.id), req.query.q || '', Number(req.query.offset || 0)),
  );
  app.post<{ Params: { id: string }; Body: { projectId: string } }>('/api/servers/:id/addons/install', async (req) => {
    const inst = manager.get(req.params.id);
    const installed = await addons.installModrinth(inst, req.body?.projectId, 0, (m) => inst.pushLog(`[Blockhost] ${m}`));
    if (inst.isActive) inst.pushLog('[Blockhost] Restart to load the new ' + (inst.rec.type === 'PAPER' || inst.rec.type === 'PURPUR' ? 'plugins' : 'mods'));
    return { installed };
  });

  /* ---------------- Mod updates & client packs ---------------- */
  app.get<{ Params: { id: string }; Querystring: { refresh?: string } }>('/api/servers/:id/addons/updates', async (req) => mods.checkUpdates(manager.get(req.params.id), req.query.refresh === '1'));
  app.post<{ Params: { id: string }; Body: { files: string[] | 'all' } }>('/api/servers/:id/addons/updates/apply', async (req) => {
    const inst = manager.get(req.params.id);
    return mods.applyUpdates(inst, req.body?.files || 'all', (m) => inst.pushLog(`[Blockhost] ${m}`));
  });
  app.get<{ Params: { id: string } }>('/api/servers/:id/addons/client-packs', async (req) => ({ packs: await mods.listClientPacks(manager.get(req.params.id)) }));
  app.post<{ Params: { id: string }; Body: { files: string[]; includeInstaller?: boolean; serverAddress?: string } }>('/api/servers/:id/addons/client-packs', async (req) => {
    const inst = manager.get(req.params.id);
    return mods.buildClientPack(inst, { files: req.body?.files || [], includeInstaller: req.body?.includeInstaller !== false, serverAddress: req.body?.serverAddress }, (m) => inst.pushLog(`[Blockhost] ${m}`));
  });
  app.delete<{ Params: { id: string; pid: string } }>('/api/servers/:id/addons/client-packs/:pid', async (req) => {
    await mods.deleteClientPack(manager.get(req.params.id), req.params.pid);
    return { ok: true };
  });
  app.get<{ Params: { id: string; pid: string } }>('/api/servers/:id/addons/client-packs/:pid/download', async (req, reply) => {
    const inst = manager.get(req.params.id);
    const f = mods.clientPackFile(inst, req.params.pid);
    const st = await fs.promises.stat(f);
    reply.header('Content-Type', 'application/zip');
    reply.header('Content-Length', st.size);
    reply.header('Content-Disposition', `attachment; filename="${inst.rec.name.replace(/[^a-zA-Z0-9 _-]/g, '')}-client-mods.zip"`);
    return reply.send(fs.createReadStream(f));
  });

  /* ---------------- Files ---------------- */
  app.get<{ Params: { id: string }; Querystring: { path?: string } }>('/api/servers/:id/files', async (req) => files.listDir(manager.get(req.params.id), req.query.path || ''));
  app.get<{ Params: { id: string }; Querystring: { path?: string } }>('/api/servers/:id/files/content', async (req) => files.readFile(manager.get(req.params.id), req.query.path || ''));
  app.put<{ Params: { id: string }; Body: { path: string; content: string } }>('/api/servers/:id/files/content', async (req) => {
    await files.writeFile(manager.get(req.params.id), req.body?.path || '', req.body?.content ?? '');
    return { ok: true };
  });
  app.post<{ Params: { id: string }; Body: { path: string } }>('/api/servers/:id/files/mkdir', async (req) => {
    await files.mkdir(manager.get(req.params.id), req.body?.path || '');
    return { ok: true };
  });
  app.post<{ Params: { id: string }; Body: { path: string } }>('/api/servers/:id/files/delete', async (req) => {
    await files.remove(manager.get(req.params.id), req.body?.path || '');
    return { ok: true };
  });
  app.post<{ Params: { id: string }; Body: { path: string; newPath: string } }>('/api/servers/:id/files/rename', async (req) => {
    await files.rename(manager.get(req.params.id), req.body?.path || '', req.body?.newPath || '');
    return { ok: true };
  });
  app.post<{ Params: { id: string } }>('/api/servers/:id/files/upload', async (req) => {
    const inst = manager.get(req.params.id);
    const { filename, data, fields } = await readUpload(req);
    await files.writeFileBuffer(inst, fields.path || '', filename, data);
    return { ok: true };
  });
  app.get<{ Params: { id: string }; Querystring: { path?: string } }>('/api/servers/:id/files/download', async (req, reply) => {
    const { stream, name, size } = await files.openForDownload(manager.get(req.params.id), req.query.path || '');
    reply.header('Content-Type', 'application/octet-stream');
    reply.header('Content-Length', size);
    reply.header('Content-Disposition', `attachment; filename="${encodeURIComponent(name)}"`);
    return reply.send(stream);
  });
}
