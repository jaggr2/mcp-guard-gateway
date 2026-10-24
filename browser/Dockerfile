# syntax=docker/dockerfile:1
# browser-orchestrator (Browser Broker, Part 12.2): Xvfb + openbox + x11vnc +
# noVNC/websockify + Chromium + the Node 24 orchestrator. The runtime MCP
# servers (@playwright/mcp, chrome-devtools-mcp) are NOT bundled — sessions
# spawn them via `npx` on demand.
FROM node:24-bookworm AS build

WORKDIR /app
COPY package*.json ./
RUN npm install

COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

# ---------------------------------------------------------------------------
FROM node:24-bookworm

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

COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY entrypoint.sh /usr/local/bin/entrypoint.sh

RUN chmod +x /usr/local/bin/entrypoint.sh \
    && mkdir -p /var/lib/browser-host/artifacts /var/lib/browser-host/profiles

ENV ORCHESTRATOR_PORT=8940 \
    ARTIFACTS_DIR=/var/lib/browser-host/artifacts \
    PROFILES_DIR=/var/lib/browser-host/profiles \
    NOVNC_PATH=/usr/share/novnc \
    CHROMIUM_BIN=chromium

EXPOSE 8940
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
