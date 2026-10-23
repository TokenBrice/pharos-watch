import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import type { SlotCatchUpMessage } from "@shared/types/slot-catch-up";
import {
  isSlotCatchUpWithinWindow,
  resolveSlotCatchUpCandidate,
  resolveSlotCatchUpDeadlineMs,
} from "@shared/lib/scheduled-slot-catch-up-policy";
import { armDueSlotCatchUps } from "../scheduled-slot-catch-up";
import { runScheduledSlotWithFence, sweepStaleScheduledSlotExecutions } from "../scheduled-slot-fence";
import { STALE_SLOT_ERROR } from "../scheduled-slot-reconciliation";
import { createDeferredPromise } from "./deferred.test-support";

const fixtures = createLatestSchemaFixtureTracker();
// 2027-01-14T11:00:00Z: a quarter-hour and a :00 boundary.
const QUARTER_SLOT = 1_799_924_400;
// The two-hourly yield slot at 10:55, five minutes earlier.
const YIELD_SLOT = QUARTER_SLOT - 5 * 60;

function createQueue() {
  const sent: SlotCatchUpMessage[] = [];
  return {
    sent,
    queue: { send: vi.fn(async (message: SlotCatchUpMessage) => { sent.push(message); }) } as unknown as Queue<SlotCatchUpMessage>,
  };
}

function seedFinishedSlot(sqlite: DatabaseSync, slotKey: string, slotStartedAt: number) {
  sqlite.prepare(
    `INSERT INTO cron_slot_executions (slot_key, slot_started_at, state, result_status, execution_owner, started_at, updated_at)
     VALUES (?, ?, 'finished', 'ok', 'original', ?, ?)`,
  ).run(slotKey, slotStartedAt, slotStartedAt, slotStartedAt + 60);
}

function arm(db: D1Database, queue: Queue<SlotCatchUpMessage>, nowSec: number, mode = "on") {
  return armDueSlotCatchUps(
    { DB: db, RESERVE_CONTINUATION_QUEUE: queue, WORKER_SLOT_CATCH_UP_MODE: mode } as never,
    { invocationId: "digest-poll", nowSec },
  );
}

function seedStaleRunningSlot(sqlite: DatabaseSync, slotKey: string, slotStartedAt: number) {
  sqlite.prepare(
    `INSERT INTO cron_slot_executions (
       slot_key, slot_started_at, state, execution_owner, execution_generation,
       invocation_id, worker_version, started_at, updated_at, child_marker_version
     ) VALUES (?, ?, 'running', 'dead-owner', 1, 'dead-invocation', 'worker-a', ?, ?, 1)`,
  ).run(slotKey, slotStartedAt, slotStartedAt + 30, slotStartedAt + 60);
}

function slotRow(sqlite: DatabaseSync, slotKey: string, slotStartedAt: number) {
  const row = sqlite.prepare(
    `SELECT state, result_status, execution_owner, execution_generation, metadata
       FROM cron_slot_executions WHERE slot_key = ? AND slot_started_at = ?`,
  ).get(slotKey, slotStartedAt) as { state: string; result_status: string | null;
    execution_owner: string; execution_generation: number; metadata: string | null } | undefined;
  return row ? { ...row, metadata: row.metadata ? JSON.parse(row.metadata) as Record<string, unknown> : null } : null;
}

const CATCH_UP = { trigger: "never-delivered", armedAt: QUARTER_SLOT + 600, armedByInvocationId: "digest-poll" } as const;

describe("one-shot scheduled slot catch-up", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    fixtures.closeAll();
  });

  it("admits only the window between grace and the next natural slot's margin", () => {
    expect(resolveSlotCatchUpCandidate("quarterHourly", QUARTER_SLOT + 300)).toBeNull();
    expect(resolveSlotCatchUpCandidate("quarterHourly", QUARTER_SLOT + 600)).toBe(QUARTER_SLOT);
    expect(resolveSlotCatchUpCandidate("quarterHourly", QUARTER_SLOT + 720)).toBe(QUARTER_SLOT);
    // Imminent next natural slot (:15) closes the window.
    expect(resolveSlotCatchUpCandidate("quarterHourly", QUARTER_SLOT + 780)).toBeNull();
    expect(resolveSlotCatchUpCandidate("hourlyYieldSync", YIELD_SLOT + 300)).toBeNull();
    expect(resolveSlotCatchUpCandidate("hourlyYieldSync", YIELD_SLOT + 600)).toBe(YIELD_SLOT);
    expect(resolveSlotCatchUpCandidate("hourlyYieldSync", YIELD_SLOT + 105 * 60)).toBe(YIELD_SLOT);
    expect(resolveSlotCatchUpCandidate("hourlyYieldSync", YIELD_SLOT + 106 * 60)).toBeNull();
    expect(isSlotCatchUpWithinWindow("statusSelfCheckOffset", QUARTER_SLOT, QUARTER_SLOT + 600)).toBe(false);
  });

  it("bounds a catch-up by the lane's longest task timeout and its next natural slot", () => {
    // quarterHourly: the :15 natural slot cuts the run short.
    expect(resolveSlotCatchUpDeadlineMs("quarterHourly", QUARTER_SLOT, (QUARTER_SLOT + 600) * 1000))
      .toBe((QUARTER_SLOT + 900) * 1000);
    // hourlyYieldSync: the 12-minute supplemental task timeout is the lane bound.
    expect(resolveSlotCatchUpDeadlineMs("hourlyYieldSync", YIELD_SLOT, (YIELD_SLOT + 600) * 1000))
      .toBe((YIELD_SLOT + 600 + 12 * 60) * 1000);
  });

  it("arms one catch-up for a never-delivered slot after its grace, and only once", async () => {
    const { sqlite, db } = fixtures.open();
    const { queue, sent } = createQueue();
    seedFinishedSlot(sqlite, "hourlyYieldSync", YIELD_SLOT);

    await expect(arm(db, queue, QUARTER_SLOT + 300)).resolves.toEqual([]);
    const armed = await arm(db, queue, QUARTER_SLOT + 600);
    expect(armed).toEqual([{ scheduleKey: "quarterHourly", slotStartedAt: QUARTER_SLOT,
      trigger: "never-delivered", disposition: "sent" }]);
    expect(sent).toEqual([expect.objectContaining({ kind: "slot-catch-up", scheduleKey: "quarterHourly",
      slotStartedAt: QUARTER_SLOT, trigger: "never-delivered", armedByInvocationId: "digest-poll" })]);

    await expect(arm(db, queue, QUARTER_SLOT + 660)).resolves.toEqual([]);
    expect(sent).toHaveLength(1);
  });

  it("never arms when disabled, live, or finished by the original", async () => {
    const { sqlite, db } = fixtures.open();
    const { queue, sent } = createQueue();
    await expect(arm(db, queue, QUARTER_SLOT + 600, "off")).resolves.toEqual([]);

    sqlite.prepare(
      `INSERT INTO cron_slot_executions (slot_key, slot_started_at, state, execution_owner, started_at, updated_at)
       VALUES ('quarterHourly', ?, 'running', 'live', ?, ?)`,
    ).run(QUARTER_SLOT, QUARTER_SLOT + 500, QUARTER_SLOT + 590);
    sqlite.prepare(
      `INSERT INTO cron_slot_executions (slot_key, slot_started_at, state, result_status, execution_owner, started_at, updated_at, metadata)
       VALUES ('hourlyYieldSync', ?, 'finished', 'error', 'done', ?, ?, '{"reason":"scheduled-slot-failed"}')`,
    ).run(YIELD_SLOT, YIELD_SLOT, YIELD_SLOT + 60);
    await expect(arm(db, queue, QUARTER_SLOT + 600)).resolves.toEqual([]);
    expect(sent).toEqual([]);
  });

  it("arms an abandoned slot in the same poll that reconciles it", async () => {
    const { sqlite, db } = fixtures.open();
    const { queue, sent } = createQueue();
    seedStaleRunningSlot(sqlite, "hourlyYieldSync", YIELD_SLOT);
    seedFinishedSlot(sqlite, "quarterHourly", QUARTER_SLOT);
    const nowSec = YIELD_SLOT + 900;

    await expect(sweepStaleScheduledSlotExecutions(db, { nowSec })).resolves.toMatchObject({ slotsReconciled: 1 });
    expect(slotRow(sqlite, "hourlyYieldSync", YIELD_SLOT)?.metadata?.error).toBe(STALE_SLOT_ERROR);
    await expect(arm(db, queue, nowSec)).resolves.toEqual([expect.objectContaining({
      scheduleKey: "hourlyYieldSync", trigger: "abandoned", disposition: "sent" })]);
    expect(sent).toHaveLength(1);
  });

  it("runs a never-delivered slot once and deduplicates the late original", async () => {
    const { sqlite, db } = fixtures.open();
    const work = vi.fn(async () => undefined);
    await expect(runScheduledSlotWithFence(db, "quarterHourly", work, {
      slotStartedAt: QUARTER_SLOT, owner: "catch-up", invocationId: "catch-up", catchUp: CATCH_UP,
    })).resolves.toMatchObject({ status: "ok", resultStatus: "ok" });
    expect(slotRow(sqlite, "quarterHourly", QUARTER_SLOT)).toMatchObject({
      state: "finished", result_status: "ok", execution_generation: 1,
      metadata: { catchUp: { trigger: "never-delivered", armedByInvocationId: "digest-poll" } },
    });

    await expect(runScheduledSlotWithFence(db, "quarterHourly", work, {
      slotStartedAt: QUARTER_SLOT, owner: "late-original", invocationId: "late-original",
    })).resolves.toMatchObject({ status: "skipped_duplicate" });
    await expect(runScheduledSlotWithFence(db, "quarterHourly", work, {
      slotStartedAt: QUARTER_SLOT, owner: "duplicate-hint", invocationId: "duplicate-hint", catchUp: CATCH_UP,
    })).resolves.toMatchObject({ status: "skipped_duplicate" });
    expect(work).toHaveBeenCalledTimes(1);
  });

  it("deduplicates an original delivered while the catch-up is still running", async () => {
    const { db } = fixtures.open();
    const { promise: entered, resolve: enter } = createDeferredPromise();
    const { promise: release, resolve: finish } = createDeferredPromise();
    const running = runScheduledSlotWithFence(db, "quarterHourly", async () => {
      enter();
      await release;
    }, { slotStartedAt: QUARTER_SLOT, owner: "catch-up", invocationId: "catch-up", catchUp: CATCH_UP });
    await entered;
    const late = vi.fn(async () => undefined);
    await expect(runScheduledSlotWithFence(db, "quarterHourly", late, {
      slotStartedAt: QUARTER_SLOT, owner: "late-original", invocationId: "late-original",
    })).resolves.toMatchObject({ status: "skipped_running" });
    finish();
    await expect(running).resolves.toMatchObject({ status: "ok" });
    expect(late).not.toHaveBeenCalled();
  });

  it("reopens a platform-abandoned slot once at the next generation and keeps its evidence", async () => {
    const { sqlite, db } = fixtures.open();
    seedStaleRunningSlot(sqlite, "hourlyYieldSync", YIELD_SLOT);
    await sweepStaleScheduledSlotExecutions(db, { nowSec: YIELD_SLOT + 900 });
    const reconciled = slotRow(sqlite, "hourlyYieldSync", YIELD_SLOT)!;
    const work = vi.fn(async () => undefined);
    const catchUp = { ...CATCH_UP, trigger: "abandoned" } as const;

    await expect(runScheduledSlotWithFence(db, "hourlyYieldSync", work, {
      slotStartedAt: YIELD_SLOT, owner: "catch-up", invocationId: "catch-up", catchUp,
    })).resolves.toMatchObject({ status: "ok", resultStatus: "ok" });
    expect(slotRow(sqlite, "hourlyYieldSync", YIELD_SLOT)).toMatchObject({
      state: "finished", result_status: "ok", execution_owner: "catch-up",
      execution_generation: reconciled.execution_generation + 1,
      metadata: { catchUp: { trigger: "abandoned", recoveredFrom: {
        resultStatus: "error", error: STALE_SLOT_ERROR, executionGeneration: reconciled.execution_generation,
      } } },
    });

    // Neither a second hint nor the late original can run it again.
    await expect(runScheduledSlotWithFence(db, "hourlyYieldSync", work, {
      slotStartedAt: YIELD_SLOT, owner: "second", invocationId: "second", catchUp,
    })).resolves.toMatchObject({ status: "skipped_duplicate" });
    await expect(runScheduledSlotWithFence(db, "hourlyYieldSync", work, {
      slotStartedAt: YIELD_SLOT, owner: "late-original", invocationId: "late-original",
    })).resolves.toMatchObject({ status: "skipped_duplicate" });
    expect(work).toHaveBeenCalledTimes(1);
  });

  it("never reopens an ordinary failed or successful terminal", async () => {
    const { sqlite, db } = fixtures.open();
    sqlite.prepare(
      `INSERT INTO cron_slot_executions (slot_key, slot_started_at, state, result_status, execution_owner, started_at, updated_at, metadata)
       VALUES ('hourlyYieldSync', ?, 'finished', 'error', 'done', ?, ?, '{"reason":"scheduled-slot-failed"}')`,
    ).run(YIELD_SLOT, YIELD_SLOT, YIELD_SLOT + 60);
    const work = vi.fn(async () => undefined);
    await expect(runScheduledSlotWithFence(db, "hourlyYieldSync", work, {
      slotStartedAt: YIELD_SLOT, owner: "catch-up", invocationId: "catch-up", catchUp: CATCH_UP,
    })).resolves.toMatchObject({ status: "skipped_duplicate" });
    expect(work).not.toHaveBeenCalled();
  });

  it("keeps the catch-up marker when the catch-up itself is abandoned, so it is never re-armed", async () => {
    const { sqlite, db } = fixtures.open();
    const { queue, sent } = createQueue();
    sqlite.prepare(
      `INSERT INTO cron_slot_executions (
         slot_key, slot_started_at, state, execution_owner, execution_generation,
         invocation_id, started_at, updated_at, child_marker_version, metadata
       ) VALUES ('hourlyYieldSync', ?, 'running', 'catch-up', 1, 'catch-up', ?, ?, 1, ?)`,
    ).run(YIELD_SLOT, YIELD_SLOT + 600, YIELD_SLOT + 620, JSON.stringify({ catchUp: { ...CATCH_UP, claimedAt: YIELD_SLOT + 600 } }));
    const nowSec = YIELD_SLOT + 1_200;
    await expect(sweepStaleScheduledSlotExecutions(db, { nowSec })).resolves.toMatchObject({ slotsReconciled: 1 });
    expect(slotRow(sqlite, "hourlyYieldSync", YIELD_SLOT)?.metadata).toMatchObject({
      error: STALE_SLOT_ERROR, catchUp: { trigger: "never-delivered" },
    });
    await expect(arm(db, queue, nowSec)).resolves.toEqual([]);
    expect(sent).toEqual([]);
  });
});
