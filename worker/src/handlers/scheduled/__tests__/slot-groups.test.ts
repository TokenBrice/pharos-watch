import { describe, expect, it, vi } from "vitest";
import type { ScheduledRuntimeContext } from "../context";
import { makeScheduledRuntime } from "../../../test-helpers/scheduled-runtime.test-support";
import { makeNoopD1 } from "../../../test-helpers/noop-d1";
import { runScheduledSlotGroups } from "../slot-groups";
import { logSkippedCronRun } from "../preflight-skip";

function buildRuntime(
  runLeasedCron: ScheduledRuntimeContext["runLeasedCron"],
): ScheduledRuntimeContext {
  return makeScheduledRuntime({
    db: makeNoopD1({
      prepare: () => ({
        bind: () => ({ run: async () => ({ meta: { changes: 1 } }) }),
      }),
    }),
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

  it.each(["skipped_neutral", "degraded"] as const)("continues after %s despite configured stop predicates", async (status) => {
    const successor = vi.fn(async () => ({ status: "ok" as const }));
    const runtime = makeScheduledRuntime();
    const summary = await runScheduledSlotGroups(runtime, "continuation", [{
      mode: "serial", label: "chain", stopOnFailure: true, stopOnNonNeutralSkip: true,
      tasks: [
        { job: "first", run: async () => ({ status }) },
        { job: "successor", run: successor },
      ],
    }]);
    expect(successor).toHaveBeenCalledOnce();
    expect(summary.jobs.map(({ job, outcome }) => [job, outcome])).toEqual([
      ["first", status === "skipped_neutral" ? "skipped" : "degraded"], ["successor", "ok"],
    ]);
  });

  it("stops only the failing parallel-serial chain", async () => {
    const blocked = vi.fn();
    const independent = vi.fn(async () => ({ status: "ok" as const }));
    const runtime = buildRuntime(vi.fn(async (_job, fn) => fn(new AbortController().signal, vi.fn())));
    const summary = await runScheduledSlotGroups(runtime, "independent chains", [{
      mode: "parallel-serial", label: "chains", chains: [
        { label: "failed", stopOnFailure: true, tasks: [
          { job: "snapshot-supply", run: async () => { throw new Error("failed"); } },
          { job: "snapshot-psi", run: blocked },
        ] },
        { label: "independent", tasks: [{ job: "snapshot-safety-grade-history", run: independent }] },
      ],
    }]);
    expect(blocked).not.toHaveBeenCalled();
    expect(independent).toHaveBeenCalledOnce();
    expect(summary.jobs.map(({ job, outcome }) => [job, outcome])).toEqual([
      ["snapshot-supply", "error"], ["snapshot-psi", "skipped"], ["snapshot-safety-grade-history", "ok"],
    ]);
  });
});

describe("logSkippedCronRun", () => {
  function recordingRuntime(): { runtime: ScheduledRuntimeContext; binds: unknown[][] } {
    const binds: unknown[][] = [];
    const runtime = makeScheduledRuntime({
      db: makeNoopD1({
        prepare: () => ({
          bind: (...args: unknown[]) => {
            binds.push(args);
            return { run: async () => ({ meta: { changes: 1 } }) };
          },
        }),
      }),
      cron: "16,46 * * * *",
      scheduleKey: "halfHourlyChartsOffset",
      scheduledTimeMs: null,
      slotStartedAt: 1_772_000_000,
      runLeasedCron: vi.fn() as ScheduledRuntimeContext["runLeasedCron"],
    });
    return { runtime, binds };
  }

  function skipMetadata(binds: unknown[]): Record<string, unknown> {
    const payload = binds.find((bind) => typeof bind === "string" && bind.startsWith("{"));
    return JSON.parse(String(payload)) as Record<string, unknown>;
  }

  it("records a skipped preflight run as degraded under a deduplicating run key", async () => {
    const { runtime, binds } = recordingRuntime();

    await logSkippedCronRun(runtime, {
      job: "sync-dex-liquidity",
      reason: "circuit-open",
      message: "DEX circuit open",
      metadata: { circuitSource: "dex-liquidity" },
    });

    expect(binds[0]).toContain("degraded");
    expect(binds[0]).toContain(
      "scheduled-preflight:halfHourlyChartsOffset:1772000000:sync-dex-liquidity:circuit-open",
    );
    const metadata = skipMetadata(binds[0]);
    expect(metadata).toMatchObject({
      circuitSource: "dex-liquidity",
      skippedReason: "circuit-open",
      message: "DEX circuit open",
      slotStartedAt: 1_772_000_000,
      scheduleKey: "halfHourlyChartsOffset",
    });
    expect(metadata).not.toHaveProperty("skipped");
  });

  it("allows explicitly benign skip rows", async () => {
    const { runtime, binds } = recordingRuntime();

    await logSkippedCronRun(runtime, {
      job: "sync-dex-liquidity",
      reason: "manually-disabled",
      status: "ok",
    });

    expect(binds[0]).toContain("ok");
    expect(binds[0]).not.toContain("degraded");
  });
});
