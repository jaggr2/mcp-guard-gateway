# syntax=docker/dockerfile:1
# Multi-stage build for the MCP Guard Gateway (Node 22 + Hono + SQLite + Angular).
FROM node:22-bookworm AS build

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
FROM node:22-bookworm

WORKDIR /app
ENV NODE_ENV=production

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist
COPY --from=build /app/web/dist ./web/dist

RUN mkdir -p /data && chown -R node:node /data

EXPOSE 8080
USER node
CMD ["node", "dist/index.js"]
