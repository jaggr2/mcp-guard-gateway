import { createApp } from "../src/app";

const app = createApp({ DB_PATH: ":memory:", SECRET_MASTER_KEY: "dev", PUBLIC_URL: "https://mcp-guard.example" });

const health = await app.fetch(new Request("https://mcp-guard.example/healthz"));
console.log("healthz", health.status, await health.text());

const meta = await app.fetch(new Request("https://mcp-guard.example/.well-known/oauth-protected-resource"));
console.log("protected-resource", meta.status, await meta.text());

const api = await app.fetch(new Request("https://mcp-guard.example/api/status"));
console.log("api/status (no auth)", api.status, await api.text());

const apiAuth = await app.fetch(
  new Request("https://mcp-guard.example/api/status", {
    headers: { "Remote-Email": "roger@jaggi.xyz", "Remote-Groups": "admins" },
  })
);
console.log("api/status (forward-auth)", apiAuth.status, await apiAuth.text());

const mcp = await app.fetch(
  new Request("https://mcp-guard.example/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "smoke", version: "1" } },
    }),
  })
);
console.log("mcp initialize", mcp.status, await mcp.text());

const spa = await app.fetch(new Request("https://mcp-guard.example/upstreams"));
console.log("GET /upstreams (SPA fallback)", spa.status, (await spa.text()).slice(0, 80));

const asset = await app.fetch(new Request("https://mcp-guard.example/main-AHWZNMIS.js"));
console.log("GET /main-*.js", asset.status, asset.headers.get("content-type"));
