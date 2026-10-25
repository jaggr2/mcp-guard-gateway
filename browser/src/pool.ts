/**
 * Static pool mapping (Part 10.2): display :N ↔ CDP 922N ↔ vnc 590N ↔ ws 608N
 * ↔ vnc input 609N, N ∈ 1..poolSize, mutex-allocated. Predictable mapping
 * beats dynamic allocation for debugging.
 *
 * Each session runs two x11vnc processes against the same display:
 * `vncPort` (590N) is the **view-only** one (`-viewonly` — input is dropped)
 * and `vncInputPort` (609N) the **interactive** one used for operator
 * takeover. `wsPort` (608N) is the websockify WS endpoint for the view-only
 * port, kept as a raw RFB-over-WS entry point.
 */
export interface PoolSlot {
  n: number;
  display: string;
  cdpPort: number;
  /** View-only x11vnc RFB port (590N). */
  vncPort: number;
  /** websockify WS port (608N → 590N). */
  wsPort: number;
  /** Interactive x11vnc RFB port (609N) — takeover input. */
  vncInputPort: number;
}

export function slotFor(n: number): PoolSlot {
  return {
    n,
    display: `:${n}`,
    cdpPort: 9220 + n,
    vncPort: 5900 + n,
    wsPort: 6080 + n,
    vncInputPort: 6090 + n,
  };
}

export class SlotPool {
  private readonly inUse = new Set<number>();

  constructor(readonly size = 8) {}

  acquire(): PoolSlot | null {
    for (let n = 1; n <= this.size; n++) {
      if (!this.inUse.has(n)) {
        this.inUse.add(n);
        return slotFor(n);
      }
    }
    return null;
  }

  release(slot: PoolSlot): void {
    this.inUse.delete(slot.n);
  }

  get used(): number {
    return this.inUse.size;
  }

  get total(): number {
    return this.size;
  }
}
