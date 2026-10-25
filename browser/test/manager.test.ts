import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { ArtifactStore } from "../src/artifacts.js";
import { SessionManager } from "../src/manager.js";
import { ProfileStore } from "../src/profiles.js";
import type { SessionHandle } from "../src/registry.js";
import { MockPorts, MockSpawner, nullLogger, testConfig } from "./helpers.js";

async function makeManager() {
  const dir = await mkdtemp(path.join(tmpdir(), "browser-mgr-"));
  const artifacts = new ArtifactStore(path.join(dir, "artifacts"));
  await artifacts.init();
  const profiles = new ProfileStore(path.join(dir, "profiles"));
  const spawner = new MockSpawner();
  const ports = new MockPorts();
  const config = testConfig();
  const manager = new SessionManager({ spawner, ports, config, artifacts, profiles, log: nullLogger });
  return { manager, spawner, ports, config };
}

async function readySession(manager: SessionManager): Promise<SessionHandle> {
  return manager.ensure("proj");
}

describe("operator auto-release (5 min) counts only interactive viewers", () => {
  it("a lingering passive watcher does not hold operator mode", async () => {
    const { manager, ports, config } = await makeManager();
    const session = await readySession(manager);

    session.takeover("api");
    expect(session.mode).toBe("operator");
    session.watcherOpened(); // passive watcher lingers (view-only route)

    ports.time += config.idleOperatorMs + 1;
    await manager.sweepIdle();
    expect(session.mode).toBe("agent"); // watcher must not block the release
  });

  it("an interactive (takeover) viewer holds operator mode until it disconnects", async () => {
    const { manager, ports, config } = await makeManager();
    const session = await readySession(manager);

    session.takeover("api");
    session.takeoverViewerOpened();

    ports.time += config.idleOperatorMs + 1;
    await manager.sweepIdle();
    expect(session.mode).toBe("operator"); // interactive viewer still driving

    session.takeoverViewerClosed();
    ports.time += config.idleOperatorMs + 1;
    await manager.sweepIdle();
    expect(session.mode).toBe("agent");
  });

  it("an API takeover without any viewer still auto-releases after the idle window", async () => {
    const { manager, ports, config } = await makeManager();
    const session = await readySession(manager);

    await manager.setMode("proj", "operator");
    ports.time += config.idleOperatorMs + 1;
    await manager.sweepIdle();
    expect(session.mode).toBe("agent");
  });
});

describe("viewer accounting", () => {
  it("distinguishes watchers (viewers) from interactive connections (takeoverViewers)", async () => {
    const { manager } = await makeManager();
    const session = await readySession(manager);

    session.watcherOpened();
    session.watcherOpened();
    session.takeoverViewerOpened();

    const [info] = await manager.list();
    expect(info.viewers).toBe(2);
    expect(info.takeoverViewers).toBe(1);
    expect(session.mode).toBe("agent"); // viewers alone never flip the mode
  });

  it("a watcher keeps the session alive past the idle teardown threshold", async () => {
    const { manager, ports, config } = await makeManager();
    const session = await readySession(manager);

    session.watcherOpened();
    ports.time += config.idleSessionMs + 1;
    await manager.sweepIdle();
    expect(manager.get("proj")).toBeDefined(); // someone is still watching

    session.watcherClosed();
    ports.time += config.idleSessionMs + 1;
    await manager.sweepIdle();
    expect(manager.get("proj")).toBeUndefined(); // no viewers + idle → teardown
  });
});
