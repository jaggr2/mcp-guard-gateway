/**
 * Static pool mapping (Part 10.2): display :N ↔ CDP 922N ↔ vnc 590N ↔ ws 608N,
 * N ∈ 1..poolSize, mutex-allocated. Predictable mapping beats dynamic
 * allocation for debugging.
 */
export interface PoolSlot {
  n: number;
  display: string;
  cdpPort: number;
  vncPort: number;
  wsPort: number;
}

export function slotFor(n: number): PoolSlot {
  return {
    n,
    display: `:${n}`,
    cdpPort: 9220 + n,
    vncPort: 5900 + n,
    wsPort: 6080 + n,
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
