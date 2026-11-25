/**
 * What an access token may do. Each scope is explained for the admin (the permission table in the UI is built from
 * this list), and every internal route is mapped to the one scope it needs. Routes not listed refuse tokens.
 */

export type Risk = 'harmless' | 'sensitive' | 'changes' | 'destructive';

export interface ScopeInfo {
  id: string;
  group: string;
  label: string;
  description: string;
  risk: Risk;
  /** Applies to the whole manager, not one server: cannot be granted to a token limited to some servers. */
  global?: boolean;
  examples: string[];
}

export const SCOPES: ScopeInfo[] = [
  { id: 'servers:read', group: 'Servers', label: 'See servers', description: 'List servers with their status, version, address, players online and CPU/memory use.', risk: 'harmless', examples: ['GET /api/v1/servers', 'GET /api/v1/servers/{id}'] },
  { id: 'servers:power', group: 'Servers', label: 'Start and stop', description: 'Start, stop, restart or force-kill servers.', risk: 'changes', examples: ['POST /api/v1/servers/{id}/start', 'POST /api/v1/servers/{id}/restart'] },
  { id: 'servers:settings', group: 'Servers', label: 'Change settings', description: 'Read and change server settings and server.properties (which can hold the RCON password), ports and live world controls (time, weather, rules).', risk: 'changes', examples: ['PATCH /api/servers/{id}', 'PUT /api/servers/{id}/properties'] },
  { id: 'servers:versions', group: 'Servers', label: 'Change versions', description: 'Change the Minecraft version or server type, reinstall, and apply server updates.', risk: 'changes', examples: ['POST /api/servers/{id}/updates/apply', 'POST /api/servers/{id}/reinstall'] },
  { id: 'servers:create', group: 'Servers', label: 'Create servers', description: 'Create new servers, import worlds and prepare modpacks for new servers.', risk: 'changes', global: true, examples: ['POST /api/servers', 'POST /api/modpacks/stage'] },
  { id: 'servers:delete', group: 'Servers', label: 'Delete servers', description: 'Delete servers, optionally with all their files and worlds.', risk: 'destructive', examples: ['DELETE /api/servers/{id}'] },
  { id: 'console:read', group: 'Console', label: 'Read the console', description: 'Server logs and the live console. Logs can show player IPs and chat.', risk: 'sensitive', examples: ['GET /api/v1/servers/{id}/logs', 'GET /api/v1/events'] },
  { id: 'console:write', group: 'Console', label: 'Run console commands', description: 'Send any console command. A command can op anyone, so this is close to full control in game.', risk: 'changes', examples: ['POST /api/v1/servers/{id}/command'] },
  { id: 'players:read', group: 'Players', label: 'See players', description: 'Who is online, player skins and inventories.', risk: 'harmless', examples: ['GET /api/v1/servers/{id}/players'] },
  { id: 'players:manage', group: 'Players', label: 'Manage players', description: 'Whitelist, op, kick, ban and pardon players, and edit inventories.', risk: 'changes', examples: ['POST /api/v1/servers/{id}/players/{name}/whitelist-add', 'POST /api/v1/servers/{id}/players/{name}/kick'] },
  { id: 'content:read', group: 'Mods & modpacks', label: 'See mods and updates', description: 'Installed mods and plugins, modpack info, client packs and available updates.', risk: 'harmless', examples: ['GET /api/v1/servers/{id}/updates', 'GET /api/servers/{id}/addons'] },
  { id: 'content:write', group: 'Mods & modpacks', label: 'Change mods and modpacks', description: 'Install, remove, enable, disable and update mods and plugins; update or detach modpacks; build client packs.', risk: 'changes', examples: ['POST /api/servers/{id}/addons/install', 'POST /api/servers/{id}/modpack/update'] },
  { id: 'backups:read', group: 'Backups', label: 'See and download backups', description: 'List backups and download them. A backup contains the whole world.', risk: 'sensitive', examples: ['GET /api/v1/servers/{id}/backups'] },
  { id: 'backups:create', group: 'Backups', label: 'Take backups', description: 'Take a backup now.', risk: 'changes', examples: ['POST /api/v1/servers/{id}/backups'] },
  { id: 'backups:restore', group: 'Backups', label: 'Restore backups', description: 'Replace the server with a backup. Progress since that backup is lost.', risk: 'destructive', examples: ['POST /api/v1/servers/{id}/backups/{backupId}/restore'] },
  { id: 'backups:delete', group: 'Backups', label: 'Delete backups', description: 'Delete backups for good.', risk: 'destructive', examples: ['DELETE /api/servers/{id}/backups/{backupId}'] },
  { id: 'files:read', group: 'Files', label: 'Read files', description: 'Browse and download any file in a server folder, including configs that may hold passwords.', risk: 'sensitive', examples: ['GET /api/servers/{id}/files', 'GET /api/servers/{id}/files/download'] },
  { id: 'files:write', group: 'Files', label: 'Change files', description: 'Edit, upload, rename and delete files in a server folder.', risk: 'destructive', examples: ['PUT /api/servers/{id}/files/content', 'POST /api/servers/{id}/files/delete'] },
  { id: 'downloads:read', group: 'Downloads', label: 'See downloads', description: 'What the manager is downloading and recent download history.', risk: 'harmless', examples: ['GET /api/v1/downloads'] },
  { id: 'downloads:control', group: 'Downloads', label: 'Control downloads', description: 'Cancel and retry downloads, clear history.', risk: 'changes', examples: ['POST /api/downloads/tasks/{id}/cancel'] },
  { id: 'network:read', group: 'Network', label: 'See network', description: 'playit tunnels and the port overview.', risk: 'harmless', global: true, examples: ['GET /api/playit', 'GET /api/ports'] },
  { id: 'network:manage', group: 'Network', label: 'Manage network', description: 'Turn playit on or off, create and remove tunnels, and run the console broadcast.', risk: 'changes', global: true, examples: ['POST /api/playit/enable', 'POST /api/servers/{id}/tunnel'] },
  { id: 'system:read', group: 'System', label: 'See system', description: 'Host CPU, memory and disk, Java runtimes and storage use.', risk: 'harmless', global: true, examples: ['GET /api/v1/system', 'GET /api/storage'] },
  { id: 'system:manage', group: 'System', label: 'Clean up storage', description: 'Delete download caches, icons and unused Java runtimes.', risk: 'changes', global: true, examples: ['DELETE /api/storage/cache'] },
];

export const SCOPE_IDS = new Set(SCOPES.map((s) => s.id));
/** Route marker: any valid token may call it (e.g. GET /api/v1/me). */
export const ANY_TOKEN = '*';
export const GLOBAL_SCOPES = new Set(SCOPES.filter((s) => s.global).map((s) => s.id));

export const PRESETS: { id: string; label: string; description: string; scopes: string[] }[] = [
  { id: 'discord', label: 'Discord bot', description: 'Show status and players, and let players start a server.', scopes: ['servers:read', 'players:read', 'servers:power'] },
  { id: 'home-assistant', label: 'Home Assistant', description: 'Sensors for status and players, buttons for start/stop.', scopes: ['servers:read', 'players:read', 'servers:power', 'system:read'] },
  { id: 'script', label: 'Script', description: 'Nothing ticked: choose what the script needs.', scopes: [] },
  { id: 'phone', label: 'Phone app', description: 'Everything the web app can do.', scopes: SCOPES.map((s) => s.id) },
];

/** Internal routes (method + Fastify route pattern) and the scope each needs. Session-only routes are not listed. */
export const ROUTE_SCOPES: Record<string, string> = {
  // servers
  'GET /api/servers': 'servers:read',
  'POST /api/servers': 'servers:create',
  'GET /api/servers/:id': 'servers:read',
  'PATCH /api/servers/:id': 'servers:settings',
  'DELETE /api/servers/:id': 'servers:delete',
  'GET /api/servers/:id/stats': 'servers:read',
  'GET /api/icons/:id': 'servers:read',
  'POST /api/servers/:id/start': 'servers:power',
  'POST /api/servers/:id/stop': 'servers:power',
  'POST /api/servers/:id/restart': 'servers:power',
  'POST /api/servers/:id/kill': 'servers:power',
  'POST /api/servers/:id/ports': 'servers:settings',
  'POST /api/servers/:id/ports/release': 'servers:settings',
  // server.properties can hold secrets (rcon.password), so reading it needs the settings permission.
  'GET /api/servers/:id/properties': 'servers:settings',
  'PUT /api/servers/:id/properties': 'servers:settings',
  'GET /api/servers/:id/world': 'servers:read',
  'POST /api/servers/:id/world': 'servers:settings',
  'POST /api/servers/:id/reinstall': 'servers:versions',
  'POST /api/servers/:id/version': 'servers:versions',
  'GET /api/servers/:id/updates': 'content:read',
  'POST /api/servers/:id/updates/apply': 'servers:versions',
  'GET /api/versions/java': 'servers:read',
  'GET /api/versions/java-runtime': 'servers:read',
  'GET /api/versions/bedrock': 'servers:read',
  'GET /api/versions/geyser': 'servers:read',
  'GET /api/items': 'servers:read',
  // console
  'GET /api/servers/:id/logs': 'console:read',
  'POST /api/servers/:id/command': 'console:write',
  // players
  'GET /api/servers/:id/players': 'players:read',
  'GET /api/servers/:id/players/:player/skin': 'players:read',
  'POST /api/servers/:id/players/action': 'players:manage',
  'GET /api/servers/:id/inventory': 'players:read',
  'GET /api/servers/:id/inventory/:player': 'players:read',
  'POST /api/servers/:id/inventory/:player': 'players:manage',
  'DELETE /api/servers/:id/inventory/:player/pending': 'players:manage',
  'POST /api/servers/:id/inventory/bridge': 'players:manage',
  // content
  'GET /api/servers/:id/addons': 'content:read',
  'GET /api/servers/:id/addons/search': 'content:read',
  'GET /api/servers/:id/addons/updates': 'content:read',
  'GET /api/servers/:id/addons/client-packs': 'content:read',
  'GET /api/servers/:id/addons/client-packs/:pid/download': 'content:read',
  'POST /api/servers/:id/addons/install': 'content:write',
  'POST /api/servers/:id/addons/upload': 'content:write',
  'POST /api/servers/:id/addons/toggle': 'content:write',
  'DELETE /api/servers/:id/addons': 'content:write',
  'POST /api/servers/:id/addons/updates/apply': 'content:write',
  'POST /api/servers/:id/addons/client-packs': 'content:write',
  'DELETE /api/servers/:id/addons/client-packs/:pid': 'content:write',
  'GET /api/servers/:id/modpack/update': 'content:read',
  'GET /api/servers/:id/modpack/file': 'content:read',
  'POST /api/servers/:id/modpack/update': 'content:write',
  'POST /api/servers/:id/modpack/skip': 'content:write',
  'POST /api/servers/:id/modpack/mode': 'content:write',
  'POST /api/servers/:id/modpack/detach': 'content:write',
  'GET /api/modpacks/search': 'content:read',
  'GET /api/modpacks/project/:idOrSlug/versions': 'content:read',
  'GET /api/modpacks/staged': 'servers:create',
  'GET /api/modpacks/staged/:id': 'servers:create',
  'DELETE /api/modpacks/staged/:id': 'servers:create',
  'POST /api/modpacks/stage': 'servers:create',
  'POST /api/modpacks/upload': 'servers:create',
  'GET /api/imports': 'servers:create',
  'POST /api/imports/upload': 'servers:create',
  'POST /api/imports/register': 'servers:create',
  'DELETE /api/imports/:id': 'servers:create',
  // backups
  'GET /api/servers/:id/backups': 'backups:read',
  'GET /api/servers/:id/backups/:bid/download': 'backups:read',
  'POST /api/servers/:id/backups': 'backups:create',
  'POST /api/servers/:id/backups/:bid/restore': 'backups:restore',
  'DELETE /api/servers/:id/backups/:bid': 'backups:delete',
  'DELETE /api/servers/:id/backups': 'backups:delete',
  // files
  'GET /api/servers/:id/files': 'files:read',
  'GET /api/servers/:id/files/content': 'files:read',
  'GET /api/servers/:id/files/download': 'files:read',
  'PUT /api/servers/:id/files/content': 'files:write',
  'POST /api/servers/:id/files/delete': 'files:write',
  'POST /api/servers/:id/files/mkdir': 'files:write',
  'POST /api/servers/:id/files/rename': 'files:write',
  'POST /api/servers/:id/files/upload': 'files:write',
  // downloads
  'GET /api/downloads': 'downloads:read',
  'POST /api/downloads/:id/cancel': 'downloads:control',
  'POST /api/downloads/tasks/:id/cancel': 'downloads:control',
  'POST /api/downloads/tasks/:id/retry': 'downloads:control',
  'DELETE /api/downloads/history': 'downloads:control',
  // network
  'GET /api/playit': 'network:read',
  'GET /api/ports': 'network:read',
  'POST /api/playit/enable': 'network:manage',
  'POST /api/playit/disable': 'network:manage',
  'POST /api/playit/refresh': 'network:manage',
  'POST /api/playit/reset': 'network:manage',
  'DELETE /api/playit/tunnels/:id': 'network:manage',
  'POST /api/servers/:id/tunnel': 'network:manage',
  'GET /api/servers/:id/broadcast': 'network:read',
  'POST /api/servers/:id/broadcast': 'network:manage',
  'POST /api/servers/:id/broadcast/restart': 'network:manage',
  'POST /api/servers/:id/broadcast/signout': 'network:manage',
  // system
  'GET /api/system': 'system:read',
  'GET /api/storage': 'system:read',
  'DELETE /api/storage/cache': 'system:manage',
  'DELETE /api/storage/cache/:name': 'system:manage',
  'DELETE /api/storage/icons': 'system:manage',
  'DELETE /api/storage/runtimes/*': 'system:manage',
};

/** Normalise scopes from a request: known ids only, no duplicates, and no global ones for server-limited tokens. */
export function cleanScopes(scopes: unknown, limited: boolean): string[] {
  const list = Array.isArray(scopes) ? scopes.filter((s): s is string => typeof s === 'string' && SCOPE_IDS.has(s)) : [];
  return [...new Set(list)].filter((s) => !limited || !GLOBAL_SCOPES.has(s)).sort();
}
