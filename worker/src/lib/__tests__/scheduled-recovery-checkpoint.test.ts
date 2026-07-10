import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createSqliteD1 } from "../../test-helpers/sqlite-d1";
import {
  advanceScheduledCheckpoint,
  beginScheduledCheckpoint,
  claimNextScheduledCheckpointRecovery,
  loadScheduledCheckpoint,
  markScheduledCheckpointDomainAttempt,
  markScheduledCheckpointItemStarted,
  prepareScheduledCheckpointRecoveryForSlot,
  ScheduledCheckpointOwnershipLostError,
  setScheduledCheckpointChildDisposition,
} from "../scheduled-recovery-checkpoint";

const CHILD_JOBS = [
  "sync-live-reserves",
  "sync-redemption-backstops",
  "sync-kinesis-supply",
  "reserve-post-sync-watchdog",
] as const;

const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../../migrations");

function createHarness() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    CREATE TABLE cron_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      metadata TEXT,
      slot_started_at INTEGER
    );
    CREATE TABLE reserve_sync_state (
      stablecoin_id TEXT PRIMARY KEY,
      adapter_key TEXT NOT NULL,
      breaker_key TEXT NOT NULL,
      last_attempted_at INTEGER,
      last_success_at INTEGER,
      last_status TEXT NOT NULL,
      warning_count INTEGER NOT NULL DEFAULT 0,
      warnings TEXT,
      last_error TEXT,
      metadata TEXT NOT NULL DEFAULT '{}',
      last_attempt_id TEXT,
      pending_attempt_id TEXT,
      last_success_attempt_id TEXT
    );
    CREATE TABLE reserve_sync_attempt_history (
      stablecoin_id TEXT NOT NULL,
      attempted_at INTEGER NOT NULL,
      adapter_key TEXT NOT NULL,
      breaker_key TEXT NOT NULL,
      attempt_id TEXT,
      status TEXT NOT NULL,
      warnings TEXT,
      warning_count INTEGER NOT NULL,
      last_error TEXT,
      metadata TEXT NOT NULL
    );
    CREATE UNIQUE INDEX idx_reserve_attempt_test
      ON reserve_sync_attempt_history(stablecoin_id, attempt_id)
      WHERE attempt_id IS NOT NULL;
  `);
  sqlite.exec(readFileSync(resolve(MIGRATIONS_DIR, "0173_scheduled_recovery_checkpoints.sql"), "utf8"));
  return { sqlite, db: createSqliteD1(sqlite) };
}

describe("scheduled recovery checkpoint", () => {
  const openDatabases: DatabaseSync[] = [];

  afterEach(() => {
    for (const sqlite of openDatabases.splice(0)) sqlite.close();
  });

  function harness() {
    const value = createHarness();
    openDatabases.push(value.sqlite);
    return value;
  }

  it("fences an abandoned attempt, clears only its pending domain attempt, and creates attempt two", async () => {
    const { sqlite, db } = harness();
    const checkpoint = await beginScheduledCheckpoint(db, {
      scheduleKey: "fourHourlyReserveSync",
      slotStartedAt: 1_000,
      job: "sync-live-reserves",
      invocationId: "slot-owner-1",
      workerVersion: "version-a",
      queueHash: "queue-a",
      nextItemKey: "coin-a",
      itemsTotal: 276,
      childJobs: CHILD_JOBS,
      nowSec: 1_001,
    });
    await markScheduledCheckpointItemStarted(db, checkpoint, {
      itemKey: "coin-b",
      itemsDone: 147,
      itemsTotal: 276,
      nowSec: 1_010,
    });
    await markScheduledCheckpointDomainAttempt(db, checkpoint, "coin-b", "domain-attempt-1", 1_011);
    sqlite.prepare(
      `INSERT INTO reserve_sync_state (
         stablecoin_id, adapter_key, breaker_key, last_attempted_at, last_status,
         last_attempt_id, pending_attempt_id
       ) VALUES (?, 'mento', 'live-reserves:mento', ?, 'skipped', ?, ?)`,
    ).run("coin-b", 1_011, "domain-attempt-1", "domain-attempt-1");
    sqlite.prepare(
      `INSERT INTO reserve_sync_state (
         stablecoin_id, adapter_key, breaker_key, last_attempted_at, last_status,
         last_attempt_id, pending_attempt_id
       ) VALUES (?, 'other', 'live-reserves:other', ?, 'skipped', ?, ?)`,
    ).run("coin-c", 1_012, "domain-attempt-2", "domain-attempt-2");

    const prepared = await prepareScheduledCheckpointRecoveryForSlot(db, {
      scheduleKey: "fourHourlyReserveSync",
      slotStartedAt: 1_000,
      job: "sync-live-reserves",
      childJobs: CHILD_JOBS,
      nowSec: 1_100,
    });

    expect(prepared).toEqual({
      abandonedAttemptNo: 1,
      recoveryAttemptNo: 2,
      currentItemKey: "coin-b",
      currentDomainAttemptId: "domain-attempt-1",
    });
    expect(sqlite.prepare("SELECT state FROM worker_scheduled_checkpoints WHERE attempt_no = 1").get()).toEqual({
      state: "platform_abandoned",
    });
    const ready = await loadScheduledCheckpoint(db, {
      scheduleKey: "fourHourlyReserveSync",
      slotStartedAt: 1_000,
      job: "sync-live-reserves",
      attemptNo: 2,
    });
    expect(ready).toMatchObject({
      state: "ready",
      executionGeneration: 2,
      nextItemKey: "coin-b",
      currentDomainAttemptId: "domain-attempt-1",
      itemsDone: 147,
      childDispositions: Object.fromEntries(CHILD_JOBS.map((job) => [job, "not_started"])),
    });
    expect(sqlite.prepare("SELECT pending_attempt_id, last_error FROM reserve_sync_state WHERE stablecoin_id = 'coin-b'").get())
      .toMatchObject({ pending_attempt_id: null, last_error: expect.stringContaining("scheduled invocation ended") });
    expect(sqlite.prepare("SELECT pending_attempt_id, last_error FROM reserve_sync_state WHERE stablecoin_id = 'coin-c'").get())
      .toEqual({ pending_attempt_id: "domain-attempt-2", last_error: null });
    expect(sqlite.prepare("SELECT status, attempt_id FROM reserve_sync_attempt_history").get()).toEqual({
      status: "error",
      attempt_id: "domain-attempt-1",
    });
    await expect(advanceScheduledCheckpoint(db, checkpoint, { nextItemKey: "coin-c", itemsDone: 148 }))
      .rejects.toBeInstanceOf(ScheduledCheckpointOwnershipLostError);
  });

  it("preserves completed children, marks only unfinished children abandoned, and ignores duplicate sweeps", async () => {
    const { sqlite, db } = harness();
    const checkpoint = await beginScheduledCheckpoint(db, {
      scheduleKey: "fourHourlyReserveSync",
      slotStartedAt: 1_500,
      job: "sync-live-reserves",
      invocationId: "slot-owner-1",
      queueHash: "queue-a",
      nextItemKey: "coin-a",
      itemsTotal: 276,
      childJobs: CHILD_JOBS,
      nowSec: 1_501,
    });
    await setScheduledCheckpointChildDisposition(db, checkpoint, "sync-live-reserves", "completed", 1_510);
    sqlite.prepare(
      "INSERT INTO cron_runs (job, started_at, metadata, slot_started_at) VALUES (?, ?, ?, ?)",
    ).run("sync-live-reserves", 1_505, JSON.stringify({ childDisposition: "completed" }), 1_500);

    await expect(prepareScheduledCheckpointRecoveryForSlot(db, {
      scheduleKey: checkpoint.scheduleKey,
      slotStartedAt: checkpoint.slotStartedAt,
      job: checkpoint.job,
      childJobs: CHILD_JOBS,
      nowSec: 1_600,
    })).resolves.toMatchObject({ abandonedAttemptNo: 1, recoveryAttemptNo: 2 });

    const abandoned = await loadScheduledCheckpoint(db, {
      scheduleKey: checkpoint.scheduleKey,
      slotStartedAt: checkpoint.slotStartedAt,
      job: checkpoint.job,
      attemptNo: 1,
    });
    expect(abandoned?.childDispositions).toEqual({
      "sync-live-reserves": "completed",
      "sync-redemption-backstops": "platform_abandoned",
      "sync-kinesis-supply": "platform_abandoned",
      "reserve-post-sync-watchdog": "platform_abandoned",
    });

    const ready = await loadScheduledCheckpoint(db, {
      scheduleKey: checkpoint.scheduleKey,
      slotStartedAt: checkpoint.slotStartedAt,
      job: checkpoint.job,
      attemptNo: 2,
    });
    expect(ready?.childDispositions).toEqual({
      "sync-live-reserves": "completed",
      "sync-redemption-backstops": "not_started",
      "sync-kinesis-supply": "not_started",
      "reserve-post-sync-watchdog": "not_started",
    });

    await expect(prepareScheduledCheckpointRecoveryForSlot(db, {
      scheduleKey: checkpoint.scheduleKey,
      slotStartedAt: checkpoint.slotStartedAt,
      job: checkpoint.job,
      childJobs: CHILD_JOBS,
      nowSec: 1_601,
    })).resolves.toBeNull();
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM worker_scheduled_checkpoints").get()).toEqual({ count: 2 });
  });

  it("allows only one recovery owner to win the ready-checkpoint CAS", async () => {
    const { db } = harness();
    const first = await beginScheduledCheckpoint(db, {
      scheduleKey: "fourHourlyReserveSync",
      slotStartedAt: 1_700,
      job: "sync-live-reserves",
      invocationId: "slot-owner-1",
      queueHash: "queue-a",
      nextItemKey: "coin-a",
      itemsTotal: 276,
      childJobs: CHILD_JOBS,
      nowSec: 1_701,
    });
    await prepareScheduledCheckpointRecoveryForSlot(db, {
      scheduleKey: first.scheduleKey,
      slotStartedAt: first.slotStartedAt,
      job: first.job,
      childJobs: CHILD_JOBS,
      nowSec: 1_710,
    });

    const claims = await Promise.all([
      claimNextScheduledCheckpointRecovery(db, {
        job: first.job,
        childJobs: CHILD_JOBS,
        owner: "recovery-owner-a",
        leaseSec: 60,
        nowSec: 1_711,
      }),
      claimNextScheduledCheckpointRecovery(db, {
        job: first.job,
        childJobs: CHILD_JOBS,
        owner: "recovery-owner-b",
        leaseSec: 60,
        nowSec: 1_711,
      }),
    ]);

    expect(claims.filter((claim) => claim != null)).toHaveLength(1);
    expect(claims.find((claim) => claim != null)?.state).toBe("recovering");
  });

  it("requeues an expired recovery under the next attempt number", async () => {
    const { sqlite, db } = harness();
    const first = await beginScheduledCheckpoint(db, {
      scheduleKey: "fourHourlyReserveSync",
      slotStartedAt: 2_000,
      job: "sync-live-reserves",
      invocationId: "slot-owner-1",
      queueHash: "queue-a",
      nextItemKey: "coin-a",
      itemsTotal: 276,
      childJobs: CHILD_JOBS,
      nowSec: 2_001,
    });
    await prepareScheduledCheckpointRecoveryForSlot(db, {
      scheduleKey: first.scheduleKey,
      slotStartedAt: first.slotStartedAt,
      job: first.job,
      childJobs: CHILD_JOBS,
      nowSec: 2_100,
    });
    const second = await claimNextScheduledCheckpointRecovery(db, {
      job: "sync-live-reserves",
      childJobs: CHILD_JOBS,
      owner: "recovery-owner-2",
      leaseSec: 60,
      nowSec: 2_101,
    });
    expect(second).toMatchObject({ attemptNo: 2, state: "recovering" });
    await markScheduledCheckpointItemStarted(db, second!, {
      itemKey: "coin-c",
      itemsDone: 200,
      itemsTotal: 276,
      recoveryLeaseUntil: 2_160,
      nowSec: 2_102,
    });

    const third = await claimNextScheduledCheckpointRecovery(db, {
      job: "sync-live-reserves",
      childJobs: CHILD_JOBS,
      owner: "recovery-owner-3",
      leaseSec: 60,
      nowSec: 2_200,
    });

    expect(third).toMatchObject({
      attemptNo: 3,
      executionGeneration: 3,
      sourceAttemptNo: 2,
      state: "recovering",
      nextItemKey: "coin-c",
    });
    expect(sqlite.prepare("SELECT state FROM worker_scheduled_checkpoints WHERE attempt_no = 2").get()).toEqual({
      state: "platform_abandoned",
    });
  });
});
