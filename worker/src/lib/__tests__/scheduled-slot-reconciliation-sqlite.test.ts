import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLatestSchemaSqlite } from "../../test-helpers/latest-schema-sqlite";
import { logCronRun } from "../cron-logger";
import { recordProducerOutcome } from "../producer-history";
import { sweepStaleScheduledSlotExecutions } from "../scheduled-slot-fence";

function createMigratedDb(): { sqlite: DatabaseSync; db: D1Database } {
  return createLatestSchemaSqlite();
}

describe("scheduled slot reconciliation against the current D1 schema", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("leaves existing producer history intact when a stale slot already has a terminal cron run", async () => {
    const { sqlite, db } = createMigratedDb();
    const nowSec = 1_772_004_000;
    const slotStartedAt = nowSec - 3_600;
    sqlite
      .prepare(
        `INSERT INTO cron_slot_executions (
         slot_key, slot_started_at, state, result_status, execution_owner,
         started_at, finished_at, updated_at, metadata, execution_generation,
         invocation_id, worker_version
       ) VALUES (?, ?, 'running', NULL, ?, ?, NULL, ?, NULL, 1, ?, ?)`,
      )
      .run(
        "halfHourlyOffset",
        slotStartedAt,
        "original-owner",
        slotStartedAt,
        slotStartedAt,
        "shared-invocation",
        "worker-version",
      );
    sqlite
      .prepare(
        `INSERT INTO cron_run_progress (
         job, started_at, updated_at, stage, lease_owner, slot_started_at
       ) VALUES (?, ?, ?, 'completed', ?, ?)`,
      )
      .run(
        "sync-dex-liquidity-stage",
        slotStartedAt,
        slotStartedAt + 1,
        "released-owner",
        slotStartedAt,
      );
    sqlite
      .prepare(
        `INSERT INTO cron_runs (
         job, started_at, duration_ms, status, item_count, slot_started_at,
         idempotency_key, schedule_key, producer_path, producer_kind,
         invocation_id, worker_version, productive, publication_count
       ) VALUES (?, ?, 1000, 'ok', 1, ?, ?, ?, ?, 'scheduled-job', ?, ?, 1, 0)`,
      )
      .run(
        "sync-dex-liquidity-stage",
        slotStartedAt,
        slotStartedAt,
        "original-run",
        "halfHourlyOffset",
        "halfHourlyOffset",
        "shared-invocation",
        "worker-version",
      );
    await recordProducerOutcome(db, {
      scheduleKey: "halfHourlyOffset",
      job: "sync-dex-liquidity-stage",
      producerPath: "halfHourlyOffset",
      producerKind: "scheduled-job",
      invocationId: "shared-invocation",
      workerVersion: "worker-version",
      slotStartedAt,
      idempotencyKey: "original-run",
      invokedAt: slotStartedAt,
      completedAt: slotStartedAt + 1,
      outcome: "ok",
      itemCount: 1,
      productivity: { productive: true },
    });

    const summary = await sweepStaleScheduledSlotExecutions(db, {
      nowSec,
      staleAfterSec: 1_200,
      slotKey: "halfHourlyOffset",
    });

    expect(summary).toMatchObject({
      candidateSlots: 1,
      slotsReconciled: 1,
      syntheticCronRuns: 0,
      notStartedCronRuns: 0,
      progressRowsCleared: 1,
      leasesCleared: 0,
    });
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM cron_run_progress").get()).toEqual({ count: 0 });
    expect(
      sqlite
        .prepare(
          `SELECT idempotency_key, outcome, productive
         FROM worker_producer_history`,
        )
        .all(),
    ).toEqual([
      {
        idempotency_key: "original-run",
        outcome: "ok",
        productive: 1,
      },
    ]);
    expect(
      sqlite
        .prepare(
          `SELECT state, result_status
         FROM cron_slot_executions
        WHERE slot_key = ? AND slot_started_at = ?`,
        )
        .get("halfHourlyOffset", slotStartedAt),
    ).toEqual({
      state: "finished",
      result_status: "error",
    });
    expect(
      await sweepStaleScheduledSlotExecutions(db, {
        nowSec: nowSec + 60,
        staleAfterSec: 1_200,
        slotKey: "halfHourlyOffset",
      }),
    ).toMatchObject({ candidateSlots: 0, slotsReconciled: 0 });
    sqlite.close();
  });

  it("repairs producer telemetry when a synthetic cron row was the only completed write", async () => {
    const { sqlite, db } = createMigratedDb();
    const nowSec = 1_772_004_000;
    const slotStartedAt = nowSec - 3_600;
    const idempotencyKey = ["scheduled-slot-not-started", "halfHourlyOffset", slotStartedAt, "sync-dex-liquidity-stage"].join(
      ":",
    );
    sqlite
      .prepare(
        `INSERT INTO cron_slot_executions (
         slot_key, slot_started_at, state, result_status, execution_owner,
         started_at, finished_at, updated_at, metadata, execution_generation,
         invocation_id, worker_version
       ) VALUES (?, ?, 'running', NULL, ?, ?, NULL, ?, NULL, 1, ?, ?)`,
      )
      .run(
        "halfHourlyOffset",
        slotStartedAt,
        "original-owner",
        slotStartedAt,
        slotStartedAt,
        "shared-invocation",
        "worker-version",
      );
    sqlite
      .prepare(
        `INSERT INTO cron_runs (
         job, started_at, duration_ms, status, error, item_count, metadata,
         slot_started_at, idempotency_key, schedule_key, producer_path,
         producer_kind, invocation_id, worker_version, productive,
         publication_count, calendar_period
       ) VALUES (?, ?, ?, 'error', ?, 0, ?, ?, ?, ?, ?, 'scheduled-job', ?, ?, 0, 0, NULL)`,
      )
      .run(
        "sync-dex-liquidity-stage",
        nowSec,
        0,
        "scheduled slot heartbeat stale; child job never started",
        JSON.stringify({ reason: "stale-slot-not-started" }),
        slotStartedAt,
        idempotencyKey,
        "halfHourlyOffset",
        "halfHourlyOffset",
        "shared-invocation",
        "worker-version",
      );

    const summary = await sweepStaleScheduledSlotExecutions(db, {
      nowSec,
      staleAfterSec: 1_200,
      slotKey: "halfHourlyOffset",
    });

    expect(summary).toMatchObject({
      slotsReconciled: 1,
      syntheticCronRuns: 0,
      notStartedCronRuns: 0,
    });
    expect(
      sqlite
        .prepare(
          `SELECT idempotency_key, outcome, productive
         FROM worker_producer_history`,
        )
        .all(),
    ).toEqual([
      {
        idempotency_key: idempotencyKey,
        outcome: "not_started",
        productive: 0,
      },
    ]);
    expect(
      sqlite
        .prepare(
          `SELECT last_invocation_id, last_outcome, invocation_count
         FROM worker_producer_heads`,
        )
        .all(),
    ).toEqual([
      {
        last_invocation_id: "shared-invocation",
        last_outcome: "not_started",
        invocation_count: 1,
      },
    ]);
    sqlite.close();
  });

  it("persists a producer cron exception through the partial idempotency index", async () => {
    const { sqlite, db } = createMigratedDb();
    vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      logCronRun(
        db,
        "cron-slot-sweeper",
        async () => {
          throw new Error("sweep failed");
        },
        {
          slotStartedAt: 1_772_000_000,
          producer: {
            scheduleKey: "statusSelfCheckOffset",
            producerPath: "statusSelfCheckOffset",
            producerKind: "scheduled-job",
            invocationId: "failed-invocation",
            workerVersion: "worker-version",
            slotStartedAt: 1_772_000_000,
          },
        },
      ),
    ).rejects.toThrow("sweep failed");

    expect(
      sqlite
        .prepare(
          `SELECT job, status, error
         FROM cron_runs`,
        )
        .all(),
    ).toEqual([
      {
        job: "cron-slot-sweeper",
        status: "error",
        error: "Error: sweep failed",
      },
    ]);
    expect(
      sqlite
        .prepare(
          `SELECT job, outcome, error
         FROM worker_producer_history`,
        )
        .all(),
    ).toEqual([
      {
        job: "cron-slot-sweeper",
        outcome: "error",
        error: "Error: sweep failed",
      },
    ]);
    sqlite.close();
  });

  it("orders synthetic no-progress evidence at the original slot time without replacing a newer success", async () => {
    const { sqlite, db } = createMigratedDb();
    const nowSec = 1_772_004_000;
    const slotStartedAt = nowSec - 3_600;
    const slotInvokedAt = slotStartedAt + 7;
    const slotUpdatedAt = slotStartedAt + 120;
    const newerStartedAt = slotStartedAt + 1_800;
    sqlite.prepare(
      `INSERT INTO cron_slot_executions (
       slot_key, slot_started_at, state, result_status, execution_owner,
       started_at, finished_at, updated_at, metadata, execution_generation,
       invocation_id, worker_version
     ) VALUES ('halfHourlyOffset', ?, 'running', NULL, 'old-owner', ?, NULL, ?, NULL, 1, 'old-invocation', 'worker-version')`,
    ).run(slotStartedAt, slotInvokedAt, slotUpdatedAt);
    sqlite.prepare(
      `INSERT INTO cron_runs (
       job, started_at, duration_ms, status, item_count, slot_started_at,
       idempotency_key, schedule_key, producer_path, producer_kind,
       invocation_id, worker_version, productive, publication_count
     ) VALUES ('sync-dex-liquidity-stage', ?, 1000, 'ok', 10, ?, 'newer-ok',
               'halfHourlyOffset', 'halfHourlyOffset', 'scheduled-job',
               'newer-invocation', 'worker-version', 1, 0)`,
    ).run(newerStartedAt, newerStartedAt);
    await recordProducerOutcome(db, {
      scheduleKey: "halfHourlyOffset",
      job: "sync-dex-liquidity-stage",
      producerPath: "halfHourlyOffset",
      producerKind: "scheduled-job",
      invocationId: "newer-invocation",
      workerVersion: "worker-version",
      slotStartedAt: newerStartedAt,
      idempotencyKey: "newer-ok",
      invokedAt: newerStartedAt,
      completedAt: newerStartedAt + 1,
      outcome: "ok",
      itemCount: 10,
      productivity: { productive: true },
    });

    const summary = await sweepStaleScheduledSlotExecutions(db, {
      nowSec,
      staleAfterSec: 1_200,
      slotKey: "halfHourlyOffset",
    });

    expect(summary).toMatchObject({ syntheticCronRuns: 1, notStartedCronRuns: 1 });
    expect(sqlite.prepare(
      `SELECT started_at, status
         FROM cron_runs
        WHERE job = 'sync-dex-liquidity-stage'
        ORDER BY started_at DESC`,
    ).all()).toEqual([
      { started_at: newerStartedAt, status: "ok" },
      { started_at: slotInvokedAt, status: "error" },
    ]);
    expect(sqlite.prepare(
      `SELECT invoked_at, completed_at, outcome, metadata_json
         FROM worker_producer_history
        WHERE invocation_id = 'old-invocation'`,
    ).get()).toMatchObject({
      invoked_at: slotInvokedAt,
      completed_at: slotUpdatedAt,
      outcome: "not_started",
    });
    expect(JSON.parse(String((sqlite.prepare(
      `SELECT metadata_json
         FROM worker_producer_history
        WHERE invocation_id = 'old-invocation'`,
    ).get() as { metadata_json: string }).metadata_json))).toMatchObject({ reconciledAt: nowSec });
    expect(sqlite.prepare(
      `SELECT last_invocation_id, last_outcome, last_invoked_at
         FROM worker_producer_heads
        WHERE job = 'sync-dex-liquidity-stage'`,
    ).get()).toEqual({
      last_invocation_id: "newer-invocation",
      last_outcome: "ok",
      last_invoked_at: newerStartedAt,
    });
    sqlite.close();
  });

  it("does not invent daily-digest failures for idle polls but reconciles durable started progress", async () => {
    const { sqlite, db } = createMigratedDb();
    const nowSec = 1_772_004_000;
    const idleSlotStartedAt = nowSec - 3_600;
    sqlite.prepare(
      `INSERT INTO cron_slot_executions (
       slot_key, slot_started_at, state, result_status, execution_owner,
       started_at, finished_at, updated_at, metadata, execution_generation,
       invocation_id, worker_version
     ) VALUES ('digestTriggerPoll', ?, 'running', NULL, 'idle-owner', ?, NULL, ?, NULL, 1,
               'idle-invocation', 'worker-version')`,
    ).run(idleSlotStartedAt, idleSlotStartedAt, idleSlotStartedAt + 30);

    const idleSummary = await sweepStaleScheduledSlotExecutions(db, {
      nowSec,
      staleAfterSec: 1_200,
      slotKey: "digestTriggerPoll",
    });
    expect(idleSummary).toMatchObject({ syntheticCronRuns: 0, notStartedCronRuns: 0 });
    expect(sqlite.prepare(
      `SELECT COUNT(*) AS count
         FROM cron_runs
        WHERE job = 'daily-digest'`,
    ).get()).toEqual({ count: 0 });

    const startedSlotStartedAt = nowSec - 1_800;
    const progressStartedAt = startedSlotStartedAt + 5;
    const progressUpdatedAt = startedSlotStartedAt + 100;
    sqlite.prepare(
      `INSERT INTO cron_slot_executions (
       slot_key, slot_started_at, state, result_status, execution_owner,
       started_at, finished_at, updated_at, metadata, execution_generation,
       invocation_id, worker_version
     ) VALUES ('digestTriggerPoll', ?, 'running', NULL, 'started-owner', ?, NULL, ?, NULL, 1,
               'started-invocation', 'worker-version')`,
    ).run(startedSlotStartedAt, startedSlotStartedAt, progressUpdatedAt);
    sqlite.prepare(
      `INSERT INTO cron_leases (job, lease_owner, lease_until, heartbeat_at, updated_at)
       VALUES ('daily-digest', 'digest-lease', ?, ?, ?)`,
    ).run(nowSec - 200, progressUpdatedAt, progressUpdatedAt);
    sqlite.prepare(
      `INSERT INTO cron_run_progress (
       job, started_at, updated_at, stage, items_done, items_total,
       message, lease_owner, metadata, slot_started_at
     ) VALUES ('daily-digest', ?, ?, 'generation', 0, 1, 'Generating', 'digest-lease', NULL, ?)`,
    ).run(progressStartedAt, progressUpdatedAt, startedSlotStartedAt);

    const startedSummary = await sweepStaleScheduledSlotExecutions(db, {
      nowSec,
      staleAfterSec: 1_200,
      slotKey: "digestTriggerPoll",
    });
    expect(startedSummary).toMatchObject({ syntheticCronRuns: 1, notStartedCronRuns: 0 });
    expect(sqlite.prepare(
      `SELECT started_at, status
         FROM cron_runs
        WHERE job = 'daily-digest'`,
    ).get()).toEqual({ started_at: progressStartedAt, status: "error" });
    expect(sqlite.prepare(
      `SELECT invoked_at, completed_at, outcome
         FROM worker_producer_history
        WHERE job = 'daily-digest'`,
    ).get()).toEqual({
      invoked_at: progressStartedAt,
      completed_at: progressUpdatedAt,
      outcome: "abandoned",
    });
    sqlite.close();
  });
});
