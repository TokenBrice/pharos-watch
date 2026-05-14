import { describe, expect, it } from "vitest";

import { runTelegramRetentionCleanup } from "../telegram-retention-cleanup";

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
function createStubDb(state: StubState): D1Database {
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
        if (sql.startsWith("INSERT INTO cache")) {
          // maybePruneTelegramProcessedUpdates uses a guarded INSERT to claim
          // the prune slot. Treat as a no-op success in tests; the actual
          // delete below will still run on the second statement.
          const [, , updatedAt] = bound as [string, string, number];
          const [key] = bound as [string];
          // Behaves like ON CONFLICT...DO UPDATE WHERE updated_at <= ?
          const existing = state.cache.find((row) => row.key === key);
          if (!existing) {
            state.cache.push({ key, value: "1", updated_at: updatedAt });
            return { success: true, meta: { changes: 1 } };
          }
          // The guarded path uses `<= eligibleBefore` to claim. We greenlight
          // the test path by always allowing the conflict to win when called.
          existing.updated_at = updatedAt;
          return { success: true, meta: { changes: 1 } };
        }
        if (sql.startsWith("DELETE FROM telegram_processed_updates")) {
          const [cutoff] = bound as [number];
          let removed = 0;
          for (let i = state.processedUpdates.length - 1; i >= 0; i--) {
            if (state.processedUpdates[i].received_at < cutoff) {
              state.processedUpdates.splice(i, 1);
              removed += 1;
            }
          }
          return { success: true, meta: { changes: removed } };
        }
        if (sql.startsWith("DELETE FROM telegram_alert_dead_letters")) {
          const [cutoff] = bound as [number];
          let removed = 0;
          for (let i = state.deadLetters.length - 1; i >= 0; i--) {
            if (state.deadLetters[i].expired_at < cutoff) {
              state.deadLetters.splice(i, 1);
              removed += 1;
            }
          }
          return { success: true, meta: { changes: removed } };
        }
        if (sql.startsWith("DELETE FROM telegram_alert_job_targets")) {
          const [cutoff] = bound as [number];
          let removed = 0;
          for (let i = state.jobTargets.length - 1; i >= 0; i--) {
            if (state.jobTargets[i].created_at < cutoff) {
              state.jobTargets.splice(i, 1);
              removed += 1;
            }
          }
          return { success: true, meta: { changes: removed } };
        }
        if (sql.startsWith("DELETE FROM telegram_alert_jobs")) {
          const [cutoff] = bound as [number];
          let removed = 0;
          for (let i = state.jobs.length - 1; i >= 0; i--) {
            if (state.jobs[i].created_at < cutoff) {
              state.jobs.splice(i, 1);
              removed += 1;
            }
          }
          return { success: true, meta: { changes: removed } };
        }
        if (sql.startsWith("DELETE FROM telegram_usage_daily")) {
          const [cutoff] = bound as [unknown];
          if (typeof cutoff !== "string") {
            throw new Error(
              `telegram_usage_daily.day is TEXT; cutoff must be a YYYY-MM-DD string, got ${typeof cutoff}`,
            );
          }
          let removed = 0;
          for (let i = state.usageDaily.length - 1; i >= 0; i--) {
            if (state.usageDaily[i].day < cutoff) {
              state.usageDaily.splice(i, 1);
              removed += 1;
            }
          }
          return { success: true, meta: { changes: removed } };
        }
        if (sql.startsWith("DELETE FROM telegram_watcher_lifecycle_daily")) {
          const [cutoff] = bound as [unknown];
          if (typeof cutoff !== "string") {
            throw new Error(
              `telegram_watcher_lifecycle_daily.day is TEXT; cutoff must be a YYYY-MM-DD string, got ${typeof cutoff}`,
            );
          }
          let removed = 0;
          for (let i = state.watcherLifecycle.length - 1; i >= 0; i--) {
            if (state.watcherLifecycle[i].day < cutoff) {
              state.watcherLifecycle.splice(i, 1);
              removed += 1;
            }
          }
          return { success: true, meta: { changes: removed } };
        }
        if (sql.startsWith("DELETE FROM telegram_chat_delivery_diagnostics")) {
          const [cutoff] = bound as [number];
          let removed = 0;
          for (let i = state.diagnostics.length - 1; i >= 0; i--) {
            if (state.diagnostics[i].updated_at < cutoff) {
              state.diagnostics.splice(i, 1);
              removed += 1;
            }
          }
          return { success: true, meta: { changes: removed } };
        }
        return { success: true, meta: { changes: 0 } };
      },
      first: async () => null,
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

    await expect(runTelegramRetentionCleanup(db, controller.signal)).rejects.toThrow(
      "retention cleanup aborted",
    );
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
});
