# API access with tokens — design

## Why

The admin wants other software to read and control the manager: a Discord bot players use, Home Assistant
(sensors and buttons), their own scripts, and a phone app. Each gets its own access token carrying only the
permissions the admin ticked, so a leaked bot token cannot delete worlds.

## Goals

- Access tokens, created and revoked in the web UI, sent as `Authorization: Bearer bh_…`.
- Fine-grained permissions (scopes), chosen from a table that explains each one: what it allows, example
  endpoints, and a risk label (harmless / sensitive / changes things / destructive). Presets prefill the table.
- A stable, documented REST API at `/api/v1` for integrations, plus tokens accepted on the internal `/api`
  (what the web UI uses) for anything v1 does not cover yet — marked as liable to change.
- Live events over a websocket at `/api/v1/events`, filtered to what the token may see.

## Non-goals

- GraphQL (REST suits Home Assistant `rest`/`rest_command`, curl and bots; the websocket covers live data).
- More user accounts or roles. Tokens belong to the single admin.
- CORS for browser clients (native apps and servers do not need it). Can be added later as an allowed-origins list.

## Anti-goals

- A token that can manage tokens, change the password or two-factor, or log in. Never.
- A route that a token reaches without a declared permission (fail closed).
- Storing tokens in a form that works if the data folder leaks (only hashes are stored).

## Approaches considered

- Permissions: (A) full-access tokens only, (B) four levels plus a server limit, (C) fine-grained scopes.
  **The admin picked C**, with a detailed table while selecting.
- Stability: (A) tokens on the internal API, (B) a separate `/api/v1` only, (C) both. **The admin picked C.**
- Protocol: GraphQL was asked about; **REST chosen** (reasons above).

## Decided

### Tokens

- Format `bh_` + 32 random bytes base64url. Shown once at creation; stored as SHA-256 hash with a short visible
  prefix (`bh_ab12…`) so the admin can tell tokens apart.
- Fields: id, name, prefix, hash, scopes, optional server list (limit), optional expiry, createdAt,
  lastUsedAt, lastUsedIp. Stored in `<data>/api-tokens.json`.
- Revoke deletes the token; takes effect on the next request (and closes its open event sockets).
- Activity: the last 200 actions per token (time, method, path, status, ip). Kept in the same file, written at
  most every few seconds.
- Rate limit: 120 requests per minute per token (in memory). Over the limit → 429 with `Retry-After`.
- Expired tokens are refused with 401 and shown as expired in the UI.
- Token management (`/api/tokens…`) and `/api/auth/*` accept the session cookie only.

### Scopes

| Scope | Allows | Risk |
|---|---|---|
| servers:read | list servers, status, resource use, ports, icons, version lists | harmless |
| servers:power | start, stop, restart, kill | changes |
| servers:settings | server settings, server.properties, ports, world controls | changes |
| servers:versions | change version, reinstall, server updates | changes |
| servers:create | create servers, import worlds, stage modpacks | changes (global) |
| servers:delete | delete servers | destructive |
| console:read | logs, live console | sensitive |
| console:write | console commands (can op anyone) | changes |
| players:read | online players, skins, inventories | harmless |
| players:manage | whitelist, op, kick, ban, inventory edits | changes |
| content:read | mods/plugins, modpack info, update checks, client packs | harmless |
| content:write | install/remove/toggle/update mods, pack updates, client packs | changes |
| backups:read | list and download backups (contain the whole world) | sensitive |
| backups:create | take backups | changes |
| backups:restore | restore a backup over the server | destructive |
| backups:delete | delete backups | destructive |
| files:read | browse and download server files | sensitive |
| files:write | edit, upload, rename, delete files | destructive |
| downloads:read | see downloads | harmless |
| downloads:control | cancel, retry, clear downloads | changes |
| network:read | playit tunnels and port overview | harmless (global) |
| network:manage | playit, tunnels, console broadcast | changes (global) |
| system:read | system info, storage | harmless (global) |
| system:manage | clean caches and runtimes | changes (global) |

Presets: Discord bot = servers:read, players:read, servers:power. Home Assistant = those + system:read.
Script = none (pick). Phone app = all.

Server limit: a token limited to some servers only sees and acts on those; global scopes cannot be granted to it.

### Internal API

Every internal route gets a required scope in one central table (method + route pattern → scope). A route not
in the table refuses tokens with 403. A test registers all route plugins and fails if any `/api` route other
than auth and token management is missing from the table. `GET /api/servers` is filtered for limited tokens.

### /api/v1

Stable JSON shapes (not the internal summaries). Errors are `{ "error": { "code", "message" } }`.

- `GET /api/v1/me` — the token: name, scopes, servers, expiry
- `GET /api/v1/servers`, `GET /api/v1/servers/{id}` — servers:read
- `POST /api/v1/servers/{id}/{start|stop|restart|kill}` — servers:power
- `GET /api/v1/servers/{id}/players` — players:read
- `POST /api/v1/servers/{id}/players/{name}/{action}` — players:manage (whitelist-add, whitelist-remove, op,
  deop, kick, ban, pardon)
- `GET /api/v1/servers/{id}/logs?lines=` — console:read
- `POST /api/v1/servers/{id}/command` — console:write
- `GET|POST /api/v1/servers/{id}/backups` — backups:read / backups:create
- `POST /api/v1/servers/{id}/backups/{backupId}/restore` — backups:restore
- `GET /api/v1/servers/{id}/updates` — content:read (server, mods, modpack)
- `GET /api/v1/downloads` — downloads:read
- `GET /api/v1/system` — system:read
- `GET /api/v1/events` (websocket) — events filtered by scope and server limit; auth by header, or by a first
  message `{ "type": "auth", "token": "…" }` within 5 s for clients that cannot set headers.

### Web UI

- New page **API access** (sidebar): token list (name, prefix, scopes count, servers, last used, expiry),
  create dialog (name, presets, permission table with checkboxes, risk badges and example endpoints, server
  limit, expiry), a show-once dialog with copy, per-token activity, revoke with confirm.
- **API reference** tab on the same page: each v1 endpoint with its scope and a curl example, generated from the
  same table the server uses.

## Left to the builder

Exact DTO field names, page layout, file layout under `server/src/api/`.
