import { describe, expect, it } from "vitest";
import { ARCHIVE_TABLES_WITHOUT_RETENTION_PRUNE, runPruneCronHistory } from "../prune-cron-history";
import { createLatestSchemaSqlite } from "../../test-helpers/latest-schema-sqlite";
import { createSqliteD1 } from "../../test-helpers/sqlite-d1";

function createTestDb() {
  const { sqlite } = createLatestSchemaSqlite();
  const preparedSqls: string[] = [];
  const sqliteDb = createSqliteD1(sqlite);
  const db = {
    ...sqliteDb,
    prepare: (sql: string) => {
      preparedSqls.push(sql);
      return sqliteDb.prepare(sql);
    },
  } as D1Database;
  return { db, preparedSqls, sqlite };
}

function insert(sqlite: import("node:sqlite").DatabaseSync, sql: string, ...values: unknown[]): void {
  sqlite.prepare(sql).run(...(values as never[]));
}

function select<T>(sqlite: import("node:sqlite").DatabaseSync, sql: string): T[] {
  return sqlite.prepare(sql).all() as T[];
}

const ONE_WEEK_SEC = 7 * 24 * 60 * 60;
const TWO_DAYS_SEC = 2 * 24 * 60 * 60;
const TWO_WEEKS_SEC = 14 * 24 * 60 * 60;
const NINETY_DAYS_SEC = 90 * 24 * 60 * 60;

function toUtcDateString(timestampSec: number): string {
  return new Date(timestampSec * 1000).toISOString().slice(0, 10);
}

describe("runPruneCronHistory", () => {
  it("throws before D1 work when the cron signal is already aborted", async () => {
    const { db } = createTestDb();
    const controller = new AbortController();
    controller.abort(new Error("cron history prune aborted"));

    await expect(runPruneCronHistory(db, controller.signal)).rejects.toThrow("cron history prune aborted");
  });

  it("removes cron_runs older than 7 days and keeps newer rows", async () => {
    const { db, sqlite } = createTestDb();
    const now = Math.floor(Date.now() / 1000);
    insert(sqlite, "INSERT INTO cron_runs (job, started_at, duration_ms, status) VALUES (?, ?, ?, ?)", "sync-stablecoins", now - ONE_WEEK_SEC - 3600, 1, "ok");
    insert(sqlite, "INSERT INTO cron_runs (job, started_at, duration_ms, status) VALUES (?, ?, ?, ?)", "sync-stablecoins", now - 3600, 1, "ok");

    const result = await runPruneCronHistory(db);

    expect(select<{ started_at: number }>(sqlite, "SELECT started_at FROM cron_runs")).toEqual([{ started_at: now - 3600 }]);
    expect(result.itemCount).toBe(1);
    expect(result.status).toBe("ok");
  });

  it("removes cron_slot_executions older than 14 days and keeps newer rows", async () => {
    const { db, sqlite } = createTestDb();
    const now = Math.floor(Date.now() / 1000);
    insert(sqlite, "INSERT INTO cron_slot_executions (slot_key, slot_started_at, state, execution_owner, started_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)", "quarterHourly", now - TWO_WEEKS_SEC - 3600, "finished", "test", now, now);
    insert(sqlite, "INSERT INTO cron_slot_executions (slot_key, slot_started_at, state, execution_owner, started_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)", "quarterHourly", now - 3600, "finished", "test", now, now);

    await runPruneCronHistory(db);

    expect(select<{ slot_started_at: number }>(sqlite, "SELECT slot_started_at FROM cron_slot_executions")).toEqual([{ slot_started_at: now - 3600 }]);
  });

  it("removes terminal repair tasks older than 7 days and keeps active or newer rows", async () => {
    const { db, sqlite } = createTestDb();
    const now = Math.floor(Date.now() / 1000);
    insert(sqlite, "INSERT INTO worker_repair_tasks (task_id, kind, subject_id, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)", "closed", "test", "closed", "closed", now, now - ONE_WEEK_SEC - 3600);
    insert(sqlite, "INSERT INTO worker_repair_tasks (task_id, kind, subject_id, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)", "open", "test", "open", "open", now, now - ONE_WEEK_SEC - 3600);
    insert(sqlite, "INSERT INTO worker_repair_tasks (task_id, kind, subject_id, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)", "cancelled", "test", "cancelled", "cancelled", now, now - 3600);

    const result = await runPruneCronHistory(db);

    expect(select<{ state: string; updated_at: number }>(sqlite, "SELECT state, updated_at FROM worker_repair_tasks ORDER BY task_id")).toEqual([
      { state: "cancelled", updated_at: now - 3600 },
      { state: "open", updated_at: now - ONE_WEEK_SEC - 3600 },
    ]);
    const metadata = JSON.parse(result.metadata!) as { repairTasksDeleted: number };
    expect(metadata.repairTasksDeleted).toBe(1);
  });

  it("removes worker_canary_runs older than 90 days and keeps newer rows", async () => {
    const { db, sqlite } = createTestDb();
    const now = Math.floor(Date.now() / 1000);
    insert(sqlite, "INSERT INTO worker_canary_runs (id, check_id, idempotency_key, status, severity, observed_at) VALUES (?, ?, ?, ?, ?, ?)", "old", "test", "old", "ok", "info", now - NINETY_DAYS_SEC - 3600);
    insert(sqlite, "INSERT INTO worker_canary_runs (id, check_id, idempotency_key, status, severity, observed_at) VALUES (?, ?, ?, ?, ?, ?)", "new", "test", "new", "ok", "info", now - 3600);

    const result = await runPruneCronHistory(db);

    expect(select<{ observed_at: number }>(sqlite, "SELECT observed_at FROM worker_canary_runs")).toEqual([{ observed_at: now - 3600 }]);
    const metadata = JSON.parse(result.metadata!) as { canaryRunsDeleted: number };
    expect(metadata.canaryRunsDeleted).toBe(1);
  });

  it("removes terminal recovery checkpoints older than 14 days without deleting recoverable work", async () => {
    const { db, sqlite } = createTestDb();
    const now = Math.floor(Date.now() / 1000);
    const checkpoint = "INSERT INTO worker_scheduled_checkpoints (schedule_key, slot_started_at, job, attempt_no, invocation_id, queue_hash, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)";
    insert(sqlite, checkpoint, "test", now, "completed", 1, "completed", "hash", "completed", now, now - TWO_WEEKS_SEC - 3600);
    insert(sqlite, checkpoint, "test", now + 1, "platform_abandoned", 1, "platform_abandoned", "hash", "platform_abandoned", now, now - TWO_WEEKS_SEC - 3600);
    insert(sqlite, checkpoint, "test", now + 2, "ready", 1, "ready", "hash", "ready", now, now - TWO_WEEKS_SEC - 3600);
    insert(sqlite, checkpoint, "test", now + 3, "failed", 1, "failed", "hash", "failed", now, now - 3600);

    const result = await runPruneCronHistory(db);

    expect(select<{ state: string; updated_at: number }>(sqlite, "SELECT state, updated_at FROM worker_scheduled_checkpoints ORDER BY slot_started_at")).toEqual([
      { state: "ready", updated_at: now - TWO_WEEKS_SEC - 3600 },
      { state: "failed", updated_at: now - 3600 },
    ]);
    const metadata = JSON.parse(result.metadata!) as { recoveryCheckpointsDeleted: number };
    expect(metadata.recoveryCheckpointsDeleted).toBe(2);
  });

  it("removes selector snapshot daily quota rows older than 2 days and keeps newer rows", async () => {
    const { db, sqlite } = createTestDb();
    const now = Math.floor(Date.now() / 1000);
    const quota = "INSERT INTO selector_snapshot_daily_quota (quota_date, ip_hash, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?)";
    insert(sqlite, quota, toUtcDateString(now - TWO_DAYS_SEC - 24 * 60 * 60), "old", now, now);
    insert(sqlite, quota, toUtcDateString(now - 3600), "new", now, now);

    const result = await runPruneCronHistory(db);

    expect(select<{ quota_date: string }>(sqlite, "SELECT quota_date FROM selector_snapshot_daily_quota")).toEqual([{ quota_date: toUtcDateString(now - 3600) }]);
    const metadata = JSON.parse(result.metadata!) as { selectorSnapshotDailyQuotaDeleted: number };
    expect(metadata.selectorSnapshotDailyQuotaDeleted).toBe(1);
  });

  it("removes block timestamp cache rows older than 14 days and keeps newer rows", async () => {
    const { db, sqlite } = createTestDb();
    const now = Math.floor(Date.now() / 1000);
    insert(sqlite, "INSERT INTO block_timestamp_cache (chain_id, block_number, timestamp, updated_at) VALUES (?, ?, ?, ?)", "ethereum", 1, now, now - TWO_WEEKS_SEC - 3600);
    insert(sqlite, "INSERT INTO block_timestamp_cache (chain_id, block_number, timestamp, updated_at) VALUES (?, ?, ?, ?)", "ethereum", 2, now, now - 3600);

    const result = await runPruneCronHistory(db);

    expect(select<{ updated_at: number }>(sqlite, "SELECT updated_at FROM block_timestamp_cache")).toEqual([{ updated_at: now - 3600 }]);
    const metadata = JSON.parse(result.metadata!) as { blockTimestampCacheDeleted: number };
    expect(metadata.blockTimestampCacheDeleted).toBe(1);
  });

  it("does not prune explicit append-only archive tables", async () => {
    const { db, preparedSqls } = createTestDb();

    await runPruneCronHistory(db);

    const deleteSqls = preparedSqls.filter((sql) => /\bDELETE\s+FROM\b/i.test(sql));
    for (const { table } of ARCHIVE_TABLES_WITHOUT_RETENTION_PRUNE) {
      expect(deleteSqls.some((sql) => sql.toLowerCase().includes(`delete from ${table.toLowerCase()}`))).toBe(false);
    }
  });

  it("reports all deleted counts in metadata", async () => {
    const { db, sqlite } = createTestDb();
    const now = Math.floor(Date.now() / 1000);
    insert(sqlite, "INSERT INTO cron_runs (job, started_at, duration_ms, status) VALUES (?, ?, ?, ?)", "sync-stablecoins", now - ONE_WEEK_SEC - 1, 1, "ok");
    insert(sqlite, "INSERT INTO worker_repair_tasks (task_id, kind, subject_id, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)", "closed", "test", "closed", "closed", now, now - ONE_WEEK_SEC - 1);
    insert(sqlite, "INSERT INTO worker_canary_runs (id, check_id, idempotency_key, status, severity, observed_at) VALUES (?, ?, ?, ?, ?, ?)", "old", "test", "old", "ok", "info", now - NINETY_DAYS_SEC - 1);
    const checkpoint = "INSERT INTO worker_scheduled_checkpoints (schedule_key, slot_started_at, job, attempt_no, invocation_id, queue_hash, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)";
    insert(sqlite, checkpoint, "test", now, "completed", 1, "completed", "hash", "completed", now, now - TWO_WEEKS_SEC - 1);
    insert(sqlite, "INSERT INTO selector_snapshot_daily_quota (quota_date, ip_hash, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?)", toUtcDateString(now - TWO_DAYS_SEC - 24 * 60 * 60), "test", now, now);
    insert(sqlite, "INSERT INTO block_timestamp_cache (chain_id, block_number, timestamp, updated_at) VALUES (?, ?, ?, ?)", "ethereum", 1, now, now - TWO_WEEKS_SEC - 1);
    insert(sqlite, "INSERT INTO cron_slot_executions (slot_key, slot_started_at, state, execution_owner, started_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)", "quarterHourly", now - TWO_WEEKS_SEC - 1, "finished", "test", now, now - TWO_WEEKS_SEC - 1);

    const result = await runPruneCronHistory(db);
    const metadata = JSON.parse(result.metadata!) as {
      cronRunsDeleted: number;
      repairTasksDeleted: number;
      canaryRunsDeleted: number;
      recoveryCheckpointsDeleted: number;
      selectorSnapshotDailyQuotaDeleted: number;
      blockTimestampCacheDeleted: number;
      slotExecutionsDeleted: number;
      cutoffCronRunsSec: number;
      cutoffRepairTasksSec: number;
      cutoffCanaryRunsSec: number;
      cutoffRecoveryCheckpointsSec: number;
      cutoffSelectorSnapshotDailyQuotaDate: string;
      cutoffBlockTimestampCacheSec: number;
      cutoffSlotExecutionsSec: number;
    };

    expect(metadata.cronRunsDeleted).toBe(1);
    expect(metadata.repairTasksDeleted).toBe(1);
    expect(metadata.canaryRunsDeleted).toBe(1);
    expect(metadata.recoveryCheckpointsDeleted).toBe(1);
    expect(metadata.selectorSnapshotDailyQuotaDeleted).toBe(1);
    expect(metadata.blockTimestampCacheDeleted).toBe(1);
    expect(metadata.slotExecutionsDeleted).toBe(1);
    expect(metadata.cutoffCronRunsSec).toBeCloseTo(now - ONE_WEEK_SEC, -2);
    expect(metadata.cutoffRepairTasksSec).toBeCloseTo(now - ONE_WEEK_SEC, -2);
    expect(metadata.cutoffCanaryRunsSec).toBeCloseTo(now - NINETY_DAYS_SEC, -2);
    expect(metadata.cutoffRecoveryCheckpointsSec).toBeCloseTo(now - TWO_WEEKS_SEC, -2);
    expect(metadata.cutoffSelectorSnapshotDailyQuotaDate).toBe(toUtcDateString(now - TWO_DAYS_SEC));
    expect(metadata.cutoffBlockTimestampCacheSec).toBeCloseTo(now - TWO_WEEKS_SEC, -2);
    expect(metadata.cutoffSlotExecutionsSec).toBeCloseTo(now - TWO_WEEKS_SEC, -2);
  });

  it("returns ok with zero counts when no rows are past either cutoff", async () => {
    const { db, sqlite } = createTestDb();
    const now = Math.floor(Date.now() / 1000);
    // Only fresh rows — neither DELETE should match anything.
    insert(sqlite, "INSERT INTO cron_runs (job, started_at, duration_ms, status) VALUES (?, ?, ?, ?)", "sync-stablecoins", now - 3600, 1, "ok");
    insert(sqlite, "INSERT INTO cron_slot_executions (slot_key, slot_started_at, state, execution_owner, started_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)", "quarterHourly", now - 3600, "finished", "test", now, now - 3600);

    const result = await runPruneCronHistory(db);

    expect(result.status).toBe("ok");
    expect(result.itemCount).toBe(0);
    const metadata = JSON.parse(result.metadata!) as {
      cronRunsDeleted: number;
      slotExecutionsDeleted: number;
    };
    expect(metadata.cronRunsDeleted).toBe(0);
    expect(metadata.slotExecutionsDeleted).toBe(0);
    // Fresh rows must survive.
    expect(select(sqlite, "SELECT * FROM cron_runs")).toHaveLength(1);
    expect(select(sqlite, "SELECT * FROM cron_slot_executions")).toHaveLength(1);
  });
});
