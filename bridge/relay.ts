import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";

/**
 * stdio-bridge: fronts an arbitrary stdio MCP server over Streamable HTTP so the
 * gateway (an HTTP MCP client) can reach it. Used for `hermes mcp serve` and for
 * stdio-only upstreams such as `uvx unifi-network-mcp`.
 *
 * Configuration via environment:
 *   STDIO_COMMAND  JSON array, e.g. ["uvx","unifi-network-mcp@latest"]
 *   STDIO_ENV      JSON object of extra env vars for the child (optional)
 *   PORT           listen port (default 8643)
 *
 * NOTE (hermes): `messages_send` requires the Hermes gateway process to be
 * running (its platform adapters own the Telegram connection); if a sibling
 * container cannot reach the gateway's send engine, run the relay inside the
 * hermes container instead (see deploy docs).
 */

const HERMES_CLI = process.env.HERMES_CLI ?? "/opt/hermes/bin/hermes";
const PORT = Number(process.env.PORT ?? 8643);

function parseCommand(): { command: string; args: string[] } {
  const raw = process.env.STDIO_COMMAND;
  if (raw) {
    const list = JSON.parse(raw) as string[];
    if (!Array.isArray(list) || list.length === 0 || list.some((x) => typeof x !== "string")) {
      throw new Error("STDIO_COMMAND must be a JSON array of strings");
    }
    return { command: list[0], args: list.slice(1) };
  }
  return { command: HERMES_CLI, args: ["mcp", "serve"] };
}

const childEnv: Record<string, string> = {};
if (process.env.STDIO_ENV) {
  const parsed = JSON.parse(process.env.STDIO_ENV) as Record<string, unknown>;
  for (const [key, value] of Object.entries(parsed)) {
    childEnv[key] = String(value);
  }
}

const { command, args } = parseCommand();
const stdio = new StdioClientTransport({ command, args, env: childEnv });
const hermes = new Client({ name: "stdio-bridge", version: "0.1.0" }, { capabilities: {} });

await hermes.connect(stdio);
console.log(`stdio-bridge: connected to \`${command} ${args.join(" ")}\``);

function makeProxyServer(): Server {
  const server = new Server({ name: "hermes-bridge", version: "0.1.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const { tools } = await hermes.listTools();
    return { tools };
  });
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;
    return (await hermes.callTool({ name, arguments: args as Record<string, unknown> })) as never;
  });
  return server;
}

const app = new Hono();

app.get("/healthz", (c) => c.json({ ok: true }));

app.all("/mcp", async (c) => {
  const server = makeProxyServer();
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  return transport.handleRequest(c.req.raw);
});

serve({ fetch: app.fetch, port: PORT, hostname: "0.0.0.0" }, (info) => {
  console.log(`stdio-bridge listening on http://${info.address}:${info.port}`);
});
