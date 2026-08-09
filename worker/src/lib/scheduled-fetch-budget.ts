import { CRON_CONNECTION_BUDGET } from "@shared/lib/cron-jobs";
import { abortReason } from "./abort";

interface AllocationWaiter {
  weight: number;
  resolve: (release: () => void) => void;
  reject: (error: unknown) => void;
  signal?: AbortSignal;
  abortListener?: () => void;
}

export interface ScheduledFetchBudgetSnapshot {
  capacity: number;
  allocated: number;
  peakAllocated: number;
  waiting: number;
}

const fetchBudgetAbortReason = (signal: AbortSignal): unknown =>
  abortReason(signal, () => new Error("scheduled fetch allocation aborted"));

/**
 * Slot-local weighted semaphore for declared child fetch allocations. It does
 * not replace provider-level limiters; it prevents parallel child chains from
 * starting when their declared aggregate could consume all six connections.
 */
export class ScheduledFetchBudget {
  readonly capacity: number;
  private allocated = 0;
  private peakAllocated = 0;
  private readonly waiters: AllocationWaiter[] = [];

  constructor(capacity = CRON_CONNECTION_BUDGET.fullForNewFetchHeavyWorkAt) {
    if (!Number.isInteger(capacity) || capacity < 1 || capacity >= CRON_CONNECTION_BUDGET.failAt) {
      throw new Error(
        `Scheduled fetch budget capacity must be an integer below ${CRON_CONNECTION_BUDGET.failAt}`,
      );
    }
    this.capacity = capacity;
  }

  snapshot(): ScheduledFetchBudgetSnapshot {
    return {
      capacity: this.capacity,
      allocated: this.allocated,
      peakAllocated: this.peakAllocated,
      waiting: this.waiters.length,
    };
  }

  async acquire(weight: number, signal?: AbortSignal): Promise<() => void> {
    if (!Number.isInteger(weight) || weight < 0 || weight > this.capacity) {
      throw new Error(`Scheduled fetch allocation ${weight} exceeds slot capacity ${this.capacity}`);
    }
    if (signal?.aborted) throw fetchBudgetAbortReason(signal);
    if (weight === 0) return () => {};

    return new Promise<() => void>((resolve, reject) => {
      const waiter: AllocationWaiter = { weight, resolve, reject, ...(signal ? { signal } : {}) };
      if (signal) {
        waiter.abortListener = () => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          reject(fetchBudgetAbortReason(signal));
          this.drain();
        };
        signal.addEventListener("abort", waiter.abortListener, { once: true });
      }
      this.waiters.push(waiter);
      this.drain();
    });
  }

  async run<T>(weight: number, signal: AbortSignal | undefined, fn: () => Promise<T>): Promise<T> {
    const release = await this.acquire(weight, signal);
    try {
      return await fn();
    } finally {
      release();
    }
  }

  private drain(): void {
    while (this.waiters.length > 0) {
      const waiter = this.waiters[0]!;
      if (waiter.signal?.aborted) {
        this.waiters.shift();
        waiter.signal.removeEventListener("abort", waiter.abortListener!);
        waiter.reject(fetchBudgetAbortReason(waiter.signal));
        continue;
      }
      if (this.allocated + waiter.weight > this.capacity) return;

      this.waiters.shift();
      if (waiter.signal && waiter.abortListener) {
        waiter.signal.removeEventListener("abort", waiter.abortListener);
      }
      this.allocated += waiter.weight;
      this.peakAllocated = Math.max(this.peakAllocated, this.allocated);
      let released = false;
      waiter.resolve(() => {
        if (released) return;
        released = true;
        this.allocated = Math.max(0, this.allocated - waiter.weight);
        this.drain();
      });
    }
  }
}
