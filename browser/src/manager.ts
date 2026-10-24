import type { Config } from "./config.js";
import type { SupervisorPorts } from "./host.js";
import type { Logger } from "./logger.js";
import type { SessionMode, SessionState } from "./machine.js";
import { SlotPool, type PoolSlot } from "./pool.js";
import type { ProcessSpawner } from "./spawner.js";
import type { ArtifactStore } from "./artifacts.js";
import { ProfileError, ProfileStore } from "./profiles.js";
import {
  RegistryError,
  type MetricsSnapshot,
  type SessionHandle,
  type SessionInfo,
  type SessionRegistry,
} from "./registry.js";
import { SessionSupervisor } from "./supervisor.js";

export interface ManagerDeps {
  spawner: ProcessSpawner;
  ports: SupervisorPorts;
  config: Config;
  artifacts: ArtifactStore;
  profiles: ProfileStore;
  log: Logger;
}

/**
 * SessionManager: project → SessionSupervisor mapping, boot queue against
 * MAX_SESSIONS, RAM floor, idle GC and the operator-idle auto-release.
 */
export class SessionManager implements SessionRegistry {
  private readonly sessions = new Map<string, SessionSupervisor>();
  private readonly pool: SlotPool;

  constructor(private readonly deps: ManagerDeps) {
    this.pool = new SlotPool(deps.config.poolSize);
  }

  get(project: string): SessionHandle | undefined {
    return this.sessions.get(project);
  }

  async ensure(project: string): Promise<SessionHandle> {
    const existing = this.sessions.get(project);
    if (existing) {
      if (existing.state === "error") {
        throw new RegistryError(
          `session ${project} is in error state — DELETE then POST to reset`,
          409,
        );
      }
      if (existing.state === "booting") {
        // Another call is already booting this session — wait for it.
        await existing.boot().catch(() => undefined);
      }
      return existing;
    }
    await this.waitForCapacity();
    const freeRam = await this.deps.ports.freeRamBytes();
    if (freeRam < this.deps.config.ramFloorBytes) {
      throw new RegistryError(
        `RAM floor reached (${freeRam} < ${this.deps.config.ramFloorBytes} free) — refusing new boots`,
        503,
      );
    }
    const slot = this.pool.acquire();
    if (!slot) {
      throw new RegistryError("display pool exhausted", 503);
    }
    const supervisor = new SessionSupervisor(
      {
        spawner: this.deps.spawner,
        ports: this.deps.ports,
        config: this.deps.config,
        log: this.deps.log,
        artifactCount: (p) => this.deps.artifacts.count(p),
      },
      project,
      slot,
    );
    this.sessions.set(project, supervisor);
    try {
      await supervisor.boot();
    } catch (err) {
      // Keep the supervisor around (state=error) so its timeline is inspectable;
      // the state machine refuses further boots until DELETE + POST.
      throw new RegistryError(`boot failed for ${project}: ${String(err)}`, 503);
    }
    return supervisor;
  }

  /** Queue boots against MAX_SESSIONS; error after bootQueueTimeoutMs (Part 10.8). */
  private async waitForCapacity(): Promise<void> {
    const deadline = this.deps.ports.now() + this.deps.config.bootQueueTimeoutMs;
    while (this.sessions.size >= this.deps.config.maxSessions) {
      if (this.deps.ports.now() >= deadline) {
        throw new RegistryError(
          `session limit reached (${this.deps.config.maxSessions}) and queue timed out`,
          503,
        );
      }
      await this.deps.ports.sleep(250);
    }
  }

  async teardown(project: string): Promise<void> {
    const supervisor = this.sessions.get(project);
    if (!supervisor) return;
    this.sessions.delete(project);
    await supervisor.teardown();
    this.pool.release(supervisor.slot);
  }

  async list(): Promise<SessionInfo[]> {
    return Promise.all([...this.sessions.values()].map((s) => s.toInfo()));
  }

  async info(project: string): Promise<SessionInfo | null> {
    const supervisor = this.sessions.get(project);
    return supervisor ? supervisor.toInfoWithTimeline() : null;
  }

  async setMode(project: string, mode: SessionMode): Promise<SessionInfo> {
    const supervisor = this.sessions.get(project);
    if (!supervisor) throw new RegistryError(`no session for project ${project}`, 404);
    if (supervisor.state !== "ready") {
      throw new RegistryError(`session ${project} is ${supervisor.state}, not ready`, 409);
    }
    if (mode === "operator") supervisor.takeover("api");
    else supervisor.release("api");
    return supervisor.toInfo();
  }

  async profileAction(
    project: string,
    action: "attach" | "commit" | "detach",
    name: string,
  ): Promise<SessionInfo> {
    const supervisor = this.sessions.get(project);
    if (!supervisor) throw new RegistryError(`no session for project ${project}`, 404);
    if (!ProfileStore.validName(name)) throw new RegistryError(`invalid profile name: ${name}`, 400);
    try {
      switch (action) {
        case "attach": {
          // A profile is a credential: attach only while an operator drives.
          if (supervisor.mode !== "operator") {
            throw new RegistryError("profile attach requires operator mode", 409);
          }
          const dir = await this.deps.profiles.attach(name, project);
          supervisor.setUserDataDir(dir, name);
          await supervisor.restart(`profile attach ${name}`);
          break;
        }
        case "commit": {
          if (supervisor.mode !== "operator") {
            throw new RegistryError("profile commit requires operator mode", 409);
          }
          const storageState = await supervisor.captureStorageState();
          await this.deps.profiles.commit(name, storageState);
          supervisor.release(`profile commit ${name}`);
          break;
        }
        case "detach": {
          const holder = this.deps.profiles.holder(name);
          if (holder !== null && holder !== project) {
            throw new RegistryError(`profile ${name} is held by ${holder}`, 409);
          }
          await this.deps.profiles.detach(name);
          supervisor.setUserDataDir(null, null);
          await supervisor.restart(`profile detach ${name}`);
          break;
        }
      }
    } catch (err) {
      if (err instanceof ProfileError) throw new RegistryError(err.message, 409);
      throw err;
    }
    return supervisor.toInfo();
  }

  /** Idle GC (30 min) + operator auto-release (5 min without a viewer WS). */
  async sweepIdle(): Promise<void> {
    const now = this.deps.ports.now();
    for (const [project, supervisor] of [...this.sessions.entries()]) {
      if (
        supervisor.mode === "operator" &&
        supervisor.viewerCount === 0 &&
        now - supervisor.lastViewerAt > this.deps.config.idleOperatorMs
      ) {
        supervisor.release("operator idle");
      }
      const idleMs = now - supervisor.lastActivityAt;
      const noViewers = supervisor.viewerCount === 0;
      if (noViewers && idleMs > this.deps.config.idleSessionMs && supervisor.state !== "booting") {
        this.deps.log.info("idle teardown", { project, idleMs });
        await this.teardown(project);
        continue;
      }
      await supervisor.checkWatchdog().catch(() => undefined);
    }
  }

  async metrics(): Promise<MetricsSnapshot> {
    const sessionsByState: Record<SessionState, number> = {
      stopped: 0,
      booting: 0,
      ready: 0,
      error: 0,
    };
    let bootsTotal = 0;
    let crashesTotal = 0;
    let screencastFramesTotal = 0;
    for (const supervisor of this.sessions.values()) {
      sessionsByState[supervisor.state]++;
      bootsTotal += supervisor.bootCount;
      crashesTotal += supervisor.crashCount;
      screencastFramesTotal += supervisor.screencastFrames;
    }
    return {
      poolTotal: this.pool.total,
      poolUsed: this.pool.used,
      sessionsByState,
      bootsTotal,
      crashesTotal,
      screencastFramesTotal,
      freeRamBytes: await this.deps.ports.freeRamBytes(),
    };
  }

  async shutdown(): Promise<void> {
    const projects = [...this.sessions.keys()];
    await Promise.all(projects.map((project) => this.teardown(project).catch(() => undefined)));
  }
}
