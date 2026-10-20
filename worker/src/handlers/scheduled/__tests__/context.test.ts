import { makeScheduledEnv } from "../../../test-helpers/scheduled-runtime.test-support";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createScheduledRuntimeContext } from "../context";
import { createSlotDeadline } from "../../../lib/cron-timeouts";
import { makeCaptureDb, type DbCall } from "../../../lib/__tests__/cron-progress.test-support";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import { getCronSlotStartedAtForSchedule } from "@shared/lib/cron-jobs";
import type { ScheduledExecutionFence } from "../../../lib/scheduled-slot-fence";
import type { Env, HeavyEnv } from "../../../lib/env";
import { loadProducerHeads } from "../../../lib/producer-history";

const fixtures = createLatestSchemaFixtureTracker();
afterEach(() => { fixtures.closeAll(); vi.useRealTimers(); });

describe("scheduled runtime context", () => {
  it("creates one event-entry deadline independent of source identity and later waits", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const runtime = createScheduledRuntimeContext(
      { DB: makeCaptureDb([]) } as Parameters<typeof createScheduledRuntimeContext>[0],
      {} as ExecutionContext,
      {
        cron: "10 * * * *",
        scheduleKey: "halfHourlyOffset",
        scheduledTimeMs: 600_000,
        slotStartedAt: 600,
        slotBudgetStartedAtMs: 900_000,
      },
    );
    expect(runtime.deadline.eventEntryMs).toBe(900_000);
    const deadline = runtime.deadline;
    const remainingMs = deadline.remainingMs();
    vi.setSystemTime(1_030_000);
    expect(runtime.deadline).toBe(deadline);
    expect(deadline.remainingMs()).toBe(remainingMs - 30_000);
  });

  it("inherits the same executing deadline for a reconstructed runtime", () => {
    const deadline = createSlotDeadline(900_000);
    const executionFence: ScheduledExecutionFence = {
      scheduleKey: "fiveMinuteReserveRecovery", slotStartedAt: 1_000, invocationId: "executing",
      owner: "owner", generation: 7, workerRole: "public",
    };
    const runtime = createScheduledRuntimeContext(
      { DB: makeCaptureDb([]) } as Parameters<typeof createScheduledRuntimeContext>[0],
      {} as ExecutionContext,
      {
        cron: "11 */4 * * *",
        scheduleKey: "fourHourlyReserveSync",
        scheduledTimeMs: 600_000,
        slotStartedAt: 600,
        deadline,
        executionFence,
      },
    );
    expect(runtime.deadline).toBe(deadline);
    expect(runtime.executionFence).toBe(executionFence);
    expect(runtime.slotBudgetStartedAtMs).toBe(deadline.eventEntryMs);
  });

  it.each(["hourlyYieldSync", "fourHourlyYieldSupplemental"] as const)(
    "preserves the independent supplemental allowance in %s",
    async (scheduleKey) => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-10-20T08:25:00Z"));
      const { db } = fixtures.open();
      const runtime = createScheduledRuntimeContext(makeScheduledEnv({ DB: db }), {} as ExecutionContext, {
        cron: scheduleKey === "hourlyYieldSync" ? "55 * * * *" : "25 */4 * * *",
        scheduleKey, scheduledTimeMs: Date.now(), slotStartedAt: Math.floor(Date.now() / 1000),
      });
      let release!: () => void;
      const held = new Promise<void>((resolve) => { release = resolve; });
      let signal: AbortSignal | undefined;
      const pending = runtime.runLeasedCron("sync-yield-supplemental", async (childSignal) => {
        signal = childSignal;
        await held;
        return { status: "ok", itemCount: 1 };
      });
      await vi.advanceTimersByTimeAsync(60_000);
      expect(signal?.aborted).toBe(false);
      expect(runtime.fetchBudget?.snapshot().allocated).toBe(3);
      release();
      expect(await pending).toMatchObject({ status: "ok", itemCount: 1 });
    },
  );

  it("writes the started progress row only after acquiring the job lease", async () => {
    const calls: DbCall[] = [];
    const db = makeCaptureDb(calls);
    const runtime = createScheduledRuntimeContext(
      { DB: db } as Parameters<typeof createScheduledRuntimeContext>[0],
      {} as ExecutionContext,
      {
        cron: "*/15 * * * *",
        scheduleKey: "quarterHourly",
        scheduledTimeMs: null,
        slotStartedAt: Math.floor(Date.now() / 1000),
      },
    );

    await runtime.runLeasedCron("sync-stablecoins", async () => ({ itemCount: 1 }));

    const leaseIndex = calls.findIndex(({ sql }) => sql.includes("INSERT INTO cron_leases"));
    const startedProgressIndex = calls.findIndex(
      ({ sql, args }) => sql.includes("INSERT INTO cron_run_progress") && args[4] === "started",
    );
    expect(leaseIndex).toBeGreaterThanOrEqual(0);
    expect(startedProgressIndex).toBeGreaterThan(leaseIndex);
  });

  it.each([null, 0])("persists measured or unknown producer counters (%s) without itemCount inference", async (measurement) => {
    const { db, sqlite } = fixtures.open();
    const slotStartedAt = getCronSlotStartedAtForSchedule("quarterHourly", Date.now());
    const runtime = createScheduledRuntimeContext(
      { DB: db } as Parameters<typeof createScheduledRuntimeContext>[0], {} as ExecutionContext,
      { cron: "*/15 * * * *", scheduleKey: "quarterHourly", scheduledTimeMs: Date.now(), slotStartedAt },
    );
    const measurements = {
      rowsRead: measurement, rowsWritten: measurement, rowsDropped: measurement, validationFailures: measurement,
    };
    await runtime.runLeasedCron("sync-stablecoins", async () => ({
      itemCount: 99, metadata: JSON.stringify({ ...measurements, reason: "observed-producer-evidence" }),
    }));
    const rows = sqlite.prepare("SELECT item_count, metadata FROM cron_runs WHERE job = 'sync-stablecoins'").all();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.item_count).toBe(99);
    expect(JSON.parse(rows[0]!.metadata as string)).toMatchObject({
      ...measurements, reason: "observed-producer-evidence", leaseOwner: expect.any(String),
      scheduleKey: "quarterHourly", slotStartedAt,
    });
  });

  it("waits for the genuine scheduled reserve head and emits only one final cron row", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-07T01:00:00Z"));
    const { db, sqlite } = fixtures.open();
    const now = Math.floor(Date.now() / 1000);
    sqlite.prepare(`INSERT INTO cron_leases (job, lease_owner, lease_until, heartbeat_at, updated_at)
      VALUES ('sync-live-reserves', 'existing-recovery', ?, ?, ?)`).run(now + 30, now, now);
    const runtime = createScheduledRuntimeContext({ DB: db } as Parameters<typeof createScheduledRuntimeContext>[0], {} as ExecutionContext, {
      cron: "11 */4 * * *", scheduleKey: "fourHourlyReserveSync", scheduledTimeMs: Date.now(),
      slotStartedAt: getCronSlotStartedAtForSchedule("fourHourlyReserveSync", Date.now()),
    });
    const work = vi.fn(async () => ({ status: "ok" as const, itemCount: 1 }));
    const pending = runtime.runLeasedCron("sync-live-reserves", work);
    await vi.advanceTimersByTimeAsync(31000);
    expect(await pending).toMatchObject({ status: "ok" });
    expect(work).toHaveBeenCalledTimes(1);
    const rows = sqlite.prepare("SELECT status, metadata FROM cron_runs WHERE job = 'sync-live-reserves'").all();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("ok");
    expect(JSON.parse(rows[0]!.metadata as string)).toMatchObject({ leaseWaitDurationMs: 31000, leaseAcquisitionAttempts: 4 });
  });

  it.each([false, true])("never waits for a non-natural scheduled reserve runtime (%s)", async (recovery) => {
    const { db, sqlite } = fixtures.open();
    const now = Math.floor(Date.now() / 1000);
    sqlite.prepare(`INSERT INTO cron_leases (job, lease_owner, lease_until, heartbeat_at, updated_at)
      VALUES ('sync-live-reserves', 'existing-recovery', ?, ?, ?)`).run(now + 900, now, now);
    const runtime = createScheduledRuntimeContext({ DB: db } as Parameters<typeof createScheduledRuntimeContext>[0], {} as ExecutionContext, {
      cron: "11 */4 * * *", scheduleKey: "fourHourlyReserveSync", scheduledTimeMs: Date.now(),
      slotStartedAt: getCronSlotStartedAtForSchedule("fourHourlyReserveSync", Date.now()),
      producerKind: recovery ? "scheduled-recovery" : "operator",
    });
    const work = vi.fn(async () => ({ itemCount: 1 }));
    expect(await runtime.runLeasedCron("sync-live-reserves", work)).toMatchObject({ status: "skipped_locked" });
    expect(work).not.toHaveBeenCalled();
    const row = sqlite.prepare("SELECT metadata FROM cron_runs WHERE job = 'sync-live-reserves'").get()!;
    expect(JSON.parse(row.metadata as string)).toMatchObject({ leaseAcquisitionAttempts: 1 });
  });

  it("marks every child against the executing fence while preserving replay attempt identity", async () => {
    const { db, sqlite } = fixtures.open();
    const executionFence: ScheduledExecutionFence = {
      scheduleKey: "fiveMinuteReserveRecovery", slotStartedAt: 1_000, invocationId: "executing",
      owner: "owner", generation: 7, workerRole: "public",
    };
    sqlite.prepare(`INSERT INTO cron_slot_executions (slot_key, slot_started_at, state, execution_owner,
      execution_generation, invocation_id, started_at, updated_at, child_marker_version)
      VALUES ('fiveMinuteReserveRecovery', 1000, 'running', 'owner', 7, 'executing', 1000, 1000, 1)`).run();
    const runtime = createScheduledRuntimeContext({ DB: db } as Parameters<typeof createScheduledRuntimeContext>[0], {} as ExecutionContext, {
      cron: "11 */4 * * *", scheduleKey: "fourHourlyReserveSync", scheduledTimeMs: 600_000, slotStartedAt: 600,
      executionFence, jobAttemptNo: 2, producerKind: "scheduled-recovery", deadline: createSlotDeadline(Date.now()),
    });
    await runtime.runLeasedCron("cron-sentinel", async () => {
      expect(sqlite.prepare("SELECT * FROM scheduled_child_attempts").get()).toMatchObject({
        schedule_key: "fourHourlyReserveSync", slot_started_at: 600, attempt_no: 2,
        execution_schedule_key: "fiveMinuteReserveRecovery", execution_slot_started_at: 1000,
        execution_generation: 7, execution_owner: "owner", execution_invocation_id: "executing",
      });
      return { itemCount: 1 };
    });
    expect(sqlite.prepare("SELECT terminal_source FROM scheduled_child_attempts").get()).toEqual({ terminal_source: "real" });
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM cron_run_progress").get()).toEqual({ count: 0 });
    expect(await loadProducerHeads(db)).toEqual([expect.objectContaining({ invocationCount: 1 })]);
  });

  it.each(["public", "heavy"] as const)("captures the %s deadline origin before lazy imports", async (role) => {
    vi.useFakeTimers();
    const entryMs = 1_800_000_000_000;
    vi.setSystemTime(entryMs);
    vi.resetModules();
    const handleScheduledEvent = vi.fn(async () => {});
    vi.doMock("../../../handlers/scheduled", () => {
      vi.setSystemTime(entryMs + 2_000);
      return { handleScheduledEvent };
    });
    vi.doMock("../../../handlers/scheduled/public-runners", () => ({ PUBLIC_SLOT_RUNNER_LOADERS: {} }));
    vi.doMock("../../../handlers/scheduled/heavy-runners", () => ({ HEAVY_SLOT_RUNNER_LOADERS: {} }));
    try {
      // Dynamic imports are deliberate: this fixture exercises lazy initialization.
      const entry = role === "public" ? await import("../../../index") : await import("../../../index.heavy");
      const event = { cron: "0 * * * *", scheduledTime: entryMs } as ScheduledEvent;
      const env = { DB: makeCaptureDb([]) } as Env & HeavyEnv;
      const ctx = {} as ExecutionContext;
      await entry.default.scheduled(event, env, ctx);
      expect(Date.now()).toBe(entryMs + 2_000);
      expect(handleScheduledEvent).toHaveBeenCalledWith(event, env, ctx, role, {}, entryMs);
    } finally {
      vi.doUnmock("../../../handlers/scheduled");
      vi.doUnmock("../../../handlers/scheduled/public-runners");
      vi.doUnmock("../../../handlers/scheduled/heavy-runners");
      vi.resetModules();
    }
  });
});
