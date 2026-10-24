import { describe, expect, it } from "vitest";
import {
  canAcceptToolCalls,
  DEFAULT_MACHINE_OPTIONS,
  initialMachine,
  TAKEOVER_ERROR,
  transition,
  type MachineState,
} from "../src/machine.js";

const OPTS = { ...DEFAULT_MACHINE_OPTIONS, crashWindowMs: 300_000, crashLimit: 3, maxBootAttempts: 2 };

function boot(): MachineState {
  return transition(initialMachine(), { type: "boot" }, OPTS).next;
}

function ready(): MachineState {
  return transition(boot(), { type: "booted" }, OPTS).next;
}

describe("session state machine", () => {
  it("stopped --boot--> booting --booted--> ready (effects: spawn)", () => {
    const t1 = transition(initialMachine(), { type: "boot" }, OPTS);
    expect(t1.ok).toBe(true);
    expect(t1.next.state).toBe("booting");
    expect(t1.next.mode).toBe("agent");
    expect(t1.effects).toEqual(["spawn"]);

    const t2 = transition(t1.next, { type: "booted" }, OPTS);
    expect(t2.ok).toBe(true);
    expect(t2.next.state).toBe("ready");
    expect(t2.effects).toEqual([]);
  });

  it("refuses boot from ready / booting / error", () => {
    expect(transition(ready(), { type: "boot" }, OPTS).ok).toBe(false);
    expect(transition(boot(), { type: "boot" }, OPTS).ok).toBe(false);
    const errored = transition(boot(), { type: "boot_failed" }, OPTS).next; // attempts=1 -> retry
    const errored2 = transition(errored, { type: "boot_failed" }, OPTS).next;
    expect(errored2.state).toBe("error");
    const t = transition(errored2, { type: "boot" }, OPTS);
    expect(t.ok).toBe(false);
    expect(t.reason).toMatch(/error state/);
  });

  it("stuck booting: kill + retry once, then error", () => {
    const t1 = transition(boot(), { type: "boot_failed" }, OPTS);
    expect(t1.ok).toBe(true);
    expect(t1.next.state).toBe("booting");
    expect(t1.next.bootAttempts).toBe(2);
    expect(t1.effects).toEqual(["kill", "spawn"]);

    const t2 = transition(t1.next, { type: "boot_failed" }, OPTS);
    expect(t2.next.state).toBe("error");
    expect(t2.effects).toEqual(["kill", "enter_error"]);
  });

  it("crash from ready: fail in-flight + kill + auto-reboot once", () => {
    const t = transition(ready(), { type: "crash", at: 1_000 }, OPTS);
    expect(t.ok).toBe(true);
    expect(t.next.state).toBe("booting");
    expect(t.next.mode).toBe("agent"); // operator mode is dropped on crash
    expect(t.next.bootAttempts).toBe(1);
    expect(t.effects).toEqual(["fail_inflight", "kill", "spawn"]);
    expect(t.next.crashes).toEqual([1_000]);
  });

  it("crash loop: >3 crashes in 5 min -> error state, refuse boots", () => {
    let state = ready();
    for (let i = 0; i < 3; i++) {
      const t = transition(state, { type: "crash", at: 10_000 + i }, OPTS);
      expect(t.next.state).toBe("booting");
      state = transition(t.next, { type: "booted" }, OPTS).next;
    }
    const final = transition(state, { type: "crash", at: 10_500 }, OPTS);
    expect(final.next.state).toBe("error");
    expect(final.effects).toEqual(["fail_inflight", "kill", "enter_error"]);
    expect(transition(final.next, { type: "boot" }, OPTS).ok).toBe(false);
  });

  it("crashes outside the 5 min window do not accumulate", () => {
    let state = ready();
    for (const at of [0, 400_000, 800_000, 1_200_000]) {
      const t = transition(state, { type: "crash", at }, OPTS);
      expect(t.next.state).toBe("booting");
      state = transition(t.next, { type: "booted" }, OPTS).next;
    }
    expect(state.state).toBe("ready");
  });

  it("takeover/release flip the mode on ready only", () => {
    const readyState = ready();
    const t1 = transition(readyState, { type: "takeover" }, OPTS);
    expect(t1.ok).toBe(true);
    expect(t1.next.mode).toBe("operator");

    const t2 = transition(t1.next, { type: "release" }, OPTS);
    expect(t2.ok).toBe(true);
    expect(t2.next.mode).toBe("agent");

    expect(transition(readyState, { type: "release" }, OPTS).ok).toBe(false);
    expect(transition(boot(), { type: "takeover" }, OPTS).ok).toBe(false);
    expect(transition(initialMachine(), { type: "takeover" }, OPTS).ok).toBe(false);
  });

  it("teardown returns to stopped and clears crash history", () => {
    const crashed = transition(ready(), { type: "crash", at: 5 }, OPTS).next;
    const t = transition(crashed, { type: "teardown" }, OPTS);
    expect(t.ok).toBe(true);
    expect(t.next.state).toBe("stopped");
    expect(t.next.crashes).toEqual([]);
    expect(t.effects).toEqual(["fail_inflight", "kill"]);
  });

  it("reset is the only escape from error (DELETE + POST)", () => {
    const errored = transition(boot(), { type: "boot_failed" }, OPTS).next;
    const errored2 = transition(errored, { type: "boot_failed" }, OPTS).next;
    const reset = transition(errored2, { type: "reset" }, OPTS);
    expect(reset.ok).toBe(true);
    expect(reset.next.state).toBe("stopped");
    expect(transition(ready(), { type: "reset" }, OPTS).ok).toBe(false);
  });

  it("restart does not count as a crash", () => {
    const t = transition(ready(), { type: "restart" }, OPTS);
    expect(t.ok).toBe(true);
    expect(t.next.state).toBe("booting");
    expect(t.next.crashes).toEqual([]);
    expect(t.effects).toEqual(["fail_inflight", "kill", "spawn"]);
  });

  it("mode gate: tool calls only in ready + agent", () => {
    expect(canAcceptToolCalls(ready())).toBe(true);
    const operator = transition(ready(), { type: "takeover" }, OPTS).next;
    expect(canAcceptToolCalls(operator)).toBe(false);
    expect(canAcceptToolCalls(boot())).toBe(false);
    expect(canAcceptToolCalls(initialMachine())).toBe(false);
    expect(TAKEOVER_ERROR).toBe("taken over by operator — retry after release");
  });
});
