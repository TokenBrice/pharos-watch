import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import { logCronRun, cronEventCacheKey } from "../cron-logger";
import { recordProducerOutcome } from "../producer-history";
import { sweepStaleScheduledSlotExecutions } from "../scheduled-slot-fence";

const fixtures = createLatestSchemaFixtureTracker();
const createMigratedDb = fixtures.open;

/**
 * Seeds one stale `cron_slot_executions` row with a dead child progress row
 * and optional version markers. Defaults reproduce the zero-duration shape;
 * the offset options reproduce a mid-run death (2026-09-23 sync-yield-data,
 * `duration_ms` 1000 while progress advanced past the start).
 */
function seedStaleSlotWithDeadChild(
  sqlite: DatabaseSync,
  nowSec: number,
  options: {
    firstSeenAt: number | null;
    activatedAt: number | null;
    /** Seconds after slot_started_at; all three default to the zero-duration shape. */
    progressStartedOffset?: number;
    progressUpdatedOffset?: number;
    slotUpdatedOffset?: number;
    /** Defaults to the pre-deploy version; null models a slot row without one. */
    slotWorkerVersion?: string | null;
    /** Stamped into progress metadata like the scheduled handler's slotMeta. */
    progressWorkerVersion?: string;
  },
): number {
  const slotStartedAt = nowSec - 3_600;
  const progressStartedAt = slotStartedAt + (options.progressStartedOffset ?? 0);
  const progressUpdatedAt = slotStartedAt + (options.progressUpdatedOffset ?? 0);
  const slotUpdatedAt = slotStartedAt + (options.slotUpdatedOffset ?? options.progressUpdatedOffset ?? 0);
  sqlite.prepare(
    `INSERT INTO cron_slot_executions (
     slot_key, slot_started_at, state, result_status, execution_owner,
     started_at, finished_at, updated_at, metadata, execution_generation,
     invocation_id, worker_version
   ) VALUES ('halfHourlyMeasuredExecution', ?, 'running', NULL, 'slot-owner', ?, NULL, ?, NULL, 1,
             'old-invocation', ?)`,
  ).run(slotStartedAt, slotStartedAt, slotUpdatedAt, options.slotWorkerVersion === undefined ? "worker-old" : options.slotWorkerVersion);
  sqlite.prepare(
    `INSERT INTO cron_leases (job, lease_owner, lease_until, heartbeat_at, updated_at)
     VALUES ('sync-cl-exit-depth', 'child-owner', ?, ?, ?)`,
  ).run(nowSec - 60, nowSec - 1_800, nowSec - 1_800);
  sqlite.prepare(
    `INSERT INTO cron_run_progress (
     job, started_at, updated_at, stage, items_done, items_total,
     message, lease_owner, metadata, slot_started_at
   ) VALUES ('sync-cl-exit-depth', ?, ?, 'lease-acquired', 0, NULL, 'Lease acquired', 'child-owner', ?, ?)`,
  ).run(
    progressStartedAt,
    progressUpdatedAt,
    options.progressWorkerVersion == null ? null : JSON.stringify({ workerVersion: options.progressWorkerVersion }),
    slotStartedAt,
  );
  if (options.firstSeenAt != null) {
    sqlite.prepare(
      `INSERT INTO cache (key, value, updated_at)
       VALUES ('worker-version-first-seen:worker-new', ?, ?)`,
    ).run(JSON.stringify({ workerVersion: "worker-new", firstSeenAt: options.firstSeenAt }), options.firstSeenAt);
  }
  if (options.activatedAt != null) {
    sqlite.prepare(
      `INSERT INTO cache (key, value, updated_at)
       VALUES ('worker-version-activated:worker-new', ?, ?)`,
    ).run(JSON.stringify({ workerVersion: "worker-new", activatedAt: options.activatedAt }), options.activatedAt);
  }
  return slotStartedAt;
}

describe("scheduled slot reconciliation against the current D1 schema", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    fixtures.closeAll();
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
        error: "sweep failed",
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
        error: "sweep failed",
      },
    ]);
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
  });

  it("does not invent a weekly-recap failure for a non-Monday 08:10 slot", async () => {
    const { sqlite, db } = createMigratedDb();
    // 2026-09-22 08:10Z is a Tuesday: weekly-recap was never due in this slot.
    const slotStartedAt = Math.floor(Date.UTC(2026, 8, 22, 8, 10) / 1_000);
    const nowSec = slotStartedAt + 3_600;
    sqlite.prepare(
      `INSERT INTO cron_slot_executions (
         slot_key, slot_started_at, state, result_status, execution_owner,
         started_at, finished_at, updated_at, metadata, execution_generation,
         invocation_id, worker_version
       ) VALUES ('daily0810Utc', ?, 'running', NULL, 'stale-owner', ?, NULL, ?, NULL, 1,
                 'stale-invocation', 'worker-version')`,
    ).run(slotStartedAt, slotStartedAt, slotStartedAt + 30);

    const summary = await sweepStaleScheduledSlotExecutions(db, {
      nowSec,
      staleAfterSec: 1_200,
      slotKey: "daily0810Utc",
    });

    expect(summary).toMatchObject({ slotsReconciled: 1 });
    expect(sqlite.prepare(
      `SELECT COUNT(*) AS count FROM cron_runs WHERE job = 'weekly-recap'`,
    ).get()).toEqual({ count: 0 });
    expect(sqlite.prepare(
      `SELECT status, error FROM cron_runs WHERE job = 'sync-cl-exit-depth'`,
    ).get()).toEqual({ status: "error", error: "scheduled slot abandoned before child job started" });
  });

  it("classifies a correlated zero-duration child as neutral only with an in-window activation marker", async () => {
    const { sqlite, db } = createMigratedDb();
    const nowSec = 1_772_004_000;
    const slotStartedAt = seedStaleSlotWithDeadChild(sqlite, nowSec, {
      firstSeenAt: nowSec - 3_600 + 5,
      activatedAt: nowSec - 3_600 - 60,
    });

    const summary = await sweepStaleScheduledSlotExecutions(db, {
      nowSec,
      staleAfterSec: 1_200,
      slotKey: "halfHourlyMeasuredExecution",
      reconcilerWorkerVersion: "worker-new",
    });

    expect(summary).toMatchObject({ slotsReconciled: 1, syntheticCronRuns: 1 });
    expect(sqlite.prepare(
      `SELECT status, error
         FROM cron_runs
        WHERE job = 'sync-cl-exit-depth'`,
    ).get()).toEqual({ status: "skipped_neutral", error: null });
    const runRow = sqlite.prepare(
      `SELECT metadata
         FROM cron_runs
        WHERE job = 'sync-cl-exit-depth'`,
    ).get() as { metadata: string } | undefined;
    expect(JSON.parse(String(runRow?.metadata ?? "{}"))).toMatchObject({
      failureCategory: "platform-interrupted",
      childDisposition: "interrupted-by-deploy",
      interruptedByWorkerVersionChange: true,
      reconciledByWorkerVersionFirstSeenAt: slotStartedAt + 5,
      reconciledByWorkerVersionActivatedAt: slotStartedAt - 60,
    });
  });

  it.each([
    ["has an activation marker 45 seconds after the child death", 45, 5],
    ["dies after the 120-second isolate-drain window", -121, 5],
    ["has only the diagnostic first-seen marker", null, 5],
    ["has neither marker", null, null],
  ] as const)("keeps a correlated zero-duration child abandoned when it %s", async (_reason, activationDelaySec, firstSeenDelaySec) => {
    const { sqlite, db } = createMigratedDb();
    const nowSec = 1_772_004_000;
    const slotStartedAt = nowSec - 3_600;
    seedStaleSlotWithDeadChild(sqlite, nowSec, {
      firstSeenAt: firstSeenDelaySec == null ? null : slotStartedAt + firstSeenDelaySec,
      activatedAt: activationDelaySec == null ? null : slotStartedAt + activationDelaySec,
    });

    const summary = await sweepStaleScheduledSlotExecutions(db, {
      nowSec,
      staleAfterSec: 1_200,
      slotKey: "halfHourlyMeasuredExecution",
      reconcilerWorkerVersion: "worker-new",
    });

    expect(summary).toMatchObject({ slotsReconciled: 1, syntheticCronRuns: 1 });
    expect(sqlite.prepare(
      `SELECT status, error
         FROM cron_runs
        WHERE job = 'sync-cl-exit-depth'`,
    ).get()).toEqual({
      status: "error",
      error: "scheduled slot heartbeat stale; child job progress abandoned",
    });
    const runRow = sqlite.prepare(
      `SELECT metadata
         FROM cron_runs
        WHERE job = 'sync-cl-exit-depth'`,
    ).get() as { metadata: string } | undefined;
    expect(JSON.parse(String(runRow?.metadata ?? "{}"))).toMatchObject({
      failureCategory: "platform-abandoned",
      childDisposition: "abandoned",
      interruptedByWorkerVersionChange: false,
      reconciledByWorkerVersionFirstSeenAt:
        firstSeenDelaySec == null ? null : slotStartedAt + firstSeenDelaySec,
      reconciledByWorkerVersionActivatedAt:
        activationDelaySec == null ? null : slotStartedAt + activationDelaySec,
    });
  });

  it("classifies a mid-run deploy eviction as neutral (2026-09-23 sync-yield-data shape)", async () => {
    const { sqlite, db } = createMigratedDb();
    const nowSec = 1_772_004_000;
    const slotStartedAt = nowSec - 3_600;
    const progressStartedAt = slotStartedAt + 8;
    const progressUpdatedAt = slotStartedAt + 9;
    sqlite.prepare(
      `INSERT INTO cron_slot_executions (
       slot_key, slot_started_at, state, result_status, execution_owner,
       started_at, finished_at, updated_at, metadata, execution_generation,
       invocation_id, worker_version
     ) VALUES ('hourlyYieldSync', ?, 'running', NULL, 'slot-owner', ?, NULL, ?, NULL, 1,
               'old-invocation', 'worker-old')`,
    ).run(slotStartedAt, slotStartedAt, progressUpdatedAt);
    sqlite.prepare(
      `INSERT INTO cron_leases (job, lease_owner, lease_until, heartbeat_at, updated_at)
       VALUES ('sync-yield-data', 'child-owner', ?, ?, ?)`,
    ).run(nowSec - 60, progressUpdatedAt, progressUpdatedAt);
    const insertProgress = sqlite.prepare(
      `INSERT INTO cron_run_progress (
       job, started_at, updated_at, stage, items_done, items_total,
       message, lease_owner, metadata, slot_started_at
     ) VALUES (?, ?, ?, 'lease-acquired', 0, NULL, 'Lease acquired', 'child-owner', NULL, ?)`,
    );
    for (const job of ["sync-yield-supplemental", "fetch-tbill-rate", "sync-yield-data"]) {
      insertProgress.run(job, progressStartedAt, progressUpdatedAt, slotStartedAt);
    }
    // The replacing version activated 30 seconds before the old isolate died.
    sqlite.prepare(
      `INSERT INTO cache (key, value, updated_at)
       VALUES ('worker-version-activated:worker-new', ?, ?)`,
    ).run(JSON.stringify({ workerVersion: "worker-new", activatedAt: progressUpdatedAt - 30 }), progressUpdatedAt - 30);

    const summary = await sweepStaleScheduledSlotExecutions(db, {
      nowSec,
      staleAfterSec: 1_200,
      slotKey: "hourlyYieldSync",
      reconcilerWorkerVersion: "worker-new",
    });

    expect(summary).toMatchObject({ slotsReconciled: 1, syntheticCronRuns: 3, notStartedCronRuns: 0 });
    const yieldRun = sqlite.prepare(
      `SELECT status, error, duration_ms, metadata
         FROM cron_runs
        WHERE job = 'sync-yield-data'`,
    ).get() as { status: string; error: string | null; duration_ms: number; metadata: string };
    // One second of progress was written before the eviction: a zero-duration
    // child was never required, only a slot heartbeat that stopped with it.
    expect(yieldRun.status).toBe("skipped_neutral");
    expect(yieldRun.error).toBeNull();
    expect(yieldRun.duration_ms).toBe(1_000);
    expect(JSON.parse(yieldRun.metadata)).toMatchObject({
      failureCategory: "platform-interrupted",
      childDisposition: "interrupted-by-deploy",
      interruptedByWorkerVersionChange: true,
      progressStage: "lease-acquired",
      progressUpdatedAt,
      activeDurationMs: 1_000,
      slotWorkerVersion: "worker-old",
      reconciledByWorkerVersion: "worker-new",
      reconciledByWorkerVersionActivatedAt: progressUpdatedAt - 30,
    });
  });

  it.each([
    ["the activation marker fires 121 seconds after the death", 121],
    ["the activation marker fires 121 seconds before the death", -121],
    ["no activation marker exists", null],
  ] as const)("keeps a mid-run child abandoned when %s", async (_reason, activationOffsetSec) => {
    const { sqlite, db } = createMigratedDb();
    const nowSec = 1_772_004_000;
    const progressUpdatedAt = nowSec - 3_600 + 9;
    seedStaleSlotWithDeadChild(sqlite, nowSec, {
      firstSeenAt: progressUpdatedAt + 5,
      activatedAt: activationOffsetSec == null ? null : progressUpdatedAt + activationOffsetSec,
      progressStartedOffset: 8,
      progressUpdatedOffset: 9,
      slotUpdatedOffset: 9,
    });

    const summary = await sweepStaleScheduledSlotExecutions(db, {
      nowSec,
      staleAfterSec: 1_200,
      slotKey: "halfHourlyMeasuredExecution",
      reconcilerWorkerVersion: "worker-new",
    });

    expect(summary).toMatchObject({ slotsReconciled: 1, syntheticCronRuns: 1 });
    const runRow = sqlite.prepare(
      `SELECT status, error, metadata
         FROM cron_runs
        WHERE job = 'sync-cl-exit-depth'`,
    ).get() as { status: string; error: string | null; metadata: string };
    expect(runRow.status).toBe("error");
    expect(runRow.error).toBe("scheduled slot heartbeat stale; child job progress abandoned");
    // Drift exists, so the marker evidence is recorded even though the death
    // falls outside the activation window and stays abandoned.
    expect(JSON.parse(runRow.metadata)).toMatchObject({
      failureCategory: "platform-abandoned",
      childDisposition: "abandoned",
      interruptedByWorkerVersionChange: false,
      activeDurationMs: 1_000,
      reconciledByWorkerVersionFirstSeenAt: progressUpdatedAt + 5,
      reconciledByWorkerVersionActivatedAt:
        activationOffsetSec == null ? null : progressUpdatedAt + activationOffsetSec,
    });
  });

  it.each([
    {
      name: "falls back to the dying invocation's progress metadata version",
      progressWorkerVersion: "worker-old",
      expectedStatus: "skipped_neutral",
      expectedSlotWorkerVersion: "worker-old",
      activationRecorded: true,
    },
    {
      name: "stays abandoned when no version evidence survives",
      progressWorkerVersion: undefined,
      expectedStatus: "error",
      expectedSlotWorkerVersion: null,
      activationRecorded: false,
    },
    {
      name: "stays abandoned when the progress version matches the reconciler",
      progressWorkerVersion: "worker-new",
      expectedStatus: "error",
      expectedSlotWorkerVersion: "worker-new",
      activationRecorded: false,
    },
  ])("with a NULL slot worker_version, $name", async ({
    progressWorkerVersion,
    expectedStatus,
    expectedSlotWorkerVersion,
    activationRecorded,
  }) => {
    const { sqlite, db } = createMigratedDb();
    const nowSec = 1_772_004_000;
    const progressUpdatedAt = nowSec - 3_600 + 9;
    seedStaleSlotWithDeadChild(sqlite, nowSec, {
      firstSeenAt: null,
      activatedAt: progressUpdatedAt - 30,
      progressStartedOffset: 8,
      progressUpdatedOffset: 9,
      slotUpdatedOffset: 9,
      slotWorkerVersion: null,
      progressWorkerVersion,
    });

    const summary = await sweepStaleScheduledSlotExecutions(db, {
      nowSec,
      staleAfterSec: 1_200,
      slotKey: "halfHourlyMeasuredExecution",
      reconcilerWorkerVersion: "worker-new",
    });

    expect(summary).toMatchObject({ slotsReconciled: 1, syntheticCronRuns: 1 });
    const runRow = sqlite.prepare(
      `SELECT status, error, metadata
         FROM cron_runs
        WHERE job = 'sync-cl-exit-depth'`,
    ).get() as { status: string; error: string | null; metadata: string };
    expect(runRow.status).toBe(expectedStatus);
    expect(runRow.error).toBe(
      expectedStatus === "error" ? "scheduled slot heartbeat stale; child job progress abandoned" : null,
    );
    expect(JSON.parse(runRow.metadata)).toMatchObject({
      interruptedByWorkerVersionChange: expectedStatus === "skipped_neutral",
      slotWorkerVersion: expectedSlotWorkerVersion,
      reconciledByWorkerVersionActivatedAt: activationRecorded ? progressUpdatedAt - 30 : null,
    });
  });
});


describe("bounded abandonment progress evidence", () => {
  afterEach(() => fixtures.closeAll());

  it.each([
    { name: "valid", metadata: JSON.stringify({ currentCoinId: "usdnr-nerona", currentAdapter: "m0-wrapper-underlying",
      currentBreakerKey: "live-reserves:usdnr-nerona", synced: 260, failed: 1,
      providerError: "SECRET RESPONSE", endpoint: "https://secret.example/key",
      adapterTelemetryProgress: { attemptCount: 261, ioCallCount: 300, elapsedTotalMs: 1234, overflow: false,
        providerError: "SECRET RESPONSE", groupCount: -1 } }), status: "parsed" },
    { name: "malformed", metadata: "{SECRET RESPONSE", status: "malformed" },
    { name: "oversized", metadata: JSON.stringify({ currentCoinId: "usdnr-nerona", body: "SECRET RESPONSE".repeat(2000) }), status: "oversized" },
    { name: "invalid fields", metadata: JSON.stringify({ currentCoinId: "https://secret.example/key", synced: -1,
      currentAdapter: "a".repeat(161), adapterTelemetryProgress: ["SECRET RESPONSE"] }), status: "parsed" },
  ])("retains only bounded evidence for $name metadata and remains idempotent", async ({ metadata, status, name }) => {
    const { sqlite, db } = createMigratedDb();
    const nowSec = 1_772_004_000;
    seedStaleSlotWithDeadChild(sqlite, nowSec, { firstSeenAt: null, activatedAt: null });
    sqlite.prepare("UPDATE cron_run_progress SET items_done = 261, items_total = 278, metadata = ?").run(metadata);
    const options = { nowSec, staleAfterSec: 1200, slotKey: "halfHourlyMeasuredExecution" };
    await sweepStaleScheduledSlotExecutions(db, options);
    const readMetadata = () => JSON.parse((sqlite.prepare("SELECT metadata FROM cron_runs WHERE job = 'sync-cl-exit-depth'").get() as { metadata: string }).metadata);
    const first = readMetadata();
    expect(first.progressSnapshot).toMatchObject({ schemaVersion: 1, itemsDone: 261, itemsTotal: 278, metadataStatus: status });
    if (name === "valid") {
      expect(first.progressSnapshot).toMatchObject({ currentCoinId: "usdnr-nerona", currentAdapter: "m0-wrapper-underlying",
        synced: 260, failed: 1, adapterTelemetryProgress: { attemptCount: 261, ioCallCount: 300, elapsedTotalMs: 1234, overflow: false } });
      expect(first.progressSnapshot.adapterTelemetryProgress).not.toHaveProperty("groupCount");
    } else {
      expect(first.progressSnapshot).not.toHaveProperty("currentCoinId");
    }
    expect(JSON.stringify(first)).not.toContain("SECRET");
    expect(JSON.stringify(first)).not.toContain("secret.example");
    expect(JSON.stringify(first.progressSnapshot).length).toBeLessThan(2000);
    const event = JSON.parse((sqlite.prepare("SELECT value FROM cache WHERE key = ?").get(cronEventCacheKey("halfHourlyMeasuredExecution", "scheduled-slot-abandoned")) as { value: string }).value);
    expect(event.metadata.abandonedProgress[0]).toEqual({ job: "sync-cl-exit-depth", ...first.progressSnapshot });
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM cron_run_progress").get()).toEqual({ count: 0 });
    await sweepStaleScheduledSlotExecutions(db, options);
    expect(readMetadata()).toEqual(first);
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM cron_runs WHERE job = 'sync-cl-exit-depth'").get()).toEqual({ count: 1 });
  });

  it("does not snapshot or clear a child whose matching lease is still heartbeating", async () => {
    const { sqlite, db } = createMigratedDb();
    const nowSec = 1_772_004_000;
    seedStaleSlotWithDeadChild(sqlite, nowSec, { firstSeenAt: null, activatedAt: null });
    sqlite.prepare("UPDATE cron_leases SET heartbeat_at = ?, lease_until = ?, updated_at = ?").run(nowSec, nowSec + 600, nowSec);
    sqlite.prepare("UPDATE cron_run_progress SET metadata = ?").run(JSON.stringify({ currentCoinId: "usdnr-nerona" }));
    await sweepStaleScheduledSlotExecutions(db, { nowSec, staleAfterSec: 1200, slotKey: "halfHourlyMeasuredExecution" });
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM cron_run_progress").get()).toEqual({ count: 1 });
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM cron_runs WHERE job = 'sync-cl-exit-depth'").get()).toEqual({ count: 0 });
  });
});
