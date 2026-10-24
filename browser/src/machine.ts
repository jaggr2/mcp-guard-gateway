/**
 * Session state machine (Part 10.3). Pure — no process/fs side effects — so the
 * boot/ready/operator/error/crash-loop rules are unit-testable in isolation.
 *
 *                  boot (POST /api/sessions/:project or first tools/call)
 *   stopped ──────────────────────────────► booting ──ready──► ready ◄──release── operator
 *      ▲                                     │  ▲                 │               ▲
 *      │                          crash ─────┘  └── auto-reboot   │ take over     │
 *      │                                     ▼                    ▼ (noVNC open / API)
 *      └── teardown ◄── idle 30 min ◄── ready/agent          operator ──idle 5 min w/o WS──┘
 *                                    error (crash loop >3/5m) ── manual reset ──► stopped
 */
export const TAKEOVER_ERROR = "taken over by operator — retry after release";

export type SessionState = "stopped" | "booting" | "ready" | "error";
export type SessionMode = "agent" | "operator";

export interface MachineState {
  state: SessionState;
  mode: SessionMode;
  /** Boot attempts within the current boot cycle (stuck-boot retry once). */
  bootAttempts: number;
  /** Timestamps of recent crash events (crash-loop window). */
  crashes: number[];
}

export type MachineEvent =
  | { type: "boot" }
  | { type: "booted" }
  | { type: "boot_failed" }
  | { type: "crash"; at: number }
  | { type: "restart" }
  | { type: "takeover" }
  | { type: "release" }
  | { type: "teardown" }
  | { type: "reset" };

export type Effect = "spawn" | "kill" | "fail_inflight" | "enter_error";

export interface MachineOptions {
  crashWindowMs: number;
  crashLimit: number;
  /** Boot attempts per boot cycle: initial boot + one retry (Part 10.9). */
  maxBootAttempts: number;
}

export const DEFAULT_MACHINE_OPTIONS: MachineOptions = {
  crashWindowMs: 5 * 60_000,
  crashLimit: 3,
  maxBootAttempts: 2,
};

export interface TransitionResult {
  ok: boolean;
  reason?: string;
  next: MachineState;
  effects: Effect[];
}

export function initialMachine(): MachineState {
  return { state: "stopped", mode: "agent", bootAttempts: 0, crashes: [] };
}

function deny(current: MachineState, reason: string): TransitionResult {
  return { ok: false, reason, next: current, effects: [] };
}

export function transition(
  current: MachineState,
  event: MachineEvent,
  opts: MachineOptions = DEFAULT_MACHINE_OPTIONS,
): TransitionResult {
  switch (event.type) {
    case "boot": {
      if (current.state === "ready") return deny(current, "session already ready");
      if (current.state === "booting") return deny(current, "boot already in progress");
      if (current.state === "error") {
        return deny(current, "session in error state — DELETE then POST to reset");
      }
      return {
        ok: true,
        next: { state: "booting", mode: "agent", bootAttempts: 1, crashes: current.crashes },
        effects: ["spawn"],
      };
    }
    case "booted": {
      if (current.state !== "booting") return deny(current, "not booting");
      return { ok: true, next: { ...current, state: "ready", mode: "agent", bootAttempts: 0 }, effects: [] };
    }
    case "boot_failed": {
      if (current.state !== "booting") return deny(current, "not booting");
      if (current.bootAttempts < opts.maxBootAttempts) {
        // Kill the partial tree and retry the boot once (Part 10.9).
        return {
          ok: true,
          next: { ...current, bootAttempts: current.bootAttempts + 1 },
          effects: ["kill", "spawn"],
        };
      }
      return {
        ok: true,
        next: { state: "error", mode: "agent", bootAttempts: current.bootAttempts, crashes: current.crashes },
        effects: ["kill", "enter_error"],
      };
    }
    case "crash": {
      if (current.state === "stopped" || current.state === "error") return deny(current, "no live session");
      const crashes = [...current.crashes, event.at].filter((t) => t > event.at - opts.crashWindowMs);
      if (crashes.length > opts.crashLimit) {
        // >crashLimit crashes within the window: refuse further boots until reset.
        return {
          ok: true,
          next: { state: "error", mode: "agent", bootAttempts: 0, crashes },
          effects: ["fail_inflight", "kill", "enter_error"],
        };
      }
      // Chromium death: error in-flight calls, then auto-reboot the session once.
      return {
        ok: true,
        next: { state: "booting", mode: "agent", bootAttempts: 1, crashes },
        effects: ["fail_inflight", "kill", "spawn"],
      };
    }
    case "restart": {
      // Profile attach/detach: full tree restart without counting as a crash.
      if (current.state !== "ready") return deny(current, "restart requires a ready session");
      return {
        ok: true,
        next: { ...current, state: "booting", bootAttempts: 1 },
        effects: ["fail_inflight", "kill", "spawn"],
      };
    }
    case "takeover": {
      if (current.state !== "ready") return deny(current, "takeover requires a ready session");
      return { ok: true, next: { ...current, mode: "operator" }, effects: [] };
    }
    case "release": {
      if (current.state !== "ready" || current.mode !== "operator") {
        return deny(current, "not in operator mode");
      }
      return { ok: true, next: { ...current, mode: "agent" }, effects: [] };
    }
    case "teardown": {
      const effects: Effect[] = current.state === "stopped" ? [] : ["fail_inflight", "kill"];
      return {
        ok: true,
        next: { state: "stopped", mode: "agent", bootAttempts: 0, crashes: [] },
        effects,
      };
    }
    case "reset": {
      if (current.state !== "error") return deny(current, "reset only applies to the error state");
      return {
        ok: true,
        next: { state: "stopped", mode: "agent", bootAttempts: 0, crashes: [] },
        effects: [],
      };
    }
    default: {
      const exhaustive: never = event;
      return deny(current, `unknown event ${JSON.stringify(exhaustive)}`);
    }
  }
}

/** Mode gate: facade tool calls only flow in `ready` + `agent` (Part 10.4). */
export function canAcceptToolCalls(state: MachineState): boolean {
  return state.state === "ready" && state.mode === "agent";
}
