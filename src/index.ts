import { serve } from "@hono/node-server";
import { createApp } from "./app";

const env = process.env as Record<string, string | undefined>;
const app = createApp(env);

const host = env.HOST ?? "0.0.0.0";
const port = Number(env.PORT ?? 8080);

serve({ fetch: app.fetch, hostname: host, port }, (info) => {
  console.log(`mcp-guard-gateway listening on http://${info.address}:${info.port}`);
});
