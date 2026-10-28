# syntax=docker/dockerfile:1.6
# ---------- build the web UI ----------
FROM node:22-bookworm-slim AS web
WORKDIR /app/web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

# ---------- build the API server ----------
FROM node:22-bookworm-slim AS server
WORKDIR /app/server
COPY server/package.json server/package-lock.json ./
RUN npm ci
COPY server/ ./
RUN npm run build && npm prune --omit=dev

# ---------- runtime: one container runs the manager + every Minecraft server ----------
FROM debian:bookworm-slim
LABEL org.opencontainers.image.title="Blockhost — Minecraft server manager" \
      org.opencontainers.image.description="Single-container manager for Java and Bedrock Minecraft servers with web UI, backups, addons and playit.gg tunnels" \
      org.opencontainers.image.source="https://github.com/iamfaraz/minecraft-server-manager"
ARG TARGETARCH
ARG MCSM_VERSION=dev
ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl unzip tar gnupg tini procps util-linux passwd \
      libcurl4 libssl3 libnss3 libstdc++6 \
    && rm -rf /var/lib/apt/lists/*

# Node.js runtime (copied from the official image, no package repo needed)
COPY --from=node:22-bookworm-slim /usr/local/bin/node /usr/local/bin/node

# Java 21 and 25 (Eclipse Temurin JRE) are bundled; other majors (8, 17, ...) are downloaded on demand into /data/runtimes
RUN ARCH=$([ "$TARGETARCH" = "arm64" ] && echo aarch64 || echo x64) \
    && for J in 21 25; do \
         mkdir -p /opt/java/$J \
         && curl -fsSL "https://api.adoptium.net/v3/binary/latest/$J/ga/linux/${ARCH}/jre/hotspot/normal/eclipse" \
            | tar -xz -C /opt/java/$J --strip-components=1 ; \
       done

# Bedrock Dedicated Server is x86_64 only: on ARM hosts run it through box64
RUN if [ "$TARGETARCH" = "arm64" ]; then \
      ( curl -fsSL https://ryanfortner.github.io/box64-debs/KEY.gpg | gpg --dearmor -o /usr/share/keyrings/box64-debs-archive-keyring.gpg \
        && echo "deb [signed-by=/usr/share/keyrings/box64-debs-archive-keyring.gpg] https://ryanfortner.github.io/box64-debs/debian ./" > /etc/apt/sources.list.d/box64.list \
        && apt-get update && apt-get install -y --no-install-recommends box64 \
        && rm -rf /var/lib/apt/lists/* ) \
      || echo "WARNING: box64 install failed; Bedrock servers will not run on this ARM image"; \
    fi

# playit.gg agent for remote play (falls back to a runtime download if this fails)
RUN ARCH=$([ "$TARGETARCH" = "arm64" ] && echo aarch64 || echo amd64) \
    && ( curl -fsSL -o /usr/local/bin/playit "https://github.com/playit-cloud/playit-agent/releases/latest/download/playit-linux-${ARCH}" \
         && chmod +x /usr/local/bin/playit ) \
    || echo "WARNING: playit download failed; it will be fetched at runtime when enabled"

WORKDIR /app
COPY --from=server /app/server/dist ./server/dist
COPY --from=server /app/server/node_modules ./server/node_modules
COPY --from=server /app/server/package.json ./server/package.json
COPY --from=web /app/web/dist ./web/dist
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

ENV MCSM_DATA_DIR=/data \
    MCSM_IN_DOCKER=1 \
    MCSM_PORT=8080 \
    MCSM_VERSION=${MCSM_VERSION} \
    HOME=/data/.home \
    PUID=1000 \
    PGID=1000 \
    NODE_ENV=production
VOLUME ["/data"]
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD curl -fsS http://127.0.0.1:8080/api/auth/status >/dev/null || exit 1

# tini reaps zombie server processes and forwards SIGTERM so worlds save on shutdown
ENTRYPOINT ["/usr/bin/tini", "-g", "--", "/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "server/dist/index.js"]
