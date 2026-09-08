import { describe, expect, it } from "vitest";
import { ScheduledFetchBudget } from "../scheduled-fetch-budget";

describe("ScheduledFetchBudget", () => {
  it("keeps weighted child allocations below the five-connection slot ceiling", async () => {
    const budget = new ScheduledFetchBudget(5);
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let releaseSecond!: () => void;
    const secondGate = new Promise<void>((resolve) => { releaseSecond = resolve; });
    let thirdStarted = false;

    const first = budget.run(3, undefined, async () => firstGate);
    const second = budget.run(2, undefined, async () => secondGate);
    const third = budget.run(1, undefined, async () => { thirdStarted = true; });
    await Promise.resolve();
    await Promise.resolve();

    expect(budget.snapshot()).toMatchObject({ allocated: 5, peakAllocated: 5, waiting: 1 });
    expect(thirdStarted).toBe(false);
    releaseFirst();
    releaseSecond();
    await Promise.all([first, second, third]);
    expect(budget.snapshot()).toMatchObject({ allocated: 0, peakAllocated: 5, waiting: 0 });
  });

  it("removes an aborted waiter without consuming capacity", async () => {
    const budget = new ScheduledFetchBudget(5);
    const release = await budget.acquire(5);
    const controller = new AbortController();
    const waiting = budget.acquire(1, controller.signal);
    controller.abort(new Error("slot stopped"));

    await expect(waiting).rejects.toThrow("slot stopped");
    expect(budget.snapshot()).toMatchObject({ allocated: 5, waiting: 0 });
    release();
    expect(budget.snapshot().allocated).toBe(0);
  });

  it("keeps measured nested live-fetch concurrency below six", async () => {
    const budget = new ScheduledFetchBudget(5);
    let activeFetches = 0;
    let peakFetches = 0;
    let markPeakReached!: () => void;
    const peakReached = new Promise<void>((resolve) => { markPeakReached = resolve; });
    let releaseFetches!: () => void;
    const fetchGate = new Promise<void>((resolve) => { releaseFetches = resolve; });
    const measuredFetch = async () => {
      activeFetches++;
      peakFetches = Math.max(peakFetches, activeFetches);
      if (activeFetches === 5) markPeakReached();
      try {
        await fetchGate;
      } finally {
        activeFetches--;
      }
    };
    const runNestedFetches = (count: number) => Promise.all(
      Array.from({ length: count }, () => measuredFetch()),
    );

    const first = budget.run(3, undefined, () => runNestedFetches(3));
    const second = budget.run(2, undefined, () => runNestedFetches(2));
    const queued = budget.run(1, undefined, () => runNestedFetches(1));
    await peakReached;

    expect(activeFetches).toBe(5);
    expect(peakFetches).toBe(5);
    expect(budget.snapshot()).toMatchObject({ allocated: 5, waiting: 1 });
    releaseFetches();
    await Promise.all([first, second, queued]);
    expect(peakFetches).toBe(5);
    expect(activeFetches).toBe(0);
  });

  it("releases a failed callback and completes its queued successor", async () => {
    const budget = new ScheduledFetchBudget(1);
    const failure = new Error("transport failed");
    let reject!: (error: Error) => void;
    const gate = new Promise<never>((_resolve, rejectGate) => { reject = rejectGate; });
    const running = budget.run(1, undefined, () => gate);
    const rejected = expect(running).rejects.toBe(failure);
    const queued = budget.run(1, undefined, async () => "completed");
    expect(budget.snapshot()).toMatchObject({ allocated: 1, waiting: 1 });
    reject(failure);
    await rejected;
    await expect(queued).resolves.toBe("completed");
    expect(budget.snapshot()).toMatchObject({ allocated: 0, waiting: 0 });
  });

  it("ignores a second release without admitting excess work", async () => {
    const budget = new ScheduledFetchBudget(1);
    const release = await budget.acquire(1);
    const next = budget.acquire(1);
    release();
    const releaseNext = await next;
    release();
    const last = budget.acquire(1);
    expect(budget.snapshot()).toMatchObject({ allocated: 1, waiting: 1 });
    releaseNext();
    (await last)();
    expect(budget.snapshot().allocated).toBe(0);
  });

  it("preserves FIFO until aborting a heavy head drains a lighter waiter", async () => {
    const budget = new ScheduledFetchBudget(3);
    const release = await budget.acquire(2);
    const controller = new AbortController();
    const failure = new Error("head cancelled");
    const head = budget.acquire(2, controller.signal);
    const rejected = expect(head).rejects.toBe(failure);
    const light = budget.acquire(1);
    expect(budget.snapshot()).toMatchObject({ allocated: 2, waiting: 2 });
    controller.abort(failure);
    await rejected;
    const releaseLight = await light;
    expect(budget.snapshot()).toMatchObject({ allocated: 3, waiting: 0 });
    releaseLight();
    release();
  });

  it("keeps capacity unchanged for zero and invalid allocations", async () => {
    const budget = new ScheduledFetchBudget(3);
    const release = await budget.acquire(3);
    const before = budget.snapshot();
    (await budget.acquire(0))();
    for (const weight of [-1, 0.5, 4, NaN]) {
      await expect(budget.acquire(weight)).rejects.toThrow();
      expect(budget.snapshot()).toEqual(before);
    }
    release();
  });
});
