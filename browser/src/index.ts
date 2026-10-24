import { serve } from "@hono/node-server";
import { ArtifactStore } from "./artifacts.js";
import { loadConfig } from "./config.js";
import { RealSupervisorPorts } from "./host.js";
import { createLogger } from "./logger.js";
import { SessionManager } from "./manager.js";
import { ProfileStore } from "./profiles.js";
import { RealProcessSpawner } from "./spawner.js";
import { createApp } from "./server.js";
import { createUpgradeHandler } from "./wsproxy.js";

const config = loadConfig();
const log = createLogger("browser-orchestrator");

const spawner = new RealProcessSpawner();
const ports = new RealSupervisorPorts();
const artifacts = new ArtifactStore(config.artifactsDir);
await artifacts.init();
const profiles = new ProfileStore(config.profilesDir);
const registry = new SessionManager({ spawner, ports, config, artifacts, profiles, log });

const app = createApp({ config, registry, artifacts, profiles, log });
const server = serve({ fetch: app.fetch, port: config.port, hostname: config.hostname });
server.on("upgrade", createUpgradeHandler({ registry, log }));

log.info("browser-orchestrator listening", {
  port: config.port,
  artifactsDir: config.artifactsDir,
  profilesDir: config.profilesDir,
  maxSessions: config.maxSessions,
});

// Idle GC (30 min) + operator auto-release (5 min) + Chromium RAM watchdog.
const sweeper = setInterval(() => {
  void registry.sweepIdle().catch((err) => log.warn("sweep failed", { err: String(err) }));
}, 30_000);
sweeper.unref();

// Artifact GC: daily, 14 days / 5 GB LRU (Part 10.6).
const gc = setInterval(() => {
  void artifacts
    .gc(config.gcMaxAgeMs, config.gcMaxBytes)
    .then((result) => log.info("artifact gc", { ...result }))
    .catch((err) => log.warn("artifact gc failed", { err: String(err) }));
}, 24 * 60 * 60_000);
gc.unref();

async function shutdown(signal: string): Promise<void> {
  log.info("shutting down", { signal });
  server.close();
  await registry.shutdown().catch((err) => log.error("shutdown failed", { err: String(err) }));
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
