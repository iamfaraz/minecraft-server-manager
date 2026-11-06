# Blockhost — Minecraft server manager (Java + Bedrock)

A single Docker container that runs and manages any number of Minecraft servers, Java **and** Bedrock, behind a modern web UI.

- **One container.** The manager, every Minecraft server process, the Java runtimes and the playit.gg agent all live in one container with one data volume.
- **Java flavors:** Vanilla, Paper, Purpur, Fabric, Forge, NeoForge. **Bedrock:** official Bedrock Dedicated Server (release or preview). Version catalogs come straight from Mojang, PaperMC, PurpurMC, FabricMC, Forge and NeoForge.
- **Correct Java every time.** The required Java major is read from Mojang's version metadata (e.g. 26.x → Java 25, 1.21 → 21, 1.20.4 → 17, ≤1.16 → 8). Java 21 and 25 are bundled; other versions download from Adoptium on demand. Override per server if you want.
- **Mod and plugin updates.** Every installed jar is identified on Modrinth by file hash (including hand-uploaded ones) and compared with the newest build for your loader and Minecraft version; update one or all with a click. For Fabric/Forge/NeoForge servers the same check tells you which mods players must also install on their own game, and builds a downloadable **client pack** zip (selected mods + loader installer + README with install steps and the server address).
- **Two-factor login** (TOTP via QR code or setup key, with recovery codes).
- **Bedrock texture and behavior packs.** Upload a `.mcpack` or `.mcaddon` under Addons; packs are extracted into `resource_packs/` or `behavior_packs/` and registered on the world, with a switch to require players to use the server's texture packs.
- **Import any world.** Upload a `.zip`/`.mcworld`, upload a folder from your browser, or drop a world into `data/imports/` on the host, then create a new server from it. Java and Bedrock worlds are detected automatically (including Paper-style nether/end folders).
- **Update in place or branch off.** Change a server's version/flavor while keeping its world, configs, plugins and mods (a world backup is taken first), or create a brand-new server on another version and import the world from an existing server or one of its backups.
- **Safe hot backups.** Running servers are frozen through the proper console pipeline (`save-off`/`save-all flush` on Java, `save hold`/`save query` with byte-exact truncation on Bedrock) so backups are consistent without kicking anyone. Manual and scheduled, with retention.
- **Live console** with slash-command suggestions and Tab completion (commands, arguments, game rules and player names for the server's edition and version). Consecutive repeats of the same log message fold into two lines: the first occurrence, then the newest one with a count such as `Running AutoCompaction... [x3]`, so you can see when a run started and when it last happened. Blockhost's own messages use the same timestamp format as the server's lines and are shown in blue.
- **Live controls on the Overview page:** set the time and weather, change difficulty, broadcast a message, save the world, and flip **game rules** with switches. Values are read back from the running server, so the switches show its real state. Rule names follow the server: snake_case on Java 26.x / 1.21.11+ (`keep_inventory`, `advance_time`), camelCase on older Java and on Bedrock, where the display rules live (`showCoordinates`, `showDaysPlayed`, `showTags`). On Bedrock the *Locator bar* switch drives `playerWaypoints` (`everyone` / `off`), because the server lists `locatorbar` but refuses to change it.
- **Player roster:** one table of every player the server knows, with who is online now, last seen, an allowlist switch, a permission selector (Player/Operator on Java; Visitor/Member/Operator on Bedrock), block/unblock and kick. Works whether the server is running or stopped. Bedrock has no ban command, so Blockhost keeps a blocklist itself and removes blocked players as they join.
- **Telemetry** (CPU, memory, players, ping via Server List Ping / RakNet), **addons** (Modrinth search + one-click install with dependencies for plugins/mods; `.mcpack`/`.mcaddon` install for Bedrock), **jailed file manager** with editor, and a **server.properties** editor.
- **Cross-play:** one toggle installs [Geyser](https://geysermc.org) + [Floodgate](https://github.com/GeyserMC/Floodgate) on Paper/Purpur/Fabric/NeoForge servers so Bedrock players can join Java servers. Geyser is configured per server through its `GEYSER_*` environment overrides (port from the very first start, RakNet and NetherNet both enabled, advertised address for Docker bridge mode), its Bedrock side is health-checked, and the console broadcast toggle works for these servers too.
- **Remote play without port forwarding:** built-in [playit.gg](https://playit.gg) agent. Enable it, claim it once in your browser, then create a tunnel per server from the UI to get a public address.
- Graceful lifecycle: `stop` → wait → SIGTERM → SIGKILL; crash detection with OOM hints and bounded auto-restart; servers that were running are resumed after the container restarts.
- **Console players (Switch / Xbox / PlayStation).** A per-server toggle runs [MCXboxBroadcast](https://github.com/MCXboxBroadcast/Broadcaster) next to a Bedrock server: sign a spare Microsoft account in with the code shown in the UI, and the server appears in that account's friends' Friends tab. See *Console players* below.
- **Armor HUD add-on for Bedrock:** held items, armour durability, arrows and free slots around the hotbar, for every Bedrock client. See *Bedrock add-on: Armor HUD* below.
- **Port manager:** one page showing which server holds or uses every port, with assign, share and release, and a prompt on Start when a port is taken. See *Ports* below.
- **Bedrock transport choice:** NetherNet (Mojang's WebRTC transport, required by current Bedrock versions) or RakNet (the classic protocol, for older versions) per server.
- Runs as your host user (`PUID`/`PGID`), so `./data` stays yours.

Tested target: x86_64 Ubuntu (e.g. an i5 with 16 GB RAM). The image is also built for arm64 (Bedrock via box64).

## Quick start

```bash
git clone https://github.com/iamfaraz/minecraft-server-manager.git && cd minecraft-server-manager
./deploy.sh
```

`deploy.sh` (Linux and macOS) checks Docker, finds a free port for the web UI (asks you if 8080 is taken), records your `id -u`/`id -g` so `./data` stays owned by you, sizes the memory limit from your RAM, stores your LAN IP for Bedrock NetherNet, offers host networking on Linux, writes `.env`, and runs `docker compose up -d --build`. Re-run it any time to update. Use `./deploy.sh --no-start` to only write `.env`, or `--port 9000` to pick a port non-interactively.

Open <http://localhost:8080> (or the port you chose), create the admin account, and click **New server**.

Everything persists in `./data` (change with `MCSM_DATA_DIR` in a `.env` file, see `.env.example`).

### Ports

Docker can only publish ports when the container starts, so the compose file publishes two ranges and the manager assigns ports from them:

| Env var               | Default        | Used by                                   |
| --------------------- | -------------- | ----------------------------------------- |
| `MCSM_JAVA_PORTS`     | `25565-25574`  | Java servers (TCP)                        |
| `MCSM_BEDROCK_PORTS`  | `19132-19141`  | Bedrock servers and Geyser (two consecutive ports each): UDP, plus TCP for NetherNet signaling |

Widen the ranges in `.env` if you need more servers. Players on your LAN connect to `<host-ip>:<port>`; the UI shows the address on each server.

### Managing ports

The **Ports** page lists every port in the two ranges and who has it: *In use* (a running server), *Assigned* (held by a stopped server), *Shared*, or *Free*.

- **Change** gives a server the next free port or one you choose. A Bedrock server and a Java server's cross-play port each take two ports in a row.
- **Share** lets several servers hold the same port, for servers that take turns on the default port so players never change the address. Choose a port another server holds and confirm.
- **Release** makes a stopped server give up its ports so others can take them. When you start it again it gets its old ports back if they are still free, and new ones otherwise.
- **Assign** on a free port hands that port to a server you pick.

Starting a server whose port is taken by another running server (or by another program on the machine) opens a dialog with three choices: stop the server in the way, move to the next free port, or enter a port. Servers started automatically, at boot or after a crash, cannot ask, so they report the conflict in their console instead.

A port outside the published ranges works inside the container but is only reachable if you publish it yourself, unless you use host networking.

### Run as your own user (PUID/PGID)

The container starts as root only to make `/data` writable, then drops to `PUID:PGID` for the manager and every server process, so everything under `./data` is owned by you rather than root:

```bash
printf 'PUID=%s\nPGID=%s\n' "$(id -u)" "$(id -g)" >> .env
docker compose up -d
```

### Timezone

Server logs, the console and scheduled backups use the container's timezone. `deploy.sh` copies the host's zone into `.env` as `TZ` (for example `TZ=Asia/Karachi`); change it there and run `docker compose up -d` to apply. The System page shows the zone in effect.

### Memory

`mem_limit` in `docker-compose.yml` (default `12g`, sized for a 16 GB host) caps the whole container. Each Java server's `-Xmx` is set in its settings; keep 1–2 GB of headroom per JVM, plus ~1 GB for each Bedrock server. The System page shows the running total against the limit and warns when you are close to the OOM killer.

### Bedrock transport: RakNet vs NetherNet

Bedrock Dedicated Server has moved to **NetherNet**, Mojang's WebRTC-based transport. Current versions accept players only over NetherNet: on 1.26.62 a server set to the classic **RakNet** UDP protocol still starts, but prints a `TRANSPORT TYPE ERROR` and nobody can join. New servers are therefore created on NetherNet, and Blockhost adds its own console message if a server hits that error. RakNet remains selectable (wizard and Settings) for older Bedrock versions:

| | RakNet (older versions only) | NetherNet (default) |
| --- | --- | --- |
| Ports | 2 UDP (IPv4 + IPv6) | 1 port, UDP (WebRTC data) **and TCP** (signaling) |
| Status ping / MOTD / player count | Yes (RakNet unconnected ping) | Reachability + latency only (TCP probe) |
| LAN discovery | Only the server on 19132 (BDS binds 19132/19133 for discovery) | Yes |
| Behind NAT, Docker on another host, playit | Works as-is | Needs `server-udp-ports=publicIP:publicPort:localPort` in server.properties |

The manager writes `transport`, `server-port`, `server-portv6`, `server-udp-ports` and `enable-lan-visibility` consistently for whichever you pick. Transport changes apply on the next start.

**NetherNet and Docker networking.** NetherNet negotiates addresses *inside* the protocol (WebRTC/ICE), so on Docker's bridge network the server would advertise its internal 172.x address and clients fail with a NetherNet error even though the UDP port is published. Two fixes, both handled for you:

- **Host networking (Linux, recommended).** `deploy.sh` offers it on Linux and writes `COMPOSE_FILE=docker-compose.yml:docker-compose.host.yml` into `.env`. Ports open directly on the host, Bedrock LAN discovery (the Friends tab) works, and no address mapping is needed. Manually: `docker compose -f docker-compose.yml -f docker-compose.host.yml up -d`.
- **Advertised IP (bridge mode).** `deploy.sh` stores your LAN IP as `MCSM_ADVERTISE_IP`; the manager then writes `server-udp-ports=<ip>:<port>:<port>` for NetherNet servers. Override per server under Settings → *Advertised IP for NetherNet*. The value `public` resolves your current public IP on every start (for port-forwarded servers with a dynamic IP).

LAN discovery in bridge mode never works (broadcasts don't cross the Docker bridge); players must use *Add Server* with the host IP and port.

**Restarts on NetherNet can take up to a minute.** Bedrock cannot open its NetherNet port while connections from the previous run are still held by the operating system, which lasts 60 seconds after the last one closes; it then starts without NetherNet and reports no error. Blockhost therefore waits for the port before starting the server and says so in the console. As a safety net it also checks the port after "Server started" and restarts the server (twice at most) if nothing is listening.

### Console players (Switch, Xbox, PlayStation)

Consoles can't type in a server address. Under a Bedrock server's **Settings → Console players**, turn on *Show this server in the Xbox Live Friends tab*:

1. The server is switched to NetherNet if needed (restart it once).
2. When the server is running, a sign-in box appears: open `microsoft.com/link`, enter the code, and sign in with a **spare** Microsoft account (the broadcaster emulates parts of a game client, so don't use your main one).
3. On the console, add that account's gamertag as a friend. Requests are accepted automatically and the server shows up under Play → Friends. Switch needs a linked Microsoft account and Nintendo Switch Online.

The same card appears on Java servers that have Cross-play (Geyser) enabled; joins are then relayed to Geyser's built-in NetherNet signaling.

How it works: MCXboxBroadcast holds an Xbox Live session for that account and relays each join to the server's NetherNet signaling on `127.0.0.1:<port>`; the console then connects directly to the address the server advertises (`MCSM_ADVERTISE_IP`, or the host itself with host networking). LAN consoles work out of the box. Remote consoles additionally need the server's UDP port reachable from the internet and the advertised IP set to `public`.

Already running the standalone container? Stop it and reuse its login: copy `config/cache/` (and optionally `config.yml`, `screenshot.jpg`) into `data/servers/<id>/broadcaster/` before enabling the toggle. The address and port in `config.yml` are rewritten automatically. The jar version is pinned (`MCXB_VERSION` build arg / `MCSM_MCXB_VERSION` env) because each release targets a specific Bedrock protocol version.

### Apple Silicon and other ARM hosts

Bedrock Dedicated Server is x86_64-only. The ARM image bundles [box64](https://github.com/ptitSeb/box64) and runs BDS through it automatically; Java servers run natively. If you'd rather run everything as x86_64 under Rosetta/QEMU, uncomment `platform: linux/amd64` in the compose file.

## Live controls, game rules and players

**Overview → Live controls** appears while a server is running:

- *Time of day* (day, noon, night, midnight), *weather* (clear, rain, thunder), *difficulty*, *broadcast a message*, and *save world now* (Java).
- *Game rules*, grouped as Display, Gameplay, World, Mobs, Damage and Drops. Each rule is a switch or a number field. The values come from the server's own answers (`gamerule …`), refreshed every minute or on demand; those background queries are kept out of the console log. Difficulty is also written to `server.properties` so it survives a restart.
- Display rules are where "show coordinates" and "show days played" live on Bedrock. Java has no on-screen coordinate rule; the nearest equivalents are the locator bar and *Hide coordinates in debug screen*.

**Players tab** lists everyone the server knows about (online, previously seen, allowlisted, operators and blocked), with filters and search:

| Action | Java | Bedrock |
| --- | --- | --- |
| Allowlist switch | `whitelist add/remove`, or `whitelist.json` when stopped | `allowlist add/remove`, or `allowlist.json` when stopped |
| Permission | Player / Operator (`op`, `deop`, `ops.json`) | Default / Visitor / Member / Operator (`permissions.json` + `permission reload`); needs the player to have joined once so their Xbox ID is known |
| Block / Unblock | The server's ban list (`ban`, `pardon`) | Blockhost-managed blocklist (`data/servers/<id>/blocklist.json`); blocked players are kicked as they join |
| Kick | `kick` | `kick` |

## Bedrock add-on: Armor HUD

`addons/armor-hud/blockhost-armor-hud.mcaddon` is a Bedrock add-on that shows each player a small HUD on both sides of the hotbar, in the style of Inventory HUD+ on Java:

| Left of the hotbar | Right of the hotbar |
| --- | --- |
| Main hand: durability, or how many of that item you carry | Off hand: durability or count (for example totems) |
| Helmet durability | Leggings durability |
| Chestplate durability | Boots durability |
| Arrows carried (shown when you have arrows or a bow) | Free inventory slots |

Durability is a percentage coloured from green down to red. Empty slots show nothing.

**Install:** open the Bedrock server in Blockhost, go to **Add-ons**, upload the `.mcaddon` file and restart the server. It contains a behavior pack and a resource pack; both are enabled for the world. Players download the resource pack when they join, so set `texturepack-required=true` under Settings if you want everyone to have it. Works for every Bedrock client, consoles included.

**How it works:** a server-side script (Script API 2.0, Bedrock 1.21.90 or newer) reads each player's equipment ten times a second and, when something changed, sends that player one hidden title holding every icon and number. The resource pack keeps that title off the screen and draws its contents next to the hotbar, using the item textures already in the player's game. The data is repeated a few times after a spawn and then every 30 seconds, so a HUD that missed an update corrects itself.

**Good to know**

- The HUD travels over the title channel, so an ordinary title (from `/title` or another add-on) disappears early if the HUD updates while it is showing.
- Icons come from a table generated from Mojang's own block and item data (`generate-icons.mjs`), covering 1,616 of the 1,627 vanilla items. Blocks are drawn as one flat face rather than the 3D cube in the hotbar. Mob heads, banners, a few items with no texture file, and items from other add-ons show a question mark; shields show the slot outline. Leather armour is drawn undyed, and potions show the plain bottle.
- On touch screens the right column sits just past the hotbar's "..." button.

**Updating the add-on:** upload the new `.mcaddon` over the old one and restart. Each release has a higher pack version, which is what makes players' devices download the new resource pack instead of using their cached copy.

**Change or rebuild:** the sources are in `addons/armor-hud/src`. The HUD layout is generated, so positions and sizes are the constants at the top of `build.mjs`.

```bash
node addons/armor-hud/generate-icons.mjs --refresh   # only after a game update: rebuilds the icon table from Mojang's data
node addons/armor-hud/build.mjs   # writes the .mcaddon (needs the zip command)
node addons/armor-hud/test.mjs    # checks the script logic and the generated HUD expressions
```

## Remote play (playit.gg)

1. **Network → Remote play → Enable playit tunnels.** The agent is downloaded (or the bundled binary is used) and started.
2. Click **Open claim page**, sign in to playit.gg (free) and approve the agent. The secret is stored in `data/playit/playit.toml`.
3. Pick a server and **Create tunnel**. A `*.joinmc.link`-style address appears here and on the server's page. Java tunnels are TCP; Bedrock and Geyser tunnels are UDP.

Tunnels created on the playit website also show up as long as they point at `127.0.0.1:<server port>`.

The bundled agent is pinned to playit **0.15.26**, the last single-binary release whose `start` command prints the claim link and stores the secret itself (`PLAYIT_VERSION` build arg / `MCSM_PLAYIT_VERSION` env). playit 1.x split into a `playitd` daemon plus an IPC frontend; supporting that is a planned follow-up. Other tunnel services (ngrok TCP, Cloudflare Tunnel, Tailscale) can target the same ports from a sidecar.

## How updates work

**Java.** The installer resolves the download for the chosen flavor and version, removes only the previous binaries (`server.jar`, Fabric launcher, Forge/NeoForge library folders) and installs the new ones. Forge/NeoForge installers run headless and the server is launched via the generated `unix_args.txt`. Worlds, `server.properties`, whitelist/ops, `plugins/` and `mods/` are untouched.

**Bedrock.** Mojang has no version manifest for BDS, so the manager uses the same download-links API as the official download page to find the current release and preview, and falls back to the known CDN URL pattern for an explicit version. On update the zip is extracted with `server.properties`, `allowlist.json`, `permissions.json`, `worlds/`, `behavior_packs/` and `resource_packs/` excluded.

Downloads are cached in `data/cache`, so re-creating a server on the same version is instant.

## Docker image

The image is published as **`imfaraz/minecraft-server-manager`** for `linux/amd64` (x86_64 servers) and `linux/arm64` (Apple Silicon Macs, ARM boards). `docker compose up -d` pulls it; `docker compose up -d --build` builds from source. Override the name with `MCSM_IMAGE` / `MCSM_IMAGE_TAG` in `.env`.

Publish a new version yourself:

```bash
./publish.sh            # builds both architectures with buildx and pushes :<version> and :latest
./publish.sh 0.2.0      # explicit tag
```

The GitHub Actions workflow in `.github/workflows/docker-publish.yml` does the same **on demand**: Actions → *Publish Docker image* → *Run workflow* (optional tag and platform inputs). It needs the `DOCKERHUB_USERNAME` and `DOCKERHUB_TOKEN` secrets (and optionally a `DOCKERHUB_IMAGE` variable).

## Development

```bash
# API (http://localhost:8080) — data goes to ./data
cd server && npm install && npm run dev

# UI with hot reload (http://localhost:5173, proxies /api and /ws)
cd web && npm install && npm run dev
```

Java servers run on the host in dev mode (your system `java` is detected; missing majors are downloaded). Bedrock needs Linux, so test it in the container:

```bash
docker compose up --build
```

## Layout

```
server/   Fastify + TypeScript API: process supervisor, installers, backups, players, addons, files, playit, websocket
web/      React + Vite + Tailwind UI
data/     (created at runtime) servers/<id>/{server.json,root/,backups/}, runtimes/, cache/, playit/, config.json
```

## Security notes

- Single admin account (bcrypt), HMAC-signed session cookie, all API and websocket routes require it. Put the UI behind HTTPS (reverse proxy) if you expose it beyond your LAN.
- Optional **two-factor authentication** (System → Two-factor authentication): TOTP compatible with Google Authenticator, Authy, 1Password, Bitwarden etc., enrolled by QR code or setup key, with 8 one-time recovery codes. Codes are replay-protected and failed logins are rate-limited per IP.
- Existing sessions are invalidated when the token format changes; just sign in again.
- The file manager and addon installers are jailed to each server's directory (path normalisation + realpath checks). Uploads are capped at 2 GB.
- Processes run as `PUID:PGID` (default 1000:1000), never as root after startup.

## Credits and third-party software

Blockhost orchestrates these projects; it does not include their source code and is not affiliated with or endorsed by them. Thank you to their authors and contributors.

| Project | What Blockhost uses it for | How it is obtained | License |
| --- | --- | --- | --- |
| [Geyser](https://geysermc.org) ([GeyserMC/Geyser](https://github.com/GeyserMC/Geyser)) by the GeyserMC team | Lets Bedrock clients join Java servers (the *Cross-play* toggle), including its built-in NetherNet signaling | Latest build downloaded from `download.geysermc.org` into the server's `plugins/` or `mods/` when you enable the toggle. Not bundled. | MIT |
| [Floodgate](https://github.com/GeyserMC/Floodgate) by the GeyserMC team | Lets Bedrock players join online-mode Java servers without a Java account | Downloaded alongside Geyser from `download.geysermc.org`. Not bundled. | MIT |
| [MCXboxBroadcast](https://github.com/MCXboxBroadcast/Broadcaster) by rtm516 and contributors | Advertises a server over Xbox Live so Switch, Xbox and PlayStation players can join from the Friends tab (the *Console players* toggle) | The unmodified `MCXboxBroadcastStandalone.jar` release (build 162) is included in the Docker image under `/opt/mcxboxbroadcast/` with its license, and run as a separate process. Source for that build: <https://github.com/MCXboxBroadcast/Broadcaster/tree/162>. | GPL-3.0 |

Notes:

- Geyser, Floodgate and MCXboxBroadcast keep their own licenses and copyrights. Blockhost only downloads, configures and supervises them; its own code is not derived from theirs.
- MCXboxBroadcast is distributed under the GNU General Public License v3.0. You may obtain, modify and redistribute it under that license from the repository above. Its authors recommend using an alternate Microsoft account, because the tool emulates parts of a game client.
- Blockhost also talks to services run by others: Mojang's version and download APIs, PaperMC, PurpurMC, FabricMC, Forge, NeoForge, Adoptium (Java runtimes), Modrinth (mods and plugins) and playit.gg (tunnels). Their terms apply to what you download through them.
- Minecraft is a trademark of Mojang AB / Microsoft. This project is not an official Minecraft product and is not approved by or associated with Mojang or Microsoft.
