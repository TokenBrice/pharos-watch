import { afterEach, describe, expect, it, vi } from "vitest";

import { createScheduledRuntimeContext } from "../context";
import { createSlotDeadline } from "../../../lib/cron-timeouts";
import { makeCaptureDb, type DbCall } from "../../../lib/__tests__/cron-progress.test-support";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import { getCronSlotStartedAtForSchedule } from "@shared/lib/cron-jobs";

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
    const runtime = createScheduledRuntimeContext(
      { DB: makeCaptureDb([]) } as Parameters<typeof createScheduledRuntimeContext>[0],
      {} as ExecutionContext,
      {
        cron: "11 */4 * * *",
        scheduleKey: "fourHourlyReserveSync",
        scheduledTimeMs: 600_000,
        slotStartedAt: 600,
        deadline,
      },
    );
    expect(runtime.deadline).toBe(deadline);
  });

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
});
