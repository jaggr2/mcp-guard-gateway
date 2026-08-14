# syntax=docker/dockerfile:1
# Multi-stage build for the MCP Guard Gateway (Node 22 + Hono + SQLite + Angular).
FROM node:22-bookworm AS build

WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

# Angular frontend (if present)
COPY web/package.json web/package-lock.json* ./web/
RUN if [ -d web ]; then cd web && npm ci; fi

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npx esbuild src/index.ts --bundle --platform=node --format=esm --packages=external --outfile=dist/index.js

RUN if [ -d web/src ]; then cd web && npm run build; fi

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
