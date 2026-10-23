import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import type { SlotCatchUpMessage } from "@shared/types/slot-catch-up";
import { CRON_SCHEDULE_CADENCES } from "@shared/lib/cron-cadences";
import { getCronSlotStartedAtForSchedule } from "@shared/lib/cron-jobs";
import { SCHEDULED_SLOT_PLANS } from "@shared/lib/scheduled-runner-registry";
import {
  isSlotCatchUpWithinWindow,
  resolveSlotCatchUpCandidate,
  resolveSlotCatchUpDeadlineMs,
  SLOT_CATCH_UP_POLICIES,
  SLOT_CATCH_UP_SCHEDULE_KEYS,
  type SlotCatchUpScheduleKey,
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

/** Settle every other catch-up lane around the fixture clock, so a test sees only its own lanes. */
function openWithLanes(...lanes: SlotCatchUpScheduleKey[]) {
  const fixture = fixtures.open();
  for (const scheduleKey of SLOT_CATCH_UP_SCHEDULE_KEYS.filter((key) => !lanes.includes(key))) {
    const { intervalSec } = CRON_SCHEDULE_CADENCES[scheduleKey];
    const last = getCronSlotStartedAtForSchedule(scheduleKey, (QUARTER_SLOT + 3600) * 1000);
    for (let slot = last; slot > QUARTER_SLOT - 8 * 3600; slot -= intervalSec) {
      seedFinishedSlot(fixture.sqlite, scheduleKey, slot);
    }
  }
  return fixture;
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

  it.each([
    // [lane, cadence, grace, next-slot margin]: grace min(2I/5, 10 min), margin min(I/5, 15 min).
    ["quarterHourly", 15, 6, 3],
    ["halfHourlyMintBurnCritical", 30, 10, 6],
    ["dewsPsiOffset", 30, 10, 6],
    ["hourlyYieldSync", 120, 10, 15],
    ["twoHourlyDexDiscovery", 360, 10, 15],
  ] as const)("derives %s's window from its %i-minute cadence", (scheduleKey, cadenceMin, graceMin, marginMin) => {
    expect(CRON_SCHEDULE_CADENCES[scheduleKey].intervalSec).toBe(cadenceMin * 60);
    expect(SLOT_CATCH_UP_POLICIES[scheduleKey]).toEqual({ graceSec: graceMin * 60, nextSlotMarginSec: marginMin * 60 });
    const slot = getCronSlotStartedAtForSchedule(scheduleKey, QUARTER_SLOT * 1000);
    const nextSlot = slot + cadenceMin * 60;
    expect(resolveSlotCatchUpCandidate(scheduleKey, slot + graceMin * 60 - 60)).not.toBe(slot);
    expect(resolveSlotCatchUpCandidate(scheduleKey, slot + graceMin * 60)).toBe(slot);
    expect(resolveSlotCatchUpCandidate(scheduleKey, nextSlot - marginMin * 60)).toBe(slot);
    expect(resolveSlotCatchUpCandidate(scheduleKey, nextSlot - marginMin * 60 + 60)).toBeNull();
  });

  it("opts in only public lanes and leaves reserve sync to its checkpoint replay", () => {
    expect([...SLOT_CATCH_UP_SCHEDULE_KEYS].sort()).toEqual([
      "dewsPsiOffset", "halfHourlyMintBurnCritical", "hourlyYieldSync", "quarterHourly", "twoHourlyDexDiscovery",
    ]);
    expect(SLOT_CATCH_UP_SCHEDULE_KEYS.every((key) => SCHEDULED_SLOT_PLANS[key].worker === "public")).toBe(true);
    for (const excluded of ["fourHourlyReserveSync", "halfHourlyChartsOffset", "v9PublicationOffset"]) {
      expect(isSlotCatchUpWithinWindow(excluded, QUARTER_SLOT, QUARTER_SLOT + 600)).toBe(false);
    }
  });

  it("bounds every catch-up's hold on the single Queue consumer, alone and back to back", () => {
    // A hold is longest when the hint is consumed as soon as the grace opens.
    const holdMin = Object.fromEntries(SLOT_CATCH_UP_SCHEDULE_KEYS.map((scheduleKey) => {
      const slot = getCronSlotStartedAtForSchedule(scheduleKey, QUARTER_SLOT * 1000);
      const entryMs = (slot + SLOT_CATCH_UP_POLICIES[scheduleKey].graceSec) * 1000;
      return [scheduleKey, (resolveSlotCatchUpDeadlineMs(scheduleKey, slot, entryMs) - entryMs) / 60_000];
    }));
    expect(holdMin).toEqual({
      quarterHourly: 9, // cut at the next natural slot
      halfHourlyMintBurnCritical: 10,
      dewsPsiOffset: 5,
      hourlyYieldSync: 12,
      twoHourlyDexDiscovery: 13,
    });
    // Worst case when every lane misses together: 49 minutes of serial holds
    // (plus one 60 s controlled-error reserve each) ahead of a continuation hint.
    expect(Object.values(holdMin).reduce((sum, minutes) => sum + minutes, 0)).toBe(49);
  });

  it.each(["halfHourlyMintBurnCritical", "dewsPsiOffset", "twoHourlyDexDiscovery"] as const)(
    "arms %s once when never delivered and once when abandoned",
    async (scheduleKey) => {
      const { db } = openWithLanes(scheduleKey);
      const { queue, sent } = createQueue();
      const slot = getCronSlotStartedAtForSchedule(scheduleKey, QUARTER_SLOT * 1000);
      const due = slot + SLOT_CATCH_UP_POLICIES[scheduleKey].graceSec;
      await expect(arm(db, queue, due)).resolves.toEqual([
        { scheduleKey, slotStartedAt: slot, trigger: "never-delivered", disposition: "sent" }]);
      await expect(arm(db, queue, due + 60)).resolves.toEqual([]);

      const abandoned = openWithLanes(scheduleKey);
      seedStaleRunningSlot(abandoned.sqlite, scheduleKey, slot);
      await expect(armDueSlotCatchUps(
        { DB: abandoned.db, RESERVE_CONTINUATION_QUEUE: queue, WORKER_SLOT_CATCH_UP_MODE: "on" } as never,
        { invocationId: "minute-lane", nowSec: due, reconcileStale: true },
      )).resolves.toEqual([{ scheduleKey, slotStartedAt: slot, trigger: "abandoned", disposition: "sent" }]);
      expect(slotRow(abandoned.sqlite, scheduleKey, slot)?.metadata?.error).toBe(STALE_SLOT_ERROR);
      expect(sent.map((message) => message.trigger)).toEqual(["never-delivered", "abandoned"]);
    },
  );

  it("arms one catch-up for a never-delivered slot after its grace, and only once", async () => {
    const { sqlite, db } = openWithLanes("quarterHourly", "hourlyYieldSync");
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
    const { sqlite, db } = openWithLanes("quarterHourly", "hourlyYieldSync");
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
    const { sqlite, db } = openWithLanes("quarterHourly", "hourlyYieldSync");
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

  it("lets the minute lane reconcile and arm a stale due slot before a late digest poll", async () => {
    const { sqlite, db } = openWithLanes("quarterHourly", "hourlyYieldSync");
    const { queue, sent } = createQueue();
    // 2026-10-23 12:30 shape: sync-stablecoins died; the poll that would sweep it ran late.
    seedStaleRunningSlot(sqlite, "quarterHourly", QUARTER_SLOT);
    seedFinishedSlot(sqlite, "hourlyYieldSync", YIELD_SLOT);
    const nowSec = QUARTER_SLOT + 420;

    // Without reconcileStale (digest host) a still-running row is left to the global sweep.
    await expect(arm(db, queue, nowSec)).resolves.toEqual([]);
    expect(slotRow(sqlite, "quarterHourly", QUARTER_SLOT)?.state).toBe("running");

    await expect(armDueSlotCatchUps(
      { DB: db, RESERVE_CONTINUATION_QUEUE: queue, WORKER_SLOT_CATCH_UP_MODE: "on" } as never,
      { invocationId: "minute-lane", nowSec, reconcileStale: true },
    )).resolves.toEqual([{ scheduleKey: "quarterHourly", slotStartedAt: QUARTER_SLOT,
      trigger: "abandoned", disposition: "sent" }]);
    expect(slotRow(sqlite, "quarterHourly", QUARTER_SLOT)).toMatchObject({
      state: "finished", result_status: "error", metadata: { error: STALE_SLOT_ERROR } });
    expect(sent).toHaveLength(1);
  });

  it("arms once when the minute lane and the digest poll detect concurrently", async () => {
    const { sqlite, db } = openWithLanes("quarterHourly", "hourlyYieldSync");
    const { queue, sent } = createQueue();
    // quarterHourly@10:00 never delivered; hourlyYieldSync@09:55 died and is still running.
    seedStaleRunningSlot(sqlite, "hourlyYieldSync", YIELD_SLOT);
    const env = { DB: db, RESERVE_CONTINUATION_QUEUE: queue, WORKER_SLOT_CATCH_UP_MODE: "on" } as never;
    const nowSec = QUARTER_SLOT + 600;
    const detect = (host: string, reconcileStale: boolean, at = nowSec) =>
      armDueSlotCatchUps(env, { invocationId: host, nowSec: at, reconcileStale });

    await Promise.all([
      detect("minute-lane-a", true), detect("minute-lane-b", true), detect("digest-poll", false),
    ]);
    await Promise.all([detect("minute-lane-c", true, nowSec + 60), detect("digest-poll-2", false, nowSec + 60)]);

    expect(sent.map(({ scheduleKey, trigger }) => `${scheduleKey}:${trigger}`).sort())
      .toEqual(["hourlyYieldSync:abandoned", "quarterHourly:never-delivered"]);
    expect(slotRow(sqlite, "hourlyYieldSync", YIELD_SLOT)?.metadata?.error).toBe(STALE_SLOT_ERROR);
  });

  it("costs one indexed read per detection however many lanes are due, and none when disabled", async () => {
    const { db } = fixtures.open();
    const { queue, sent } = createQueue();
    const prepare = vi.spyOn(db, "prepare");
    await expect(arm(db, queue, QUARTER_SLOT + 600, "off")).resolves.toEqual([]);
    expect(prepare).not.toHaveBeenCalled();

    // 11:10: every lane but mint/burn (10:34, window closed at 10:58) is due and never delivered.
    await arm(db, queue, QUARTER_SLOT + 600);
    expect(sent.map((message) => message.scheduleKey).sort())
      .toEqual(["dewsPsiOffset", "hourlyYieldSync", "quarterHourly", "twoHourlyDexDiscovery"]);
    prepare.mockClear();
    await expect(arm(db, queue, QUARTER_SLOT + 660)).resolves.toEqual([]);
    expect(prepare).toHaveBeenCalledTimes(1);
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
    const { sqlite, db } = openWithLanes("quarterHourly", "hourlyYieldSync");
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
