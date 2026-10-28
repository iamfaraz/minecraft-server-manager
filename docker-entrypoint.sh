#!/bin/sh
# Runs as root only long enough to make /data writable by PUID:PGID, then drops privileges.
set -e
PUID="${PUID:-1000}"
PGID="${PGID:-1000}"
export HOME="${HOME:-/data/.home}"

if [ "$(id -u)" = "0" ]; then
  if ! getent group "$PGID" >/dev/null 2>&1; then groupadd -o -g "$PGID" blockhost; fi
  if ! getent passwd "$PUID" >/dev/null 2>&1; then useradd -o -M -u "$PUID" -g "$PGID" -d "$HOME" -s /bin/sh blockhost; fi
  mkdir -p /data "$HOME"
  # Only touch files that are not already owned correctly (fast on big worlds).
  find /data \( ! -user "$PUID" -o ! -group "$PGID" \) -exec chown -h "$PUID:$PGID" {} + 2>/dev/null || true
  echo "[entrypoint] running as uid=$PUID gid=$PGID"
  exec setpriv --reuid="$PUID" --regid="$PGID" --init-groups "$@"
fi
exec "$@"
