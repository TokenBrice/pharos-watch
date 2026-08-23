import { describe, expect, it, vi } from "vitest";
import type { ScheduledRuntimeContext } from "../context";
import { makeScheduledRuntime } from "../../../test-helpers/scheduled-runtime.test-support";
import { flattenScheduledSlotGroupTasks, runScheduledSlotGroups } from "../slot-groups";

function buildRuntime(
  runLeasedCron: ScheduledRuntimeContext["runLeasedCron"],
): ScheduledRuntimeContext {
  return makeScheduledRuntime({
    db: {
      prepare: () => ({
        bind: () => ({ run: async () => ({ meta: { changes: 1 } }) }),
      }),
    } as unknown as D1Database,
    cron: "0 8 * * *",
    scheduleKey: "daily0800Utc",
    scheduledTimeMs: null,
    slotStartedAt: 0,
    runLeasedCron,
  });
}

describe("scheduled slot groups", () => {
  it("runs serial chains in parallel while preserving order within each chain", async () => {
    const order: string[] = [];
    let releaseA: (() => void) | null = null;
    const aCanFinish = new Promise<void>((resolve) => {
      releaseA = resolve;
    });

    const runLeasedCron = vi.fn(async (job: string, fn) => {
      order.push(`start:${job}`);
      const result = await fn(new AbortController().signal, async () => {});
      if (job === "a") {
        await aCanFinish;
      }
      if (job === "c") {
        releaseA?.();
      }
      order.push(`end:${job}`);
      return result;
    }) as ScheduledRuntimeContext["runLeasedCron"];

    const summary = await runScheduledSlotGroups(buildRuntime(runLeasedCron), "test slot", [
      {
        mode: "parallel-serial",
        label: "chains",
        chains: [
          {
            label: "left",
            tasks: [
              { job: "a", run: async () => ({ status: "ok" }) },
              { job: "b", run: async () => ({ status: "ok" }) },
            ],
          },
          {
            label: "right",
            tasks: [
              { job: "c", run: async () => ({ status: "ok" }) },
            ],
          },
        ],
      },
    ]);

    expect(order.indexOf("end:a")).toBeLessThan(order.indexOf("start:b"));
    expect(order.indexOf("start:c")).toBeLessThan(order.indexOf("start:b"));
    expect(summary).toMatchObject({
      jobsAttempted: 3,
      jobsSucceeded: 3,
      jobsRun: 3,
      jobsSkipped: 0,
      jobsDegraded: 0,
      jobsErrored: 0,
      budgetOnlyJobs: 0,
    });
    expect(summary.jobs.map((job) => job.job)).toEqual(["a", "b", "c"]);
  });

  it("summarizes degraded and failed best-effort child jobs", async () => {
    const runLeasedCron = vi.fn(async (job: string, fn) => {
      if (job === "failed") {
        throw new Error("boom");
      }
      return fn(new AbortController().signal, async () => {});
    }) as ScheduledRuntimeContext["runLeasedCron"];

    const summary = await runScheduledSlotGroups(buildRuntime(runLeasedCron), "test slot", [
      {
        mode: "serial",
        label: "serial",
        tasks: [
          { job: "ok", run: async () => ({ status: "ok" }) },
          { job: "degraded", run: async () => ({ status: "degraded" }) },
          { job: "failed", run: async () => ({ status: "ok" }) },
        ],
      },
    ]);

    expect(summary).toMatchObject({
      jobsAttempted: 3,
      jobsSucceeded: 1,
      jobsRun: 1,
      jobsSkipped: 0,
      jobsDegraded: 1,
      jobsErrored: 1,
    });
    expect(summary.jobs.map((job) => [job.job, job.outcome])).toEqual([
      ["ok", "ok"],
      ["degraded", "degraded"],
      ["failed", "error"],
    ]);
  });

  it("skips remaining serial tasks after a failure when stopOnFailure is enabled", async () => {
    const runLeasedCron = vi.fn(async (job: string, fn) => {
      if (job === "snapshot-safety-grade-history") {
        throw new Error("boom");
      }
      return fn(new AbortController().signal, async () => {});
    }) as ScheduledRuntimeContext["runLeasedCron"];

    const summary = await runScheduledSlotGroups(buildRuntime(runLeasedCron), "test slot", [
      {
        mode: "serial",
        label: "dependent-serial",
        stopOnFailure: true,
        tasks: [
          { job: "snapshot-supply", run: async () => ({ status: "ok" }) },
          { job: "snapshot-safety-grade-history", run: async () => ({ status: "ok" }) },
          { job: "snapshot-psi", run: async () => ({ status: "ok" }) },
        ],
      },
    ]);

    expect(runLeasedCron).toHaveBeenCalledTimes(2);
    expect(summary).toMatchObject({
      jobsAttempted: 2,
      jobsSucceeded: 1,
      jobsRun: 1,
      jobsSkipped: 1,
      jobsDegraded: 0,
      jobsErrored: 1,
    });
    expect(summary.jobs.map((job) => [job.job, job.outcome, job.reason])).toEqual([
      ["snapshot-supply", "ok", undefined],
      ["snapshot-safety-grade-history", "error", undefined],
      ["snapshot-psi", "skipped", "upstream-failure:snapshot-safety-grade-history"],
    ]);
  });

  it("skips dependent serial tasks after a non-neutral lease skip when configured", async () => {
    const runLeasedCron = vi.fn(async (job: string, fn) => {
      if (job === "snapshot-supply") {
        return { status: "skipped_locked" as const };
      }
      return fn(new AbortController().signal, async () => {});
    }) as ScheduledRuntimeContext["runLeasedCron"];

    const summary = await runScheduledSlotGroups(buildRuntime(runLeasedCron), "test slot", [
      {
        mode: "serial",
        label: "dependent-serial",
        stopOnNonNeutralSkip: true,
        tasks: [
          { job: "snapshot-supply", run: async () => ({ status: "ok" }) },
          { job: "snapshot-safety-grade-history", run: async () => ({ status: "ok" }) },
          { job: "snapshot-psi", run: async () => ({ status: "ok" }) },
        ],
      },
    ]);

    expect(runLeasedCron).toHaveBeenCalledTimes(1);
    expect(summary).toMatchObject({
      jobsAttempted: 0,
      jobsSkipped: 3,
      jobsNeutralSkipped: 0,
      jobsErrored: 0,
    });
    expect(summary.jobs.map((job) => [job.job, job.outcome, job.reason])).toEqual([
      ["snapshot-supply", "skipped", "lease-locked"],
      ["snapshot-safety-grade-history", "skipped", "upstream-blocked:snapshot-supply"],
      ["snapshot-psi", "skipped", "upstream-blocked:snapshot-supply"],
    ]);
  });

  it("flattens mixed group shapes for preflight accounting", () => {
    const tasks = flattenScheduledSlotGroupTasks([
      {
        mode: "serial",
        label: "serial",
        tasks: [{ job: "a", run: async () => undefined }],
      },
      {
        mode: "parallel-serial",
        label: "chains",
        chains: [
          { label: "left", tasks: [{ job: "b", run: async () => undefined }] },
          { label: "right", tasks: [{ job: "c", run: async () => undefined }] },
        ],
      },
    ]);

    expect(tasks.map((task) => task.job)).toEqual(["a", "b", "c"]);
  });
});
