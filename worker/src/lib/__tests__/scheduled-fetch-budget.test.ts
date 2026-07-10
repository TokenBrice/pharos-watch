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
});
