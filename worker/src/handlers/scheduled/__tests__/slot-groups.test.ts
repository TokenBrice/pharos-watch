import { afterEach, describe, expect, it, vi } from "vitest";
import type { ScheduledRuntimeContext } from "../context";
import { makeScheduledRuntime } from "../../../test-helpers/scheduled-runtime.test-support";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import { runScheduledSlotGroups } from "../slot-groups";
import { logSkippedCronRun } from "../preflight-skip";

const fixtures = createLatestSchemaFixtureTracker();
afterEach(() => fixtures.closeAll());

function fencedRuntime(overrides: Partial<ScheduledRuntimeContext>) {
  const fixture = fixtures.open();
  const runtime = makeScheduledRuntime({ ...overrides, db: fixture.db, invocationId: "producer-invocation" });
  runtime.executionFence = {
    scheduleKey: runtime.scheduleKey, slotStartedAt: runtime.slotStartedAt,
    invocationId: "executing-invocation", owner: "executing-owner", generation: 3, workerRole: "public",
  };
  fixture.sqlite.prepare(`INSERT INTO cron_slot_executions (slot_key, slot_started_at, state, execution_owner,
    execution_generation, invocation_id, started_at, updated_at, child_marker_version)
    VALUES (?, ?, 'running', 'executing-owner', 3, 'executing-invocation', ?, ?, 1)`)
    .run(runtime.scheduleKey, runtime.slotStartedAt, runtime.slotStartedAt, runtime.slotStartedAt);
  return { runtime, sqlite: fixture.sqlite };
}

function buildRuntime(
  runLeasedCron: ScheduledRuntimeContext["runLeasedCron"],
): ScheduledRuntimeContext {
  return fencedRuntime({
    cron: "0 8 * * *",
    scheduleKey: "daily0800Utc",
    scheduledTimeMs: null,
    slotStartedAt: 0,
    runLeasedCron,
  }).runtime;
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
      ["snapshot-safety-grade-history", "error", "Error"],
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
  function recordingRuntime() {
    return fencedRuntime({
      cron: "16,46 * * * *",
      scheduleKey: "halfHourlyChartsOffset",
      scheduledTimeMs: null,
      slotStartedAt: 1_772_000_000,
      runLeasedCron: vi.fn() as ScheduledRuntimeContext["runLeasedCron"],
    });
  }

  it("records a skipped preflight run as degraded under a deduplicating run key", async () => {
    const { runtime, sqlite } = recordingRuntime();

    await logSkippedCronRun(runtime, {
      job: "sync-dex-liquidity",
      reason: "circuit-open",
      message: "DEX circuit open",
      metadata: { circuitSource: "dex-liquidity" },
    });

    const row = sqlite.prepare("SELECT * FROM cron_runs").get()!;
    expect(row.status).toBe("degraded");
    expect(row.idempotency_key).toMatch(/^scheduled-child:[a-f0-9]{64}$/);
    expect(row.degraded_reason).toBe("circuit-open");
    const metadata = JSON.parse(row.metadata as string);
    expect(metadata).toMatchObject({
      circuitSource: "dex-liquidity", skippedReason: "circuit-open", reason: "circuit-open",
      message: "DEX circuit open", slotStartedAt: 1_772_000_000, scheduleKey: "halfHourlyChartsOffset",
      childDisposition: "not_started", schedulerTerminalSource: "preflight", schedulerAttemptKey: row.idempotency_key,
    });
    expect(metadata).not.toHaveProperty("skipped");
    expect(sqlite.prepare("SELECT started_at, terminal_source FROM scheduled_child_attempts").get())
      .toEqual({ started_at: null, terminal_source: "preflight" });
    expect(sqlite.prepare("SELECT outcome FROM worker_producer_history").get()).toEqual({ outcome: "not_started" });
  });

  it("allows explicitly benign skip rows", async () => {
    const { runtime, sqlite } = recordingRuntime();

    await logSkippedCronRun(runtime, {
      job: "sync-dex-liquidity",
      reason: "manually-disabled",
      status: "ok",
    });

    expect(sqlite.prepare("SELECT status, degraded_reason FROM cron_runs").get())
      .toEqual({ status: "ok", degraded_reason: null });
  });

  it("preserves a canonical reason on neutral direct skips", async () => {
    const { runtime, sqlite } = recordingRuntime();
    await logSkippedCronRun(runtime, {
      job: "sync-dex-liquidity", reason: "producer-priority", status: "skipped_neutral",
      metadata: { reason: "legacy-override" },
    });
    const row = sqlite.prepare("SELECT degraded_reason, metadata FROM cron_runs").get()!;
    expect(row.degraded_reason).toBe("producer-priority");
    expect(JSON.parse(row.metadata as string)).toMatchObject({
      reason: "producer-priority", skippedReason: "producer-priority", childDisposition: "not_started",
    });
    expect(sqlite.prepare("SELECT outcome FROM worker_producer_history").get()).toEqual({ outcome: "skipped_neutral" });
  });

  it("rejects a preflight terminal after executing-fence takeover without advancing history", async () => {
    const { runtime, sqlite } = recordingRuntime();
    sqlite.exec("UPDATE cron_slot_executions SET execution_generation = 4, execution_owner = 'new-owner'");
    await expect(logSkippedCronRun(runtime, { job: "sync-dex-liquidity", reason: "circuit-open" }))
      .rejects.toMatchObject({ reason: "cron-child-terminal-superseded" });
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM cron_runs").get()).toEqual({ count: 0 });
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM worker_producer_history").get()).toEqual({ count: 0 });
  });
});
