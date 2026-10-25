import { describe, expect, it } from "vitest";
import { SlotPool, slotFor } from "../src/pool.js";

describe("slot pool (display :N ↔ CDP 922N ↔ vnc 590N ↔ ws 608N ↔ vnc input 609N)", () => {
  it("maps N to the static port layout", () => {
    expect(slotFor(1)).toEqual({
      n: 1,
      display: ":1",
      cdpPort: 9221,
      vncPort: 5901,
      wsPort: 6081,
      vncInputPort: 6091,
    });
    expect(slotFor(8)).toEqual({
      n: 8,
      display: ":8",
      cdpPort: 9228,
      vncPort: 5908,
      wsPort: 6088,
      vncInputPort: 6098,
    });
  });

  it("allocates mutex slots and releases them for reuse", () => {
    const pool = new SlotPool(3);
    const a = pool.acquire();
    const b = pool.acquire();
    const c = pool.acquire();
    expect([a?.n, b?.n, c?.n]).toEqual([1, 2, 3]);
    expect(pool.used).toBe(3);
    expect(pool.acquire()).toBeNull(); // exhausted

    pool.release(b!);
    expect(pool.used).toBe(2);
    const d = pool.acquire();
    expect(d?.n).toBe(2); // released slot is reused
    expect(pool.total).toBe(3);
  });
});
