import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import { createSqliteD1 } from "@shared/test-utils/sqlite-d1";
import { getCronSlotStartedAtForSchedule } from "@shared/lib/cron-jobs";
import { CRON_SCHEDULE_CADENCES } from "@shared/lib/cron-cadences";
import { RESERVE_RECOVERY_HEAVY_SLOT_KEYS } from "@shared/lib/scheduled-runner-registry";
import {
  createReserveLeaseOwner, getReserveProducerPriority, getReserveRecoveryLookaheadSec,
  reserveRecoveryAdmissionSql,
} from "../reserve-producer-priority";
import { runCronWithLease } from "../cron-lease-primitives";
import { beginLiveReserveCheckpoint, claimNextLiveReserveCheckpointRecovery } from "../scheduled-recovery-checkpoint";
import { SCHEDULED_SLOT_JOB_BUDGET_MS } from "../cron-timeouts";

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
  it("derives the 24-minute producer protection budget", () => {
    expect(getReserveRecoveryLookaheadSec()).toBe(1440);
  });

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

  it.each(["missing", "running", "reconciling", "null-finished-at"])("protects an unfinished due producer: %s", async (state) => {
    const fixture = admittedFixture();
    if (state === "missing") fixture.sqlite.prepare("DELETE FROM cron_slot_executions").run();
    else if (state === "null-finished-at") fixture.sqlite.prepare("UPDATE cron_slot_executions SET finished_at = NULL").run();
    else fixture.sqlite.prepare("UPDATE cron_slot_executions SET state = ?").run(state);
    expect(await getReserveProducerPriority(fixture.db)).toMatchObject({
      reason: "producer-slot-priority", condition: "current-slot-unfinished", slotStartedAt: fixture.current,
    });
  });

  it.each(["degraded", "error"])("releases producer priority after a finished %s slot", async (status) => {
    const fixture = admittedFixture();
    fixture.sqlite.prepare("UPDATE cron_slot_executions SET result_status = ?").run(status);
    expect(await getReserveProducerPriority(fixture.db)).toBeNull();
  });

  it.each(RESERVE_RECOVERY_HEAVY_SLOT_KEYS)("protects a live controlled heavy slot: %s", async (scheduleKey) => {
    const fixture = admittedFixture();
    fixture.sqlite.prepare(`INSERT INTO cron_slot_executions
      (slot_key, slot_started_at, state, execution_owner, execution_generation, started_at, updated_at)
      VALUES (?, ?, 'running', 'heavy', 1, ?, ?)`)
      .run(scheduleKey, fixture.now, fixture.now - 1, fixture.now);
    expect(await getReserveProducerPriority(fixture.db)).toMatchObject({
      reason: "heavy-slot-co-tenancy", scheduleKey, condition: "heavy-slot-running",
    });
    const admission = reserveRecoveryAdmissionSql();
    expect(fixture.sqlite.prepare(`SELECT (${admission.sql}) AS admitted`).get(...admission.binds)).toEqual({ admitted: 0 });
    fixture.sqlite.prepare("UPDATE cron_slot_executions SET started_at = ? WHERE execution_owner = 'heavy'")
      .run(fixture.now - SCHEDULED_SLOT_JOB_BUDGET_MS / 1000);
    expect(await getReserveProducerPriority(fixture.db)).toBeNull();
    expect(fixture.sqlite.prepare(`SELECT (${admission.sql}) AS admitted`).get(...admission.binds)).toEqual({ admitted: 1 });
  });

  it("propagates failed slot reads instead of admitting work", async () => {
    const fixture = admittedFixture();
    fixture.sqlite.exec("DROP TABLE cron_slot_executions");
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

  it("fences a heavy-slot start between claim selection and mutation", async () => {
    const fixture = admittedFixture();
    await beginLiveReserveCheckpoint(fixture.db, { slotStartedAt: fixture.current - 14400, invocationId: "old" });
    fixture.sqlite.prepare("UPDATE worker_scheduled_checkpoints SET state = 'ready'").run();
    const db = createSqliteD1(fixture.sqlite, { onRun: (sql) => {
      if (sql.includes("SET state = 'recovering'")) fixture.sqlite.prepare(`INSERT INTO cron_slot_executions
        (slot_key, slot_started_at, state, execution_owner, execution_generation, started_at, updated_at)
        VALUES ('halfHourlyChartsOffset', ?, 'running', 'heavy', 1, ?, ?)`)
        .run(fixture.now, fixture.now, fixture.now);
    } });
    expect(await claimNextLiveReserveCheckpointRecovery(db, { owner: "new", leaseSec: 900 }))
      .toMatchObject({ disposition: "priority", producerPriority: { reason: "heavy-slot-co-tenancy" } });
    expect(fixture.sqlite.prepare("SELECT state, invocation_id FROM worker_scheduled_checkpoints").get())
      .toEqual({ state: "ready", invocation_id: "old" });
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

  it("honors a smaller remaining head/slot admission cap", async () => {
    const fixture = admittedFixture();
    seedBlocker(fixture, "long-blocker", 900);
    const work = vi.fn(async () => "published");
    const pending = runCronWithLease(fixture.db, "sync-live-reserves", work, {
      acquisitionWait: { deadlineMs: Date.now() + 10000 },
    });
    await vi.advanceTimersByTimeAsync(10000);
    expect(await pending).toMatchObject({ status: "skipped_locked", leaseWaitDurationMs: 10000 });
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

  it("attributes the actual structured holder separately from the requester", async () => {
    const fixture = admittedFixture();
    const owner = createReserveLeaseOwner("holder-id", "reserve-recovery", "reserve-config-recovery", {
      invocationId: "holder-invocation", scheduleKey: "fiveMinuteReserveRecovery", slotStartedAt: fixture.now,
    });
    seedBlocker(fixture, owner);
    expect(await runCronWithLease(fixture.db, "sync-live-reserves", async () => {}, { owner: "requester" }))
      .toMatchObject({ status: "skipped_locked", leaseOwner: "requester", blockedBy: {
        leaseJob: "sync-live-reserves", leaseOwner: owner, holderJob: "reserve-recovery", path: "reserve-config-recovery",
        invocationId: "holder-invocation", scheduleKey: "fiveMinuteReserveRecovery", slotStartedAt: fixture.now,
      } });
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
