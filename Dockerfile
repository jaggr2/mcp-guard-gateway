# syntax=docker/dockerfile:1
# Multi-stage build for ONE image serving TWO roles (Warden stack):
#   - the MCP Guard Gateway (Node + Hono + SQLite + Angular admin UI), and
#   - the Browser Broker's browser-orchestrator + browser runtime (Xvfb,
#     openbox, x11vnc, noVNC/websockify, Chromium).
# The same image is deployed as two Incus instances with different entrypoints
# (see entrypoint.sh): `warden` runs the default CMD (gateway, :8080) and
# `browser-host` runs with ROLE=browser (orchestrator, :8940).

# ---------------------------------------------------------------------------
# Gateway build: deps, sources, Angular admin UI, esbuild bundle -> dist/
FROM node:24-bookworm AS gateway-build

WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

# Gateway sources + deps
COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src

# Angular admin UI
COPY web ./web
RUN cd web && npm ci && npm run build

RUN npx esbuild src/index.ts --bundle --platform=node --format=esm --packages=external --outfile=dist/index.js

# ---------------------------------------------------------------------------
# browser-orchestrator build (Browser Broker, Part 12.2): its own dependency
# tree + tsc -> browser/dist. The runtime MCP servers (@playwright/mcp,
# chrome-devtools-mcp) are NOT bundled — sessions spawn them via `npx` on
# demand.
FROM node:24-bookworm AS browser-build

WORKDIR /app/browser
COPY browser/package*.json ./
RUN npm ci

COPY browser/tsconfig.json ./
COPY browser/src ./src
RUN npm run build && npm prune --omit=dev

# ---------------------------------------------------------------------------
FROM node:24-bookworm

# Browser runtime (same package set as the former standalone browser image).
RUN apt-get update && apt-get install -y --no-install-recommends \
      xvfb \
      openbox \
      x11vnc \
      novnc \
      websockify \
      chromium \
      fonts-liberation \
      fonts-noto-color-emoji \
      fonts-noto-cjk \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
ENV NODE_ENV=production

# Gateway (default role)
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=gateway-build /app/dist ./dist
COPY --from=gateway-build /app/web/dist ./web/dist

# browser-orchestrator (ROLE=browser) — separate node_modules tree under
# /app/browser so both dependency sets coexist unchanged.
COPY --from=browser-build /app/browser/package.json ./browser/package.json
COPY --from=browser-build /app/browser/node_modules ./browser/node_modules
COPY --from=browser-build /app/browser/dist ./browser/dist

COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh \
    && mkdir -p /data /var/lib/browser-host/artifacts /var/lib/browser-host/profiles

ENV ORCHESTRATOR_PORT=8940 \
    ARTIFACTS_DIR=/var/lib/browser-host/artifacts \
    PROFILES_DIR=/var/lib/browser-host/profiles \
    NOVNC_PATH=/usr/share/novnc \
    CHROMIUM_BIN=chromium

EXPOSE 8080 8940
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["node", "dist/index.js"]
