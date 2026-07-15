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
});
