import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSqliteD1 } from "../../test-helpers/sqlite-d1";
import { logCronRun } from "../cron-logger";
import { recordProducerOutcome } from "../producer-history";
import { sweepStaleScheduledSlotExecutions } from "../scheduled-slot-fence";

const MIGRATIONS_DIR = join(process.cwd(), "worker/migrations");

function createMigratedDb(): { sqlite: DatabaseSync; db: D1Database } {
  const sqlite = new DatabaseSync(":memory:");
  for (const file of readdirSync(MIGRATIONS_DIR)
    .filter((entry) => entry.endsWith(".sql"))
    .sort()) {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- repo-owned migration fixture
    sqlite.exec(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
  }
  return { sqlite, db: createSqliteD1(sqlite) };
}

function seedStaleDexProgress(
  sqlite: DatabaseSync,
  input: {
    nowSec: number;
    slotStartedAt: number;
    childStartedAt: number;
    attemptIds?: string[];
    stage?: string;
    progressMetadata?: Record<string, unknown>;
  },
): void {
  sqlite
    .prepare(
      `INSERT INTO cron_slot_executions (
       slot_key, slot_started_at, state, result_status, execution_owner,
       started_at, finished_at, updated_at, metadata, execution_generation,
       invocation_id, worker_version
     ) VALUES ('halfHourlyOffset', ?, 'running', NULL, 'slot-owner', ?, NULL, ?, NULL, 1,
       'invocation', 'version')`,
    )
    .run(input.slotStartedAt, input.slotStartedAt, input.slotStartedAt);
  sqlite
    .prepare(
      `INSERT INTO cron_run_progress
       (job, started_at, updated_at, stage, lease_owner, slot_started_at, metadata)
     VALUES ('sync-dex-liquidity', ?, ?, ?, 'old-owner', ?, ?)`,
    )
    .run(
      input.childStartedAt,
      input.childStartedAt + 60,
      input.stage ?? "persistence",
      input.slotStartedAt,
      input.progressMetadata ? JSON.stringify(input.progressMetadata) : null,
    );
  for (const [index, attemptId] of (input.attemptIds ?? ["attempt-1"]).entries()) {
    sqlite
      .prepare(
        `INSERT INTO worker_job_attempts (
         attempt_id, idempotency_key, schedule_key, job, slot_started_at,
         producer_kind, producer_path, invocation_id, state, status_class,
         attempt_no, owner, lease_until, queued_at, started_at, updated_at, created_at
       ) VALUES (?, ?, 'halfHourlyOffset', 'sync-dex-liquidity', ?,
         'scheduled-job', 'halfHourlyOffset', 'invocation', 'running', NULL,
         ?, 'old-owner', ?, ?, ?, ?, ?)`,
      )
      .run(
        attemptId,
        `${attemptId}-key`,
        input.slotStartedAt,
        index + 1,
        input.nowSec - 60,
        input.childStartedAt,
        input.childStartedAt,
        input.childStartedAt + 60,
        input.childStartedAt,
      );
  }
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
        `INSERT INTO cron_runs (
         job, started_at, duration_ms, status, item_count, slot_started_at,
         idempotency_key, schedule_key, producer_path, producer_kind,
         invocation_id, worker_version, productive, publication_count
       ) VALUES (?, ?, 1000, 'ok', 1, ?, ?, ?, ?, 'scheduled-job', ?, ?, 1, 0)`,
      )
      .run(
        "sync-dex-liquidity",
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
      job: "sync-dex-liquidity",
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
      successfulChildTerminals: 1,
      realChildFailures: 0,
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
      result_status: "degraded",
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

  it("preserves skipped-locked as a known terminal omission rather than a real child failure", async () => {
    const { sqlite, db } = createMigratedDb();
    const nowSec = 1_772_004_000;
    const slotStartedAt = nowSec - 3_600;
    sqlite
      .prepare(
        `INSERT INTO cron_slot_executions (
           slot_key, slot_started_at, state, result_status, execution_owner,
           started_at, finished_at, updated_at, metadata, execution_generation
         ) VALUES ('halfHourlyOffset', ?, 'running', NULL, 'slot-owner', ?, NULL, ?, NULL, 1)`,
      )
      .run(slotStartedAt, slotStartedAt, slotStartedAt);
    sqlite
      .prepare(
        `INSERT INTO cron_runs (job, started_at, duration_ms, status, slot_started_at, idempotency_key)
         VALUES ('sync-dex-liquidity', ?, 1000, 'skipped_locked', ?, 'real-skipped-locked')`,
      )
      .run(slotStartedAt, slotStartedAt);

    const summary = await sweepStaleScheduledSlotExecutions(db, {
      nowSec,
      staleAfterSec: 1_200,
      slotKey: "halfHourlyOffset",
    });

    expect(summary).toMatchObject({
      slotsReconciled: 1,
      successfulChildTerminals: 0,
      skippedLockedChildTerminals: 1,
      realChildFailures: 0,
    });
    expect(
      sqlite
        .prepare(
          "SELECT result_status FROM cron_slot_executions WHERE slot_key = 'halfHourlyOffset' AND slot_started_at = ?",
        )
        .get(slotStartedAt),
    ).toEqual({ result_status: "degraded" });
    sqlite.close();
  });

  it("repairs producer telemetry when a synthetic cron row was the only completed write", async () => {
    const { sqlite, db } = createMigratedDb();
    const nowSec = 1_772_004_000;
    const slotStartedAt = nowSec - 3_600;
    const idempotencyKey = ["scheduled-slot-not-started", "halfHourlyOffset", slotStartedAt, "sync-dex-liquidity"].join(
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
        "sync-dex-liquidity",
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
      notStartedCronRuns: 1,
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

  it("prefers exact progress generation identity across start skew and preserves a newer lease", async () => {
    const { sqlite, db } = createMigratedDb();
    const nowSec = 1_772_004_000;
    const slotStartedAt = nowSec - 3_600;
    const childStartedAt = slotStartedAt + 10;
    const generationStartedAt = childStartedAt + 64;
    const generationId = `dex-liquidity-${generationStartedAt}`;
    sqlite
      .prepare(
        `INSERT INTO cron_slot_executions (
         slot_key, slot_started_at, state, result_status, execution_owner,
         started_at, finished_at, updated_at, metadata, execution_generation,
         invocation_id, worker_version
       ) VALUES ('halfHourlyOffset', ?, 'running', NULL, 'slot-owner', ?, NULL, ?, NULL, 1, 'invocation', 'version')`,
      )
      .run(slotStartedAt, slotStartedAt, slotStartedAt);
    sqlite
      .prepare(
        `INSERT INTO cron_run_progress
           (job, started_at, updated_at, stage, lease_owner, slot_started_at, metadata)
         VALUES ('sync-dex-liquidity', ?, ?, 'persistence-generation-complete', 'old-owner', ?, ?)`,
      )
      .run(childStartedAt, childStartedAt + 120, slotStartedAt, JSON.stringify({ generationId }));
    sqlite
      .prepare(
        `INSERT INTO cron_leases (job, lease_owner, lease_until, heartbeat_at, updated_at)
         VALUES ('sync-dex-liquidity', 'new-owner', ?, ?, ?)`,
      )
      .run(nowSec + 600, nowSec, nowSec);
    sqlite
      .prepare(
        `INSERT INTO worker_job_attempts (
           attempt_id, idempotency_key, schedule_key, job, slot_started_at,
           producer_kind, producer_path, invocation_id,
           state, status_class, attempt_no, owner, lease_until,
           queued_at, started_at, item_count, result_metadata_json, updated_at, created_at
         ) VALUES ('old-attempt', 'old-attempt-key', 'halfHourlyOffset', 'sync-dex-liquidity', ?,
           'scheduled-job', 'halfHourlyOffset', 'invocation',
           'running', NULL, 1, 'old-owner', ?, ?, ?, 12, '{"progress":{"stage":"persistence-complete"}}', ?, ?)`,
      )
      .run(slotStartedAt, nowSec - 600, childStartedAt, childStartedAt, slotStartedAt, childStartedAt);
    sqlite
      .prepare(
        `INSERT INTO dex_liquidity_publication_generations (
           generation_id, started_at, state, expected_row_count, written_row_count,
           current_row_count, created_at, published_at
         ) VALUES (?, ?, 'published', 345, 345, 345, ?, ?)`,
      )
      .run(generationId, generationStartedAt, generationStartedAt, generationStartedAt + 300);
    sqlite
      .prepare(
        `INSERT INTO dex_liquidity_publication_generations (
           generation_id, started_at, state, expected_row_count, written_row_count,
           current_row_count, created_at, published_at
         ) VALUES (?, ?, 'published', 111, 111, 111, ?, ?)`,
      )
      .run(
        `dex-liquidity-${generationStartedAt + 1}`,
        generationStartedAt + 1,
        generationStartedAt + 1,
        generationStartedAt + 301,
      );

    const summary = await sweepStaleScheduledSlotExecutions(db, {
      nowSec,
      staleAfterSec: 1_200,
      slotKey: "halfHourlyOffset",
    });

    expect(summary).toMatchObject({
      slotsReconciled: 1,
      syntheticCronRuns: 1,
      jobAttemptsAbandoned: 0,
      jobAttemptsTerminalized: 1,
    });
    const attempt = sqlite
      .prepare(
        `SELECT state, status_class, finished_at, duration_ms, item_count, result_metadata_json
         FROM worker_job_attempts WHERE attempt_id = 'old-attempt'`,
      )
      .get() as Record<string, unknown> & { result_metadata_json: string };
    expect(attempt).toMatchObject({
      state: "completed",
      status_class: "degraded",
      finished_at: nowSec,
      duration_ms: (nowSec - childStartedAt) * 1_000,
      item_count: 345,
    });
    expect(JSON.parse(attempt.result_metadata_json)).toMatchObject({
      progress: { stage: "persistence-complete" },
      reason: "stale-slot-reconciled",
      childDisposition: "published_terminal_missing",
    });
    expect(sqlite.prepare("SELECT lease_owner FROM cron_leases WHERE job = 'sync-dex-liquidity'").get()).toEqual({
      lease_owner: "new-owner",
    });
    expect(sqlite.prepare("SELECT job FROM cron_run_progress WHERE job = 'sync-dex-liquidity'").get()).toBeUndefined();
    expect(
      sqlite
        .prepare(
          `SELECT status, error, productive, publication_count, item_count
           FROM cron_runs WHERE job = 'sync-dex-liquidity' AND slot_started_at = ?`,
        )
        .get(slotStartedAt),
    ).toEqual({ status: "degraded", error: null, productive: 1, publication_count: 1, item_count: 345 });
    const slot = sqlite
      .prepare(
        "SELECT result_status, metadata FROM cron_slot_executions WHERE slot_key = 'halfHourlyOffset' AND slot_started_at = ?",
      )
      .get(slotStartedAt) as { result_status: string; metadata: string };
    expect(slot.result_status).toBe("degraded");
    expect(JSON.parse(slot.metadata)).toMatchObject({
      staleSlotReconciliation: {
        derivedPublishedChildTerminals: 1,
        publicationFailures: 0,
        terminalAccountingUnknown: 1,
        abandonedJobs: [{ disposition: "published_terminal_missing" }],
      },
    });
    expect(
      await sweepStaleScheduledSlotExecutions(db, {
        nowSec: nowSec + 60,
        staleAfterSec: 1_200,
        slotKey: "halfHourlyOffset",
      }),
    ).toMatchObject({ candidateSlots: 0, slotsReconciled: 0 });
    expect(
      sqlite
        .prepare("SELECT COUNT(*) AS count FROM cron_runs WHERE job = 'sync-dex-liquidity' AND slot_started_at = ?")
        .get(slotStartedAt),
    ).toEqual({ count: 1 });
    sqlite.close();
  });

  it("fails closed when exact progress metadata identifies a generation outside the child window", async () => {
    const { sqlite, db } = createMigratedDb();
    const nowSec = 1_772_004_000;
    const slotStartedAt = nowSec - 3_600;
    const childStartedAt = slotStartedAt + 10;
    seedStaleDexProgress(sqlite, {
      nowSec,
      slotStartedAt,
      childStartedAt,
      stage: "persistence-generation-complete",
      progressMetadata: { generationId: "dex-liquidity-mismatch" },
    });
    const insertGeneration = sqlite.prepare(
      `INSERT INTO dex_liquidity_publication_generations (
         generation_id, started_at, state, expected_row_count, written_row_count,
         current_row_count, created_at, published_at
       ) VALUES (?, ?, 'published', 345, 345, 345, ?, ?)`,
    );
    insertGeneration.run("dex-liquidity-mismatch", childStartedAt - 30, childStartedAt - 30, childStartedAt - 20);
    insertGeneration.run(
      `dex-liquidity-${childStartedAt + 8}`,
      childStartedAt + 8,
      childStartedAt + 8,
      childStartedAt + 30,
    );

    const summary = await sweepStaleScheduledSlotExecutions(db, {
      nowSec,
      staleAfterSec: 1_200,
      slotKey: "halfHourlyOffset",
    });

    expect(summary).toMatchObject({
      slotsReconciled: 1,
      derivedPublishedChildTerminals: 0,
      publicationFailures: 0,
      terminalAccountingUnknown: 1,
    });
    expect(sqlite.prepare("SELECT state FROM worker_job_attempts WHERE attempt_id = 'attempt-1'").get()).toEqual({
      state: "abandoned",
    });
    sqlite.close();
  });

  it("preserves progress and leaves the slot unfinished when attempt terminalization fails", async () => {
    const { sqlite, db } = createMigratedDb();
    const nowSec = 1_772_004_000;
    const slotStartedAt = nowSec - 3_600;
    const childStartedAt = slotStartedAt + 10;
    seedStaleDexProgress(sqlite, { nowSec, slotStartedAt, childStartedAt });
    sqlite
      .prepare(
        `INSERT INTO cron_leases (job, lease_owner, lease_until, heartbeat_at, updated_at)
       VALUES ('sync-dex-liquidity', 'old-owner', ?, ?, ?)`,
      )
      .run(nowSec - 60, nowSec - 120, nowSec - 120);
    sqlite.exec(`
      CREATE TRIGGER fail_stale_attempt_terminalization
      BEFORE UPDATE ON worker_job_attempts
      WHEN OLD.attempt_id = 'attempt-1'
      BEGIN
        SELECT RAISE(ABORT, 'injected attempt terminalization failure');
      END;
    `);

    await expect(
      sweepStaleScheduledSlotExecutions(db, {
        nowSec,
        staleAfterSec: 1_200,
        slotKey: "halfHourlyOffset",
      }),
    ).rejects.toThrow("injected attempt terminalization failure");

    expect(
      sqlite
        .prepare(
          "SELECT state, result_status, finished_at FROM cron_slot_executions WHERE slot_key = 'halfHourlyOffset' AND slot_started_at = ?",
        )
        .get(slotStartedAt),
    ).toEqual({ state: "reconciling", result_status: null, finished_at: null });
    expect(sqlite.prepare("SELECT state FROM worker_job_attempts WHERE attempt_id = 'attempt-1'").get()).toEqual({
      state: "running",
    });
    expect(sqlite.prepare("SELECT job FROM cron_run_progress WHERE job = 'sync-dex-liquidity'").get()).toEqual({
      job: "sync-dex-liquidity",
    });
    expect(sqlite.prepare("SELECT lease_owner FROM cron_leases WHERE job = 'sync-dex-liquidity'").get()).toEqual({
      lease_owner: "old-owner",
    });
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM cron_runs").get()).toEqual({ count: 0 });

    sqlite.exec("DROP TRIGGER fail_stale_attempt_terminalization");
    const retried = await sweepStaleScheduledSlotExecutions(db, {
      nowSec: nowSec + 1_201,
      staleAfterSec: 1_200,
      slotKey: "halfHourlyOffset",
    });
    expect(retried).toMatchObject({ slotsReconciled: 1, jobAttemptsTerminalized: 1 });
    expect(sqlite.prepare("SELECT state FROM worker_job_attempts WHERE attempt_id = 'attempt-1'").get()).toEqual({
      state: "abandoned",
    });
    expect(
      sqlite.prepare("SELECT lease_owner FROM cron_leases WHERE job = 'sync-dex-liquidity'").get(),
    ).toBeUndefined();
    sqlite.close();
  });

  it("lets an old-owner renewal before retirement prevent attempt terminalization", async () => {
    const { sqlite, db: baseDb } = createMigratedDb();
    const nowSec = 1_772_004_000;
    const slotStartedAt = nowSec - 3_600;
    const childStartedAt = slotStartedAt + 10;
    seedStaleDexProgress(sqlite, { nowSec, slotStartedAt, childStartedAt });
    sqlite
      .prepare(
        `INSERT INTO cron_leases (job, lease_owner, lease_until, heartbeat_at, updated_at)
       VALUES ('sync-dex-liquidity', 'old-owner', ?, ?, ?)`,
      )
      .run(nowSec - 60, nowSec - 120, nowSec - 120);
    let renewed = false;
    const db = {
      prepare: baseDb.prepare.bind(baseDb),
      batch: async <T = unknown>(statements: D1PreparedStatement[]) => {
        if (!renewed) {
          renewed = true;
          sqlite
            .prepare(
              `UPDATE cron_leases
                SET lease_until = ?, heartbeat_at = ?, updated_at = ?
              WHERE job = 'sync-dex-liquidity' AND lease_owner = 'old-owner'`,
            )
            .run(nowSec + 300, nowSec, nowSec);
        }
        return baseDb.batch<T>(statements);
      },
    } as D1Database;

    await expect(
      sweepStaleScheduledSlotExecutions(db, {
        nowSec,
        staleAfterSec: 1_200,
        slotKey: "halfHourlyOffset",
      }),
    ).rejects.toThrow("worker-job attempt terminal CAS lost");

    expect(sqlite.prepare("SELECT state FROM worker_job_attempts WHERE attempt_id = 'attempt-1'").get()).toEqual({
      state: "running",
    });
    expect(sqlite.prepare("SELECT lease_until FROM cron_leases WHERE job = 'sync-dex-liquidity'").get()).toEqual({
      lease_until: nowSec + 300,
    });
    expect(sqlite.prepare("SELECT job FROM cron_run_progress WHERE job = 'sync-dex-liquidity'").get()).toEqual({
      job: "sync-dex-liquidity",
    });
    expect(
      sqlite
        .prepare("SELECT state FROM cron_slot_executions WHERE slot_key = 'halfHourlyOffset' AND slot_started_at = ?")
        .get(slotStartedAt),
    ).toEqual({ state: "reconciling" });
    sqlite.close();
  });

  it("retires the exact expired lease with the attempt so a later renewal loses ownership", async () => {
    const { sqlite, db } = createMigratedDb();
    const nowSec = 1_772_004_000;
    const slotStartedAt = nowSec - 3_600;
    const childStartedAt = slotStartedAt + 10;
    seedStaleDexProgress(sqlite, { nowSec, slotStartedAt, childStartedAt });
    sqlite
      .prepare(
        `INSERT INTO cron_leases (job, lease_owner, lease_until, heartbeat_at, updated_at)
       VALUES ('sync-dex-liquidity', 'old-owner', ?, ?, ?)`,
      )
      .run(nowSec - 60, nowSec - 120, nowSec - 120);

    const summary = await sweepStaleScheduledSlotExecutions(db, {
      nowSec,
      staleAfterSec: 1_200,
      slotKey: "halfHourlyOffset",
    });
    const lateRenewal = sqlite
      .prepare(
        `UPDATE cron_leases
          SET lease_until = ?, heartbeat_at = ?, updated_at = ?
        WHERE job = 'sync-dex-liquidity' AND lease_owner = 'old-owner'`,
      )
      .run(nowSec + 300, nowSec, nowSec);

    expect(summary).toMatchObject({
      slotsReconciled: 1,
      jobAttemptsTerminalized: 1,
      leasesCleared: 1,
    });
    expect(sqlite.prepare("SELECT state FROM worker_job_attempts WHERE attempt_id = 'attempt-1'").get()).toEqual({
      state: "abandoned",
    });
    expect(Number(lateRenewal.changes)).toBe(0);
    expect(
      sqlite.prepare("SELECT lease_owner FROM cron_leases WHERE job = 'sync-dex-liquidity'").get(),
    ).toBeUndefined();
    sqlite.close();
  });

  it("recognizes an ambiguous post-commit retry of the terminalization batch", async () => {
    const { sqlite, db: baseDb } = createMigratedDb();
    const nowSec = 1_772_004_000;
    const slotStartedAt = nowSec - 3_600;
    const childStartedAt = slotStartedAt + 10;
    seedStaleDexProgress(sqlite, { nowSec, slotStartedAt, childStartedAt });
    sqlite
      .prepare(
        `INSERT INTO cron_leases (job, lease_owner, lease_until, heartbeat_at, updated_at)
       VALUES ('sync-dex-liquidity', 'old-owner', ?, ?, ?)`,
      )
      .run(nowSec - 60, nowSec - 120, nowSec - 120);
    vi.spyOn(Math, "random").mockReturnValue(0);
    let injected = false;
    const db = {
      prepare: baseDb.prepare.bind(baseDb),
      batch: async <T = unknown>(statements: D1PreparedStatement[]) => {
        const results = await baseDb.batch<T>(statements);
        if (!injected) {
          injected = true;
          throw new Error("D1 DB is overloaded after commit");
        }
        return results;
      },
    } as D1Database;

    const summary = await sweepStaleScheduledSlotExecutions(db, {
      nowSec,
      staleAfterSec: 1_200,
      slotKey: "halfHourlyOffset",
    });

    expect(injected).toBe(true);
    expect(summary).toMatchObject({
      slotsReconciled: 1,
      jobAttemptsTerminalized: 1,
      jobAttemptsAbandoned: 1,
      leasesCleared: 1,
      syntheticCronRuns: 1,
    });
    expect(
      sqlite.prepare("SELECT state, status_class FROM worker_job_attempts WHERE attempt_id = 'attempt-1'").get(),
    ).toEqual({ state: "abandoned", status_class: "abandoned" });
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM cron_leases WHERE job = 'sync-dex-liquidity'").get()).toEqual({
      count: 0,
    });
    expect(
      sqlite
        .prepare("SELECT COUNT(*) AS count FROM cron_runs WHERE job = 'sync-dex-liquidity' AND slot_started_at = ?")
        .get(slotStartedAt),
    ).toEqual({ count: 1 });
    sqlite.close();
  });

  it("stops child reconciliation when its slot claim is superseded", async () => {
    const { sqlite, db: baseDb } = createMigratedDb();
    const nowSec = 1_772_004_000;
    const slotStartedAt = nowSec - 3_600;
    const childStartedAt = slotStartedAt + 10;
    seedStaleDexProgress(sqlite, { nowSec, slotStartedAt, childStartedAt });
    sqlite
      .prepare(
        `INSERT INTO cron_leases (job, lease_owner, lease_until, heartbeat_at, updated_at)
       VALUES ('sync-dex-liquidity', 'old-owner', ?, ?, ?)`,
      )
      .run(nowSec - 60, nowSec - 120, nowSec - 120);
    let superseded = false;
    const db = {
      prepare: baseDb.prepare.bind(baseDb),
      batch: async <T = unknown>(statements: D1PreparedStatement[]) => {
        if (!superseded) {
          superseded = true;
          sqlite
            .prepare(
              `UPDATE cron_slot_executions
                SET execution_owner = 'new-reconciler', execution_generation = execution_generation + 1
              WHERE slot_key = 'halfHourlyOffset' AND slot_started_at = ?`,
            )
            .run(slotStartedAt);
        }
        return baseDb.batch<T>(statements);
      },
    } as D1Database;

    await expect(
      sweepStaleScheduledSlotExecutions(db, {
        nowSec,
        staleAfterSec: 1_200,
        slotKey: "halfHourlyOffset",
      }),
    ).rejects.toThrow("scheduled slot reconciliation ownership lost");

    expect(
      sqlite
        .prepare(
          "SELECT state, execution_owner, execution_generation FROM cron_slot_executions WHERE slot_started_at = ?",
        )
        .get(slotStartedAt),
    ).toEqual({
      state: "reconciling",
      execution_owner: "new-reconciler",
      execution_generation: 3,
    });
    expect(sqlite.prepare("SELECT state FROM worker_job_attempts WHERE attempt_id = 'attempt-1'").get()).toEqual({
      state: "running",
    });
    expect(sqlite.prepare("SELECT lease_owner FROM cron_leases WHERE job = 'sync-dex-liquidity'").get()).toEqual({
      lease_owner: "old-owner",
    });
    expect(sqlite.prepare("SELECT job FROM cron_run_progress WHERE job = 'sync-dex-liquidity'").get()).toEqual({
      job: "sync-dex-liquidity",
    });
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM cron_runs").get()).toEqual({ count: 0 });
    sqlite.close();
  });

  it("corrects its terminal attempt when a real terminal arrives after the first batch", async () => {
    const { sqlite, db: baseDb } = createMigratedDb();
    const nowSec = 1_772_004_000;
    const slotStartedAt = nowSec - 3_600;
    const childStartedAt = slotStartedAt + 10;
    seedStaleDexProgress(sqlite, { nowSec, slotStartedAt, childStartedAt });
    sqlite
      .prepare(
        `INSERT INTO cron_leases (job, lease_owner, lease_until, heartbeat_at, updated_at)
       VALUES ('sync-dex-liquidity', 'old-owner', ?, ?, ?)`,
      )
      .run(nowSec - 60, nowSec - 120, nowSec - 120);
    let terminalInserted = false;
    const db = {
      prepare: baseDb.prepare.bind(baseDb),
      batch: async <T = unknown>(statements: D1PreparedStatement[]) => {
        const results = await baseDb.batch<T>(statements);
        if (!terminalInserted) {
          terminalInserted = true;
          sqlite
            .prepare(
              `INSERT INTO cron_runs (
               job, started_at, duration_ms, status, error, item_count, metadata,
               slot_started_at, idempotency_key, schedule_key, producer_path,
               producer_kind, invocation_id, worker_version, productive, publication_count
             ) VALUES ('sync-dex-liquidity', ?, 1000, 'ok', NULL, 27, NULL, ?,
               'real-terminal-after-snapshot', 'halfHourlyOffset', 'halfHourlyOffset',
               'scheduled-job', 'invocation', 'version', 1, 0)`,
            )
            .run(childStartedAt, slotStartedAt);
        }
        return results;
      },
    } as D1Database;

    const summary = await sweepStaleScheduledSlotExecutions(db, {
      nowSec,
      staleAfterSec: 1_200,
      slotKey: "halfHourlyOffset",
    });

    expect(summary).toMatchObject({
      slotsReconciled: 1,
      jobAttemptsTerminalized: 1,
      jobAttemptsAbandoned: 0,
      successfulChildTerminals: 1,
      syntheticCronRuns: 0,
      realChildFailures: 0,
    });
    expect(
      sqlite
        .prepare(
          "SELECT state, status_class, item_count, error FROM worker_job_attempts WHERE attempt_id = 'attempt-1'",
        )
        .get(),
    ).toEqual({ state: "completed", status_class: "ok", item_count: 27, error: null });
    expect(
      sqlite
        .prepare("SELECT COUNT(*) AS count FROM cron_runs WHERE job = 'sync-dex-liquidity' AND slot_started_at = ?")
        .get(slotStartedAt),
    ).toEqual({ count: 1 });
    sqlite.close();
  });

  it("corrects its terminal attempt when DEX publication completes after the first batch", async () => {
    const { sqlite, db: baseDb } = createMigratedDb();
    const nowSec = 1_772_004_000;
    const slotStartedAt = nowSec - 3_600;
    const childStartedAt = slotStartedAt + 10;
    const generationId = "dex-late-publication";
    seedStaleDexProgress(sqlite, {
      nowSec,
      slotStartedAt,
      childStartedAt,
      stage: "persistence-generation-complete",
      progressMetadata: { generationId },
    });
    sqlite
      .prepare(
        `INSERT INTO cron_leases (job, lease_owner, lease_until, heartbeat_at, updated_at)
       VALUES ('sync-dex-liquidity', 'old-owner', ?, ?, ?)`,
      )
      .run(nowSec - 60, nowSec - 120, nowSec - 120);
    sqlite
      .prepare(
        `INSERT INTO dex_liquidity_publication_generations (
         generation_id, started_at, state, expected_row_count, written_row_count,
         current_row_count, created_at, published_at
       ) VALUES (?, ?, 'staged', 31, 31, NULL, ?, NULL)`,
      )
      .run(generationId, childStartedAt + 1, childStartedAt + 1);
    let published = false;
    const db = {
      prepare: baseDb.prepare.bind(baseDb),
      batch: async <T = unknown>(statements: D1PreparedStatement[]) => {
        const results = await baseDb.batch<T>(statements);
        if (!published) {
          published = true;
          sqlite
            .prepare(
              `UPDATE dex_liquidity_publication_generations
                SET state = 'published', current_row_count = expected_row_count, published_at = ?
              WHERE generation_id = ?`,
            )
            .run(nowSec - 30, generationId);
        }
        return results;
      },
    } as D1Database;

    const summary = await sweepStaleScheduledSlotExecutions(db, {
      nowSec,
      staleAfterSec: 1_200,
      slotKey: "halfHourlyOffset",
    });

    expect(summary).toMatchObject({
      slotsReconciled: 1,
      jobAttemptsTerminalized: 1,
      jobAttemptsAbandoned: 0,
      derivedPublishedChildTerminals: 1,
      publicationFailures: 0,
      syntheticCronRuns: 1,
    });
    expect(
      sqlite
        .prepare(
          "SELECT state, status_class, item_count, error FROM worker_job_attempts WHERE attempt_id = 'attempt-1'",
        )
        .get(),
    ).toEqual({ state: "completed", status_class: "degraded", item_count: 31, error: null });
    expect(
      sqlite
        .prepare(
          "SELECT status, item_count, idempotency_key FROM cron_runs WHERE job = 'sync-dex-liquidity' AND slot_started_at = ?",
        )
        .get(slotStartedAt),
    ).toMatchObject({
      status: "degraded",
      item_count: 31,
      idempotency_key: expect.stringContaining("scheduled-slot-published-terminal-missing"),
    });
    sqlite.close();
  });

  it("corrects a committed synthetic publication failure when DEX publication completes afterward", async () => {
    const { sqlite, db } = createMigratedDb();
    const nowSec = 1_772_004_000;
    const slotStartedAt = nowSec - 3_600;
    const childStartedAt = slotStartedAt + 10;
    const generationId = "dex-after-synthetic-failure";
    seedStaleDexProgress(sqlite, {
      nowSec,
      slotStartedAt,
      childStartedAt,
      stage: "persistence-generation-complete",
      progressMetadata: { generationId },
    });
    sqlite
      .prepare(
        `INSERT INTO dex_liquidity_publication_generations (
         generation_id, started_at, state, expected_row_count, written_row_count,
         current_row_count, created_at, published_at
       ) VALUES (?, ?, 'staged', 31, 31, NULL, ?, NULL)`,
      )
      .run(generationId, childStartedAt + 1, childStartedAt + 1);
    sqlite.exec(`
      CREATE TRIGGER publish_dex_after_synthetic_failure
      AFTER INSERT ON cron_runs
      WHEN NEW.idempotency_key LIKE 'scheduled-slot-stale:%'
      BEGIN
        UPDATE dex_liquidity_publication_generations
           SET state = 'published', current_row_count = expected_row_count, published_at = ${nowSec - 30}
         WHERE generation_id = '${generationId}';
      END;
    `);

    const summary = await sweepStaleScheduledSlotExecutions(db, {
      nowSec,
      staleAfterSec: 1_200,
      slotKey: "halfHourlyOffset",
    });

    expect(summary).toMatchObject({
      slotsReconciled: 1,
      jobAttemptsTerminalized: 1,
      jobAttemptsAbandoned: 0,
      derivedPublishedChildTerminals: 1,
      publicationFailures: 0,
    });
    expect(
      sqlite
        .prepare(
          "SELECT state, status_class, item_count, error FROM worker_job_attempts WHERE attempt_id = 'attempt-1'",
        )
        .get(),
    ).toEqual({ state: "completed", status_class: "degraded", item_count: 31, error: null });
    expect(
      sqlite
        .prepare(
          `SELECT status, error, item_count, idempotency_key, productive, publication_count
         FROM cron_runs
        WHERE job = 'sync-dex-liquidity' AND slot_started_at = ?`,
        )
        .all(slotStartedAt),
    ).toEqual([
      {
        status: "degraded",
        error: null,
        item_count: 31,
        idempotency_key: `scheduled-slot-published-terminal-missing:halfHourlyOffset:${slotStartedAt}:sync-dex-liquidity:${generationId}`,
        productive: 1,
        publication_count: 1,
      },
    ]);
    expect(
      sqlite
        .prepare(
          `SELECT idempotency_key, outcome, productive, item_count
         FROM worker_producer_history
        WHERE schedule_key = 'halfHourlyOffset' AND job = 'sync-dex-liquidity'`,
        )
        .get(),
    ).toEqual({
      idempotency_key: `scheduled-slot-published-terminal-missing:halfHourlyOffset:${slotStartedAt}:sync-dex-liquidity:${generationId}`,
      outcome: "degraded",
      productive: 1,
      item_count: 31,
    });
    expect(sqlite.prepare("SELECT job FROM cron_run_progress WHERE job = 'sync-dex-liquidity'").get()).toBeUndefined();
    sqlite.close();
  });

  it("promotes progress that appears after the no-progress snapshot into reconciliation", async () => {
    const { sqlite, db: baseDb } = createMigratedDb();
    const nowSec = 1_772_004_000;
    const slotStartedAt = nowSec - 3_600;
    const childStartedAt = slotStartedAt + 10;
    seedStaleDexProgress(sqlite, { nowSec, slotStartedAt, childStartedAt, stage: "fetching" });
    sqlite.prepare("DELETE FROM cron_run_progress WHERE job = 'sync-dex-liquidity'").run();
    let progressInserted = false;
    const db = {
      prepare: baseDb.prepare.bind(baseDb),
      batch: async <T = unknown>(statements: D1PreparedStatement[]) => {
        if (!progressInserted) {
          progressInserted = true;
          sqlite
            .prepare(
              `INSERT INTO cron_run_progress
               (job, started_at, updated_at, stage, lease_owner, slot_started_at, metadata)
             VALUES ('sync-dex-liquidity', ?, ?, 'fetching', 'old-owner', ?, NULL)`,
            )
            .run(childStartedAt, childStartedAt + 60, slotStartedAt);
        }
        return baseDb.batch<T>(statements);
      },
    } as D1Database;

    const summary = await sweepStaleScheduledSlotExecutions(db, {
      nowSec,
      staleAfterSec: 1_200,
      slotKey: "halfHourlyOffset",
    });

    expect(progressInserted).toBe(true);
    expect(summary).toMatchObject({
      slotsReconciled: 1,
      notStartedCronRuns: 0,
      terminalAccountingUnknown: 1,
      progressRowsCleared: 1,
      abandonedSlots: [{ abandonedJobs: [{ job: "sync-dex-liquidity", progressStage: "fetching" }] }],
    });
    expect(
      sqlite.prepare("SELECT state, status_class FROM worker_job_attempts WHERE attempt_id = 'attempt-1'").get(),
    ).toEqual({ state: "abandoned", status_class: "abandoned" });
    expect(
      sqlite
        .prepare("SELECT metadata FROM cron_runs WHERE job = 'sync-dex-liquidity' AND slot_started_at = ?")
        .get(slotStartedAt),
    ).toMatchObject({
      metadata: expect.stringContaining('"childDisposition":"terminal_accounting_unknown"'),
    });
    expect(sqlite.prepare("SELECT job FROM cron_run_progress WHERE job = 'sync-dex-liquidity'").get()).toBeUndefined();
    sqlite.close();
  });

  it("reclassifies progress inserted after the synthetic not-started terminal commits", async () => {
    const { sqlite, db } = createMigratedDb();
    const nowSec = 1_772_004_000;
    const slotStartedAt = nowSec - 3_600;
    const childStartedAt = slotStartedAt + 10;
    seedStaleDexProgress(sqlite, { nowSec, slotStartedAt, childStartedAt, stage: "fetching" });
    sqlite.prepare("DELETE FROM cron_run_progress WHERE job = 'sync-dex-liquidity'").run();
    sqlite.exec(`
      CREATE TRIGGER add_progress_after_not_started_terminal
      AFTER INSERT ON cron_runs
      WHEN NEW.idempotency_key LIKE 'scheduled-slot-not-started:%'
      BEGIN
        INSERT INTO cron_run_progress
          (job, started_at, updated_at, stage, lease_owner, slot_started_at, metadata)
        VALUES (
          'sync-dex-liquidity',
          ${childStartedAt},
          ${childStartedAt + 60},
          'fetching',
          'old-owner',
          ${slotStartedAt},
          NULL
        );
      END;
    `);

    const summary = await sweepStaleScheduledSlotExecutions(db, {
      nowSec,
      staleAfterSec: 1_200,
      slotKey: "halfHourlyOffset",
    });

    expect(summary).toMatchObject({
      slotsReconciled: 1,
      syntheticCronRuns: 1,
      notStartedCronRuns: 0,
      terminalAccountingUnknown: 1,
      progressRowsCleared: 1,
      jobAttemptsTerminalized: 1,
      jobAttemptsAbandoned: 1,
      abandonedSlots: [
        {
          abandonedJobs: [
            {
              job: "sync-dex-liquidity",
              disposition: "terminal_accounting_unknown",
              progressStage: "fetching",
            },
          ],
        },
      ],
    });
    expect(
      sqlite
        .prepare(
          `SELECT started_at, duration_ms, status, item_count, metadata, idempotency_key
             FROM cron_runs
            WHERE job = 'sync-dex-liquidity' AND slot_started_at = ?`,
        )
        .all(slotStartedAt),
    ).toEqual([
      {
        started_at: childStartedAt,
        duration_ms: (nowSec - childStartedAt) * 1_000,
        status: "error",
        item_count: null,
        metadata: expect.stringContaining('"childDisposition":"terminal_accounting_unknown"'),
        idempotency_key: `scheduled-slot-stale:halfHourlyOffset:${slotStartedAt}:sync-dex-liquidity:${childStartedAt}`,
      },
    ]);
    expect(
      sqlite
        .prepare(
          `SELECT idempotency_key, outcome
             FROM worker_producer_history
            WHERE schedule_key = 'halfHourlyOffset' AND job = 'sync-dex-liquidity'`,
        )
        .get(),
    ).toEqual({
      idempotency_key: `scheduled-slot-stale:halfHourlyOffset:${slotStartedAt}:sync-dex-liquidity:${childStartedAt}`,
      outcome: "abandoned",
    });
    expect(
      sqlite.prepare("SELECT state, status_class FROM worker_job_attempts WHERE attempt_id = 'attempt-1'").get(),
    ).toEqual({ state: "abandoned", status_class: "abandoned" });
    expect(sqlite.prepare("SELECT job FROM cron_run_progress WHERE job = 'sync-dex-liquidity'").get()).toBeUndefined();
    expect(
      sqlite
        .prepare(
          `SELECT state, result_status
             FROM cron_slot_executions
            WHERE slot_key = 'halfHourlyOffset' AND slot_started_at = ?`,
        )
        .get(slotStartedAt),
    ).toEqual({ state: "finished", result_status: "error" });
    sqlite.close();
  });

  it("reconciles progress committed immediately before the guarded slot finish", async () => {
    const { sqlite, db: baseDb } = createMigratedDb();
    const nowSec = 1_772_004_000;
    const slotStartedAt = nowSec - 3_600;
    const childStartedAt = slotStartedAt + 10;
    seedStaleDexProgress(sqlite, { nowSec, slotStartedAt, childStartedAt, stage: "fetching" });
    sqlite.prepare("DELETE FROM cron_run_progress WHERE job = 'sync-dex-liquidity'").run();
    let progressInsertedBeforeFinish = false;
    const db = {
      prepare: (sql: string) => {
        const statement = baseDb.prepare(sql);
        if (!sql.includes("UPDATE cron_slot_executions") || !sql.includes("SET state = 'finished'")) {
          return statement;
        }
        return {
          bind: (...args: unknown[]) => {
            const bound = statement.bind(...args);
            return {
              run: async <T = unknown>() => {
                if (!progressInsertedBeforeFinish) {
                  progressInsertedBeforeFinish = true;
                  sqlite
                    .prepare(
                      `INSERT INTO cron_run_progress
                       (job, started_at, updated_at, stage, lease_owner, slot_started_at, metadata)
                     VALUES ('sync-dex-liquidity', ?, ?, 'fetching', 'old-owner', ?, NULL)`,
                    )
                    .run(childStartedAt, childStartedAt + 60, slotStartedAt);
                }
                return bound.run<T>();
              },
            } as D1PreparedStatement;
          },
        } as D1PreparedStatement;
      },
      batch: baseDb.batch.bind(baseDb),
    } as D1Database;

    const summary = await sweepStaleScheduledSlotExecutions(db, {
      nowSec,
      staleAfterSec: 1_200,
      slotKey: "halfHourlyOffset",
    });

    expect(progressInsertedBeforeFinish).toBe(true);
    expect(summary).toMatchObject({
      slotsReconciled: 1,
      notStartedCronRuns: 0,
      terminalAccountingUnknown: 1,
      progressRowsCleared: 1,
      abandonedSlots: [
        {
          abandonedJobs: [
            {
              job: "sync-dex-liquidity",
              disposition: "terminal_accounting_unknown",
              progressStage: "fetching",
            },
          ],
        },
      ],
    });
    expect(
      sqlite
        .prepare(
          `SELECT metadata, idempotency_key
             FROM cron_runs
            WHERE job = 'sync-dex-liquidity' AND slot_started_at = ?`,
        )
        .all(slotStartedAt),
    ).toEqual([
      {
        metadata: expect.stringContaining('"childDisposition":"terminal_accounting_unknown"'),
        idempotency_key: `scheduled-slot-stale:halfHourlyOffset:${slotStartedAt}:sync-dex-liquidity:${childStartedAt}`,
      },
    ]);
    expect(sqlite.prepare("SELECT job FROM cron_run_progress WHERE job = 'sync-dex-liquidity'").get()).toBeUndefined();
    expect(
      sqlite
        .prepare(
          `SELECT state, result_status
             FROM cron_slot_executions
            WHERE slot_key = 'halfHourlyOffset' AND slot_started_at = ?`,
        )
        .get(slotStartedAt),
    ).toEqual({ state: "finished", result_status: "error" });
    sqlite.close();
  });

  it("fails closed when concurrent active attempts make terminal ownership ambiguous", async () => {
    const { sqlite, db } = createMigratedDb();
    const nowSec = 1_772_004_000;
    const slotStartedAt = nowSec - 3_600;
    const childStartedAt = slotStartedAt + 10;
    seedStaleDexProgress(sqlite, {
      nowSec,
      slotStartedAt,
      childStartedAt,
      attemptIds: ["attempt-1", "attempt-2"],
    });

    await expect(
      sweepStaleScheduledSlotExecutions(db, {
        nowSec,
        staleAfterSec: 1_200,
        slotKey: "halfHourlyOffset",
      }),
    ).rejects.toThrow("ambiguous active worker-job attempts");

    expect(
      sqlite
        .prepare(
          "SELECT state, result_status FROM cron_slot_executions WHERE slot_key = 'halfHourlyOffset' AND slot_started_at = ?",
        )
        .get(slotStartedAt),
    ).toEqual({ state: "reconciling", result_status: null });
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM worker_job_attempts WHERE state = 'running'").get()).toEqual({
      count: 2,
    });
    expect(sqlite.prepare("SELECT job FROM cron_run_progress WHERE job = 'sync-dex-liquidity'").get()).toEqual({
      job: "sync-dex-liquidity",
    });
    sqlite.close();
  });

  it("restores publication-failure taxonomy from a synthetic terminal row on retry", async () => {
    const { sqlite, db } = createMigratedDb();
    const nowSec = 1_772_004_000;
    const slotStartedAt = nowSec - 3_600;
    const childStartedAt = slotStartedAt + 10;
    seedStaleDexProgress(sqlite, { nowSec, slotStartedAt, childStartedAt });
    const idempotencyKey = [
      "scheduled-slot-stale",
      "halfHourlyOffset",
      slotStartedAt,
      "sync-dex-liquidity",
      childStartedAt,
    ].join(":");
    sqlite
      .prepare(
        `INSERT INTO cron_runs (
         job, started_at, duration_ms, status, error, item_count, metadata,
         slot_started_at, idempotency_key, schedule_key, producer_path,
         producer_kind, invocation_id, worker_version, productive, publication_count
       ) VALUES ('sync-dex-liquidity', ?, 1000, 'error', 'stale', NULL, ?, ?, ?,
         'halfHourlyOffset', 'halfHourlyOffset', 'scheduled-job', 'invocation', 'version', 0, 0)`,
      )
      .run(
        childStartedAt,
        JSON.stringify({
          reason: "stale-slot-reconciled",
          childDisposition: "publication_failure",
          failureCategory: "publication-failure",
        }),
        slotStartedAt,
        idempotencyKey,
      );

    const summary = await sweepStaleScheduledSlotExecutions(db, {
      nowSec,
      staleAfterSec: 1_200,
      slotKey: "halfHourlyOffset",
    });

    expect(summary).toMatchObject({
      slotsReconciled: 1,
      syntheticCronRuns: 0,
      publicationFailures: 1,
      terminalAccountingUnknown: 0,
      realChildFailures: 0,
      jobAttemptsAbandoned: 1,
    });
    expect(
      sqlite.prepare("SELECT state, status_class FROM worker_job_attempts WHERE attempt_id = 'attempt-1'").get(),
    ).toEqual({ state: "abandoned", status_class: "abandoned" });
    expect(
      sqlite.prepare("SELECT outcome FROM worker_producer_history WHERE idempotency_key = ?").get(idempotencyKey),
    ).toEqual({ outcome: "abandoned" });
    sqlite.close();
  });

  it("restores published-terminal-missing taxonomy from a synthetic terminal row on retry", async () => {
    const { sqlite, db } = createMigratedDb();
    const nowSec = 1_772_004_000;
    const slotStartedAt = nowSec - 3_600;
    const childStartedAt = slotStartedAt + 10;
    seedStaleDexProgress(sqlite, { nowSec, slotStartedAt, childStartedAt });
    const generationId = `dex-liquidity-${childStartedAt}`;
    const idempotencyKey = [
      "scheduled-slot-published-terminal-missing",
      "halfHourlyOffset",
      slotStartedAt,
      "sync-dex-liquidity",
      generationId,
    ].join(":");
    sqlite
      .prepare(
        `INSERT INTO dex_liquidity_publication_generations (
         generation_id, started_at, state, expected_row_count, written_row_count,
         current_row_count, created_at, published_at
       ) VALUES (?, ?, 'published', 345, 345, 345, ?, ?)`,
      )
      .run(generationId, childStartedAt, childStartedAt, childStartedAt);
    sqlite
      .prepare(
        `INSERT INTO cron_runs (
         job, started_at, duration_ms, status, error, item_count, metadata,
         slot_started_at, idempotency_key, schedule_key, producer_path,
         producer_kind, invocation_id, worker_version, productive, publication_count
       ) VALUES ('sync-dex-liquidity', ?, 1000, 'degraded', NULL, 345, ?, ?, ?,
         'halfHourlyOffset', 'halfHourlyOffset', 'scheduled-job', 'invocation', 'version', 1, 1)`,
      )
      .run(
        childStartedAt,
        JSON.stringify({
          reason: "stale-slot-reconciled",
          childDisposition: "published_terminal_missing",
          generationId,
        }),
        slotStartedAt,
        idempotencyKey,
      );

    const summary = await sweepStaleScheduledSlotExecutions(db, {
      nowSec,
      staleAfterSec: 1_200,
      slotKey: "halfHourlyOffset",
    });

    expect(summary).toMatchObject({
      slotsReconciled: 1,
      syntheticCronRuns: 0,
      successfulChildTerminals: 0,
      derivedPublishedChildTerminals: 1,
      publicationFailures: 0,
      terminalAccountingUnknown: 1,
      realChildFailures: 0,
    });
    expect(
      sqlite
        .prepare("SELECT state, status_class, item_count FROM worker_job_attempts WHERE attempt_id = 'attempt-1'")
        .get(),
    ).toEqual({ state: "completed", status_class: "degraded", item_count: 345 });
    expect(
      sqlite
        .prepare("SELECT outcome, productive FROM worker_producer_history WHERE idempotency_key = ?")
        .get(idempotencyKey),
    ).toEqual({ outcome: "degraded", productive: 1 });
    sqlite.close();
  });

  it.each([
    ["missing", false],
    ["staged", true],
  ])("fails closed when the persistence-stage generation is %s", async (_label, insertStaged) => {
    const { sqlite, db } = createMigratedDb();
    const nowSec = 1_772_004_000;
    const slotStartedAt = nowSec - 3_600;
    const childStartedAt = slotStartedAt + 10;
    sqlite
      .prepare(
        `INSERT INTO cron_slot_executions (
           slot_key, slot_started_at, state, result_status, execution_owner,
           started_at, finished_at, updated_at, metadata, execution_generation
         ) VALUES ('halfHourlyOffset', ?, 'running', NULL, 'slot-owner', ?, NULL, ?, NULL, 1)`,
      )
      .run(slotStartedAt, slotStartedAt, slotStartedAt);
    sqlite
      .prepare(
        `INSERT INTO cron_run_progress
           (job, started_at, updated_at, stage, lease_owner, slot_started_at)
         VALUES ('sync-dex-liquidity', ?, ?, 'persistence', 'old-owner', ?)`,
      )
      .run(childStartedAt, childStartedAt + 60, slotStartedAt);
    if (insertStaged) {
      sqlite
        .prepare(
          `INSERT INTO dex_liquidity_publication_generations (
             generation_id, started_at, state, expected_row_count, written_row_count, created_at
           ) VALUES (?, ?, 'staged', 345, 120, ?)`,
        )
        .run(`dex-liquidity-${childStartedAt}`, childStartedAt, childStartedAt);
    }

    const summary = await sweepStaleScheduledSlotExecutions(db, {
      nowSec,
      staleAfterSec: 1_200,
      slotKey: "halfHourlyOffset",
    });

    expect(summary).toMatchObject({ slotsReconciled: 1, syntheticCronRuns: 1 });
    const slot = sqlite
      .prepare(
        "SELECT result_status, metadata FROM cron_slot_executions WHERE slot_key = 'halfHourlyOffset' AND slot_started_at = ?",
      )
      .get(slotStartedAt) as { result_status: string; metadata: string };
    expect(slot.result_status).toBe("error");
    expect(JSON.parse(slot.metadata)).toMatchObject({
      staleSlotReconciliation: {
        publicationFailures: 1,
        terminalAccountingUnknown: 0,
        abandonedJobs: [{ disposition: "publication_failure" }],
      },
    });
    sqlite.close();
  });

  it("fails closed when more than one publication generation matches the child lifetime", async () => {
    const { sqlite, db } = createMigratedDb();
    const nowSec = 1_772_004_000;
    const slotStartedAt = nowSec - 3_600;
    const childStartedAt = slotStartedAt + 10;
    sqlite
      .prepare(
        `INSERT INTO cron_slot_executions (
           slot_key, slot_started_at, state, result_status, execution_owner,
           started_at, finished_at, updated_at, metadata, execution_generation
         ) VALUES ('halfHourlyOffset', ?, 'running', NULL, 'slot-owner', ?, NULL, ?, NULL, 1)`,
      )
      .run(slotStartedAt, slotStartedAt, slotStartedAt);
    sqlite
      .prepare(
        `INSERT INTO cron_run_progress
           (job, started_at, updated_at, stage, lease_owner, slot_started_at)
         VALUES ('sync-dex-liquidity', ?, ?, 'persistence', 'old-owner', ?)`,
      )
      .run(childStartedAt, childStartedAt + 60, slotStartedAt);
    const insertGeneration = sqlite.prepare(
      `INSERT INTO dex_liquidity_publication_generations (
         generation_id, started_at, state, expected_row_count, written_row_count,
         current_row_count, created_at, published_at
       ) VALUES (?, ?, 'published', 345, 345, 345, ?, ?)`,
    );
    insertGeneration.run(`dex-liquidity-${childStartedAt}`, childStartedAt, childStartedAt, childStartedAt);
    insertGeneration.run(
      `dex-liquidity-${childStartedAt + 1}`,
      childStartedAt + 1,
      childStartedAt + 1,
      childStartedAt + 1,
    );

    const summary = await sweepStaleScheduledSlotExecutions(db, {
      nowSec,
      staleAfterSec: 1_200,
      slotKey: "halfHourlyOffset",
    });

    expect(summary).toMatchObject({
      slotsReconciled: 1,
      derivedPublishedChildTerminals: 0,
      publicationFailures: 0,
      terminalAccountingUnknown: 1,
      realChildFailures: 0,
    });
    const slot = sqlite
      .prepare(
        "SELECT result_status, metadata FROM cron_slot_executions WHERE slot_key = 'halfHourlyOffset' AND slot_started_at = ?",
      )
      .get(slotStartedAt) as { result_status: string; metadata: string };
    expect(slot.result_status).toBe("error");
    expect(JSON.parse(slot.metadata)).toMatchObject({
      staleSlotReconciliation: {
        abandonedJobs: [{ disposition: "terminal_accounting_unknown" }],
      },
    });
    sqlite.close();
  });

  it("revalidates the exact ambiguous DEX generation set before terminalization", async () => {
    const { sqlite, db: baseDb } = createMigratedDb();
    const nowSec = 1_772_004_000;
    const slotStartedAt = nowSec - 3_600;
    const childStartedAt = slotStartedAt + 10;
    seedStaleDexProgress(sqlite, { nowSec, slotStartedAt, childStartedAt });
    const insertGeneration = sqlite.prepare(
      `INSERT INTO dex_liquidity_publication_generations (
         generation_id, started_at, state, expected_row_count, written_row_count,
         current_row_count, created_at, published_at
       ) VALUES (?, ?, 'staged', 20, 20, NULL, ?, NULL)`,
    );
    insertGeneration.run("ambiguous-a", childStartedAt, childStartedAt);
    insertGeneration.run("ambiguous-b", childStartedAt + 1, childStartedAt + 1);
    let batchCalls = 0;
    const db = {
      prepare: baseDb.prepare.bind(baseDb),
      batch: async <T = unknown>(statements: D1PreparedStatement[]) => {
        batchCalls++;
        if (batchCalls === 1) {
          sqlite
            .prepare(
              `UPDATE dex_liquidity_publication_generations
                SET state = 'published', current_row_count = expected_row_count, published_at = ?
              WHERE generation_id = 'ambiguous-a'`,
            )
            .run(nowSec - 30);
        }
        return baseDb.batch<T>(statements);
      },
    } as D1Database;

    const summary = await sweepStaleScheduledSlotExecutions(db, {
      nowSec,
      staleAfterSec: 1_200,
      slotKey: "halfHourlyOffset",
    });

    expect(batchCalls).toBe(2);
    expect(summary).toMatchObject({
      slotsReconciled: 1,
      jobAttemptsTerminalized: 1,
      terminalAccountingUnknown: 1,
      derivedPublishedChildTerminals: 0,
    });
    expect(sqlite.prepare("SELECT state FROM worker_job_attempts WHERE attempt_id = 'attempt-1'").get()).toEqual({
      state: "abandoned",
    });
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
        undefined,
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

  it("lets a real producer completion replace synthetic history for the same invocation", async () => {
    const { sqlite, db } = createMigratedDb();
    const slotStartedAt = 1_772_000_000;
    await recordProducerOutcome(db, {
      scheduleKey: "halfHourlyOffset",
      job: "sync-dex-liquidity",
      producerPath: "halfHourlyOffset",
      producerKind: "scheduled-job",
      invocationId: "shared-late-invocation",
      workerVersion: "worker-version",
      slotStartedAt,
      idempotencyKey: `scheduled-slot-stale:halfHourlyOffset:${slotStartedAt}:sync-dex-liquidity:${slotStartedAt}`,
      invokedAt: slotStartedAt,
      completedAt: slotStartedAt + 60,
      outcome: "abandoned",
      itemCount: null,
      metadata: JSON.stringify({ reason: "stale-slot-reconciled", childDisposition: "publication_failure" }),
      error: "synthetic failure",
      productivity: { productive: false, reason: "platform-abandoned" },
    });

    await expect(
      logCronRun(db, "sync-dex-liquidity", async () => ({ status: "ok", itemCount: 31 }), undefined, {
        slotStartedAt,
        producer: {
          scheduleKey: "halfHourlyOffset",
          producerPath: "halfHourlyOffset",
          producerKind: "scheduled-job",
          invocationId: "shared-late-invocation",
          workerVersion: "worker-version",
          slotStartedAt,
        },
      }),
    ).resolves.toMatchObject({ status: "ok", itemCount: 31 });

    expect(
      sqlite
        .prepare(
          `SELECT status, error, item_count, idempotency_key
         FROM cron_runs
        WHERE job = 'sync-dex-liquidity'`,
        )
        .all(),
    ).toEqual([
      {
        status: "ok",
        error: null,
        item_count: 31,
        idempotency_key: expect.stringMatching(/^cron-run:sync-dex-liquidity:/),
      },
    ]);
    expect(
      sqlite
        .prepare(
          `SELECT idempotency_key, outcome, productive, item_count, error
         FROM worker_producer_history
        WHERE schedule_key = 'halfHourlyOffset' AND job = 'sync-dex-liquidity'`,
        )
        .all(),
    ).toEqual([
      {
        idempotency_key: expect.stringMatching(/^cron-run:sync-dex-liquidity:/),
        outcome: "ok",
        productive: 1,
        item_count: 31,
        error: null,
      },
    ]);
    expect(
      sqlite
        .prepare(
          `SELECT last_outcome, invocation_count, productive_count
         FROM worker_producer_heads
        WHERE schedule_key = 'halfHourlyOffset' AND job = 'sync-dex-liquidity'`,
        )
        .get(),
    ).toEqual({ last_outcome: "ok", invocation_count: 1, productive_count: 1 });
    sqlite.close();
  });
});
