import { describe, expect, it } from "vitest";

import {
  TELEGRAM_PROCESSED_UPDATE_PRUNE_BATCH_LIMIT,
  runTelegramRetentionCleanup,
} from "../telegram-retention-cleanup";

interface UsageDailyRow {
  day: string;
}

interface WatcherLifecycleRow {
  day: string;
}

interface ProcessedUpdateRow {
  received_at: number;
}

interface DeadLetterRow {
  expired_at: number;
}

interface CreatedAtRow {
  created_at: number;
}

interface UpdatedAtRow {
  updated_at: number;
}

interface CacheRow {
  key: string;
  value: string;
  updated_at: number;
}

interface StubState {
  usageDaily: UsageDailyRow[];
  watcherLifecycle: WatcherLifecycleRow[];
  processedUpdates: ProcessedUpdateRow[];
  deadLetters: DeadLetterRow[];
  jobTargets: CreatedAtRow[];
  jobs: CreatedAtRow[];
  diagnostics: UpdatedAtRow[];
  cache: CacheRow[];
}

function makeState(): StubState {
  return {
    usageDaily: [],
    watcherLifecycle: [],
    processedUpdates: [],
    deadLetters: [],
    jobTargets: [],
    jobs: [],
    diagnostics: [],
    cache: [],
  };
}

/**
 * Minimal D1 stub that understands every statement issued by
 * `runTelegramRetentionCleanup` (its own deletes plus the deletes inside
 * `pruneTelegramProcessedUpdates` and the UPDATE in
 * `reconcileExpiredTelegramAlertJobTargets`). Mirrors the pattern in
 * prune-cron-history.test.ts and telegram-inactive-cleanup.test.ts.
 */
function createStubDb(
  state: StubState,
  options: { afterProcessedUpdateDelete?: () => void } = {},
): D1Database {
  function boundDeleteLimit(bound: unknown[]): number {
    const limit = Number(bound[2]);
    return Number.isFinite(limit) ? limit : Number.POSITIVE_INFINITY;
  }

  function deleteMatching<T>(rows: T[], predicate: (row: T) => boolean, limit = Number.POSITIVE_INFINITY): number {
    let removed = 0;
    for (let i = 0; i < rows.length && removed < limit; ) {
      if (predicate(rows[i])) {
        rows.splice(i, 1);
        removed += 1;
      } else {
        i += 1;
      }
    }
    return removed;
  }

  function prepare(sql: string): D1PreparedStatement {
    let bound: unknown[] = [];
    const stmt = {
      bind: (...args: unknown[]) => {
        bound = args;
        return stmt as unknown as D1PreparedStatement;
      },
      run: async () => {
        if (sql.startsWith("UPDATE telegram_alert_job_targets")) {
          // reconcileExpiredTelegramAlertJobTargets: no rows to update in
          // these tests.
          return { success: true, meta: { changes: 0 } };
        }
        if (sql.startsWith("DELETE FROM telegram_processed_updates")) {
          const [cutoff, limit] = bound as [number, number];
          const removed = deleteMatching(state.processedUpdates, (row) => row.received_at < cutoff, limit);
          options.afterProcessedUpdateDelete?.();
          return { success: true, meta: { changes: removed } };
        }
        if (sql.startsWith("DELETE FROM telegram_alert_dead_letters")) {
          const [cutoff] = bound as [number];
          const removed = deleteMatching(state.deadLetters, (row) => row.expired_at < cutoff, boundDeleteLimit(bound));
          return { success: true, meta: { changes: removed } };
        }
        if (sql.startsWith("DELETE FROM telegram_alert_job_targets")) {
          const [cutoff] = bound as [number];
          const removed = deleteMatching(state.jobTargets, (row) => row.created_at < cutoff, boundDeleteLimit(bound));
          return { success: true, meta: { changes: removed } };
        }
        if (sql.startsWith("DELETE FROM telegram_alert_jobs")) {
          const [cutoff] = bound as [number];
          const removed = deleteMatching(state.jobs, (row) => row.created_at < cutoff, boundDeleteLimit(bound));
          return { success: true, meta: { changes: removed } };
        }
        if (sql.startsWith("DELETE FROM telegram_usage_daily")) {
          const [cutoff] = bound as [unknown];
          if (typeof cutoff !== "string") {
            throw new Error(
              `telegram_usage_daily.day is TEXT; cutoff must be a YYYY-MM-DD string, got ${typeof cutoff}`,
            );
          }
          const removed = deleteMatching(state.usageDaily, (row) => row.day < cutoff, boundDeleteLimit(bound));
          return { success: true, meta: { changes: removed } };
        }
        if (sql.startsWith("DELETE FROM telegram_watcher_lifecycle_daily")) {
          const [cutoff] = bound as [unknown];
          if (typeof cutoff !== "string") {
            throw new Error(
              `telegram_watcher_lifecycle_daily.day is TEXT; cutoff must be a YYYY-MM-DD string, got ${typeof cutoff}`,
            );
          }
          const removed = deleteMatching(state.watcherLifecycle, (row) => row.day < cutoff, boundDeleteLimit(bound));
          return { success: true, meta: { changes: removed } };
        }
        if (sql.startsWith("DELETE FROM telegram_chat_delivery_diagnostics")) {
          const [cutoff] = bound as [number];
          const removed = deleteMatching(state.diagnostics, (row) => row.updated_at < cutoff, boundDeleteLimit(bound));
          return { success: true, meta: { changes: removed } };
        }
        if (sql.startsWith("DELETE FROM cache")) {
          const [prefixLike, cutoff, limit] = bound as [string, number, number];
          const prefix = prefixLike.endsWith("%") ? prefixLike.slice(0, -1) : prefixLike;
          const removed = deleteMatching(
            state.cache,
            (row) => row.key.startsWith(prefix) && row.updated_at < cutoff,
            Number.isFinite(limit) ? limit : Number.POSITIVE_INFINITY,
          );
          return { success: true, meta: { changes: removed } };
        }
        return { success: true, meta: { changes: 0 } };
      },
      first: async () => {
        if (sql.includes("SELECT COUNT(*) AS count") && sql.includes("FROM telegram_processed_updates")) {
          const [cutoff, limit] = bound as [number, number];
          const count = Math.min(
            state.processedUpdates.filter((row) => row.received_at < cutoff).length,
            limit,
          );
          return { count };
        }
        return null;
      },
      all: async () => ({ results: [], success: true, meta: {} }),
    };
    return stmt as unknown as D1PreparedStatement;
  }

  return {
    prepare,
    batch: async () => [],
    exec: async () => ({ count: 0, duration: 0 }),
    dump: async () => new ArrayBuffer(0),
  } as unknown as D1Database;
}

function todayString(nowSec: number): string {
  return new Date(nowSec * 1000).toISOString().slice(0, 10);
}

describe("runTelegramRetentionCleanup", () => {
  it("throws before D1 work when the cron signal is already aborted", async () => {
    const db = createStubDb(makeState());
    const controller = new AbortController();
    controller.abort(new Error("retention cleanup aborted"));

    await expect(runTelegramRetentionCleanup(db, controller.signal)).rejects.toThrow("retention cleanup aborted");
  });

  it("prunes telegram_usage_daily rows older than the YYYY-MM-DD cutoff", async () => {
    const state = makeState();
    // A row from January 2024 — well past the 400-day retention window.
    state.usageDaily.push({ day: "2024-01-01" });
    const db = createStubDb(state);

    const result = await runTelegramRetentionCleanup(db);

    expect(result.status).toBe("ok");
    expect(state.usageDaily).toHaveLength(0);
    const metadata = JSON.parse(result.metadata!) as { usageDailyPruned: number };
    expect(metadata.usageDailyPruned).toBe(1);
  });

  it("keeps fresh telegram_usage_daily rows from today", async () => {
    const state = makeState();
    const now = Math.floor(Date.now() / 1000);
    state.usageDaily.push({ day: todayString(now) });
    const db = createStubDb(state);

    const result = await runTelegramRetentionCleanup(db);

    expect(state.usageDaily).toHaveLength(1);
    const metadata = JSON.parse(result.metadata!) as { usageDailyPruned: number };
    expect(metadata.usageDailyPruned).toBe(0);
  });

  it("prunes telegram_watcher_lifecycle_daily rows older than the YYYY-MM-DD cutoff", async () => {
    const state = makeState();
    state.watcherLifecycle.push({ day: "2024-01-01" });
    const db = createStubDb(state);

    const result = await runTelegramRetentionCleanup(db);

    expect(state.watcherLifecycle).toHaveLength(0);
    const metadata = JSON.parse(result.metadata!) as { watcherLifecyclePruned: number };
    expect(metadata.watcherLifecyclePruned).toBe(1);
  });

  it("keeps fresh telegram_watcher_lifecycle_daily rows from today", async () => {
    const state = makeState();
    const now = Math.floor(Date.now() / 1000);
    state.watcherLifecycle.push({ day: todayString(now) });
    const db = createStubDb(state);

    const result = await runTelegramRetentionCleanup(db);

    expect(state.watcherLifecycle).toHaveLength(1);
    const metadata = JSON.parse(result.metadata!) as { watcherLifecyclePruned: number };
    expect(metadata.watcherLifecyclePruned).toBe(0);
  });

  it("binds a string cutoff for both day-typed tables (regression guard)", async () => {
    // The stub's DELETE handlers throw if the bind is not a string. This
    // exercises both telegram_usage_daily and telegram_watcher_lifecycle_daily
    // and locks the text-vs-integer comparison fix.
    const state = makeState();
    state.usageDaily.push({ day: "2024-01-01" });
    state.watcherLifecycle.push({ day: "2024-01-01" });
    const db = createStubDb(state);

    await expect(runTelegramRetentionCleanup(db)).resolves.toMatchObject({ status: "ok" });
    expect(state.usageDaily).toHaveLength(0);
    expect(state.watcherLifecycle).toHaveLength(0);
  });

  it("caps large retention deletes per table and reports cappedAtLimit metadata", async () => {
    const state = makeState();
    for (let i = 0; i < 10_001; i += 1) {
      state.usageDaily.push({ day: "2024-01-01" });
      state.jobTargets.push({ created_at: 1 });
    }
    const db = createStubDb(state);

    const result = await runTelegramRetentionCleanup(db);

    expect(state.usageDaily).toHaveLength(1);
    expect(state.jobTargets).toHaveLength(1);
    const metadata = JSON.parse(result.metadata!) as {
      deleteBatchLimit: number;
      usageDailyPruned: number;
      jobTargetsPruned: number;
      cappedAtLimit: {
        usageDaily: boolean;
        jobTargets: boolean;
        jobs: boolean;
      };
    };
    expect(metadata.deleteBatchLimit).toBe(10_000);
    expect(metadata.usageDailyPruned).toBe(10_000);
    expect(metadata.jobTargetsPruned).toBe(10_000);
    expect(metadata.cappedAtLimit.usageDaily).toBe(true);
    expect(metadata.cappedAtLimit.jobTargets).toBe(true);
    expect(metadata.cappedAtLimit.jobs).toBe(false);
  });

  it("caps processed-update retention to one bounded run and reports a lower-bound backlog", async () => {
    const state = makeState();
    const now = Math.floor(Date.now() / 1000);
    const staleReceivedAt = now - 8 * 24 * 60 * 60;
    for (let i = 0; i < 12_001; i += 1) {
      state.processedUpdates.push({ received_at: staleReceivedAt });
    }
    const db = createStubDb(state);

    const result = await runTelegramRetentionCleanup(db);

    expect(state.processedUpdates).toHaveLength(7_001);
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
    const state = makeState();
    const now = Math.floor(Date.now() / 1000);
    const staleReceivedAt = now - 8 * 24 * 60 * 60;
    for (let i = 0; i < 3_000; i += 1) {
      state.processedUpdates.push({ received_at: staleReceivedAt });
    }

    let monotonicMs = 0;
    const db = createStubDb(state, {
      afterProcessedUpdateDelete: () => {
        monotonicMs = 10;
      },
    });
    const result = await runTelegramRetentionCleanup(db, undefined, {
      monotonicNow: () => monotonicMs,
      processedUpdateTimeBudgetMs: 10,
    });

    expect(state.processedUpdates).toHaveLength(2_000);
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

  it("prunes stale Telegram chat cache residue by prefix", async () => {
    const state = makeState();
    const now = Math.floor(Date.now() / 1000);
    const staleShortLived = now - 8 * 24 * 60 * 60;
    const freshShortLived = now - 3600;
    const staleWarning = now - 31 * 24 * 60 * 60;
    const freshWarning = now - 20 * 24 * 60 * 60;
    state.cache.push(
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
    );
    const db = createStubDb(state);

    const result = await runTelegramRetentionCleanup(db);

    expect(state.cache.map((row) => row.key).sort()).toEqual(
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
