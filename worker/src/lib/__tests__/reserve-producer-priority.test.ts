import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import { createSqliteD1 } from "@shared/test-utils/sqlite-d1";
import { getCronSlotStartedAtForSchedule } from "@shared/lib/cron-jobs";
import { CRON_SCHEDULE_CADENCES } from "@shared/lib/cron-cadences";
import { getReserveRecoveryConflictSlotKeys, RESERVE_RECOVERY_CONFLICT_SLOT_KEYS, SCHEDULED_SLOT_PLANS } from "@shared/lib/scheduled-runner-registry";
import {
  getReserveProducerPriority,
  RESERVE_SLOT_NEVER_DELIVERED_GRACE_SEC,
  reserveRecoveryAdmissionSql,
  resolveReserveProducerAdmission,
} from "../reserve-producer-priority";
import { runCronWithLease } from "../cron-lease-primitives";
import { beginLiveReserveCheckpoint, claimNextLiveReserveCheckpointRecovery } from "../scheduled-recovery-checkpoint";
import { SCHEDULED_SLOT_JOB_BUDGET_MS } from "../cron-timeouts";
import { resolveScheduledSlotPolicy } from "../scheduled-slot-policy";
import { mockD1 } from "@shared/test-utils/mock-d1";

const fixtures = createLatestSchemaFixtureTracker();
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-07T01:00:00Z"));
});
afterEach(() => { fixtures.closeAll(); vi.restoreAllMocks(); vi.useRealTimers(); });

function admittedFixture() {
  const fixture = fixtures.open();
  fixture.sqlite.function("unixepoch", () => Math.floor(Date.now() / 1000));
  const now = Math.floor(Date.now() / 1000);
  const current = getCronSlotStartedAtForSchedule("fourHourlyReserveSync", Date.now());
  fixture.sqlite.prepare(`INSERT INTO cron_slot_executions
    (slot_key, slot_started_at, state, execution_owner, execution_generation, started_at, finished_at, updated_at)
    VALUES ('fourHourlyReserveSync', ?, 'finished', 'producer', 1, ?, ?, ?)`)
    .run(current, current, current + 100, current + 100);
  return { ...fixture, now, current };
}

function seedBlocker(fixture: { sqlite: DatabaseSync; now: number }, owner = "legacy-owner", durationSec = 30) {
  fixture.sqlite.prepare(`INSERT INTO cron_leases (job, lease_owner, lease_until, heartbeat_at, updated_at)
    VALUES ('sync-live-reserves', ?, ?, ?, ?)`)
    .run(owner, fixture.now + durationSec, fixture.now, fixture.now);
}

describe("reserve recovery admission", () => {
  it.each(["2026-10-06T23:47:00Z", "2026-10-07T03:47:00Z"])("protects the exact next-slot boundary across rollover: %s", async (boundary) => {
    const fixture = admittedFixture();
    const target = Date.parse(boundary);
    vi.setSystemTime(target - 1000);
    const current = getCronSlotStartedAtForSchedule("fourHourlyReserveSync", Date.now());
    fixture.sqlite.prepare("UPDATE cron_slot_executions SET slot_started_at = ?").run(current);
    expect(await getReserveProducerPriority(fixture.db)).toBeNull();
    vi.setSystemTime(target);
    expect(await getReserveProducerPriority(fixture.db)).toMatchObject({
      reason: "producer-slot-priority", condition: "next-slot-lookahead",
      slotStartedAt: current + CRON_SCHEDULE_CADENCES.fourHourlyReserveSync.intervalSec,
    });
  });

  it.each(["running", "reconciling", "null-finished-at"])("protects an unfinished due producer even during next-slot lookahead: %s", async (state) => {
    const fixture = admittedFixture();
    if (state === "null-finished-at") fixture.sqlite.prepare("UPDATE cron_slot_executions SET finished_at = NULL").run();
    else fixture.sqlite.prepare("UPDATE cron_slot_executions SET state = ?").run(state);
    expect(await getReserveProducerPriority(fixture.db)).toMatchObject({
      reason: "producer-slot-priority", condition: "current-slot-unfinished", slotStartedAt: fixture.current,
    });
    vi.setSystemTime(new Date("2026-10-07T03:47:00Z"));
    expect(await getReserveProducerPriority(fixture.db)).toMatchObject({
      reason: "producer-slot-priority", condition: "current-slot-unfinished", slotStartedAt: fixture.current,
    });
    const admission = reserveRecoveryAdmissionSql();
    expect(fixture.sqlite.prepare(`SELECT (${admission.sql}) AS admitted`).get(...admission.binds)).toEqual({ admitted: 0 });
  });

  it.each([
    ["fresh", 600, 30, true],
    ["silence boundary", 600, resolveScheduledSlotPolicy("fourHourlyReserveSync").slotSilenceSec, true],
    ["stale heartbeat", 600, resolveScheduledSlotPolicy("fourHourlyReserveSync").slotSilenceSec + 1, false],
    ["future heartbeat", 600, -1, false],
    ["before slot start", 600, 601, false],
    ["before hard dead", resolveScheduledSlotPolicy("fourHourlyReserveSync").hardDeadSec - 1, 0, true],
    ["hard-dead boundary", resolveScheduledSlotPolicy("fourHourlyReserveSync").hardDeadSec, 0, false],
    ["past hard dead", resolveScheduledSlotPolicy("fourHourlyReserveSync").hardDeadSec + 1, 0, false],
  ] as const)("bounds proven-live producer waiting: %s", async (_label, slotAge, heartbeatAge, live) => {
    const fixture = admittedFixture();
    const observedAt = fixture.current + slotAge;
    vi.setSystemTime(observedAt * 1000);
    fixture.sqlite.prepare("UPDATE cron_slot_executions SET state = 'running', finished_at = NULL, updated_at = ?")
      .run(observedAt - heartbeatAge);
    expect(await getReserveProducerPriority(fixture.db)).toMatchObject({
      reason: "producer-slot-priority", condition: live ? "producer-slot-live" : "current-slot-unfinished",
      scheduleKey: "fourHourlyReserveSync", slotStartedAt: fixture.current,
    });
    const admission = reserveRecoveryAdmissionSql();
    expect(fixture.sqlite.prepare(`SELECT (${admission.sql}) AS admitted`).get(...admission.binds)).toEqual({ admitted: 0 });
  });

  it.each(["reconciling", "abandoned", "interrupted", "finished", "running"])(
    "requires running state without a terminal clock for live proof: %s", async (state) => {
      const fixture = admittedFixture();
      const observedAt = fixture.current + 600;
      vi.setSystemTime(observedAt * 1000);
      fixture.sqlite.prepare("UPDATE cron_slot_executions SET state = ?, finished_at = ?, updated_at = ?")
        .run(state, state === "running" ? observedAt : null, observedAt);
      expect(await getReserveProducerPriority(fixture.db)).toMatchObject({ condition: "current-slot-unfinished" });
    },
  );

  it.each([null, 0, Number.NaN, Infinity])("does not prove life from an invalid heartbeat: %s", async (updated_at) => {
    const observedAt = Math.floor(Date.parse("2026-10-07T00:16:00Z") / 1000);
    const db = mockD1([{
      match: "FROM cron_slot_executions", rows: [], first: { state: "running", finished_at: null, updated_at },
    }]);
    expect(await getReserveProducerPriority(db, observedAt)).toMatchObject({ condition: "current-slot-unfinished" });
  });

  it("does not promote an Oct-13 delivered-but-no-claim producer to a healthy wait", async () => {
    vi.setSystemTime(new Date("2026-10-13T16:16:44Z"));
    const fixture = admittedFixture();
    expect(fixture.current).toBe(1791907860);
    fixture.sqlite.prepare("UPDATE cron_slot_executions SET slot_started_at = ?")
      .run(fixture.current - CRON_SCHEDULE_CADENCES.fourHourlyReserveSync.intervalSec);
    fixture.sqlite.prepare(`INSERT INTO cron_slot_executions
      (slot_key, slot_started_at, state, execution_owner, execution_generation, started_at, updated_at)
      VALUES ('fiveMinuteReserveRecovery', ?, 'running', 'unrelated', 1, ?, ?)`)
      .run(fixture.now, fixture.now, fixture.now);
    fixture.sqlite.prepare(`INSERT INTO cron_run_progress (job, started_at, updated_at, lease_owner, metadata)
      VALUES ('sync-live-reserves', ?, ?, 'unrelated-child', ?)`)
      .run(fixture.now, fixture.now, JSON.stringify({ scheduleKey: "fourHourlyReserveSync", slotStartedAt: fixture.current }));
    // Inside the never-delivered grace the missing row still wins; unrelated
    // progress is never proof of life. Past it the slot was never delivered.
    vi.setSystemTime(fixture.now * 1000);
    expect(await getReserveProducerPriority(fixture.db)).toMatchObject({
      reason: "producer-slot-priority", condition: "current-slot-unfinished", slotStartedAt: 1791907860,
    });
    const admission = reserveRecoveryAdmissionSql();
    expect(fixture.sqlite.prepare(`SELECT (${admission.sql}) AS admitted`).get(...admission.binds)).toEqual({ admitted: 0 });
    vi.setSystemTime((fixture.current + resolveScheduledSlotPolicy("fourHourlyReserveSync").hardDeadSec) * 1000);
    await expect(resolveReserveProducerAdmission(fixture.db)).resolves.toEqual({
      priority: null,
      currentSlot: { reason: "current-slot-never-delivered", slotStartedAt: 1791907860, graceSec: RESERVE_SLOT_NEVER_DELIVERED_GRACE_SEC },
    });
    expect(fixture.sqlite.prepare(`SELECT (${admission.sql}) AS admitted`).get(...admission.binds)).toEqual({ admitted: 1 });
  });

  it("proceeds past a never-delivered current slot only after its cadence-derived grace, and yields to a late original", async () => {
    const fixture = admittedFixture();
    expect(RESERVE_SLOT_NEVER_DELIVERED_GRACE_SEC).toBe(10 * 60);
    fixture.sqlite.prepare("DELETE FROM cron_slot_executions").run();
    const admitted = () => {
      const admission = reserveRecoveryAdmissionSql();
      return (fixture.sqlite.prepare(`SELECT (${admission.sql}) AS admitted`).get(...admission.binds) as { admitted: number }).admitted;
    };

    // Within grace: delivery may still be in flight.
    vi.setSystemTime((fixture.current + RESERVE_SLOT_NEVER_DELIVERED_GRACE_SEC - 1) * 1000);
    expect(await getReserveProducerPriority(fixture.db)).toMatchObject({ condition: "current-slot-unfinished" });
    expect(admitted()).toBe(0);

    // Past grace with no row: recovery proceeds and says why.
    vi.setSystemTime((fixture.current + RESERVE_SLOT_NEVER_DELIVERED_GRACE_SEC) * 1000);
    await expect(resolveReserveProducerAdmission(fixture.db)).resolves.toMatchObject({
      priority: null, currentSlot: { reason: "current-slot-never-delivered", slotStartedAt: fixture.current },
    });
    expect(admitted()).toBe(1);

    // Upcoming-slot protection still applies to a never-delivered slot.
    vi.setSystemTime((fixture.current + CRON_SCHEDULE_CADENCES.fourHourlyReserveSync.intervalSec - 60) * 1000);
    expect(await getReserveProducerPriority(fixture.db)).toMatchObject({ condition: "next-slot-lookahead" });
    expect(admitted()).toBe(0);

    // A late original claims its row and wins every fence from then on.
    const lateAt = fixture.current + RESERVE_SLOT_NEVER_DELIVERED_GRACE_SEC + 120;
    vi.setSystemTime(lateAt * 1000);
    fixture.sqlite.prepare(`INSERT INTO cron_slot_executions
      (slot_key, slot_started_at, state, execution_owner, execution_generation, started_at, updated_at)
      VALUES ('fourHourlyReserveSync', ?, 'running', 'late-original', 1, ?, ?)`)
      .run(fixture.current, lateAt, lateAt);
    expect(await getReserveProducerPriority(fixture.db)).toMatchObject({ condition: "producer-slot-live" });
    expect(admitted()).toBe(0);
  });

  it.each(["degraded", "error"])("releases producer priority after a finished %s slot", async (status) => {
    const fixture = admittedFixture();
    fixture.sqlite.prepare("UPDATE cron_slot_executions SET result_status = ?").run(status);
    expect(await getReserveProducerPriority(fixture.db)).toBeNull();
  });

  it.each(RESERVE_RECOVERY_CONFLICT_SLOT_KEYS)("protects a live same-role graph slot: %s", async (scheduleKey) => {
    const fixture = admittedFixture();
    fixture.sqlite.prepare(`INSERT INTO cron_slot_executions
      (slot_key, slot_started_at, state, execution_owner, execution_generation, started_at, updated_at)
      VALUES (?, ?, 'running', 'heavy', 1, ?, ?)`)
      .run(scheduleKey, fixture.now, fixture.now - 1, fixture.now);
    expect(await getReserveProducerPriority(fixture.db)).toMatchObject({
      reason: "same-role-slot-co-tenancy", scheduleKey, condition: "same-role-slot-running",
    });
    const admission = reserveRecoveryAdmissionSql();
    expect(fixture.sqlite.prepare(`SELECT (${admission.sql}) AS admitted`).get(...admission.binds)).toEqual({ admitted: 0 });
    fixture.sqlite.prepare("UPDATE cron_slot_executions SET started_at = ? WHERE execution_owner = 'heavy'")
      .run(fixture.now - SCHEDULED_SLOT_JOB_BUDGET_MS / 1000);
    expect(await getReserveProducerPriority(fixture.db)).toBeNull();
    expect(fixture.sqlite.prepare(`SELECT (${admission.sql}) AS admitted`).get(...admission.binds)).toEqual({ admitted: 1 });
  });

  it("projects conflicts from Worker ownership, including future role migrations", () => {
    expect(RESERVE_RECOVERY_CONFLICT_SLOT_KEYS).toEqual(["fourHourlyReserveSync"]);
    for (const key of ["halfHourlyChartsOffset", "v9PublicationOffset"] as const) {
      expect(getReserveRecoveryConflictSlotKeys({
        ...SCHEDULED_SLOT_PLANS, [key]: { worker: "public" },
      })).toEqual(["fourHourlyReserveSync", key]);
    }
    expect(getReserveRecoveryConflictSlotKeys({
      ...SCHEDULED_SLOT_PLANS,
      fourHourlyReserveSync: { worker: "heavy" },
    })).toEqual([]);
  });

  it.each(["halfHourlyChartsOffset", "v9PublicationOffset"])(
    "admits separate-Worker %s in preflight, checkpoint CAS and lease CAS", async (scheduleKey) => {
      const fixture = admittedFixture();
      fixture.sqlite.prepare(`INSERT INTO cron_slot_executions
        (slot_key, slot_started_at, state, execution_owner, execution_generation, started_at, updated_at)
        VALUES (?, ?, 'running', 'heavy', 1, ?, ?)`).run(scheduleKey, fixture.now, fixture.now, fixture.now);
      expect(await getReserveProducerPriority(fixture.db)).toBeNull();
      const admission = reserveRecoveryAdmissionSql();
      expect(fixture.sqlite.prepare(`SELECT (${admission.sql}) AS admitted`).get(...admission.binds)).toEqual({ admitted: 1 });
      await beginLiveReserveCheckpoint(fixture.db, { slotStartedAt: fixture.current - 14400, invocationId: "old" });
      fixture.sqlite.prepare("UPDATE worker_scheduled_checkpoints SET state = 'ready'").run();
      expect(await claimNextLiveReserveCheckpointRecovery(fixture.db, { owner: "new", leaseSec: 900 }))
        .toMatchObject({ disposition: "claimed" });
      const work = vi.fn(async () => "published");
      expect(await runCronWithLease(fixture.db, "sync-live-reserves", work, { reserveRecoveryAdmission: true }))
        .toMatchObject({ status: "ok", result: "published" });
      expect(work).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["fourHourlyReserveSync", "halfHourlyChartsOffset", "v9PublicationOffset"])(
    "applies role-aware admission at the late lease write: %s", async (scheduleKey) => {
      const fixture = admittedFixture();
      const db = createSqliteD1(fixture.sqlite, { onRun: (sql) => {
        if (sql.includes("INSERT INTO cron_leases")) fixture.sqlite.prepare(`INSERT INTO cron_slot_executions
          (slot_key, slot_started_at, state, execution_owner, execution_generation, started_at, updated_at)
          VALUES (?, ?, 'running', 'late-slot', 1, ?, ?)`).run(scheduleKey, fixture.now, fixture.now, fixture.now);
      } });
      const work = vi.fn(async () => "published");
      const result = await runCronWithLease(db, "sync-live-reserves", work, { reserveRecoveryAdmission: true });
      expect(result.status).toBe(scheduleKey === "fourHourlyReserveSync" ? "skipped_neutral" : "ok");
      expect(work).toHaveBeenCalledTimes(scheduleKey === "fourHourlyReserveSync" ? 0 : 1);
    },
  );

  it("keeps the global recovery lease live across intervening minute polls", async () => {
    const fixture = admittedFixture();
    fixture.sqlite.prepare(`INSERT INTO cron_leases (job, lease_owner, lease_until, heartbeat_at, updated_at)
      VALUES ('reserve-recovery', 'live-continuation', ?, ?, ?)`).run(fixture.now + 900, fixture.now, fixture.now);
    const work = vi.fn();
    for (const elapsed of [60, 120, 240, 300]) {
      vi.setSystemTime((fixture.now + elapsed) * 1000);
      expect(await runCronWithLease(fixture.db, "reserve-recovery", work)).toMatchObject({ status: "skipped_locked" });
    }
    expect(work).not.toHaveBeenCalled();
    expect(fixture.sqlite.prepare("SELECT lease_owner, lease_until FROM cron_leases").get())
      .toEqual({ lease_owner: "live-continuation", lease_until: fixture.now + 900 });
    expect(resolveScheduledSlotPolicy("fiveMinuteReserveRecovery").hardDeadSec).toBeGreaterThan(300);
  });

  it("propagates failed slot reads instead of admitting work", async () => {
    const fixture = admittedFixture();
    fixture.sqlite.exec("DROP TABLE cron_slot_executions");
    await expect(getReserveProducerPriority(fixture.db)).rejects.toThrow("no such table");
    vi.setSystemTime(new Date("2026-10-07T03:47:00Z"));
    await expect(getReserveProducerPriority(fixture.db)).rejects.toThrow("no such table");
  });

  it.each([false, true])("fences a producer row appearing after preflight during lease INSERT/conflict UPDATE (%s)", async (conflict) => {
    const fixture = admittedFixture();
    if (conflict) seedBlocker(fixture, "expired", -1);
    const db = createSqliteD1(fixture.sqlite, { onRun: (sql) => {
      if (sql.includes("INSERT INTO cron_leases")) fixture.sqlite.prepare("UPDATE cron_slot_executions SET state = 'running'").run();
    } });
    const work = vi.fn(async () => "published");
    const result = await runCronWithLease(db, "sync-live-reserves", work, { reserveRecoveryAdmission: true });
    expect(result).toMatchObject({ status: "skipped_neutral", producerPriority: { reason: "producer-slot-priority" } });
    expect(work).not.toHaveBeenCalled();
    expect(fixture.sqlite.prepare("SELECT lease_owner FROM cron_leases").all()).toEqual(conflict ? [{ lease_owner: "expired" }] : []);
  });

  it("checks priority before requeueing expired claims", async () => {
    const fixture = admittedFixture();
    const checkpoint = await beginLiveReserveCheckpoint(fixture.db, { slotStartedAt: fixture.current - 14400, invocationId: "recovery" });
    fixture.sqlite.prepare("UPDATE worker_scheduled_checkpoints SET state = 'recovering', recovery_owner = 'old', recovery_lease_until = ?")
      .run(fixture.now - 1);
    fixture.sqlite.prepare("UPDATE cron_slot_executions SET state = 'running'").run();
    expect(await claimNextLiveReserveCheckpointRecovery(fixture.db, { owner: "new", leaseSec: 900 })).toMatchObject({ disposition: "priority" });
    expect(fixture.sqlite.prepare("SELECT state, attempt_no FROM worker_scheduled_checkpoints").get())
      .toEqual({ state: "recovering", attempt_no: checkpoint.attemptNo });
  });

  it.each(["fourHourlyReserveSync", "halfHourlyChartsOffset", "v9PublicationOffset"])(
    "applies role-aware admission to a late slot start at checkpoint CAS: %s", async (scheduleKey) => {
    const fixture = admittedFixture();
    await beginLiveReserveCheckpoint(fixture.db, { slotStartedAt: fixture.current - 14400, invocationId: "old" });
    fixture.sqlite.prepare("UPDATE worker_scheduled_checkpoints SET state = 'ready'").run();
    const db = createSqliteD1(fixture.sqlite, { onRun: (sql) => {
      if (sql.includes("SET state = 'recovering'")) fixture.sqlite.prepare(`INSERT INTO cron_slot_executions
        (slot_key, slot_started_at, state, execution_owner, execution_generation, started_at, updated_at)
        VALUES (?, ?, 'running', 'late-slot', 1, ?, ?)`)
        .run(scheduleKey, fixture.now, fixture.now, fixture.now);
    } });
    const claim = await claimNextLiveReserveCheckpointRecovery(db, { owner: "new", leaseSec: 900 });
    if (scheduleKey === "fourHourlyReserveSync") {
      expect(claim).toMatchObject({ disposition: "priority", producerPriority: { reason: "same-role-slot-co-tenancy" } });
      expect(fixture.sqlite.prepare("SELECT state, invocation_id FROM worker_scheduled_checkpoints").get())
        .toEqual({ state: "ready", invocation_id: "old" });
    } else {
      expect(claim).toMatchObject({ disposition: "claimed" });
    }
  });
});

describe("bounded reserve producer lease waiting", () => {
  it("acquires at the strict-expiry next second with one requester and one execution", async () => {
    const fixture = admittedFixture();
    seedBlocker(fixture);
    const work = vi.fn(async () => "published");
    const waiting = vi.fn();
    const pending = runCronWithLease(fixture.db, "sync-live-reserves", work, {
      owner: "requester", acquisitionWait: { deadlineMs: Date.now() + 145000, onWait: waiting },
    });
    await vi.advanceTimersByTimeAsync(31000);
    expect(await pending).toMatchObject({ status: "ok", leaseOwner: "requester", leaseWaitDurationMs: 31000, leaseAcquisitionAttempts: 4 });
    expect(work).toHaveBeenCalledTimes(1);
    expect(waiting).toHaveBeenCalledTimes(3);
  });

  it("takes over at the captured deadline when the platform timer fires a millisecond late", async () => {
    const fixture = admittedFixture();
    seedBlocker(fixture);
    // Real event-loop timers fire after the requested delay. The lease expires at
    // now+30, so the wake at now+31.001 is the first eligible takeover second and
    // must still attempt while the caller's admission budget holds.
    const platformSetTimeout = globalThis.setTimeout;
    vi.spyOn(globalThis, "setTimeout").mockImplementation(
      ((handler: () => void, delayMs?: number) => platformSetTimeout(handler, (delayMs ?? 0) + 1)) as typeof setTimeout,
    );
    const work = vi.fn(async () => "published");
    const pending = runCronWithLease(fixture.db, "sync-live-reserves", work, {
      owner: "requester", acquisitionWait: { deadlineMs: Date.now() + 145000 },
    });
    await vi.advanceTimersByTimeAsync(32000);
    expect(await pending).toMatchObject({ status: "ok", leaseOwner: "requester" });
    expect(work).toHaveBeenCalledTimes(1);
  });

  it("acquires on the next poll when a live blocker releases early", async () => {
    const fixture = admittedFixture();
    seedBlocker(fixture, "live-blocker", 900);
    const work = vi.fn(async () => "published");
    const pending = runCronWithLease(fixture.db, "sync-live-reserves", work, {
      owner: "requester", acquisitionWait: { deadlineMs: Date.now() + 145000 },
    });
    await vi.advanceTimersByTimeAsync(5000);
    fixture.sqlite.prepare("DELETE FROM cron_leases WHERE lease_owner = 'live-blocker'").run();
    await vi.advanceTimersByTimeAsync(10000);
    expect(await pending).toMatchObject({ status: "ok", leaseWaitDurationMs: 15000, leaseAcquisitionAttempts: 2 });
    expect(work).toHaveBeenCalledTimes(1);
  });

  it("never admits after a slow wait observer consumes the fixed admission budget", async () => {
    const fixture = admittedFixture();
    seedBlocker(fixture, "live-blocker", 900);
    const work = vi.fn(async () => "published");
    const result = await runCronWithLease(fixture.db, "sync-live-reserves", work, {
      acquisitionWait: {
        deadlineMs: Date.now() + 10000,
        onWait: () => {
          vi.setSystemTime(Date.now() + 11000);
          fixture.sqlite.prepare("DELETE FROM cron_leases WHERE lease_owner = 'live-blocker'").run();
        },
      },
    });
    expect(result).toMatchObject({ status: "skipped_locked", leaseAcquisitionAttempts: 1, leaseWaitDurationMs: 11000 });
    expect(work).not.toHaveBeenCalled();
  });

  it("does not extend its captured deadline when the blocker renews", async () => {
    const fixture = admittedFixture();
    seedBlocker(fixture);
    const work = vi.fn(async () => "published");
    const pending = runCronWithLease(fixture.db, "sync-live-reserves", work, {
      owner: "requester", acquisitionWait: { deadlineMs: Date.now() + 145000 },
    });
    await vi.advanceTimersByTimeAsync(20000);
    fixture.sqlite.prepare("UPDATE cron_leases SET lease_until = ?").run(fixture.now + 900);
    await vi.advanceTimersByTimeAsync(11000);
    expect(await pending).toMatchObject({ status: "skipped_locked", leaseWaitDurationMs: 31000, blockedBy: { leaseUntil: fixture.now + 900 } });
    expect(work).not.toHaveBeenCalled();
  });

  it("aborts waiting without taking over or running the producer", async () => {
    const fixture = admittedFixture();
    seedBlocker(fixture);
    const controller = new AbortController();
    const work = vi.fn(async () => "published");
    const pending = runCronWithLease(fixture.db, "sync-live-reserves", work, {
      abortSignal: controller.signal, acquisitionWait: { deadlineMs: Date.now() + 145000 },
    });
    const rejected = expect(pending).rejects.toThrow("stop waiting");
    await vi.advanceTimersByTimeAsync(1000);
    controller.abort(new Error("stop waiting"));
    await rejected;
    expect(work).not.toHaveBeenCalled();
    expect(fixture.sqlite.prepare("SELECT lease_owner FROM cron_leases").get()).toEqual({ lease_owner: "legacy-owner" });
  });

  it("never infers a legacy holder from the lease key or another owner's progress", async () => {
    const fixture = admittedFixture();
    seedBlocker(fixture);
    fixture.sqlite.prepare(`INSERT INTO cron_run_progress (job, started_at, updated_at, lease_owner, metadata)
      VALUES ('sync-live-reserves', ?, ?, 'someone-else', ?)`)
      .run(fixture.now, fixture.now, JSON.stringify({ invocationId: "unrelated", scheduleKey: "fourHourlyReserveSync" }));
    expect(await runCronWithLease(fixture.db, "sync-live-reserves", async () => {}, { owner: "requester" }))
      .toMatchObject({ blockedBy: { holderJob: null, path: null, invocationId: null, scheduleKey: null, slotStartedAt: null } });
    fixture.sqlite.prepare("UPDATE cron_run_progress SET lease_owner = 'legacy-owner', slot_started_at = ?")
      .run(fixture.now);
    expect(await runCronWithLease(fixture.db, "sync-live-reserves", async () => {}, { owner: "requester" }))
      .toMatchObject({ blockedBy: { holderJob: "sync-live-reserves", invocationId: "unrelated", scheduleKey: "fourHourlyReserveSync", slotStartedAt: fixture.now } });
  });
});
