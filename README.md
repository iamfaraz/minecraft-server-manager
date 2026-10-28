# Blockhost — Minecraft server manager (Java + Bedrock)

A single Docker container that runs and manages any number of Minecraft servers, Java **and** Bedrock, behind a modern web UI.

- **One container.** The manager, every Minecraft server process, the Java runtimes and the playit.gg agent all live in one container with one data volume.
- **Java flavors:** Vanilla, Paper, Purpur, Fabric, Forge, NeoForge. **Bedrock:** official Bedrock Dedicated Server (release or preview). Version catalogs come straight from Mojang, PaperMC, PurpurMC, FabricMC, Forge and NeoForge.
- **Correct Java every time.** The required Java major is read from Mojang's version metadata (e.g. 26.x → Java 25, 1.21 → 21, 1.20.4 → 17, ≤1.16 → 8). Java 21 and 25 are bundled; other versions download from Adoptium on demand. Override per server if you want.
- **Update in place or branch off.** Change a server's version/flavor while keeping its world, configs, plugins and mods (a world backup is taken first), or create a brand-new server on another version and import the world from an existing server or one of its backups.
- **Safe hot backups.** Running servers are frozen through the proper console pipeline (`save-off`/`save-all flush` on Java, `save hold`/`save query` with byte-exact truncation on Bedrock) so backups are consistent without kicking anyone. Manual and scheduled, with retention.
- **Live console** (stdin/stdout, no RCON needed), **telemetry** (CPU, memory, players, ping via Server List Ping / RakNet), **player management** (whitelist/allowlist, ops, bans, kicks; Mojang UUID lookup; offline-mode UUIDs), **addons** (Modrinth search + one-click install with dependencies for plugins/mods; `.mcpack`/`.mcaddon` install for Bedrock), **jailed file manager** with editor, and a **server.properties** editor.
- **Cross-play:** one toggle installs Geyser + Floodgate on Paper/Purpur/Fabric/NeoForge servers so Bedrock players can join Java servers.
- **Remote play without port forwarding:** built-in [playit.gg](https://playit.gg) agent. Enable it, claim it once in your browser, then create a tunnel per server from the UI to get a public address.
- Graceful lifecycle: `stop` → wait → SIGTERM → SIGKILL; crash detection with OOM hints and bounded auto-restart; servers that were running are resumed after the container restarts.
- **Bedrock transport choice:** RakNet (classic, pingable, tunnel-friendly) or NetherNet (Mojang's new WebRTC transport, the BDS default) per server.
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
| `MCSM_BEDROCK_PORTS`  | `19132-19141`  | Bedrock servers (2 UDP ports each) and Geyser |

Widen the ranges in `.env` if you need more servers. Players on your LAN connect to `<host-ip>:<port>`; the UI shows the address on each server.

### Run as your own user (PUID/PGID)

The container starts as root only to make `/data` writable, then drops to `PUID:PGID` for the manager and every server process, so everything under `./data` is owned by you rather than root:

```bash
printf 'PUID=%s\nPGID=%s\n' "$(id -u)" "$(id -g)" >> .env
docker compose up -d
```

### Memory

`mem_limit` in `docker-compose.yml` (default `12g`, sized for a 16 GB host) caps the whole container. Each Java server's `-Xmx` is set in its settings; keep 1–2 GB of headroom per JVM, plus ~1 GB for each Bedrock server. The System page shows the running total against the limit and warns when you are close to the OOM killer.

### Bedrock transport: RakNet vs NetherNet

Recent Bedrock Dedicated Server builds default to **NetherNet**, Mojang's WebRTC-based transport, with the classic **RakNet** UDP protocol still available. Each Bedrock server has a transport switch (wizard and Settings):

| | RakNet (default here) | NetherNet |
| --- | --- | --- |
| Ports | 2 UDP (IPv4 + IPv6), both published | 1 UDP (dual-stack) |
| Status ping / MOTD / player count | Yes (RakNet unconnected ping) | No standard ping; state comes from the log |
| LAN discovery | Only the server on 19132 (BDS binds 19132/19133 for discovery) | Yes |
| Behind NAT, Docker on another host, playit | Works as-is | Needs `server-udp-ports=publicIP:publicPort:localPort` in server.properties |

The manager writes `transport`, `server-port`, `server-portv6`, `server-udp-ports` and `enable-lan-visibility` consistently for whichever you pick. Transport changes apply on the next start.

**NetherNet and Docker networking.** NetherNet negotiates addresses *inside* the protocol (WebRTC/ICE), so on Docker's bridge network the server would advertise its internal 172.x address and clients fail with a NetherNet error even though the UDP port is published. Two fixes, both handled for you:

- **Host networking (Linux, recommended).** `deploy.sh` offers it on Linux and writes `COMPOSE_FILE=docker-compose.yml:docker-compose.host.yml` into `.env`. Ports open directly on the host, Bedrock LAN discovery (the Friends tab) works, and no address mapping is needed. Manually: `docker compose -f docker-compose.yml -f docker-compose.host.yml up -d`.
- **Advertised IP (bridge mode).** `deploy.sh` stores your LAN IP as `MCSM_ADVERTISE_IP`; the manager then writes `server-udp-ports=<ip>:<port>:<port>` for NetherNet servers. Override per server under Settings → *Advertised IP for NetherNet* (use your public IP when port-forwarding).

LAN discovery in bridge mode never works (broadcasts don't cross the Docker bridge); players must use *Add Server* with the host IP and port.

### Apple Silicon and other ARM hosts

Bedrock Dedicated Server is x86_64-only. The ARM image bundles [box64](https://github.com/ptitSeb/box64) and runs BDS through it automatically; Java servers run natively. If you'd rather run everything as x86_64 under Rosetta/QEMU, uncomment `platform: linux/amd64` in the compose file.

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

The GitHub Actions workflow in `.github/workflows/docker-publish.yml` does the same on every push to `main` and on `v*` tags; add `DOCKERHUB_USERNAME` and `DOCKERHUB_TOKEN` secrets to the repo (and optionally a `DOCKERHUB_IMAGE` variable) to enable it.

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
- The file manager and addon installers are jailed to each server's directory (path normalisation + realpath checks). Uploads are capped at 2 GB.
- Processes run as `PUID:PGID` (default 1000:1000), never as root after startup.
