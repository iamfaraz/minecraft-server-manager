# Per-server playit card Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Each server's Settings tab gets a "Remote play (playit)" card that shows, creates and deletes that server's tunnels and surfaces the shared agent state.

**Architecture:** Pure helpers in `server/src/playitServer.ts` decide which ports a server exposes and which tunnels belong to it; routes in `servers.ts` use them (new GET, duplicate guard on POST, cleanup on delete). A new React card consumes the GET and refreshes on the existing `playit` websocket event.

**Tech Stack:** Node 24, TypeScript, Fastify 5, node:test via tsx; React, TanStack Query, Tailwind, lucide.

**Spec:** `docs/superpowers/specs/2026-11-25-playit-server-card-design.md`

## Global Constraints
- New GET maps to `network:read` in `ROUTE_SCOPES` (the route-coverage test in `api/api.test.ts` fails otherwise).
- Duplicate create → HTTP 409 with message `This server already has a tunnel for port <port>`.
- Server delete never fails because of tunnel cleanup; failures are logged with `app.log.warn`.
- Protocol matching follows `tunnelsForPort`: a TCP lookup matches `portType !== 'udp'`, a UDP lookup matches `portType !== 'tcp'`.

## Review Focus
- playit API unreachable (`tunnelsError` set): the card must show the error, not "no tunnel" with a Create button that duplicates.
- Agent not running: Create/Delete disabled; GET still answers with `ports[].tunnel = null`.
- Cross-play turned off with a Geyser tunnel left: row stays, `inUse: false`.
- Bedrock server: one UDP game row, no Geyser row.
- Server whose port changed: the old tunnel is no longer matched (it shows on the Remote play page as `127.0.0.1:<port>`); accepted, noted.

---

### Task 1: Server helpers, routes and tests

**Files:**
- Create: `server/src/playitServer.ts`
- Create: `server/src/playitServer.test.ts`
- Modify: `server/src/routes/servers.ts` (tunnel POST guard, new GET, delete cleanup)
- Modify: `server/src/api/scopes.ts` (`'GET /api/servers/:id/tunnels': 'network:read'`)
- Modify: `server/src/playit.ts` (public `cachedTunnels()` returning the current list and `tunnelsError`)

**Interfaces:**
- Produces:
  - `type PortKind = 'game' | 'geyser'`
  - `interface ServerPort { kind: PortKind; port: number; protocol: 'tcp' | 'udp'; inUse: boolean; tunnel: PlayitTunnel | null }`
  - `serverPorts(rec: Pick<ServerRecord,'edition'|'port'|'geyser'|'geyserPort'>, tunnels: PlayitTunnel[]): ServerPort[]`
  - `tunnelsOfServer(rec, tunnels): PlayitTunnel[]` (every tunnel matched by `serverPorts`)
  - `GET /api/servers/:id/tunnels` → `{ agent: { state, enabled, claimUrl, error }, tunnelsError: string | null, ports: ServerPort[] }`

- [ ] **Step 1: Write failing tests** in `playitServer.test.ts`:
  - `java server without geyser has one tcp game port` → `[{kind:'game', port:25565, protocol:'tcp', inUse:true, tunnel:null}]`
  - `bedrock server's game port is udp`
  - `geyser on adds a udp geyser port`
  - `geyser tunnel left after cross-play is off stays listed and not in use` (rec.geyser=false, geyserPort=19132, a udp tunnel on 19132 → row kind 'geyser', inUse:false)
  - `matches tunnels by port and protocol` (a udp tunnel on 25565 does not match the java tcp row)
  - `tunnelsOfServer returns game and geyser tunnels only`
- [ ] **Step 2:** `cd server && npm test` → FAIL (module missing).
- [ ] **Step 3:** Implement `playitServer.ts`. Then routes:
  - POST guard: refresh tunnels, then if `serverPorts(...)` finds a tunnel for the requested kind → `HttpError(409, ...)`.
  - GET as in Interfaces.
  - Delete: read `inst.rec` before `manager.remove`, then delete each of `tunnelsOfServer` via `playit.deleteTunnel` only when the agent is running (try/catch, warn).
  - Map the scope.
- [ ] **Step 4:** `cd server && npm test` → all pass (including route coverage); `npx tsc --noEmit` clean.
- [ ] **Step 5:** Commit `feat(playit): per-server tunnel view, duplicate guard, cleanup on delete`.

### Task 2: Web card and Remote play links

**Files:**
- Create: `web/src/pages/server/PlayitCard.tsx`
- Modify: `web/src/pages/server/Settings.tsx` (render `<PlayitCard s={s} />` after Cross-play)
- Modify: `web/src/pages/RemotePlay.tsx` (server name → `Link` to `/servers/<id>/settings`)
- Modify: `web/src/lib/types.ts` (`ServerTunnels`, `ServerPort`)

**Interfaces:**
- Consumes: Task 1's GET; existing `POST /api/servers/:id/tunnel {kind}`, `DELETE /api/playit/tunnels/:id`, `POST /api/playit/enable`.
- Query key `['server-tunnels', id]`; invalidated on the websocket `playit` event and after every mutation.

- [ ] **Step 1:** Build the card: rows per `ports[]` (dot, address + Copy, Delete with confirm, Create when no tunnel; "Not used while cross-play is off" when `!inUse`). Agent off → "Turn on playit" button with "affects all servers" hint; claiming → claim link + Copy; other non-running states → state chip + link to `/remote`. `tunnelsError` → error line and Create hidden.
- [ ] **Step 2:** `cd web && npx tsc --noEmit && npm run build` → clean.
- [ ] **Step 3:** Live check: run the app with a scratch data dir, open a server's Settings, screenshot the card in the agent-off state (the playit account cannot be claimed in a scratch run; state it in the report).
- [ ] **Step 4:** Commit `feat(web): Remote play card on each server's Settings tab`.
