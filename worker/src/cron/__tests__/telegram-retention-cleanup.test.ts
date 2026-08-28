import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { createLatestSchemaSqlite } from "../../test-helpers/latest-schema-sqlite";
import {
  TELEGRAM_PROCESSED_UPDATE_PRUNE_BATCH_LIMIT,
  runTelegramRetentionCleanup,
} from "../telegram-retention-cleanup";

const databases: DatabaseSync[] = [];

afterEach(() => {
  while (databases.length > 0) databases.pop()?.close();
});

function setupLatestSchema(): { sqlite: DatabaseSync; db: D1Database } {
  const result = createLatestSchemaSqlite();
  databases.push(result.sqlite);
  return result;
}

function countRows(sqlite: DatabaseSync, table: string): number {
  return Number((sqlite.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count);
}

function insertUsageDaily(sqlite: DatabaseSync, day: string, suffix = "row"): void {
  sqlite.prepare(
    `INSERT INTO telegram_usage_daily
       (day, event_type, source_category, action_detail, outcome, latency_bucket,
        failure_class, count, first_seen_at, last_seen_at)
     VALUES (?, ?, 'unknown', '', 'unknown', 'unknown', '', 1, 1, 1)`,
  ).run(day, suffix);
}

function insertWatcherLifecycle(sqlite: DatabaseSync, day: string): void {
  sqlite.prepare("INSERT INTO telegram_watcher_lifecycle_daily (day, snapshot_at) VALUES (?, 1)").run(day);
}

function insertProcessedUpdates(sqlite: DatabaseSync, count: number, receivedAt: number): void {
  const insert = sqlite.prepare(
    "INSERT INTO telegram_processed_updates (update_id, received_at, status) VALUES (?, ?, 'processed')",
  );
  sqlite.exec("BEGIN");
  for (let index = 0; index < count; index += 1) insert.run(index + 1, receivedAt);
  sqlite.exec("COMMIT");
}

function insertRecapTargets(sqlite: DatabaseSync, count: number, updatedAt: number): void {
  const insert = sqlite.prepare(
    `INSERT INTO telegram_recap_targets
       (recap_key, chat_id, local_date, window_start_at, window_end_at,
        preference_generation, watchlist_fingerprint, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 1, 'watchlist', 'cancelled', ?, ?)`,
  );
  sqlite.exec("BEGIN");
  for (let index = 0; index < count; index += 1) {
    insert.run(`recap-${index}`, `chat-${index}`, `2024-${String(Math.floor(index / 28) % 12 + 1).padStart(2, "0")}-${String(index % 28 + 1).padStart(2, "0")}`, updatedAt, updatedAt, updatedAt, updatedAt);
  }
  sqlite.exec("COMMIT");
}

function todayString(nowSec: number): string {
  return new Date(nowSec * 1000).toISOString().slice(0, 10);
}

describe("runTelegramRetentionCleanup", () => {
  it("throws before D1 work when the cron signal is already aborted", async () => {
    const { db } = setupLatestSchema();
    const controller = new AbortController();
    controller.abort(new Error("retention cleanup aborted"));

    await expect(runTelegramRetentionCleanup(db, controller.signal)).rejects.toThrow("retention cleanup aborted");
  });

  it("prunes telegram_usage_daily rows older than the YYYY-MM-DD cutoff", async () => {
    const { sqlite, db } = setupLatestSchema();
    // A row from January 2024 — well past the 400-day retention window.
    insertUsageDaily(sqlite, "2024-01-01");

    const result = await runTelegramRetentionCleanup(db);

    expect(result.status).toBe("ok");
    expect(countRows(sqlite, "telegram_usage_daily")).toBe(0);
    const metadata = JSON.parse(result.metadata!) as { usageDailyPruned: number };
    expect(metadata.usageDailyPruned).toBe(1);
  });

  it("keeps fresh telegram_usage_daily rows from today", async () => {
    const { sqlite, db } = setupLatestSchema();
    const now = Math.floor(Date.now() / 1000);
    insertUsageDaily(sqlite, todayString(now));

    const result = await runTelegramRetentionCleanup(db);

    expect(countRows(sqlite, "telegram_usage_daily")).toBe(1);
    const metadata = JSON.parse(result.metadata!) as { usageDailyPruned: number };
    expect(metadata.usageDailyPruned).toBe(0);
  });

  it("prunes telegram_watcher_lifecycle_daily rows older than the YYYY-MM-DD cutoff", async () => {
    const { sqlite, db } = setupLatestSchema();
    insertWatcherLifecycle(sqlite, "2024-01-01");

    const result = await runTelegramRetentionCleanup(db);

    expect(countRows(sqlite, "telegram_watcher_lifecycle_daily")).toBe(0);
    const metadata = JSON.parse(result.metadata!) as { watcherLifecyclePruned: number };
    expect(metadata.watcherLifecyclePruned).toBe(1);
  });

  it("keeps fresh telegram_watcher_lifecycle_daily rows from today", async () => {
    const { sqlite, db } = setupLatestSchema();
    const now = Math.floor(Date.now() / 1000);
    insertWatcherLifecycle(sqlite, todayString(now));

    const result = await runTelegramRetentionCleanup(db);

    expect(countRows(sqlite, "telegram_watcher_lifecycle_daily")).toBe(1);
    const metadata = JSON.parse(result.metadata!) as { watcherLifecyclePruned: number };
    expect(metadata.watcherLifecyclePruned).toBe(0);
  });

  it("binds a string cutoff for both day-typed tables (regression guard)", async () => {
    const { sqlite, db } = setupLatestSchema();
    insertUsageDaily(sqlite, "2024-01-01");
    insertWatcherLifecycle(sqlite, "2024-01-01");

    await expect(runTelegramRetentionCleanup(db)).resolves.toMatchObject({ status: "ok" });
    expect(countRows(sqlite, "telegram_usage_daily")).toBe(0);
    expect(countRows(sqlite, "telegram_watcher_lifecycle_daily")).toBe(0);
  });

  it("caps large retention deletes per table and reports cappedAtLimit metadata", async () => {
    const { sqlite, db } = setupLatestSchema();
    const usageInsert = sqlite.prepare(
      `INSERT INTO telegram_usage_daily
         (day, event_type, source_category, action_detail, outcome, latency_bucket,
          failure_class, count, first_seen_at, last_seen_at)
       VALUES ('2024-01-01', ?, 'unknown', '', 'unknown', 'unknown', '', 1, 1, 1)`,
    );
    const diagnosticsInsert = sqlite.prepare(
      "INSERT INTO telegram_chat_delivery_diagnostics (chat_id, updated_at) VALUES (?, 1)",
    );
    sqlite.exec("BEGIN");
    for (let i = 0; i < 10_001; i += 1) {
      usageInsert.run(`event-${i}`);
      diagnosticsInsert.run(`chat-${i}`);
    }
    sqlite.exec("COMMIT");

    const result = await runTelegramRetentionCleanup(db);

    expect(countRows(sqlite, "telegram_usage_daily")).toBe(1);
    expect(countRows(sqlite, "telegram_chat_delivery_diagnostics")).toBe(1);
    const metadata = JSON.parse(result.metadata!) as {
      deleteBatchLimit: number;
      usageDailyPruned: number;
      diagnosticsPruned: number;
      cappedAtLimit: {
        usageDaily: boolean;
        diagnostics: boolean;
      };
    };
    expect(metadata.deleteBatchLimit).toBe(10_000);
    expect(metadata.usageDailyPruned).toBe(10_000);
    expect(metadata.diagnosticsPruned).toBe(10_000);
    expect(metadata.cappedAtLimit.usageDaily).toBe(true);
    expect(metadata.cappedAtLimit.diagnostics).toBe(true);
  });

  it("caps recap-target pruning and reports the retention run as truncated", async () => {
    const { sqlite, db } = setupLatestSchema();
    const now = Math.floor(Date.now() / 1000);
    insertRecapTargets(sqlite, 10_001, now - 91 * 24 * 60 * 60);

    const result = await runTelegramRetentionCleanup(db);

    expect(countRows(sqlite, "telegram_recap_targets")).toBe(1);
    const metadata = JSON.parse(result.metadata!) as {
      recapTargetsPruned: number;
      runBudgetTruncated: boolean;
      cappedAtLimit: { recapTargets: boolean };
    };
    expect(metadata.recapTargetsPruned).toBe(10_000);
    expect(metadata.cappedAtLimit.recapTargets).toBe(true);
    expect(metadata.runBudgetTruncated).toBe(true);
  });

  it("caps processed-update retention to one bounded run and reports a lower-bound backlog", async () => {
    const { sqlite, db } = setupLatestSchema();
    const now = Math.floor(Date.now() / 1000);
    const staleReceivedAt = now - 8 * 24 * 60 * 60;
    insertProcessedUpdates(sqlite, 12_001, staleReceivedAt);

    const result = await runTelegramRetentionCleanup(db);

    expect(countRows(sqlite, "telegram_processed_updates")).toBe(7_001);
    const metadata = JSON.parse(result.metadata!) as {
      processedUpdatesPruned: number;
      processedUpdatesRemainingBacklog: { count: number; exact: boolean; probeLimit: number };
      processedUpdatePruneBudget: { batches: number; batchLimit: number; timeBudgetExhausted: boolean };
      runBudgetTruncated: boolean;
      cappedAtLimit: { processedUpdates: boolean };
    };
    expect(metadata.processedUpdatesPruned).toBe(5_000);
    expect(metadata.cappedAtLimit.processedUpdates).toBe(true);
    expect(metadata.processedUpdatePruneBudget).toMatchObject({
      batches: 5,
      batchLimit: TELEGRAM_PROCESSED_UPDATE_PRUNE_BATCH_LIMIT,
      timeBudgetExhausted: false,
    });
    expect(metadata.processedUpdatesRemainingBacklog).toEqual({
      count: 5_001,
      exact: false,
      probeLimit: 5_001,
    });
    expect(metadata.runBudgetTruncated).toBe(true);
  });

  it("stops processed-update batches at the time budget and reports the exact remaining backlog", async () => {
    const { sqlite, db } = setupLatestSchema();
    const now = Math.floor(Date.now() / 1000);
    const staleReceivedAt = now - 8 * 24 * 60 * 60;
    insertProcessedUpdates(sqlite, 3_000, staleReceivedAt);

    const monotonicTimes = [0, 0, 10];
    const result = await runTelegramRetentionCleanup(db, undefined, {
      monotonicNow: () => monotonicTimes.shift() ?? 10,
      processedUpdateTimeBudgetMs: 10,
    });

    expect(countRows(sqlite, "telegram_processed_updates")).toBe(2_000);
    const metadata = JSON.parse(result.metadata!) as {
      processedUpdatesPruned: number;
      processedUpdatesRemainingBacklog: { count: number; exact: boolean; probeLimit: number };
      processedUpdatePruneBudget: {
        rowLimit: number;
        batchLimit: number;
        timeBudgetMs: number;
        batches: number;
        timeBudgetExhausted: boolean;
      };
      runBudgetTruncated: boolean;
      cappedAtLimit: { processedUpdates: boolean };
    };
    expect(metadata.processedUpdatesPruned).toBe(1_000);
    expect(metadata.cappedAtLimit.processedUpdates).toBe(false);
    expect(metadata.processedUpdatePruneBudget).toEqual({
      rowLimit: 5_000,
      batchLimit: 1_000,
      timeBudgetMs: 10,
      batches: 1,
      timeBudgetExhausted: true,
    });
    expect(metadata.processedUpdatesRemainingBacklog).toEqual({
      count: 2_000,
      exact: true,
      probeLimit: 5_001,
    });
    expect(metadata.runBudgetTruncated).toBe(true);
  });

  it("prunes stale Telegram adoption client quota rows after two days", async () => {
    const { sqlite, db } = setupLatestSchema();
    const now = Math.floor(Date.now() / 1000);
    sqlite.prepare(
      `INSERT INTO telegram_adoption_client_quota
         (bucket_start, ip_hash, request_count, updated_at)
       VALUES (?, ?, 1, ?), (?, ?, 1, ?)`,
    ).run(1, "a".repeat(32), now - 3 * 24 * 60 * 60, 2, "b".repeat(32), now - 3600);

    const result = await runTelegramRetentionCleanup(db);

    expect(sqlite.prepare("SELECT updated_at FROM telegram_adoption_client_quota").all()).toEqual([
      { updated_at: now - 3600 },
    ]);
    const metadata = JSON.parse(result.metadata!) as { adoptionClientQuotaPruned: number };
    expect(metadata.adoptionClientQuotaPruned).toBe(1);
  });

  it("prunes stale Telegram chat cache residue by prefix", async () => {
    const { sqlite, db } = setupLatestSchema();
    const now = Math.floor(Date.now() / 1000);
    const staleShortLived = now - 8 * 24 * 60 * 60;
    const freshShortLived = now - 3600;
    const staleWarning = now - 31 * 24 * 60 * 60;
    const freshWarning = now - 20 * 24 * 60 * 60;
    const cacheRows = [
      { key: "telegram:command-cooldown:42:/status", value: "1", updated_at: staleShortLived },
      { key: "telegram:mini-app-mutation-burst:42", value: "12", updated_at: staleShortLived },
      { key: "telegram:command-flood:42", value: "1", updated_at: staleShortLived },
      { key: "telegram:chat-member:42:99", value: "1", updated_at: staleShortLived },
      { key: "telegram:chat-admins:-42", value: "1", updated_at: staleShortLived },
      { key: "telegram:group-welcome:-42", value: "1", updated_at: staleShortLived },
      { key: "telegram:re-engagement-warned:42", value: "1", updated_at: staleWarning },
      { key: "telegram:command-cooldown:43:/status", value: "1", updated_at: freshShortLived },
      { key: "telegram:mini-app-mutation-burst:43", value: "6", updated_at: freshShortLived },
      { key: "telegram:command-flood:43", value: "1", updated_at: freshShortLived },
      { key: "telegram:chat-member:43:99", value: "1", updated_at: freshShortLived },
      { key: "telegram:chat-admins:-43", value: "1", updated_at: freshShortLived },
      { key: "telegram:group-welcome:-43", value: "1", updated_at: freshShortLived },
      { key: "telegram:re-engagement-warned:43", value: "1", updated_at: freshWarning },
    ];
    const insert = sqlite.prepare("INSERT INTO cache (key, value, updated_at) VALUES (?, ?, ?)");
    for (const row of cacheRows) insert.run(row.key, row.value, row.updated_at);

    const result = await runTelegramRetentionCleanup(db);

    expect((sqlite.prepare("SELECT key FROM cache ORDER BY key").all() as Array<{ key: string }>).map((row) => row.key)).toEqual(
      [
        "telegram:command-cooldown:43:/status",
        "telegram:mini-app-mutation-burst:43",
        "telegram:command-flood:43",
        "telegram:chat-admins:-43",
        "telegram:chat-member:43:99",
        "telegram:group-welcome:-43",
        "telegram:re-engagement-warned:43",
      ].sort(),
    );
    const metadata = JSON.parse(result.metadata!) as {
      commandCooldownCachePruned: number;
      miniAppMutationBurstCachePruned: number;
      commandFloodCachePruned: number;
      chatMemberCachePruned: number;
      chatAdminsCachePruned: number;
      groupWelcomeCachePruned: number;
      reEngagementWarningCachePruned: number;
      retentionDays: {
        shortLivedChatCache: number;
        reEngagementWarningCache: number;
      };
    };
    expect(metadata.commandCooldownCachePruned).toBe(1);
    expect(metadata.miniAppMutationBurstCachePruned).toBe(1);
    expect(metadata.commandFloodCachePruned).toBe(1);
    expect(metadata.chatMemberCachePruned).toBe(1);
    expect(metadata.chatAdminsCachePruned).toBe(1);
    expect(metadata.groupWelcomeCachePruned).toBe(1);
    expect(metadata.reEngagementWarningCachePruned).toBe(1);
    expect(metadata.retentionDays.shortLivedChatCache).toBe(7);
    expect(metadata.retentionDays.reEngagementWarningCache).toBe(30);
  });
});
