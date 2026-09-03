import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { createLatestSchemaSqlite } from "../../test-helpers/latest-schema-sqlite";
import { createSqliteD1 } from "../../test-helpers/sqlite-d1";
import {
  advanceLiveReserveCheckpoint,
  beginLiveReserveCheckpoint,
  claimNextLiveReserveCheckpointRecovery as claimNextCheckpointRecovery,
  loadLiveReserveCheckpoint as loadCheckpoint,
  markLiveReserveCheckpointItemStarted,
  prepareEligibleLiveReserveCheckpointRecoveries as prepareEligibleCheckpointRecoveries,
  prepareLiveReserveCheckpointRecoveryForSlot as prepareCheckpointRecoveryForSlot,
  ScheduledCheckpointOwnershipLostError,
  setLiveReserveCheckpointChildDisposition,
} from "../scheduled-recovery-checkpoint";
import { LIVE_RESERVE_QUEUE_HASH } from "../../cron/sync-live-reserves-shared";

const CHILD_JOBS = [
  "sync-live-reserves",
  "sync-redemption-backstops",
  "sync-kinesis-supply",
  "reserve-post-sync-watchdog",
] as const;
const CHILD_PREREQUISITES = {
  "sync-live-reserves": [],
  "sync-redemption-backstops": ["sync-live-reserves"],
  "sync-kinesis-supply": [],
  "reserve-post-sync-watchdog": ["sync-live-reserves"],
} as const;

function createHarness() {
  return createLatestSchemaSqlite();
}

async function beginCheckpoint(
  db: D1Database,
  input: {
    slotStartedAt: number;
    invocationId: string;
    scheduleKey?: string;
    job?: string;
    workerVersion?: string | null;
    queueHash?: string;
    nextItemKey?: string | null;
    itemsTotal?: number;
    childJobs?: readonly string[];
    nowSec?: number;
  },
) {
  const checkpoint = await beginLiveReserveCheckpoint(db, {
    slotStartedAt: input.slotStartedAt,
    invocationId: input.invocationId,
    workerVersion: input.workerVersion,
    nowSec: input.nowSec,
  });
  const queueHash = input.queueHash ?? checkpoint.queueHash;
  const nextItemKey = input.nextItemKey === undefined ? checkpoint.nextItemKey : input.nextItemKey;
  const itemsTotal = input.itemsTotal ?? checkpoint.itemsTotal;
  await db
    .prepare(
      `UPDATE worker_scheduled_checkpoints
          SET queue_hash = ?, next_item_key = ?, items_total = ?
        WHERE schedule_key = ? AND slot_started_at = ? AND job = ? AND attempt_no = ?`,
    )
    .bind(
      queueHash,
      nextItemKey,
      itemsTotal,
      checkpoint.scheduleKey,
      checkpoint.slotStartedAt,
      checkpoint.job,
      checkpoint.attemptNo,
    )
    .run();
  return { ...checkpoint, queueHash, nextItemKey, itemsTotal };
}

function loadLiveReserveCheckpoint(
  db: D1Database,
  input: { slotStartedAt: number; attemptNo: number; [key: string]: unknown },
) {
  return loadCheckpoint(db, input);
}

function prepareLiveReserveCheckpointRecoveryForSlot(
  db: D1Database,
  input: { slotStartedAt: number; nowSec?: number; [key: string]: unknown },
) {
  return prepareCheckpointRecoveryForSlot(db, input);
}



function prepareEligibleLiveReserveCheckpointRecoveries(
  db: D1Database,
  input: { staleAfterSec: number; nowSec?: number; limit?: number; [key: string]: unknown },
) {
  return prepareEligibleCheckpointRecoveries(db, input);
}

function claimNextLiveReserveCheckpointRecovery(
  db: D1Database,
  input: { owner: string; leaseSec: number; nowSec?: number; [key: string]: unknown },
) {
  return claimNextCheckpointRecovery(db, input);
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
    const checkpoint = await beginCheckpoint(db, {
      scheduleKey: "fourHourlyReserveSync",
      slotStartedAt: 1_000,
      job: "sync-live-reserves",
      invocationId: "slot-owner-1",
      workerVersion: "version-a",
      queueHash: LIVE_RESERVE_QUEUE_HASH,
      nextItemKey: "coin-a",
      itemsTotal: 276,
      childJobs: CHILD_JOBS,
      nowSec: 1_001,
    });
    await markLiveReserveCheckpointItemStarted(db, checkpoint, {
      itemKey: "coin-b",
      domainAttemptId: "domain-attempt-1",
      itemsDone: 147,
      itemsTotal: 276,
      nowSec: 1_010,
    });
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

    const prepared = await prepareLiveReserveCheckpointRecoveryForSlot(db, {
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
    const ready = await loadLiveReserveCheckpoint(db, {
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
    expect(sqlite.prepare(
      "SELECT * FROM worker_scheduled_checkpoints WHERE slot_started_at = 1000 ORDER BY attempt_no",
    ).all()).toEqual([
      {
        schedule_key: "fourHourlyReserveSync",
        slot_started_at: 1_000,
        job: "sync-live-reserves",
        attempt_no: 1,
        execution_generation: 1,
        invocation_id: "slot-owner-1",
        worker_version: "version-a",
        queue_hash: LIVE_RESERVE_QUEUE_HASH,
        state: "platform_abandoned",
        next_item_key: "coin-b",
        current_item_key: "coin-b",
        current_domain_attempt_id: "domain-attempt-1",
        items_done: 147,
        items_total: 276,
        child_dispositions_json: JSON.stringify(
          Object.fromEntries(CHILD_JOBS.map((job) => [job, "platform_abandoned"])),
        ),
        recovery_owner: null,
        recovery_lease_until: null,
        source_attempt_no: null,
        error: "scheduled invocation ended before terminal checkpoint",
        created_at: 1_001,
        updated_at: 1_100,
        completed_at: 1_100,
      },
      {
        schedule_key: "fourHourlyReserveSync",
        slot_started_at: 1_000,
        job: "sync-live-reserves",
        attempt_no: 2,
        execution_generation: 2,
        invocation_id: "recovery-pending:fourHourlyReserveSync:1000:sync-live-reserves:2",
        worker_version: "version-a",
        queue_hash: LIVE_RESERVE_QUEUE_HASH,
        state: "ready",
        next_item_key: "coin-b",
        current_item_key: null,
        current_domain_attempt_id: "domain-attempt-1",
        items_done: 147,
        items_total: 276,
        child_dispositions_json: JSON.stringify(
          Object.fromEntries(CHILD_JOBS.map((job) => [job, "not_started"])),
        ),
        recovery_owner: null,
        recovery_lease_until: null,
        source_attempt_no: 1,
        error: null,
        created_at: 1_100,
        updated_at: 1_100,
        completed_at: null,
      },
    ]);
    expect(sqlite.prepare("SELECT pending_attempt_id, last_error FROM reserve_sync_state WHERE stablecoin_id = 'coin-b'").get())
      .toMatchObject({ pending_attempt_id: null, last_error: expect.stringContaining("scheduled invocation ended") });
    expect(sqlite.prepare("SELECT pending_attempt_id, last_error FROM reserve_sync_state WHERE stablecoin_id = 'coin-c'").get())
      .toEqual({ pending_attempt_id: "domain-attempt-2", last_error: null });
    expect(sqlite.prepare("SELECT status, attempt_id FROM reserve_sync_attempt_history").get()).toEqual({
      status: "error",
      attempt_id: "domain-attempt-1",
    });
    await expect(claimNextLiveReserveCheckpointRecovery(db, {
      owner: "recovery-owner-after-isolate-restart",
      leaseSec: 60,
      nowSec: 1_101,
    })).resolves.toMatchObject({ attemptNo: 2, state: "recovering" });
    expect(sqlite.prepare(
      "SELECT COUNT(*) AS count FROM reserve_sync_attempt_history WHERE attempt_id = 'domain-attempt-1'",
    ).get()).toEqual({ count: 1 });
    await expect(advanceLiveReserveCheckpoint(db, checkpoint, { nextItemKey: "coin-c", itemsDone: 148 }))
      .rejects.toBeInstanceOf(ScheduledCheckpointOwnershipLostError);
  });

  it("rolls back checkpoint, reserve-attempt, and ready-attempt writes when atomic preparation faults", async () => {
    const { sqlite, db } = harness();
    const checkpoint = await beginCheckpoint(db, {
      slotStartedAt: 1_200,
      invocationId: "slot-owner-fault",
      nextItemKey: "coin-fault",
      itemsTotal: 10,
      nowSec: 1_201,
    });
    await markLiveReserveCheckpointItemStarted(db, checkpoint, {
      itemKey: "coin-fault",
      domainAttemptId: "domain-attempt-fault",
      itemsDone: 4,
      itemsTotal: 10,
      nowSec: 1_210,
    });
    sqlite.prepare(
      `INSERT INTO reserve_sync_state (
         stablecoin_id, adapter_key, breaker_key, last_attempted_at, last_status,
         last_attempt_id, pending_attempt_id
       ) VALUES ('coin-fault', 'adapter', 'breaker', 1210, 'skipped',
                 'domain-attempt-fault', 'domain-attempt-fault')`,
    ).run();
    const faultDb = createSqliteD1(sqlite, {
      onRun(sql) {
        if (sql.includes("UPDATE reserve_sync_state")) throw new Error("injected reserve abandonment fault");
      },
    });

    await expect(prepareLiveReserveCheckpointRecoveryForSlot(faultDb, {
      slotStartedAt: 1_200,
      nowSec: 1_300,
    })).rejects.toThrow("injected reserve abandonment fault");

    expect(sqlite.prepare(
      `SELECT state, current_item_key, current_domain_attempt_id, updated_at, completed_at
         FROM worker_scheduled_checkpoints WHERE slot_started_at = 1200 AND attempt_no = 1`,
    ).get()).toEqual({
      state: "running",
      current_item_key: "coin-fault",
      current_domain_attempt_id: "domain-attempt-fault",
      updated_at: 1_210,
      completed_at: null,
    });
    expect(sqlite.prepare(
      "SELECT COUNT(*) AS count FROM worker_scheduled_checkpoints WHERE slot_started_at = 1200",
    ).get()).toEqual({ count: 1 });
    expect(sqlite.prepare(
      "SELECT pending_attempt_id, last_error FROM reserve_sync_state WHERE stablecoin_id = 'coin-fault'",
    ).get()).toEqual({ pending_attempt_id: "domain-attempt-fault", last_error: null });
    expect(sqlite.prepare(
      "SELECT COUNT(*) AS count FROM reserve_sync_attempt_history WHERE stablecoin_id = 'coin-fault'",
    ).get()).toEqual({ count: 0 });
  });

  it("preserves completed children, marks only unfinished children abandoned, and ignores duplicate sweeps", async () => {
    const { sqlite, db } = harness();
    const checkpoint = await beginCheckpoint(db, {
      scheduleKey: "fourHourlyReserveSync",
      slotStartedAt: 1_500,
      job: "sync-live-reserves",
      invocationId: "slot-owner-1",
      queueHash: LIVE_RESERVE_QUEUE_HASH,
      nextItemKey: "coin-a",
      itemsTotal: 276,
      childJobs: CHILD_JOBS,
      nowSec: 1_501,
    });
    await advanceLiveReserveCheckpoint(db, checkpoint, {
      nextItemKey: null,
      itemsDone: 276,
      nowSec: 1_509,
    });
    await setLiveReserveCheckpointChildDisposition(db, checkpoint, "sync-live-reserves", "completed", 1_510);
    sqlite.prepare(
      "INSERT INTO cron_runs (job, started_at, duration_ms, status, metadata, slot_started_at) VALUES (?, ?, 0, 'ok', ?, ?)",
    ).run("sync-live-reserves", 1_505, JSON.stringify({ childDisposition: "completed" }), 1_500);
    sqlite.prepare(
      "INSERT INTO cron_runs (job, started_at, duration_ms, status, metadata, slot_started_at) VALUES (?, ?, 0, 'degraded', ?, ?)",
    ).run(
      "sync-redemption-backstops",
      1_506,
      JSON.stringify({
        skippedReason: "upstream-blocked:sync-live-reserves",
        childDisposition: "not_started",
      }),
      1_500,
    );

    await expect(prepareLiveReserveCheckpointRecoveryForSlot(db, {
      scheduleKey: checkpoint.scheduleKey,
      slotStartedAt: checkpoint.slotStartedAt,
      job: checkpoint.job,
      childJobs: CHILD_JOBS,
      nowSec: 1_600,
    })).resolves.toMatchObject({ abandonedAttemptNo: 1, recoveryAttemptNo: 2 });

    const abandoned = await loadLiveReserveCheckpoint(db, {
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

    const ready = await loadLiveReserveCheckpoint(db, {
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

    await expect(prepareLiveReserveCheckpointRecoveryForSlot(db, {
      scheduleKey: checkpoint.scheduleKey,
      slotStartedAt: checkpoint.slotStartedAt,
      job: checkpoint.job,
      childJobs: CHILD_JOBS,
      nowSec: 1_601,
    })).resolves.toBeNull();
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM worker_scheduled_checkpoints").get()).toEqual({ count: 2 });
  });

  it("preserves completed independent children when the reserve frontier is unfinished", async () => {
    const { db } = harness();
    const checkpoint = await beginCheckpoint(db, {
      scheduleKey: "fourHourlyReserveSync",
      slotStartedAt: 1_600,
      job: "sync-live-reserves",
      invocationId: "slot-owner-1",
      queueHash: LIVE_RESERVE_QUEUE_HASH,
      nextItemKey: "coin-b",
      itemsTotal: 276,
      childJobs: CHILD_JOBS,
      nowSec: 1_601,
    });
    await setLiveReserveCheckpointChildDisposition(
      db,
      checkpoint,
      "sync-kinesis-supply",
      "completed",
      1_602,
    );

    await prepareLiveReserveCheckpointRecoveryForSlot(db, {
      scheduleKey: checkpoint.scheduleKey,
      slotStartedAt: checkpoint.slotStartedAt,
      job: checkpoint.job,
      childJobs: CHILD_JOBS,
      childPrerequisites: CHILD_PREREQUISITES,
      nowSec: 1_610,
    });

    const ready = await loadLiveReserveCheckpoint(db, {
      scheduleKey: checkpoint.scheduleKey,
      slotStartedAt: checkpoint.slotStartedAt,
      job: checkpoint.job,
      attemptNo: 2,
    });
    expect(ready?.childDispositions).toEqual({
      "sync-live-reserves": "not_started",
      "sync-redemption-backstops": "not_started",
      "sync-kinesis-supply": "completed",
      "reserve-post-sync-watchdog": "not_started",
    });
  });

  it("allows only one recovery owner to win the ready-checkpoint CAS", async () => {
    const { db } = harness();
    const first = await beginCheckpoint(db, {
      scheduleKey: "fourHourlyReserveSync",
      slotStartedAt: 1_700,
      job: "sync-live-reserves",
      invocationId: "slot-owner-1",
      queueHash: LIVE_RESERVE_QUEUE_HASH,
      nextItemKey: "coin-a",
      itemsTotal: 276,
      childJobs: CHILD_JOBS,
      nowSec: 1_701,
    });
    await prepareLiveReserveCheckpointRecoveryForSlot(db, {
      scheduleKey: first.scheduleKey,
      slotStartedAt: first.slotStartedAt,
      job: first.job,
      childJobs: CHILD_JOBS,
      nowSec: 1_710,
    });

    const claims = await Promise.all([
      claimNextLiveReserveCheckpointRecovery(db, {
        job: first.job,
        childJobs: CHILD_JOBS,
        owner: "recovery-owner-a",
        leaseSec: 60,
        nowSec: 1_711,
      }),
      claimNextLiveReserveCheckpointRecovery(db, {
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

  it("prepares and claims the exact suffix after a budget-truncated degraded slot", async () => {
    const { sqlite, db } = harness();
    const checkpoint = await beginCheckpoint(db, {
      scheduleKey: "fourHourlyReserveSync",
      slotStartedAt: 1_800,
      job: "sync-live-reserves",
      invocationId: "slot-owner-1",
      queueHash: LIVE_RESERVE_QUEUE_HASH,
      nextItemKey: "coin-a",
      itemsTotal: 100,
      childJobs: CHILD_JOBS,
      nowSec: 1_801,
    });
    await advanceLiveReserveCheckpoint(db, checkpoint, {
      nextItemKey: "coin-z",
      itemsDone: 99,
      nowSec: 1_805,
    });
    await setLiveReserveCheckpointChildDisposition(
      db,
      checkpoint,
      "sync-live-reserves",
      "completed",
      1_806,
    );
    sqlite.prepare(
      `INSERT INTO cron_slot_executions (
         slot_key, slot_started_at, state, result_status, execution_owner,
         execution_generation, started_at, finished_at, updated_at
       ) VALUES ('fourHourlyReserveSync', 1800, 'finished', 'degraded', 'slot-owner-1', 1, 1800, 1810, 1810)`,
    ).run();
    sqlite.prepare(
      "INSERT INTO cron_runs (job, started_at, duration_ms, status, metadata, slot_started_at) VALUES (?, ?, 0, 'degraded', ?, ?)",
    ).run(
      "sync-live-reserves",
      1_805,
      JSON.stringify({ runBudgetTruncated: true, deferredCoins: 1 }),
      1_800,
    );

    const prepared = await prepareEligibleLiveReserveCheckpointRecoveries(db, {
      scheduleKey: checkpoint.scheduleKey,
      job: checkpoint.job,
      childJobs: CHILD_JOBS,
      expectedQueueHash: LIVE_RESERVE_QUEUE_HASH,
      staleAfterSec: 120,
      nowSec: 1_820,
    });

    expect(prepared.prepared).toEqual([expect.objectContaining({
      abandonedAttemptNo: 1,
      recoveryAttemptNo: 2,
    })]);
    const claimed = await claimNextLiveReserveCheckpointRecovery(db, {
      job: checkpoint.job,
      childJobs: CHILD_JOBS,
      owner: "recovery-owner-2",
      leaseSec: 60,
      expectedQueueHash: LIVE_RESERVE_QUEUE_HASH,
      nowSec: 1_821,
    });
    expect(claimed).toMatchObject({
      attemptNo: 2,
      state: "recovering",
      nextItemKey: "coin-z",
      itemsDone: 99,
      childDispositions: expect.objectContaining({
        "sync-live-reserves": "not_started",
      }),
    });
  });

  it("does not let a late duplicate producer invocation adopt an existing checkpoint", async () => {
    const { db } = harness();
    await beginCheckpoint(db, {
      scheduleKey: "fourHourlyReserveSync",
      slotStartedAt: 1_650,
      job: "sync-live-reserves",
      invocationId: "original-owner",
      queueHash: LIVE_RESERVE_QUEUE_HASH,
      nextItemKey: "coin-a",
      itemsTotal: 276,
      childJobs: CHILD_JOBS,
      nowSec: 1_651,
    });

    await expect(beginLiveReserveCheckpoint(db, {
      slotStartedAt: 1_650,
      invocationId: "late-owner",
      nowSec: 1_700,
    })).rejects.toBeInstanceOf(ScheduledCheckpointOwnershipLostError);
  });

  it("requeues an expired recovery under the next attempt number", async () => {
    const { sqlite, db } = harness();
    const first = await beginCheckpoint(db, {
      scheduleKey: "fourHourlyReserveSync",
      slotStartedAt: 2_000,
      job: "sync-live-reserves",
      invocationId: "slot-owner-1",
      queueHash: LIVE_RESERVE_QUEUE_HASH,
      nextItemKey: "coin-a",
      itemsTotal: 276,
      childJobs: CHILD_JOBS,
      nowSec: 2_001,
    });
    await prepareLiveReserveCheckpointRecoveryForSlot(db, {
      scheduleKey: first.scheduleKey,
      slotStartedAt: first.slotStartedAt,
      job: first.job,
      childJobs: CHILD_JOBS,
      nowSec: 2_100,
    });
    const second = await claimNextLiveReserveCheckpointRecovery(db, {
      job: "sync-live-reserves",
      childJobs: CHILD_JOBS,
      owner: "recovery-owner-2",
      leaseSec: 60,
      nowSec: 2_101,
    });
    expect(second).toMatchObject({ attemptNo: 2, state: "recovering" });
    await markLiveReserveCheckpointItemStarted(db, second!, {
      itemKey: "coin-c",
      domainAttemptId: "domain-attempt-3",
      itemsDone: 200,
      itemsTotal: 276,
      recoveryLeaseUntil: 2_160,
      nowSec: 2_102,
    });
    sqlite.prepare(
      `INSERT INTO reserve_sync_state (
         stablecoin_id, adapter_key, breaker_key, last_attempted_at, last_status,
         last_attempt_id, pending_attempt_id
       ) VALUES ('coin-c', 'adapter', 'breaker', 2102, 'skipped',
                 'domain-attempt-3', 'domain-attempt-3')`,
    ).run();

    const third = await claimNextLiveReserveCheckpointRecovery(db, {
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
      currentDomainAttemptId: "domain-attempt-3",
    });
    expect(sqlite.prepare("SELECT state FROM worker_scheduled_checkpoints WHERE attempt_no = 2").get()).toEqual({
      state: "platform_abandoned",
    });
    expect(sqlite.prepare(
      "SELECT pending_attempt_id, last_error FROM reserve_sync_state WHERE stablecoin_id = 'coin-c'",
    ).get()).toMatchObject({
      pending_attempt_id: null,
      last_error: expect.stringContaining("scheduled invocation ended"),
    });
    expect(sqlite.prepare(
      "SELECT COUNT(*) AS count FROM reserve_sync_attempt_history WHERE attempt_id = 'domain-attempt-3'",
    ).get()).toEqual({ count: 1 });
  });


  it("prepares a terminal abandoned slot only after its exact child lease expires", async () => {
    const { sqlite, db } = harness();
    await beginCheckpoint(db, {
      scheduleKey: "fourHourlyReserveSync",
      slotStartedAt: 4_000,
      job: "sync-live-reserves",
      invocationId: "slot-owner-1",
      queueHash: LIVE_RESERVE_QUEUE_HASH,
      nextItemKey: "coin-a",
      itemsTotal: 276,
      childJobs: CHILD_JOBS,
      nowSec: 4_001,
    });
    sqlite.prepare(
      `INSERT INTO cron_slot_executions (
         slot_key, slot_started_at, state, result_status, execution_owner,
         execution_generation, started_at, finished_at, updated_at
       ) VALUES ('fourHourlyReserveSync', 4000, 'finished', 'error', 'slot-owner-1', 1, 4000, 4010, 4010)`,
    ).run();
    sqlite.prepare(
      `INSERT INTO cron_run_progress (job, started_at, updated_at, stage, lease_owner, slot_started_at)
       VALUES ('sync-live-reserves', 4000, 4010, 'syncing', 'child-owner', 4000)`,
    ).run();
    sqlite.prepare(
      `INSERT INTO cron_leases (job, lease_owner, lease_until, heartbeat_at, updated_at)
       VALUES ('sync-live-reserves', 'child-owner', 4200, 4010, 4010)`,
    ).run();

    const blocked = await prepareEligibleLiveReserveCheckpointRecoveries(db, {
      scheduleKey: "fourHourlyReserveSync",
      job: "sync-live-reserves",
      childJobs: CHILD_JOBS,
      expectedQueueHash: LIVE_RESERVE_QUEUE_HASH,
      staleAfterSec: 120,
      nowSec: 4_100,
    });
    expect(blocked.prepared).toEqual([]);

    const prepared = await prepareEligibleLiveReserveCheckpointRecoveries(db, {
      scheduleKey: "fourHourlyReserveSync",
      job: "sync-live-reserves",
      childJobs: CHILD_JOBS,
      expectedQueueHash: LIVE_RESERVE_QUEUE_HASH,
      staleAfterSec: 120,
      nowSec: 4_201,
    });
    expect(prepared.prepared).toEqual([expect.objectContaining({
      abandonedAttemptNo: 1,
      recoveryAttemptNo: 2,
    })]);
  });

  it("selects a compatible recovery before the limit despite older incompatible checkpoints", async () => {
    const { sqlite, db } = harness();
    for (let index = 0; index < 6; index++) {
      const slotStartedAt = 5_000 + index;
      await beginCheckpoint(db, {
        scheduleKey: "fourHourlyReserveSync",
        slotStartedAt,
        job: "sync-live-reserves",
        invocationId: `old-owner-${index}`,
        queueHash: "queue-old",
        nextItemKey: "coin-old",
        itemsTotal: 100,
        childJobs: CHILD_JOBS,
        nowSec: 5_001 + index,
      });
      sqlite.prepare(
        `INSERT INTO cron_slot_executions (
           slot_key, slot_started_at, state, result_status, execution_owner,
           execution_generation, started_at, finished_at, updated_at
         ) VALUES ('fourHourlyReserveSync', ?, 'finished', 'error', ?, 1, ?, ?, ?)`,
      ).run(slotStartedAt, `old-owner-${index}`, slotStartedAt, 5_100 + index, 5_100 + index);
    }
    await beginCheckpoint(db, {
      scheduleKey: "fourHourlyReserveSync",
      slotStartedAt: 6_000,
      job: "sync-live-reserves",
      invocationId: "current-owner",
      queueHash: LIVE_RESERVE_QUEUE_HASH,
      nextItemKey: "coin-current",
      itemsTotal: 100,
      childJobs: CHILD_JOBS,
      nowSec: 6_001,
    });
    sqlite.prepare(
      `INSERT INTO cron_slot_executions (
         slot_key, slot_started_at, state, result_status, execution_owner,
         execution_generation, started_at, finished_at, updated_at
       ) VALUES ('fourHourlyReserveSync', 6000, 'finished', 'error', 'current-owner', 1, 6000, 6010, 6010)`,
    ).run();

    const prepared = await prepareEligibleLiveReserveCheckpointRecoveries(db, {
      scheduleKey: "fourHourlyReserveSync",
      job: "sync-live-reserves",
      childJobs: CHILD_JOBS,
      expectedQueueHash: LIVE_RESERVE_QUEUE_HASH,
      staleAfterSec: 120,
      nowSec: 6_200,
      limit: 1,
    });

    expect(prepared.inspection).toMatchObject({
      incompatibleCheckpointCount: 6,
      eligibleCheckpointCount: 1,
      candidates: [expect.objectContaining({ slotStartedAt: 6_000, queueHash: LIVE_RESERVE_QUEUE_HASH })],
    });
    expect(prepared.prepared).toEqual([expect.objectContaining({
      abandonedAttemptNo: 1,
      recoveryAttemptNo: 2,
    })]);
    expect(sqlite.prepare(
      "SELECT COUNT(*) AS count FROM worker_scheduled_checkpoints WHERE queue_hash = 'queue-old' AND state = 'running'",
    ).get()).toEqual({ count: 6 });
  });

  it("filters incompatible ready checkpoints before the bounded claim window", async () => {
    const { db } = harness();
    for (let index = 0; index < 6; index++) {
      const checkpoint = await beginCheckpoint(db, {
        scheduleKey: "fourHourlyReserveSync",
        slotStartedAt: 7_000 + index,
        job: "sync-live-reserves",
        invocationId: `old-owner-${index}`,
        queueHash: "queue-old",
        nextItemKey: "coin-old",
        itemsTotal: 100,
        childJobs: CHILD_JOBS,
        nowSec: 7_001 + index,
      });
      await prepareLiveReserveCheckpointRecoveryForSlot(db, {
        scheduleKey: checkpoint.scheduleKey,
        slotStartedAt: checkpoint.slotStartedAt,
        job: checkpoint.job,
        childJobs: CHILD_JOBS,
        nowSec: 7_100 + index,
      });
    }
    const current = await beginCheckpoint(db, {
      scheduleKey: "fourHourlyReserveSync",
      slotStartedAt: 8_000,
      job: "sync-live-reserves",
      invocationId: "current-owner",
      queueHash: LIVE_RESERVE_QUEUE_HASH,
      nextItemKey: "coin-current",
      itemsTotal: 100,
      childJobs: CHILD_JOBS,
      nowSec: 8_001,
    });
    await prepareLiveReserveCheckpointRecoveryForSlot(db, {
      scheduleKey: current.scheduleKey,
      slotStartedAt: current.slotStartedAt,
      job: current.job,
      childJobs: CHILD_JOBS,
      nowSec: 8_100,
    });

    const claimed = await claimNextLiveReserveCheckpointRecovery(db, {
      job: "sync-live-reserves",
      childJobs: CHILD_JOBS,
      owner: "recovery-owner",
      leaseSec: 60,
      expectedQueueHash: LIVE_RESERVE_QUEUE_HASH,
      nowSec: 8_101,
    });

    expect(claimed).toMatchObject({
      slotStartedAt: 8_000,
      attemptNo: 2,
      queueHash: LIVE_RESERVE_QUEUE_HASH,
      state: "recovering",
    });
  });

});
