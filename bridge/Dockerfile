# hermes-bridge: exposes `hermes mcp serve` (stdio) over Streamable HTTP.
# Extends the official hermes image (has the hermes CLI + venv + node) and adds
# the Node SDK relay. Mount the Hermes data volume at /opt/data.
FROM nousresearch/hermes-agent:v2026.8.13

WORKDIR /app

COPY package.json ./
RUN npm install && npm install --save-dev esbuild

COPY relay.ts ./
RUN npx esbuild relay.ts --bundle --platform=node --format=esm --packages=external --outfile=relay.js

ENV HERMES_CLI=/opt/hermes/bin/hermes
ENV PORT=8643
EXPOSE 8643

CMD ["node", "relay.js"]
