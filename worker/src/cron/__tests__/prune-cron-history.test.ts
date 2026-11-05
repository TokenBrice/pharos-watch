import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runPruneCronHistory } from "../prune-cron-history";
import { pruneStatusProbeRuns, runPruneStatusProbeRuns } from "../prune-status-probe-runs";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import { WORKER_CANARY_RUN_RETENTION_SEC } from "@shared/lib/retention-policy";
import { SAFETY_SCORE_CAPTURE_ARCHIVE_RETENTION_SEC } from "@shared/lib/safety-score-capture-archive";

const fixtures = createLatestSchemaFixtureTracker();
const createTestDb = fixtures.open;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-06-03T12:00:00Z"));
});
afterEach(() => {
  fixtures.closeAll();
  vi.useRealTimers();
});

function insert(sqlite: DatabaseSync, sql: string, ...values: unknown[]): void {
  sqlite.prepare(sql).run(...(values as never[]));
}

function select<T>(sqlite: DatabaseSync, sql: string): T[] {
  return sqlite.prepare(sql).all() as T[];
}

const ONE_WEEK_SEC = 7 * 24 * 60 * 60;
const TWO_DAYS_SEC = 2 * 24 * 60 * 60;
const TWO_WEEKS_SEC = 14 * 24 * 60 * 60;
const THIRTY_FIVE_DAYS_SEC = 35 * 24 * 60 * 60;

function toUtcDateString(timestampSec: number): string {
  return new Date(timestampSec * 1000).toISOString().slice(0, 10);
}

describe("runPruneCronHistory", () => {
  it("isolates history groups and reports every cap", async () => {
    const { db } = createTestDb();
    const batch = vi.spyOn(db, "batch");
    const log = vi.spyOn(console, "info").mockImplementation(() => {});
    const result = await runPruneCronHistory(db);
    expect(batch).toHaveBeenCalledTimes(6);
    expect(log.mock.calls.slice(0, 2).map(([, detail]) => JSON.parse(detail).completed.map(({ key }: { key: string }) => key)))
      .toEqual([["cronRuns"], ["producerHistory"]]);
    const metadata = JSON.parse(result.metadata!);
    expect(Object.keys(metadata.retentionTruncated)).toEqual(expect.arrayContaining([
      "cronRuns", "producerHistory", "repairTasks", "canaryRuns", "recoveryCheckpoints",
      "selectorSnapshotDailyQuota", "blockTimestampCache", "slotExecutions", "reserveContinuationExecutions",
      "apiRequestConsumerStats", "siteDataRequestStats", "apiKeyRequestStats",
      "apiRequestSourceSamples", "siteDataRequestSamples",
      "safetyScoreJournal", "safetyScoreAttempts", "safetyScoreCaptureArchive",
      "selfServeRequestRateLimits", "selfServeIssuanceRateLimits",
    ]));
    expect(Object.values(metadata.retentionTruncated).every((flag) => flag === false)).toBe(true);
  });

  it("retains producer boundaries and counters across slices", async () => {
    const { db, sqlite } = createTestDb();
    const now = Math.floor(Date.now() / 1000);
    const row = `INSERT INTO worker_producer_history
      (idempotency_key, schedule_key, job, producer_path, producer_kind, invocation_id,
       invoked_at, completed_at, outcome, productive, calendar_period, created_at)`;
    sqlite.prepare(`WITH RECURSIVE n(id) AS (SELECT 1 UNION ALL SELECT id + 1 FROM n WHERE id < 10001)
      ${row} SELECT 'old-' || id, 's', 'j', 'p', 'scheduled-job', 'old-' || id, 1, ?, 'ok', id % 2, NULL, 1 FROM n`)
      .run(now - 31 * 86400);
    for (const [days, kind, calendar] of [[30, "scheduled-job", null], [90, "budget-only", null], [550, "budget-only", "2024-01"]] as const) {
      for (const offset of [-1, 0, 1]) {
        const id = `${days}/${offset}`;
        insert(sqlite, `${row} VALUES (?, 's', 'j', 'p', ?, ?, 1, ?, 'ok', 1, ?, 1)`, id, kind, id, now - days * 86400 + offset, calendar);
      }
    }
    const result = await runPruneCronHistory(db);
    expect(result.itemCount).toBe(10004);
    expect(JSON.parse(result.metadata!).producerHistoryDeleted).toBe(10004);
    expect(select(sqlite, "SELECT idempotency_key AS id FROM worker_producer_history ORDER BY id")).toEqual(
      ["30/0", "30/1", "550/0", "550/1", "90/0", "90/1"].map((id) => ({ id })),
    );
    expect(select(sqlite, "SELECT producer_kind, invocation_count, productive_count FROM worker_producer_retained_counts ORDER BY producer_kind"))
      .toEqual(select(sqlite, `SELECT producer_kind, COUNT(*) AS invocation_count, SUM(productive) AS productive_count
        FROM worker_producer_history GROUP BY producer_kind ORDER BY producer_kind`));
  });

  it.each([
    ["api_request_source_samples", "apiRequestSourceSamples", "'public-api', 'external', 'unkeyed', 64, 1"],
    ["site_data_request_samples", "siteDataRequestSamples", "'pages-upstream-fetch', 'site-api', 64, 1"],
  ])("bounds the 35-day sampled drain for %s and retains its exact cutoff", async (table, key, dimensions) => {
    const { db, sqlite } = createTestDb();
    const cutoff = Math.floor(Date.now() / 1000) - THIRTY_FIVE_DAYS_SEC;
    sqlite.prepare(`WITH RECURSIVE n(id) AS (SELECT 1 UNION ALL SELECT id + 1 FROM n WHERE id < 20001)
      INSERT INTO ${table} SELECT ?, printf('route-%06d', id), '/api/test', ${dimensions} FROM n`).run(cutoff - 1);
    sqlite.prepare(`INSERT INTO ${table} VALUES (?, 'boundary', '/api/test', ${dimensions})`).run(cutoff);
    const result = await runPruneCronHistory(db);
    expect(JSON.parse(result.metadata!)).toMatchObject({
      [`${key}Deleted`]: 20_000,
      cutoffRequestTelemetrySec: cutoff,
      retentionTruncated: { [key]: true },
      requestTelemetryCappedAtLimit: { [key]: true },
    });
    expect(sqlite.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE bucket_start < ?`).get(cutoff)).toEqual({ count: 1 });
    expect(sqlite.prepare(`SELECT route_key FROM ${table} WHERE bucket_start = ?`).all(cutoff)).toEqual([{ route_key: "boundary" }]);
  });

  it("prunes only expired finished Queue executions and cascades their child attempts", async () => {
    const { db, sqlite } = createTestDb();
    const now = Math.floor(Date.now() / 1000);
    const cutoff = now - TWO_WEEKS_SEC;
    const executions = [
      ["expired", "finished", cutoff - 1],
      ["boundary", "finished", cutoff],
      ["recent", "finished", now],
      ["running", "running", null],
      ["reconciling", "reconciling", null],
    ] as const;
    for (const [id, state, finishedAt] of executions) {
      insert(sqlite, `INSERT INTO reserve_continuation_executions
        (delivery_id, schedule_key, slot_started_at, attempt_no, checkpoint_generation, queue_hash,
         items_done, phase, source_invocation_id, execution_owner, execution_generation, invocation_id,
         state, started_at, updated_at, deadline_ms, finished_at)
        VALUES (?, 'fourHourlyReserveSync', ?, 1, 1, 'hash', 1, 'reserve', 'head', ?, 1, ?, ?, ?, ?, ?, ?)`,
      id, cutoff - 100, id, id, state, cutoff - 100, cutoff - 100, (cutoff - 1) * 1000, finishedAt);
      insert(sqlite, `INSERT INTO reserve_continuation_child_attempts
        (attempt_key, delivery_id, schedule_key, slot_started_at, job, producer_path, producer_kind,
         invocation_id, attempt_no, execution_schedule_key, execution_slot_started_at,
         execution_invocation_id, execution_generation, execution_owner)
        VALUES (?, ?, 'fourHourlyReserveSync', ?, 'sync-live-reserves', 'fourHourlyReserveSync',
          'queue-recovery', ?, 1, 'fourHourlyReserveSync', ?, ?, 1, ?)`,
      id, id, cutoff - 100, id, cutoff - 100, id, id);
    }

    const result = await runPruneCronHistory(db);
    const retained = [{ id: "boundary" }, { id: "recent" }, { id: "reconciling" }, { id: "running" }];
    expect(select(sqlite, "SELECT delivery_id AS id FROM reserve_continuation_executions ORDER BY delivery_id")).toEqual(retained);
    expect(select(sqlite, "SELECT attempt_key AS id FROM reserve_continuation_child_attempts ORDER BY attempt_key")).toEqual(retained);
    expect(result.itemCount).toBe(1);
    expect(JSON.parse(result.metadata!)).toMatchObject({
      retentionTruncated: { reserveContinuationExecutions: false },
    });
  });

  it("surfaces a missing repair table rather than treating the failed batch as empty", async () => {
    const { db, sqlite } = createTestDb();
    sqlite.exec("DROP TABLE worker_repair_tasks");
    await expect(runPruneCronHistory(db)).rejects.toThrow("worker_repair_tasks");
  });

  it("preserves the smaller repair-task ceiling and leaves failed tasks untouched", async () => {
    const { db, sqlite } = createTestDb();
    const now = Math.floor(Date.now() / 1000);
    sqlite.prepare(`WITH RECURSIVE n(id) AS (SELECT 1 UNION ALL SELECT id + 1 FROM n WHERE id < 50000)
      INSERT INTO worker_repair_tasks (task_id, kind, subject_id, state, created_at, updated_at)
      SELECT 'repair-' || id, 'test', CAST(id AS TEXT), 'closed', ?, ? FROM n`).run(now, now - ONE_WEEK_SEC - 1);
    insert(sqlite, "INSERT INTO worker_repair_tasks (task_id, kind, subject_id, state, created_at, updated_at) VALUES ('failed', 'test', 'failed', 'failed', ?, ?)", now, now - ONE_WEEK_SEC - 1);
    const result = await runPruneCronHistory(db);
    expect(JSON.parse(result.metadata!)).toMatchObject({ repairTasksDeleted: 20_000, retentionTruncated: { repairTasks: true } });
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM worker_repair_tasks").get()).toEqual({ count: 30_001 });
  });

  it.each([
    { requestRows: 25_001, issuanceRows: 0, deleted: 25_001, requestsLeft: 0, issuanceLeft: 0, truncated: false },
    { requestRows: 30_000, issuanceRows: 70_001, deleted: 100_000, requestsLeft: 0, issuanceLeft: 1, truncated: true },
    { requestRows: 100_001, issuanceRows: 1, deleted: 100_000, requestsLeft: 1, issuanceLeft: 1, truncated: true },
  ])("preserves the 100k shared self-serve ceiling and request-table priority ($requestRows/$issuanceRows)", async ({
    requestRows, issuanceRows, deleted, requestsLeft, issuanceLeft, truncated,
  }) => {
    const { db, sqlite } = createTestDb();
    const now = Math.floor(Date.now() / 1000);
    const cutoff = now - TWO_DAYS_SEC;
    const tables = [
      ["api_key_request_rate_limit_v2", "submission_ip", "last_seen_at", requestRows, requestsLeft],
      ["api_key_self_serve_issuance_limits", "submission_ip_daily", "updated_at", issuanceRows, issuanceLeft],
    ] as const;
    for (const [table, scope, clock, count] of tables) {
      if (count > 0) sqlite.prepare(`WITH RECURSIVE n(id) AS (SELECT 1 UNION ALL SELECT id + 1 FROM n WHERE id < ?)
        INSERT INTO ${table} (scope, subject_hash, bucket_start, ${clock})
        SELECT ?, printf('subject-%06d', id), ?, ? FROM n`).run(count, scope, cutoff - 1, now);
      insert(sqlite, `INSERT INTO ${table} (scope, subject_hash, bucket_start, ${clock}) VALUES (?, 'boundary', ?, ?)`, scope, cutoff, now);
    }

    const result = await runPruneCronHistory(db);
    expect(JSON.parse(result.metadata!)).toMatchObject({
      selfServeRateLimitsDeleted: deleted,
      retentionTruncated: { selfServeRateLimits: truncated },
    });
    for (const [table, , , , count] of tables) {
      expect(sqlite.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE bucket_start < ?`).get(cutoff)).toEqual({ count });
      expect(sqlite.prepare(`SELECT subject_hash FROM ${table} WHERE bucket_start = ?`).all(cutoff)).toEqual([{ subject_hash: "boundary" }]);
    }
  });

  it("throws before D1 work when the cron signal is already aborted", async () => {
    const { db } = createTestDb();
    const controller = new AbortController();
    controller.abort(new Error("cron history prune aborted"));

    await expect(runPruneCronHistory(db, controller.signal)).rejects.toThrow("cron history prune aborted");
  });

  it("prunes both Safety evidence stores at 120 days while retaining the exact boundary", async () => {
    const { db, sqlite } = createTestDb();
    const now = Math.floor(Date.now() / 1000);
    const cutoff = now - 120 * 86_400;
    for (const [id, clock] of [["old", cutoff - 1], ["boundary", cutoff]] as const) {
      insert(sqlite, `INSERT INTO safety_score_publication_journal
        (generation_id, stablecoin_id, published_at, methodology_version, policy_digest, evaluation_build_digest, compact_digest, compact_json, input_lineage_json)
        VALUES (?, 'coin', ?, '10.12', 'policy', 'build', 'digest', '{}', '{}')`, id, clock);
      insert(sqlite, `INSERT INTO safety_score_publication_attempts
        (attempt_id, generation_id, attempted_at, published_at, outcome, hold_reason_codes_json, methodology_version, policy_digest, evaluation_build_digest, input_lineage_json)
        VALUES (?, ?, ?, ?, 'held', '["dex-stale"]', '10.12', 'policy', 'build', '{}')`, id, id, clock, clock);
    }
    const result = await runPruneCronHistory(db);
    expect(sqlite.prepare("SELECT generation_id FROM safety_score_publication_journal").all()).toEqual([{ generation_id: "boundary" }]);
    expect(sqlite.prepare("SELECT attempt_id FROM safety_score_publication_attempts").all()).toEqual([{ attempt_id: "boundary" }]);
    expect(JSON.parse(result.metadata!)).toMatchObject({
      safetyScoreJournalDeleted: 1, safetyScoreAttemptsDeleted: 1, cutoffSafetyScoreJournalSec: cutoff,
      safetyScoreJournalCappedAtLimit: false, safetyScoreAttemptsCappedAtLimit: false,
    });
  });

  it("prunes only the 180-day archive index expiry and retains every newer generation", async () => {
    const { db, sqlite } = createTestDb();
    const now = Math.floor(Date.now() / 1000);
    const cutoff = now - SAFETY_SCORE_CAPTURE_ARCHIVE_RETENTION_SEC;
    const rows = [["expired", cutoff - 1], ["boundary", cutoff], ["recent-1", now - 100], ["recent-2", now - 99]] as const;
    for (const [id, clock] of rows) {
      insert(sqlite, `INSERT INTO safety_score_capture_archive
        (generation_id, published_at, methodology_version, policy_digest, evaluation_build_digest,
         r2_key, object_sha256, object_bytes, archived_at)
        VALUES (?, ?, '10.12', 'policy', 'build', ?, 'digest', 123, ?)`, id, clock, `captures/${id}`, now);
    }
    const result = await runPruneCronHistory(db);
    expect(sqlite.prepare("SELECT generation_id FROM safety_score_capture_archive ORDER BY published_at").all())
      .toEqual([{ generation_id: "boundary" }, { generation_id: "recent-1" }, { generation_id: "recent-2" }]);
    expect(result.itemCount).toBe(1);
    expect(JSON.parse(result.metadata!)).toMatchObject({
      safetyScoreCaptureArchiveDeleted: 1, safetyScoreCaptureArchiveCappedAtLimit: false,
      cutoffSafetyScoreCaptureArchiveSec: cutoff,
    });
  });

  it("caps archive-index expiry at 100,000 rows and reports the remaining backlog", async () => {
    const { db, sqlite } = createTestDb();
    const now = Math.floor(Date.now() / 1000);
    const cutoff = now - SAFETY_SCORE_CAPTURE_ARCHIVE_RETENTION_SEC;
    sqlite.prepare(`WITH RECURSIVE n(id) AS (SELECT 1 UNION ALL SELECT id + 1 FROM n WHERE id < 100001)
      INSERT INTO safety_score_capture_archive
        (generation_id, published_at, methodology_version, policy_digest, evaluation_build_digest,
         r2_key, object_sha256, object_bytes, archived_at)
      SELECT printf('generation-%06d', id), ?, '10.12', 'policy', 'build',
        printf('captures/%d', id), 'digest', 123, ? FROM n`).run(cutoff - 1, now);
    const result = await runPruneCronHistory(db);
    expect(result.itemCount).toBe(100_000);
    expect(JSON.parse(result.metadata!)).toMatchObject({
      safetyScoreCaptureArchiveDeleted: 100_000, safetyScoreCaptureArchiveCappedAtLimit: true,
    });
    expect(sqlite.prepare("SELECT generation_id FROM safety_score_capture_archive").all())
      .toEqual([{ generation_id: "generation-100001" }]);
  });

  it("caps the cron_runs backlog at 100,000 rows, deletes oldest first, and flags truncation", async () => {
    const { db, sqlite } = createTestDb();
    const now = Math.floor(Date.now() / 1000);
    const cutoff = now - ONE_WEEK_SEC;
    sqlite.prepare(`WITH RECURSIVE n(id) AS (SELECT 1 UNION ALL SELECT id + 1 FROM n WHERE id < 100001)
      INSERT INTO cron_runs (job, started_at, duration_ms, status)
      SELECT 'sync-stablecoins', ? - id, 1, 'ok' FROM n`).run(cutoff);

    const result = await runPruneCronHistory(db);

    expect(select<{ started_at: number }>(sqlite, "SELECT started_at FROM cron_runs")).toEqual([
      { started_at: cutoff - 1 },
    ]);
    expect(result.itemCount).toBe(100_000);
    expect(JSON.parse(result.metadata!)).toMatchObject({
      cronRunsDeleted: 100_000,
      retentionTruncated: {
        cronRuns: true,
        blockTimestampCache: false,
        slotExecutions: false,
        producerHistory: false,
        repairTasks: false,
        canaryRuns: false,
        recoveryCheckpoints: false,
        selfServeRateLimits: false,
      },
    });
  });

  it.each([
    {
      label: "removes cron_runs older than 7 days and keeps newer rows",
      seed: (sqlite: DatabaseSync, now: number) => {
        for (const offset of [-1, 0]) insert(sqlite,
          "INSERT INTO cron_runs (job, started_at, duration_ms, status) VALUES ('sync-stablecoins', ?, 1, 'ok')", now - ONE_WEEK_SEC + offset);
      },
      remaining: (sqlite: DatabaseSync) => select<{ started_at: number }>(sqlite, "SELECT started_at FROM cron_runs"),
      expected: (now: number) => [{ started_at: now - ONE_WEEK_SEC }],
      deletedKey: "cronRunsDeleted",
      cutoffKey: "cutoffCronRunsSec",
      cutoff: (now: number) => now - ONE_WEEK_SEC,
    },
    {
      label: "removes cron_slot_executions older than 14 days and keeps newer rows",
      seed: (sqlite: DatabaseSync, now: number) => {
        for (const age of [TWO_WEEKS_SEC + 3600, 3600]) insert(sqlite,
          "INSERT INTO cron_slot_executions (slot_key, slot_started_at, state, execution_owner, started_at, updated_at) VALUES ('quarterHourly', ?, 'finished', 'test', ?, ?)", now - age, now, now);
      },
      remaining: (sqlite: DatabaseSync) => select<{ slot_started_at: number }>(sqlite, "SELECT slot_started_at FROM cron_slot_executions"),
      expected: (now: number) => [{ slot_started_at: now - 3600 }],
      deletedKey: "slotExecutionsDeleted",
      cutoffKey: "cutoffSlotExecutionsSec",
      cutoff: (now: number) => now - TWO_WEEKS_SEC,
    },
    {
      label: "removes selector snapshot daily quota rows older than 2 days and keeps newer rows",
      seed: (sqlite: DatabaseSync, now: number) => {
        const quota = "INSERT INTO selector_snapshot_daily_quota (quota_date, ip_hash, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?)";
        insert(sqlite, quota, toUtcDateString(now - TWO_DAYS_SEC - 24 * 60 * 60), "old", now, now);
        insert(sqlite, quota, toUtcDateString(now - 3600), "new", now, now);
      },
      remaining: (sqlite: DatabaseSync) => select<{ quota_date: string }>(sqlite, "SELECT quota_date FROM selector_snapshot_daily_quota"),
      expected: (now: number) => [{ quota_date: toUtcDateString(now - 3600) }],
      deletedKey: "selectorSnapshotDailyQuotaDeleted",
      cutoffKey: "cutoffSelectorSnapshotDailyQuotaDate",
      cutoff: (now: number) => toUtcDateString(now - TWO_DAYS_SEC),
    },
    {
      label: "removes block timestamp cache rows older than 14 days and keeps newer rows",
      seed: (sqlite: DatabaseSync, now: number) => {
        for (const [block, age] of [[1, TWO_WEEKS_SEC + 3600], [2, 3600]]) insert(sqlite,
          "INSERT INTO block_timestamp_cache (chain_id, block_number, timestamp, updated_at) VALUES ('ethereum', ?, ?, ?)", block, now, now - age);
      },
      remaining: (sqlite: DatabaseSync) => select<{ updated_at: number }>(sqlite, "SELECT updated_at FROM block_timestamp_cache"),
      expected: (now: number) => [{ updated_at: now - 3600 }],
      deletedKey: "blockTimestampCacheDeleted",
      cutoffKey: "cutoffBlockTimestampCacheSec",
      cutoff: (now: number) => now - TWO_WEEKS_SEC,
    },
    ...[
      ["Worker", "api_request_consumer_stats", "apiRequestConsumerStatsDeleted", "lane, consumer_class", "'public-api', 'external'"],
      ["Pages", "site_data_request_stats", "siteDataRequestStatsDeleted", "delivery_path, upstream_lane", "'pages-cache-hit', ''"],
      ["per-key", "api_key_request_stats", "apiKeyRequestStatsDeleted", "api_key_id", "1"],
    ].map(([label, table, deletedKey, columns, dimensions]) => ({
      label: `removes ${label} request attribution older than 35 days and reports the count`,
      seed: (sqlite: DatabaseSync, now: number) => {
        const extra = label === "per-key" ? "" : ", route_key, route_path";
        const row = `INSERT INTO ${table} (bucket_start${extra}, ${columns}, request_count)
          VALUES (?${extra ? ", ?, ?" : ""}, ${dimensions}, 1)`;
        for (const [offset, id] of [[-1, "old"], [0, "boundary"]] as const) {
          insert(sqlite, row, now - THIRTY_FIVE_DAYS_SEC + offset, ...(extra ? [id, `/api/${id}`] : []));
        }
      },
      remaining: (sqlite: DatabaseSync) => select(sqlite, `SELECT bucket_start FROM ${table}`),
      expected: (now: number) => [{ bucket_start: now - THIRTY_FIVE_DAYS_SEC }],
      deletedKey, cutoffKey: "cutoffRequestTelemetrySec",
      cutoff: (now: number) => now - THIRTY_FIVE_DAYS_SEC,
    })),
  ])("$label", async ({ seed, remaining, expected, deletedKey, cutoffKey, cutoff }) => {
    const { db, sqlite } = createTestDb();
    const now = Math.floor(Date.now() / 1000);
    seed(sqlite, now);

    const result = await runPruneCronHistory(db);
    const metadata = JSON.parse(result.metadata!) as Record<string, number | string>;

    expect(remaining(sqlite)).toEqual(expected(now));
    expect(metadata[deletedKey]).toBe(1);
    expect(metadata[cutoffKey]).toBe(cutoff(now));
    expect(result.status).toBe("ok");
  });

  it.each([
    {
      label: "removes terminal repair tasks older than 7 days and keeps active or newer rows",
      table: "worker_repair_tasks", columns: "task_id, kind, subject_id, state, created_at, updated_at",
      rows: (now: number) => [
        ["closed", "test", "closed", "closed", now, now - ONE_WEEK_SEC - 3600],
        ["open", "test", "open", "open", now, now - ONE_WEEK_SEC - 3600],
        ["cancelled", "test", "cancelled", "cancelled", now, now - 3600],
      ],
      projection: "state, updated_at", order: "task_id", deletedKey: "repairTasksDeleted", deleted: 1,
      expected: (now: number) => [{ state: "cancelled", updated_at: now - 3600 }, { state: "open", updated_at: now - ONE_WEEK_SEC - 3600 }],
    },
    {
      label: "removes worker_canary_runs older than 14 days and keeps newer rows",
      table: "worker_canary_runs", columns: "id, check_id, idempotency_key, status, severity, observed_at",
      rows: (now: number) => [
        ["old", "test", "old", "ok", "info", now - WORKER_CANARY_RUN_RETENTION_SEC - 3600],
        ["new", "test", "new", "ok", "info", now - 3600],
      ],
      projection: "observed_at", order: "id", deletedKey: "canaryRunsDeleted", deleted: 1,
      expected: (now: number) => [{ observed_at: now - 3600 }],
    },
    {
      label: "removes terminal recovery checkpoints older than 14 days without deleting recoverable work",
      table: "worker_scheduled_checkpoints",
      columns: "schedule_key, slot_started_at, job, attempt_no, invocation_id, queue_hash, state, created_at, updated_at",
      rows: (now: number) => ["completed", "platform_abandoned", "ready", "failed"].map((state, index) =>
        ["test", now + index, state, 1, state, "hash", state, now, now - (index === 3 ? 3600 : TWO_WEEKS_SEC + 3600)]),
      projection: "state, updated_at", order: "slot_started_at", deletedKey: "recoveryCheckpointsDeleted", deleted: 2,
      expected: (now: number) => [{ state: "ready", updated_at: now - TWO_WEEKS_SEC - 3600 }, { state: "failed", updated_at: now - 3600 }],
    },
  ])("$label", async ({ table, columns, rows, projection, order, deletedKey, deleted, expected }) => {
    const { db, sqlite } = createTestDb();
    const now = Math.floor(Date.now() / 1000);
    for (const row of rows(now)) insert(sqlite, `INSERT INTO ${table} (${columns}) VALUES (${row.map(() => "?")})`, ...row);
    const result = await runPruneCronHistory(db);
    expect(select(sqlite, `SELECT ${projection} FROM ${table} ORDER BY ${order}`)).toEqual(expected(now));
    expect(JSON.parse(result.metadata!)[deletedKey]).toBe(deleted);
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

const createProbeDb = () => createTestDb().db;

async function seedProbeRuns(
  db: D1Database,
  opts: { count: number; createdAt: number; statusRotation: Array<"healthy" | "degraded" | "stale"> },
) {
  for (let i = 0; i < opts.count; i++) {
    const status = opts.statusRotation[i % opts.statusRotation.length];
    await db
      .prepare(
        "INSERT INTO status_probe_runs (status, sample_count, pass_count, fail_count, p95_latency_ms, details_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(status, 50, 50, 0, 100, "{}", opts.createdAt)
      .run();
  }
}

describe("pruneStatusProbeRuns", () => {
  it("throws before D1 work when the cron signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort(new Error("probe prune aborted"));

    await expect(runPruneStatusProbeRuns(createProbeDb(), controller.signal)).rejects.toThrow("probe prune aborted");
  });

  it("threads an aborted signal into the direct D1 prune helper", async () => {
    const db = createProbeDb();
    const now = Math.floor(Date.now() / 1000);
    const cutoffSec = now - 90 * 86_400;
    await seedProbeRuns(db, {
      count: 1,
      createdAt: now - 91 * 86_400,
      statusRotation: ["healthy"],
    });

    const controller = new AbortController();
    controller.abort(new Error("probe prune helper aborted"));

    await expect(pruneStatusProbeRuns(db, { cutoffSec, batchSize: 100, signal: controller.signal })).rejects.toThrow(
      "probe prune helper aborted",
    );
    const remaining = await db
      .prepare("SELECT COUNT(*) AS cnt FROM status_probe_runs")
      .first<{ cnt: number }>();
    expect(remaining?.cnt).toBe(1);
  });

  it("deletes rows older than cutoffSec and stops at batchSize", async () => {
    const db = createProbeDb();
    const now = Math.floor(Date.now() / 1000);
    const cutoffSec = now - 90 * 86_400;
    // Seed: 150 rows 91 days ago (candidates), 10 rows from today (must survive).
    await seedProbeRuns(db, {
      count: 150,
      createdAt: now - 91 * 86_400,
      statusRotation: ["healthy", "degraded", "stale"],
    });
    await seedProbeRuns(db, {
      count: 10,
      createdAt: now - 300,
      statusRotation: ["healthy"],
    });

    // First pass: batchSize=100 caps the deletion, leaving 50 eligible rows.
    const first = await pruneStatusProbeRuns(db, { cutoffSec, batchSize: 100 });
    expect(first).toEqual({ deleted: 100, cappedAtLimit: true });

    // Second pass finishes the backlog.
    const second = await pruneStatusProbeRuns(db, { cutoffSec, batchSize: 100 });
    expect(second).toEqual({ deleted: 50, cappedAtLimit: false });

    // Recent rows survive.
    const remaining = await db
      .prepare("SELECT COUNT(*) AS cnt FROM status_probe_runs")
      .first<{ cnt: number }>();
    expect(remaining?.cnt).toBe(10);
  });

  it("reports cappedAtLimit in run metadata when the 90-day backlog fills the batch", async () => {
    const db = createProbeDb();
    const now = Math.floor(Date.now() / 1000);
    const expectedCutoffSec = now - 90 * 86_400;
    await db.prepare(`WITH RECURSIVE n(id) AS (SELECT 1 UNION ALL SELECT id + 1 FROM n WHERE id < 10000)
      INSERT INTO status_probe_runs
        (status, sample_count, pass_count, fail_count, p95_latency_ms, details_json, created_at)
      SELECT 'healthy', 50, 50, 0, 100, '{}', ? FROM n`).bind(expectedCutoffSec - 1).run();

    const result = await runPruneStatusProbeRuns(db);
    const metadata = JSON.parse(result.metadata!) as { deleted: number; cappedAtLimit: boolean };

    expect(metadata).toMatchObject({ deleted: 10_000, cappedAtLimit: true });
    const remaining = await db.prepare("SELECT COUNT(*) AS cnt FROM status_probe_runs").first<{ cnt: number }>();
    expect(remaining?.cnt).toBe(0);
  });
});
