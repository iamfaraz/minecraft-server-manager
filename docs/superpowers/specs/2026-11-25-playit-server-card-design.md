# Per-server playit card — design (short)

## Why
playit tunnels are created per server, but all of it lives on the global Remote play page (pick a server from a dropdown, then find its row in one big table). The admin wants each server's remote-play setup on that server's Settings tab. First step towards a family launcher that joins servers locally and remotely; Cloudflare SRV, Pi-hole and the launcher are parked.

## Approaches
- **Per-server card + small server endpoint (chosen).** The card shows only this server's tunnels and the agent state; the global page stays for agent/claim/log/all tunnels.
- Move everything onto the server page and drop the global page: rejected, the agent and claim are shared by all servers.
- Card filters the global `/api/playit` status client-side with no new endpoint: rejected, duplicate-tunnel and cleanup rules belong on the server.

## Design
- **Card "Remote play (playit)"** on every server's Settings tab (Java and Bedrock).
  - One row per exposed port: the game port, plus the Geyser port when cross-play is on. A row has a status dot, the public address with Copy, and Delete; with no tunnel it shows Create.
  - An existing Geyser-port tunnel while cross-play is off stays listed, noted as unused.
  - Agent states: off shows "Turn on playit" (labelled as affecting all servers). Claiming shows the claim link and Copy inline. Other states show the state and a link to the Remote play page.
- **Server**
  - `GET /api/servers/:id/tunnels` returns `{ agent: {state, enabled, claimUrl, error}, ports: [{kind: 'game'|'geyser', port, protocol: 'tcp'|'udp', inUse, tunnel: PlayitTunnel|null}] }`.
  - `POST /api/servers/:id/tunnel` refuses a duplicate with 409 when that port and protocol already has a tunnel.
  - Deleting a server deletes its playit tunnels (best effort; logged on failure, never blocks the delete).
  - The new GET is mapped to the `network:read` permission (the existing tunnel POST keeps its scope).
- **Remote play page** unchanged except each tunnel row's server name links to that server's Settings tab.

## Non-goals
Cloudflare DNS/SRV, Pi-hole, the launcher, changing a tunnel's port, playit 1.x support.

## Left to the builder
Exact copy, icons, and the card's position (next to Cross-play).
