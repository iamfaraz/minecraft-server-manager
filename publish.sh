#!/usr/bin/env bash
# Build the multi-arch image (linux/amd64 for x86_64 servers, linux/arm64 for Apple Silicon / ARM)
# and push it to Docker Hub.
#
# Usage: ./publish.sh [tag]            (default tag: version from server/package.json, also tags :latest)
#   MCSM_IMAGE=you/name ./publish.sh   (override image name; defaults to .env or imfaraz/minecraft-server-manager)
set -euo pipefail
cd "$(dirname "$0")"

[ -f .env ] && set -a && . ./.env && set +a
IMAGE="${MCSM_IMAGE:-imfaraz/minecraft-server-manager}"
VERSION="${1:-$(node -p "require('./server/package.json').version" 2>/dev/null || echo dev)}"
PLATFORMS="${PLATFORMS:-linux/amd64,linux/arm64}"

command -v docker >/dev/null || { echo "docker not found" >&2; exit 1; }
docker buildx version >/dev/null 2>&1 || { echo "docker buildx is required" >&2; exit 1; }

if ! docker buildx inspect mcsm-builder >/dev/null 2>&1; then
  docker buildx create --name mcsm-builder --driver docker-container --use >/dev/null
else
  docker buildx use mcsm-builder
fi

# Make sure we're logged in to Docker Hub (credentials may live in a credential helper).
HUB="https://index.docker.io/v1/"
logged_in() {
  grep -q "\"$HUB\"" ~/.docker/config.json 2>/dev/null && return 0
  local helper; helper="$(python3 -c "import json,os;print(json.load(open(os.path.expanduser('~/.docker/config.json'))).get('credsStore',''))" 2>/dev/null || true)"
  [ -n "$helper" ] && "docker-credential-$helper" list 2>/dev/null | grep -q "index.docker.io" && return 0
  return 1
}
if ! logged_in; then
  echo "Logging in to Docker Hub as ${IMAGE%%/*}…"
  docker login -u "${IMAGE%%/*}"
fi

echo "Building $IMAGE:$VERSION and $IMAGE:latest for $PLATFORMS"
docker buildx build \
  --platform "$PLATFORMS" \
  --build-arg "MCSM_VERSION=$VERSION" \
  -t "$IMAGE:$VERSION" \
  -t "$IMAGE:latest" \
  --push \
  .

echo "Pushed: docker pull $IMAGE:$VERSION"
