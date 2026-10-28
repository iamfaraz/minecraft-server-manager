#!/usr/bin/env bash
# Blockhost deploy script (Linux + macOS).
#  - picks a free web port (asks you if the default is taken)
#  - records your UID/GID so files in ./data are owned by you
#  - writes/updates .env and starts the stack with docker compose
#
# Usage: ./deploy.sh [--no-start] [--port N]
set -euo pipefail

cd "$(dirname "$0")"

ENV_FILE=".env"
DEFAULT_WEB_PORT="${MCSM_WEB_PORT:-8080}"
START=1
FORCE_PORT=""

while [ $# -gt 0 ]; do
  case "$1" in
    --no-start) START=0 ;;
    --port) FORCE_PORT="$2"; shift ;;
    -h|--help) sed -n '2,8p' "$0"; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
  shift
done

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
ok()   { printf '  \033[32m✔\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
die()  { printf '  \033[31m✖\033[0m %s\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------- helpers
# Returns 0 if something is listening on TCP $1 (or UDP when $2 = udp).
port_in_use() {
  local port="$1" proto="${2:-tcp}"
  if command -v lsof >/dev/null 2>&1; then
    if [ "$proto" = udp ]; then lsof -nP -iUDP:"$port" >/dev/null 2>&1 && return 0
    else lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1 && return 0; fi
  fi
  if command -v ss >/dev/null 2>&1; then
    if [ "$proto" = udp ]; then ss -lun 2>/dev/null | awk '{print $5}' | grep -Eq "[:.]${port}\$" && return 0
    else ss -ltn 2>/dev/null | awk '{print $4}' | grep -Eq "[:.]${port}\$" && return 0; fi
  fi
  if command -v netstat >/dev/null 2>&1; then
    netstat -an 2>/dev/null | grep -Ei "^(tcp|udp).*[:.]${port} .*(LISTEN|\*\.\*)" | grep -qi "$proto" && return 0
  fi
  # A container from a previous deploy counts as "in use by us" — fine, compose will reuse it.
  return 1
}

# Read KEY from .env (empty if missing).
env_get() { [ -f "$ENV_FILE" ] && grep -E "^$1=" "$ENV_FILE" | tail -1 | cut -d= -f2- || true; }

# Set KEY=VALUE in .env, replacing an existing line or appending.
env_set() {
  local key="$1" val="$2"
  touch "$ENV_FILE"
  if grep -qE "^$key=" "$ENV_FILE"; then
    # portable in-place edit (GNU + BSD sed)
    local tmp; tmp="$(mktemp)"
    sed "s|^$key=.*|$key=$val|" "$ENV_FILE" > "$tmp" && mv "$tmp" "$ENV_FILE"
  else
    printf '%s=%s\n' "$key" "$val" >> "$ENV_FILE"
  fi
}

is_port() { [[ "$1" =~ ^[0-9]+$ ]] && [ "$1" -ge 1 ] && [ "$1" -le 65535 ]; }

# ---------------------------------------------------------------- checks
bold "Blockhost deploy"
OS="$(uname -s)"
case "$OS" in Linux|Darwin) ok "OS: $OS ($(uname -m))" ;; *) die "Unsupported OS: $OS (use Linux or macOS)" ;; esac

command -v docker >/dev/null 2>&1 || die "Docker is not installed. See https://docs.docker.com/engine/install/"
docker compose version >/dev/null 2>&1 || die "'docker compose' plugin is missing. Install Docker Compose v2."
docker info >/dev/null 2>&1 || die "Docker daemon is not running (or you lack permission; try: sudo usermod -aG docker \$USER and re-login)."
ok "Docker $(docker version --format '{{.Server.Version}}' 2>/dev/null)"

# ---------------------------------------------------------------- .env
[ -f "$ENV_FILE" ] || { cp .env.example "$ENV_FILE"; ok "Created $ENV_FILE from .env.example"; }

# UID/GID of the invoking user (even under sudo)
PUID="${SUDO_UID:-$(id -u)}"
PGID="${SUDO_GID:-$(id -g)}"
if [ "$PUID" = "0" ]; then
  warn "Running as root: data will be owned by root. Run as your normal user to avoid this."
fi
env_set PUID "$PUID"
env_set PGID "$PGID"
ok "Running servers as uid=$PUID gid=$PGID"

# Web port
WEB_PORT="${FORCE_PORT:-$(env_get MCSM_WEB_PORT)}"
WEB_PORT="${WEB_PORT:-$DEFAULT_WEB_PORT}"
is_port "$WEB_PORT" || die "Invalid port: $WEB_PORT"

# If our own container already publishes this port, that's not a conflict.
OWN_PORT="$(docker inspect -f '{{range $p, $c := .NetworkSettings.Ports}}{{range $c}}{{.HostPort}} {{end}}{{end}}' blockhost 2>/dev/null || true)"
while port_in_use "$WEB_PORT" tcp && ! grep -qw "$WEB_PORT" <<<"$OWN_PORT"; do
  warn "Port $WEB_PORT is already in use."
  if [ ! -t 0 ]; then die "Pick a free port with: ./deploy.sh --port <N>"; fi
  read -r -p "  Enter a different web UI port: " WEB_PORT
  is_port "$WEB_PORT" || { warn "Not a valid port."; WEB_PORT="$DEFAULT_WEB_PORT"; }
done
env_set MCSM_WEB_PORT "$WEB_PORT"
ok "Web UI port: $WEB_PORT"

# Game port ranges: warn (don't block) if the first port of a range is taken by something else.
JAVA_PORTS="$(env_get MCSM_JAVA_PORTS)"; JAVA_PORTS="${JAVA_PORTS:-25565-25574}"
BEDROCK_PORTS="$(env_get MCSM_BEDROCK_PORTS)"; BEDROCK_PORTS="${BEDROCK_PORTS:-19132-19141}"
env_set MCSM_JAVA_PORTS "$JAVA_PORTS"
env_set MCSM_BEDROCK_PORTS "$BEDROCK_PORTS"
if port_in_use "${JAVA_PORTS%%-*}" tcp && ! grep -qw "${JAVA_PORTS%%-*}" <<<"$OWN_PORT"; then
  warn "TCP ${JAVA_PORTS%%-*} is in use by another program; change MCSM_JAVA_PORTS in .env if the stack fails to start."
fi
if port_in_use "${BEDROCK_PORTS%%-*}" udp && ! grep -qw "${BEDROCK_PORTS%%-*}" <<<"$OWN_PORT"; then
  warn "UDP ${BEDROCK_PORTS%%-*} is in use by another program; change MCSM_BEDROCK_PORTS in .env if the stack fails to start."
fi
ok "Java ports $JAVA_PORTS (tcp), Bedrock ports $BEDROCK_PORTS (udp)"

# Memory limit default based on host RAM (leave ~4 GB for the OS), unless already set.
if [ -z "$(env_get MCSM_MEMORY_LIMIT)" ] || [ "$(env_get MCSM_MEMORY_LIMIT)" = "12g" ]; then
  if [ "$OS" = Linux ]; then TOTAL_KB=$(awk '/MemTotal/ {print $2}' /proc/meminfo); TOTAL_GB=$((TOTAL_KB / 1024 / 1024))
  else TOTAL_GB=$(( $(sysctl -n hw.memsize) / 1024 / 1024 / 1024 )); fi
  LIMIT_GB=$(( TOTAL_GB > 6 ? TOTAL_GB - 4 : TOTAL_GB / 2 ))
  [ "$LIMIT_GB" -lt 2 ] && LIMIT_GB=2
  env_set MCSM_MEMORY_LIMIT "${LIMIT_GB}g"
fi
ok "Container memory limit: $(env_get MCSM_MEMORY_LIMIT)"

# Advertised IP: what players type into "Add Server". NetherNet (WebRTC) Bedrock servers must announce it.
LAN_IP="$( (hostname -I 2>/dev/null || ipconfig getifaddr en0 2>/dev/null || true) | awk '{print $1}')"
if [ -z "$(env_get MCSM_ADVERTISE_IP)" ] && [ -n "$LAN_IP" ]; then env_set MCSM_ADVERTISE_IP "$LAN_IP"; fi
ok "Advertised IP for Bedrock NetherNet: $(env_get MCSM_ADVERTISE_IP) (edit MCSM_ADVERTISE_IP in .env for public/port-forwarded play)"

# Networking mode. Host networking (Linux only) lets phones/consoles discover servers on the LAN and makes
# NetherNet work without NAT mapping; bridge mode publishes fixed port ranges instead.
if [ "$OS" = Linux ] && [ -z "$(env_get COMPOSE_FILE)" ]; then
  NET_MODE=host
  if [ -t 0 ]; then
    read -r -p "  Use host networking? Recommended on Linux for Bedrock LAN discovery + NetherNet [Y/n]: " ans
    case "${ans:-Y}" in n|N) NET_MODE=bridge ;; esac
  fi
  if [ "$NET_MODE" = host ]; then env_set COMPOSE_FILE "docker-compose.yml:docker-compose.host.yml"; fi
fi
if [ -n "$(env_get COMPOSE_FILE)" ]; then ok "Network: host (ports are opened directly on this machine)"; else ok "Network: bridge (published port ranges)"; fi

DATA_DIR="$(env_get MCSM_DATA_DIR)"; DATA_DIR="${DATA_DIR:-./data}"
env_set MCSM_DATA_DIR "$DATA_DIR"
mkdir -p "$DATA_DIR"
ok "Data directory: $DATA_DIR"

# ---------------------------------------------------------------- start
if [ "$START" = 1 ]; then
  bold "Building and starting (first build downloads Java runtimes; this takes a few minutes)…"
  docker compose up -d --build
  echo
  HOST_IP="$( (hostname -I 2>/dev/null || ipconfig getifaddr en0 2>/dev/null || echo localhost) | awk '{print $1}')"
  ok "Blockhost is starting. Open: http://localhost:$WEB_PORT  (LAN: http://${HOST_IP:-localhost}:$WEB_PORT)"
  ok "Logs: docker compose logs -f"
else
  ok ".env written. Start with: docker compose up -d --build"
fi
