export interface Config {
  /** Bearer token required on management + MCP-facade endpoints. */
  token: string;
  port: number;
  hostname: string;
  /** Artifact store root (ARTIFACTS_DIR). */
  artifactsDir: string;
  /** Per-project playwright `--output-dir` staging area (derived). */
  stagingDir: string;
  /** Browser profile store root (PROFILES_DIR). */
  profilesDir: string;
  /** Where the installed noVNC client assets live (dev: placeholder page). */
  novncPath: string;
  /** Chromium binary (CHROMIUM_BIN). */
  chromiumBin: string;
  /** Concurrent live sessions (MAX_SESSIONS). */
  maxSessions: number;
  /** Display/port pool size, N in 1..poolSize. */
  poolSize: number;
  /** Idle teardown: no tool call / WS viewer for this long. */
  idleSessionMs: number;
  /** Operator auto-release: operator mode with no viewer WS for this long. */
  idleOperatorMs: number;
  /** Boot readiness gate budget per attempt. */
  bootTimeoutMs: number;
  /** How long a queued boot waits for a free session slot before erroring. */
  bootQueueTimeoutMs: number;
  /** SIGTERM -> SIGKILL grace when killing Chromium / children. */
  shutdownGraceMs: number;
  /** Refuse new boots while free RAM is below this. */
  ramFloorBytes: number;
  /** Chromium RSS watchdog threshold per session. */
  chromiumRamLimitBytes: number;
  /** Per-request timeout for facade calls forwarded to MCP children. */
  requestTimeoutMs: number;
  /** Crash-loop window / limit (Part 10.8: 3 crashes in 5 min -> error). */
  crashWindowMs: number;
  crashLimit: number;
  /** Screencast fan-out rate cap (frames per second). */
  screencastFps: number;
  /** Artifact GC: max age and max total size. */
  gcMaxAgeMs: number;
  gcMaxBytes: number;
}

const MINUTE = 60_000;

function intEnv(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) throw new Error(`invalid ${name}: ${raw}`);
  return Math.floor(n);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const token = env.ORCHESTRATOR_TOKEN ?? "";
  if (token === "") {
    throw new Error("ORCHESTRATOR_TOKEN is required (fail closed — no unauthenticated management API)");
  }
  const artifactsDir = env.ARTIFACTS_DIR ?? "/var/lib/browser-host/artifacts";
  return {
    token,
    port: intEnv(env, "ORCHESTRATOR_PORT", 8940),
    hostname: env.ORCHESTRATOR_HOSTNAME ?? "0.0.0.0",
    artifactsDir,
    stagingDir: `${artifactsDir}/_staging`,
    profilesDir: env.PROFILES_DIR ?? "/var/lib/browser-host/profiles",
    novncPath: env.NOVNC_PATH ?? "/usr/share/novnc",
    chromiumBin: env.CHROMIUM_BIN ?? "chromium",
    maxSessions: intEnv(env, "MAX_SESSIONS", 2),
    poolSize: intEnv(env, "POOL_SIZE", 8),
    idleSessionMs: intEnv(env, "IDLE_SESSION_MINUTES", 30) * MINUTE,
    idleOperatorMs: intEnv(env, "IDLE_OPERATOR_MINUTES", 5) * MINUTE,
    bootTimeoutMs: intEnv(env, "BOOT_TIMEOUT_MS", 10_000),
    bootQueueTimeoutMs: intEnv(env, "BOOT_QUEUE_TIMEOUT_MS", 30_000),
    shutdownGraceMs: intEnv(env, "SHUTDOWN_GRACE_MS", 5_000),
    ramFloorBytes: intEnv(env, "RAM_FLOOR_BYTES", 1_500_000_000),
    chromiumRamLimitBytes: intEnv(env, "CHROMIUM_RAM_LIMIT_BYTES", 1_500_000_000),
    requestTimeoutMs: intEnv(env, "REQUEST_TIMEOUT_MS", 120_000),
    crashWindowMs: intEnv(env, "CRASH_WINDOW_MS", 5 * MINUTE),
    crashLimit: intEnv(env, "CRASH_LIMIT", 3),
    screencastFps: intEnv(env, "SCREENCAST_FPS", 5),
    gcMaxAgeMs: intEnv(env, "GC_MAX_AGE_DAYS", 14) * 24 * 60 * MINUTE,
    gcMaxBytes: intEnv(env, "GC_MAX_BYTES", 5_000_000_000),
  };
}
