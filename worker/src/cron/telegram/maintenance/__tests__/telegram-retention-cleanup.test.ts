import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createLatestSchemaSqlite } from "@shared/test-utils/latest-schema-sqlite";
import { collectTelegramAdoptionReport } from "../../../../../../scripts/maintenance/report-telegram-adoption";
import {
  TELEGRAM_PROCESSED_UPDATE_PRUNE_BATCH_LIMIT,
  runTelegramRetentionCleanup,
} from "../telegram-retention-cleanup";
import {
  cleanupExpiredPendingAlerts,
  TELEGRAM_PENDING_SENT_RETENTION_SEC,
} from "../../delivery/cleanup";

const NOW_SEC = 1_800_000_000;
const DAY_SEC = 24 * 60 * 60;

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

interface SourceFixture {
  id: string;
  ageDays: number;
  terminal: boolean;
  finalDeliveryState: "accepted" | "execution_unknown";
  effectState: "complete" | "execution_unknown";
}

interface LegacyTargetFixture {
  id: string;
  ageSec: number;
  targetStatus?: "sent" | "failed" | "expired";
  jobStatus?: "discovered" | "queued" | "sent" | "degraded" | "expired";
  effectState?: "unstarted" | "claimed" | "sending" | "complete" | "execution_unknown";
  finalDeliveryState?: "accepted" | "failed" | "cancelled" | "expired" | "execution_unknown" | null;
  activePendingState?: "pending" | "sending" | "execution_unknown";
  withItem?: boolean;
}

function insertLegacyTargetBundle(sqlite: DatabaseSync, fixture: LegacyTargetFixture): void {
  const createdAt = NOW_SEC - fixture.ageSec;
  const jobId = `legacy-job-${fixture.id}`;
  const targetKey = `legacy-target-${fixture.id}`;
  const dedupeKey = `legacy-dedupe-${fixture.id}`;
  const sourceEventId = `missing-source-${fixture.id}`;

  sqlite
    .prepare(
      `INSERT INTO telegram_alert_jobs (
         job_id, alert_type, source_event_id, severity, created_at, expires_at, status
       ) VALUES (?, 'dews', ?, 'risk', ?, ?, ?)`,
    )
    .run(
      jobId,
      sourceEventId,
      createdAt,
      NOW_SEC + DAY_SEC,
      fixture.jobStatus ?? "sent",
    );
  sqlite
    .prepare(
      `INSERT INTO telegram_alert_job_targets (
         job_id, target_key, chat_id, chunk_index, alert_type, status,
         pending_dedupe_key, created_at, effect_state, final_delivery_state
       ) VALUES (?, ?, ?, 0, 'dews', ?, ?, ?, ?, ?)`,
    )
    .run(
      jobId,
      targetKey,
      `legacy-chat-${fixture.id}`,
      fixture.targetStatus ?? "sent",
      dedupeKey,
      createdAt,
      fixture.effectState ?? "unstarted",
      fixture.finalDeliveryState === undefined ? null : fixture.finalDeliveryState,
    );
  if (fixture.withItem) {
    sqlite
      .prepare(
        `INSERT INTO telegram_alert_job_target_items (
           job_id, target_key, source_event_id, item_key, created_at
         ) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(jobId, targetKey, sourceEventId, `item-${fixture.id}`, createdAt);
  }
  if (fixture.activePendingState) {
    sqlite
      .prepare(
        `INSERT INTO telegram_pending_alerts (
           chat_id, message_html, created_at, dedupe_key, delivery_state
         ) VALUES (?, '<b>pending</b>', ?, ?, ?)`,
      )
      .run(`legacy-chat-${fixture.id}`, createdAt, dedupeKey, fixture.activePendingState);
  }
}

function insertUnresolvedSource(
  sqlite: DatabaseSync,
  id: string,
  ageSec: number,
  options: {
    referencedByJob?: boolean;
    referencedByPending?: boolean;
    referencedByDeadLetter?: boolean;
    referencedByFreeze?: boolean;
    expiresAt?: number;
  } = {},
): void {
  const detectedAt = NOW_SEC - ageSec;
  sqlite
    .prepare(
      `INSERT INTO telegram_alert_source_events (
         source_event_id, schema_version, status, detected_at, expires_at,
         event_payload, baseline_payload, target_plan_state
       ) VALUES (?, 1, 'resolving', ?, ?, '{}', '{}', 'unstarted')`,
    )
    .run(id, detectedAt, options.expiresAt ?? NOW_SEC - 1);
  if (options.referencedByJob) {
    sqlite
      .prepare(
        `INSERT INTO telegram_alert_jobs (
           job_id, alert_type, source_event_id, severity, created_at, expires_at, status
         ) VALUES (?, 'dews', ?, 'risk', ?, ?, 'discovered')`,
      )
      .run(`source-job-${id}`, id, detectedAt, NOW_SEC + DAY_SEC);
  }
  if (options.referencedByPending) {
    sqlite
      .prepare(
        `INSERT INTO telegram_pending_alerts (
           chat_id, message_html, created_at, source_event_id
         ) VALUES (?, '<b>pending</b>', ?, ?)`,
      )
      .run(`source-chat-${id}`, NOW_SEC, id);
  }
  if (options.referencedByDeadLetter) {
    sqlite
      .prepare(
        `INSERT INTO telegram_alert_dead_letters (
           chat_id, message_html, created_at, expired_at, reason, source_event_id
         ) VALUES (?, '<b>dead letter</b>', ?, ?, 'expired', ?)`,
      )
      .run(`source-chat-${id}`, NOW_SEC, NOW_SEC, id);
  }
  if (options.referencedByFreeze) {
    sqlite
      .prepare(
        `INSERT INTO telegram_freeze_alert_events (
           source_event_id, tape_event_id, blacklist_event_id, event_type,
           detected_at, expires_at, payload_json, status, created_at, updated_at
         ) VALUES (?, ?, ?, 'blacklist', ?, ?, '{}', 'planning', ?, ?)`,
      )
      .run(id, `tape-${id}`, `blacklist-${id}`, NOW_SEC, NOW_SEC + DAY_SEC, NOW_SEC, NOW_SEC);
  }
}

function insertSourceBundle(sqlite: DatabaseSync, fixture: SourceFixture): void {
  const detectedAt = NOW_SEC - fixture.ageDays * DAY_SEC;
  const completedAt = fixture.terminal ? detectedAt + 60 : null;
  const chatId = `chat-${fixture.id}`;
  const jobId = `job-${fixture.id}`;
  const targetKey = `target-${fixture.id}`;
  const planKey = `plan-${fixture.id}`;

  sqlite
    .prepare(
      `INSERT INTO telegram_alert_source_events (
         source_event_id, schema_version, status, detected_at, expires_at,
         event_payload, baseline_payload, target_plan_state, target_plan_generation,
         completed_at
       ) VALUES (?, 1, 'planned', ?, ?, '{}', '{}', 'capturing', 1, ?)`,
    )
    .run(fixture.id, detectedAt, NOW_SEC + DAY_SEC, completedAt);
  sqlite
    .prepare(
      `INSERT INTO telegram_alert_planning_subscribers (
         source_event_id, plan_generation, chat_id, preference_generation,
         last_active_at, captured_at, planning_outcome
       ) VALUES (?, 1, ?, 1, ?, ?, 'target_planned')`,
    )
    .run(fixture.id, chatId, detectedAt, detectedAt);
  sqlite
    .prepare(
      `INSERT INTO telegram_alert_target_plan_pages (
         source_event_id, plan_generation, page_index, status, created_at, updated_at
       ) VALUES (?, 1, 0, 'complete', ?, ?)`,
    )
    .run(fixture.id, detectedAt, detectedAt);
  sqlite
    .prepare("UPDATE telegram_alert_source_events SET target_plan_state = 'planning' WHERE source_event_id = ?")
    .run(fixture.id);
  sqlite
    .prepare(
      `INSERT INTO telegram_alert_target_plans (
         source_event_id, plan_generation, plan_key, page_index, plan_ordinal,
         chat_id, alert_type, status, preference_generation, estimated_chunks,
         plan_payload_json, plan_payload_digest, expected_target_count,
         materialized_target_count, created_at, updated_at, materialized_at
       ) VALUES (?, 1, ?, 0, 0, ?, 'dews', 'materialized', 1, 1,
                 '{}', ?, 1, 1, ?, ?, ?)`,
    )
    .run(fixture.id, planKey, chatId, "a".repeat(64), detectedAt, detectedAt, detectedAt);
  sqlite
    .prepare(
      `INSERT INTO telegram_alert_target_plan_items (
         source_event_id, plan_generation, plan_key, item_key, created_at
       ) VALUES (?, 1, ?, 'dews:usdc-circle', ?)`,
    )
    .run(fixture.id, planKey, detectedAt);
  sqlite
    .prepare(
      `INSERT INTO telegram_alert_target_expiry_progress (
         source_event_id, plan_generation, state, started_at, updated_at, completed_at
       ) VALUES (?, 1, 'complete', ?, ?, ?)`,
    )
    .run(fixture.id, detectedAt, detectedAt, detectedAt);
  sqlite
    .prepare(
      `INSERT INTO telegram_alert_source_resolution_pages (
         source_event_id, page_key, alert_type, page_index, status, created_at, updated_at
       ) VALUES (?, 'dews:0', 'dews', 0, 'complete', ?, ?)`,
    )
    .run(fixture.id, detectedAt, detectedAt);
  sqlite
    .prepare(
      `INSERT INTO telegram_alert_source_resolution_memberships (
         source_event_id, alert_type, preset_id, stablecoin_id, created_at
       ) VALUES (?, 'dews', 'preset-depeg-risk', 'usdc-circle', ?)`,
    )
    .run(fixture.id, detectedAt);
  sqlite
    .prepare(
      `INSERT INTO telegram_alert_source_resolution_targets (
         source_event_id, page_key, preset_id, chat_id, created_at
       ) VALUES (?, 'dews:0', 'preset-depeg-risk', ?, ?)`,
    )
    .run(fixture.id, chatId, detectedAt);
  sqlite
    .prepare(
      `INSERT INTO telegram_alert_jobs (
         job_id, alert_type, source_event_id, severity, created_at, expires_at, status
       ) VALUES (?, 'dews', ?, 'risk', ?, ?, 'sent')`,
    )
    .run(jobId, fixture.id, detectedAt, NOW_SEC + DAY_SEC);
  sqlite
    .prepare(
      `INSERT INTO telegram_alert_job_targets (
         job_id, target_key, chat_id, chunk_index, alert_type, status,
         pending_dedupe_key, created_at, effect_state, source_event_id,
         plan_generation, plan_key, final_delivery_state
       ) VALUES (?, ?, ?, 0, 'dews', 'sent', ?, ?, ?, ?, 1, ?, ?)`,
    )
    .run(
      jobId,
      targetKey,
      chatId,
      `dedupe-${fixture.id}`,
      detectedAt,
      fixture.effectState,
      fixture.id,
      planKey,
      fixture.finalDeliveryState,
    );
  sqlite
    .prepare(
      `UPDATE telegram_alert_source_events
          SET status = ?, target_plan_state = ?, completed_at = ?
        WHERE source_event_id = ?`,
    )
    .run(
      fixture.terminal ? "complete" : "planned",
      fixture.terminal ? "delivery_open" : "planning",
      completedAt,
      fixture.id,
    );
}

function countForSource(sqlite: DatabaseSync, table: string, sourceEventId: string): number {
  const allowedTables = new Set([
    "telegram_alert_source_events",
    "telegram_alert_planning_subscribers",
    "telegram_alert_target_plan_pages",
    "telegram_alert_target_plans",
    "telegram_alert_target_plan_items",
    "telegram_alert_target_expiry_progress",
    "telegram_alert_source_resolution_pages",
    "telegram_alert_source_resolution_memberships",
    "telegram_alert_source_resolution_targets",
    "telegram_alert_jobs",
    "telegram_alert_job_targets",
  ]);
  if (!allowedTables.has(table)) throw new Error(`Unsupported fixture table ${table}`);
  return Number(
    sqlite.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE source_event_id = ?`).get(sourceEventId)?.count ?? 0,
  );
}

describe("runTelegramRetentionCleanup", () => {
  it("batches independent retention steps and reports previously grouped per-entry caps", async () => {
    const { db } = setupLatestSchema();
    const batch = vi.spyOn(db, "batch");
    const result = await runTelegramRetentionCleanup(db);
    const metadata = JSON.parse(result.metadata!);
    expect(batch.mock.calls.length).toBeLessThanOrEqual(15);
    expect(batch.mock.calls.filter(([statements]) => statements.length > 1).length).toBeGreaterThanOrEqual(6);
    expect(metadata.retentionTruncated).toMatchObject({
      legacyTargetItems: false, legacyTargets: false, legacyTerminalJobs: false,
      staleUnresolvedJobs: false, staleUnresolvedSources: false,
      replayJobTargetItems: false, replayJobTargets: false, replayJobs: false,
      replaySourceEvents: false, auditJobTargetItems: false, auditJobTargets: false,
      auditSourceEvents: false, commandCooldownCache: false, miniAppAdoptionSessionCache: false,
    });
  });

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

  it.each([
    { table: "telegram_usage_daily", insert: insertUsageDaily, metadataKey: "usageDailyPruned" },
    { table: "telegram_watcher_lifecycle_daily", insert: insertWatcherLifecycle, metadataKey: "watcherLifecyclePruned" },
  ])("keeps fresh $table rows from today", async ({ table, insert, metadataKey }) => {
    const { sqlite, db } = setupLatestSchema();
    const now = Math.floor(Date.now() / 1000);
    insert(sqlite, todayString(now));

    const result = await runTelegramRetentionCleanup(db);

    expect(countRows(sqlite, table)).toBe(1);
    const metadata = JSON.parse(result.metadata!) as Record<string, number>;
    expect(metadata[metadataKey]).toBe(0);
  });

  it("prunes telegram_watcher_lifecycle_daily rows older than the YYYY-MM-DD cutoff", async () => {
    const { sqlite, db } = setupLatestSchema();
    insertWatcherLifecycle(sqlite, "2024-01-01");

    const result = await runTelegramRetentionCleanup(db);

    expect(countRows(sqlite, "telegram_watcher_lifecycle_daily")).toBe(0);
    const metadata = JSON.parse(result.metadata!) as { watcherLifecyclePruned: number };
    expect(metadata.watcherLifecyclePruned).toBe(1);
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

  it("preserves retired recap audit cutoffs and never prunes nonterminal targets", async () => {
    const { sqlite, db } = setupLatestSchema();
    vi.useFakeTimers();
    vi.setSystemTime(NOW_SEC * 1000);
    try {
      const retained: string[] = [];
      for (const status of ["sent", "skipped_no_changes", "skipped_paused", "skipped_stale", "cancelled", "expired", "execution_unknown", "failed_permanent", "planned", "queued"]) {
        const retentionDays = status === "sent" || status.startsWith("skipped_") ? 30 : 90;
        for (const offset of [-1, 0, 1]) {
          const key = `${status}:${offset}`;
          const updatedAt = NOW_SEC - retentionDays * DAY_SEC + offset;
          sqlite.prepare(`INSERT INTO telegram_recap_targets
            (recap_key, chat_id, local_date, window_start_at, window_end_at,
             preference_generation, watchlist_fingerprint, status, created_at, updated_at)
            VALUES (?, ?, '2026-07-11', 0, 0, 1, 'retired-watchlist', ?, ?, ?)`)
            .run(key, key, status, updatedAt, updatedAt);
          if (offset >= 0 || status === "planned" || status === "queued") retained.push(key);
        }
      }
      await runTelegramRetentionCleanup(db);
      expect(sqlite.prepare("SELECT recap_key FROM telegram_recap_targets ORDER BY recap_key").all())
        .toEqual(retained.sort().map((recap_key) => ({ recap_key })));
    } finally {
      vi.useRealTimers();
    }
  });

  it("caps processed-update retention to one bounded run and reports a lower-bound backlog", async () => {
    const { sqlite, db } = setupLatestSchema();
    const now = Math.floor(Date.now() / 1000);
    const staleReceivedAt = now - 8 * 24 * 60 * 60;
    insertProcessedUpdates(sqlite, 12_001, staleReceivedAt);

    const result = await runTelegramRetentionCleanup(db, undefined, { monotonicNow: () => 0 });

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

  it("reaps old sent pending rows while retaining recent delivery evidence", async () => {
    const { sqlite, db } = setupLatestSchema();
    const now = 1_800_000_000;
    const insert = sqlite.prepare(
      `INSERT INTO telegram_pending_alerts
         (id, chat_id, message_html, created_at, updated_at, delivery_state, delivery_completed_at)
       VALUES (?, ?, 'sent', ?, ?, 'sent', ?)`,
    );
    const oldCompletedAt = now - TELEGRAM_PENDING_SENT_RETENTION_SEC - 1;
    const recentCompletedAt = now - TELEGRAM_PENDING_SENT_RETENTION_SEC + 1;
    insert.run(1, "old-chat", oldCompletedAt, oldCompletedAt, oldCompletedAt);
    insert.run(2, "recent-chat", recentCompletedAt, recentCompletedAt, recentCompletedAt);

    await expect(cleanupExpiredPendingAlerts(db, now)).resolves.toBe(1);
    expect(sqlite.prepare(
      "SELECT id, delivery_completed_at FROM telegram_pending_alerts ORDER BY id",
    ).all()).toEqual([{ id: 2, delivery_completed_at: recentCompletedAt }]);
  });
});

describe("telegram authoritative retention", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("prunes terminal workflow rows and settled replay bundles without deleting ambiguous or active work", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW_SEC * 1000);
    const { sqlite, db } = setupLatestSchema();
    insertSourceBundle(sqlite, {
      id: "stale-settled",
      ageDays: 15,
      terminal: true,
      finalDeliveryState: "accepted",
      effectState: "complete",
    });
    insertSourceBundle(sqlite, {
      id: "stale-unknown",
      ageDays: 15,
      terminal: true,
      finalDeliveryState: "execution_unknown",
      effectState: "execution_unknown",
    });
    insertSourceBundle(sqlite, {
      id: "fresh-settled",
      ageDays: 0.5,
      terminal: true,
      finalDeliveryState: "accepted",
      effectState: "complete",
    });
    insertSourceBundle(sqlite, {
      id: "old-active",
      ageDays: 15,
      terminal: false,
      finalDeliveryState: "accepted",
      effectState: "complete",
    });

    const terminalSourcePlan = sqlite
      .prepare(
        `EXPLAIN QUERY PLAN
         SELECT source_event_id
           FROM telegram_alert_source_events
          WHERE completed_at < ?
            AND status IN ('complete', 'expired')
          ORDER BY completed_at ASC, source_event_id ASC`,
      )
      .all(NOW_SEC - DAY_SEC) as Array<{ detail: string }>;
    expect(terminalSourcePlan.some((row) => row.detail.includes("idx_tase_terminal_completed"))).toBe(true);

    const result = await runTelegramRetentionCleanup(db);
    const metadata = JSON.parse(result.metadata!) as Record<string, unknown>;
    const workflowTables = [
      "telegram_alert_planning_subscribers",
      "telegram_alert_target_plan_pages",
      "telegram_alert_target_plan_items",
      "telegram_alert_target_expiry_progress",
    ];
    const replayTables = [
      "telegram_alert_source_events",
      "telegram_alert_target_plans",
      "telegram_alert_jobs",
      "telegram_alert_job_targets",
    ];

    for (const table of [...workflowTables, ...replayTables]) {
      expect(countForSource(sqlite, table, "stale-settled"), table).toBe(0);
    }
    for (const table of workflowTables) {
      expect(countForSource(sqlite, table, "stale-unknown"), table).toBe(0);
    }
    for (const table of replayTables) {
      expect(countForSource(sqlite, table, "stale-unknown"), table).toBe(1);
    }
    for (const sourceEventId of ["fresh-settled", "old-active"]) {
      for (const table of [...workflowTables, ...replayTables]) {
        expect(countForSource(sqlite, table, sourceEventId), `${sourceEventId}:${table}`).toBe(1);
      }
    }
    expect(metadata).toMatchObject({
      planningSubscribersPruned: 2,
      targetPlanPagesPruned: 2,
      targetPlanItemsPruned: 2,
      targetExpiryProgressPruned: 2,
      sourceResolutionPagesPruned: 2,
      sourceResolutionMembershipsPruned: 2,
      sourceResolutionTargetsPruned: 2,
      sourceEventsPruned: 1,
      jobsPruned: 1,
      jobTargetsPruned: 1,
      replayJobTargetsPruned: 1,
      targetPlansPruned: 1,
      replayJobsPruned: 1,
      replaySourceEventsPruned: 1,
      retentionDays: {
        alertAudit: 90,
        authoritativeWorkflow: 1,
        authoritativeReplay: 14,
      },
    });
  });

  it("prunes legacy terminal targets at 14 days while protecting boundary and active delivery states", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW_SEC * 1000);
    const { sqlite, db } = setupLatestSchema();
    insertLegacyTargetBundle(sqlite, {
      id: "eligible-child",
      ageSec: 14 * DAY_SEC + 1,
      withItem: true,
    });
    insertLegacyTargetBundle(sqlite, {
      id: "eligible-degraded",
      ageSec: 15 * DAY_SEC,
      targetStatus: "failed",
      jobStatus: "degraded",
      finalDeliveryState: "failed",
    });
    insertLegacyTargetBundle(sqlite, {
      id: "boundary",
      ageSec: 14 * DAY_SEC,
    });
    insertLegacyTargetBundle(sqlite, {
      id: "fresh",
      ageSec: 13 * DAY_SEC,
    });
    insertLegacyTargetBundle(sqlite, {
      id: "pending",
      ageSec: 15 * DAY_SEC,
      activePendingState: "pending",
    });
    insertLegacyTargetBundle(sqlite, {
      id: "pending-sending",
      ageSec: 15 * DAY_SEC,
      activePendingState: "sending",
    });
    insertLegacyTargetBundle(sqlite, {
      id: "pending-unknown",
      ageSec: 15 * DAY_SEC,
      activePendingState: "execution_unknown",
    });
    insertLegacyTargetBundle(sqlite, {
      id: "effect-claimed",
      ageSec: 15 * DAY_SEC,
      effectState: "claimed",
    });
    insertLegacyTargetBundle(sqlite, {
      id: "effect-sending",
      ageSec: 15 * DAY_SEC,
      effectState: "sending",
    });
    insertLegacyTargetBundle(sqlite, {
      id: "effect-unknown",
      ageSec: 15 * DAY_SEC,
      effectState: "execution_unknown",
    });
    insertLegacyTargetBundle(sqlite, {
      id: "delivery-unknown",
      ageSec: 15 * DAY_SEC,
      effectState: "complete",
      finalDeliveryState: "execution_unknown",
    });

    const result = await runTelegramRetentionCleanup(db);
    const metadata = JSON.parse(result.metadata!) as {
      highGrowthRetention: {
        legacyTargetItemsPruned: number;
        legacyTargetsPruned: number;
        legacyTerminalJobsPruned: number;
        terminalCutoff: number;
        unresolvedCutoff: number;
        rowLimit: number;
        oldestLegacyTargetRemainingAt: number | null;
        oldestLegacyTargetEligibleAt: number | null;
        error: string | null;
      };
      retentionDays: { staleUnresolved: number };
    };

    expect(result.status).toBe("ok");
    expect(metadata.highGrowthRetention.legacyTargetItemsPruned).toBe(1);
    expect(metadata.highGrowthRetention.legacyTargetsPruned).toBe(2);
    expect(metadata.highGrowthRetention.legacyTerminalJobsPruned).toBe(1);
    expect(
      sqlite
        .prepare("SELECT job_id FROM telegram_alert_job_target_items WHERE job_id = 'legacy-job-eligible-child'")
        .get(),
    ).toBeUndefined();
    expect(
      sqlite
        .prepare("SELECT job_id FROM telegram_alert_job_targets WHERE job_id = 'legacy-job-eligible-child'")
        .get(),
    ).toBeUndefined();
    expect(
      sqlite
        .prepare("SELECT job_id FROM telegram_alert_jobs WHERE job_id = 'legacy-job-eligible-child'")
        .get(),
    ).toBeUndefined();
    expect(
      sqlite
        .prepare("SELECT job_id FROM telegram_alert_jobs WHERE job_id = 'legacy-job-eligible-degraded'")
        .get(),
    ).toBeDefined();
    for (const id of [
      "boundary",
      "fresh",
      "pending",
      "pending-sending",
      "pending-unknown",
      "effect-claimed",
      "effect-sending",
      "effect-unknown",
      "delivery-unknown",
    ]) {
      expect(
        sqlite
          .prepare("SELECT job_id FROM telegram_alert_job_targets WHERE job_id = ?")
          .get(`legacy-job-${id}`),
        id,
      ).toBeDefined();
    }
    expect(metadata.highGrowthRetention).toMatchObject({
      terminalCutoff: NOW_SEC - 14 * DAY_SEC,
      unresolvedCutoff: NOW_SEC - 30 * DAY_SEC,
      rowLimit: 100_000,
      oldestLegacyTargetRemainingAt: NOW_SEC - 15 * DAY_SEC,
      oldestLegacyTargetEligibleAt: null,
      error: null,
    });
    expect(metadata.retentionDays.staleUnresolved).toBe(30);
  });

  it("continues bounded legacy-target cleanup across runs without orphaning child items", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW_SEC * 1000);
    const { sqlite, db } = setupLatestSchema();
    for (const id of ["one", "two", "three"]) {
      insertLegacyTargetBundle(sqlite, {
        id,
        ageSec: 15 * DAY_SEC,
        withItem: true,
      });
    }

    const first = await runTelegramRetentionCleanup(db, undefined, { highGrowthDeleteLimit: 2 });
    const firstMetadata = JSON.parse(first.metadata!) as {
      highGrowthRetention: {
        legacyTargetItemsPruned: number;
        legacyTargetsPruned: number;
        cappedAtLimit: boolean;
        oldestLegacyTargetEligibleAt: number | null;
      };
      runBudgetTruncated: boolean;
    };
    expect(firstMetadata).toMatchObject({
      highGrowthRetention: {
        legacyTargetItemsPruned: 2,
        legacyTargetsPruned: 2,
        cappedAtLimit: true,
        oldestLegacyTargetEligibleAt: NOW_SEC - 15 * DAY_SEC,
      },
      runBudgetTruncated: true,
    });
    expect(
      Number(sqlite.prepare("SELECT COUNT(*) AS count FROM telegram_alert_job_target_items").get()?.count),
    ).toBe(1);
    expect(
      Number(sqlite.prepare("SELECT COUNT(*) AS count FROM telegram_alert_job_targets").get()?.count),
    ).toBe(1);

    const second = await runTelegramRetentionCleanup(db, undefined, { highGrowthDeleteLimit: 2 });
    const secondMetadata = JSON.parse(second.metadata!) as {
      highGrowthRetention: {
        legacyTargetItemsPruned: number;
        legacyTargetsPruned: number;
        cappedAtLimit: boolean;
        oldestLegacyTargetEligibleAt: number | null;
      };
    };
    expect(secondMetadata).toMatchObject({
      highGrowthRetention: {
        legacyTargetItemsPruned: 1,
        legacyTargetsPruned: 1,
        cappedAtLimit: false,
        oldestLegacyTargetEligibleAt: null,
      },
    });
    expect(
      Number(sqlite.prepare("SELECT COUNT(*) AS count FROM telegram_alert_job_target_items").get()?.count),
    ).toBe(0);
    expect(
      Number(sqlite.prepare("SELECT COUNT(*) AS count FROM telegram_alert_job_targets").get()?.count),
    ).toBe(0);
  });

  it("prunes only unreferenced stale unresolved sources and source-less unresolved jobs after 30 days", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW_SEC * 1000);
    const { sqlite, db } = setupLatestSchema();
    insertUnresolvedSource(sqlite, "stale-orphan", 30 * DAY_SEC + 1);
    insertUnresolvedSource(sqlite, "boundary", 30 * DAY_SEC);
    insertUnresolvedSource(sqlite, "referenced", 31 * DAY_SEC, { referencedByJob: true });
    insertUnresolvedSource(sqlite, "pending-reference", 31 * DAY_SEC, { referencedByPending: true });
    insertUnresolvedSource(sqlite, "dead-letter-reference", 31 * DAY_SEC, { referencedByDeadLetter: true });
    insertUnresolvedSource(sqlite, "freeze-reference", 31 * DAY_SEC, { referencedByFreeze: true });
    insertUnresolvedSource(sqlite, "not-expired", 31 * DAY_SEC, { expiresAt: NOW_SEC + DAY_SEC });
    insertLegacyTargetBundle(sqlite, {
      id: "stale-queued",
      ageSec: 31 * DAY_SEC,
      jobStatus: "queued",
    });
    insertLegacyTargetBundle(sqlite, {
      id: "fresh-queued",
      ageSec: 29 * DAY_SEC,
      jobStatus: "queued",
    });

    const result = await runTelegramRetentionCleanup(db);
    const metadata = JSON.parse(result.metadata!) as {
      highGrowthRetention: {
        staleUnresolvedJobsPruned: number;
        staleUnresolvedSourcesPruned: number;
        oldestUnresolvedSourceRemainingAt: number | null;
        error: string | null;
      };
    };

    expect(result.status).toBe("ok");
    expect(metadata.highGrowthRetention.staleUnresolvedJobsPruned).toBe(1);
    expect(metadata.highGrowthRetention.staleUnresolvedSourcesPruned).toBe(1);
    expect(
      sqlite.prepare("SELECT source_event_id FROM telegram_alert_source_events WHERE source_event_id = 'stale-orphan'").get(),
    ).toBeUndefined();
    for (const id of [
      "boundary",
      "referenced",
      "pending-reference",
      "dead-letter-reference",
      "freeze-reference",
      "not-expired",
    ]) {
      expect(
        sqlite.prepare("SELECT source_event_id FROM telegram_alert_source_events WHERE source_event_id = ?").get(id),
        id,
      ).toBeDefined();
    }
    expect(
      sqlite.prepare("SELECT job_id FROM telegram_alert_jobs WHERE job_id = 'legacy-job-stale-queued'").get(),
    ).toBeUndefined();
    expect(
      sqlite.prepare("SELECT job_id FROM telegram_alert_jobs WHERE job_id = 'legacy-job-fresh-queued'").get(),
    ).toBeDefined();
    expect(metadata.highGrowthRetention).toMatchObject({
      oldestUnresolvedSourceRemainingAt: NOW_SEC - 31 * DAY_SEC,
      error: null,
    });
  });

  it("applies the configured high-growth limit to job and unresolved-source residue", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW_SEC * 1000);
    const { sqlite, db } = setupLatestSchema();
    const insertJob = sqlite.prepare(
      `INSERT INTO telegram_alert_jobs (
         job_id, alert_type, source_event_id, severity, created_at, expires_at, status
       ) VALUES (?, 'dews', ?, 'risk', ?, ?, ?)`,
    );
    for (const index of [1, 2, 3]) {
      insertJob.run(
        `terminal-${index}`,
        `missing-terminal-source-${index}`,
        NOW_SEC - 15 * DAY_SEC,
        NOW_SEC + DAY_SEC,
        "sent",
      );
      insertJob.run(
        `unresolved-${index}`,
        `missing-unresolved-source-${index}`,
        NOW_SEC - 31 * DAY_SEC,
        NOW_SEC + DAY_SEC,
        "queued",
      );
      insertUnresolvedSource(sqlite, `unresolved-source-${index}`, 31 * DAY_SEC);
    }

    const result = await runTelegramRetentionCleanup(db, undefined, { highGrowthDeleteLimit: 2 });
    const metadata = JSON.parse(result.metadata!) as {
      highGrowthRetention: {
        legacyTerminalJobsPruned: number;
        staleUnresolvedJobsPruned: number;
        staleUnresolvedSourcesPruned: number;
        rowLimit: number;
        cappedAtLimit: boolean;
      };
    };

    expect(metadata).toMatchObject({
      highGrowthRetention: {
        legacyTerminalJobsPruned: 2,
        staleUnresolvedJobsPruned: 2,
        staleUnresolvedSourcesPruned: 2,
        rowLimit: 2,
        cappedAtLimit: true,
      },
    });
    expect(Number(sqlite.prepare("SELECT COUNT(*) AS count FROM telegram_alert_jobs").get()?.count)).toBe(2);
    expect(
      Number(sqlite.prepare("SELECT COUNT(*) AS count FROM telegram_alert_source_events").get()?.count),
    ).toBe(1);
  });

  it("degrades only the high-growth family when its cleanup query fails", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW_SEC * 1000);
    const { db } = setupLatestSchema();
    const isolatedDb = {
      ...db,
      prepare: (sql: string) => {
        if (sql.includes("pharos:telegram:legacy-terminal-target-items-retention")) {
          throw new Error("injected Telegram high-growth cleanup failure");
        }
        return db.prepare(sql);
      },
    } as D1Database;

    const result = await runTelegramRetentionCleanup(isolatedDb);
    const metadata = JSON.parse(result.metadata!) as {
      highGrowthRetention: { error: string | null };
      usageDailyPruned: number;
    };

    expect(result.status).toBe("degraded");
    expect(metadata.highGrowthRetention.error).toContain("injected Telegram high-growth cleanup failure");
    expect(metadata.usageDailyPruned).toBe(0);
  });
  it.each([
    { sourceAgeDays: 20, targetAgeDays: 20, remaining: 0 },
    { sourceAgeDays: 14, targetAgeDays: 14, remaining: 1 },
    { sourceAgeDays: 0, targetAgeDays: 91, remaining: 0 },
    { sourceAgeDays: 0, targetAgeDays: 90, remaining: 1 },
  ])("keeps delivery-window coverage unknown across source/creation prune boundaries: %j", async ({
    sourceAgeDays, targetAgeDays, remaining,
  }) => {
    const { sqlite, db } = createLatestSchemaSqlite();
    const clock = vi.spyOn(Date, "now").mockReturnValue(NOW_SEC * 1000);
    try {
      const completedAt = NOW_SEC - sourceAgeDays * DAY_SEC;
      const createdAt = NOW_SEC - targetAgeDays * DAY_SEC;
      sqlite.prepare(`INSERT INTO telegram_alert_source_events (
        source_event_id, schema_version, status, detected_at, expires_at,
        event_payload, baseline_payload, target_plan_state, target_plan_generation, completed_at
      ) VALUES ('source', 1, 'planned', ?, ?, '{}', '{}', 'planning', 1, ?)`)
        .run(completedAt, NOW_SEC + DAY_SEC, completedAt);
      sqlite.prepare(`INSERT INTO telegram_alert_jobs (
        job_id, alert_type, source_event_id, severity, created_at, expires_at, status
      ) VALUES ('job', 'dews', 'source', 'risk', ?, ?, 'sent')`)
        .run(createdAt, NOW_SEC + DAY_SEC);
      sqlite.prepare(`INSERT INTO telegram_alert_job_targets (
        job_id, target_key, chat_id, chunk_index, alert_type, status,
        pending_dedupe_key, created_at, effect_state, source_event_id,
        plan_generation, plan_key, final_delivery_state, final_delivery_at
      ) VALUES ('job', 'target', 'chat', 0, 'dews', 'sent',
        'dedupe', ?, 'complete', 'source', 1, 'plan', 'accepted', ?)`)
        .run(createdAt, NOW_SEC - 2 * DAY_SEC);
      sqlite.exec(`UPDATE telegram_alert_source_events
        SET status = 'complete', target_plan_state = 'delivery_open' WHERE source_event_id = 'source'`);
      const client = {
        queryRaw: () => "",
        executeStatements: () => undefined,
        query<T>(sql: string): T[] { return sqlite.prepare(sql).all() as T[]; },
      };
      expect(collectTelegramAdoptionReport(client, NOW_SEC).adoption.retainedAlertsSent7d).toBe(1);
      await runTelegramRetentionCleanup(db);
      const report = collectTelegramAdoptionReport(client, NOW_SEC);
      expect(report.adoption.retainedAlertsSent7d).toBe(remaining);
      expect(report.adoption.retainedAlertsSent30d).toBe(remaining);
      expect(report.adoption.alertsSent7d).toBeNull();
      expect(report.adoption.alertsSent30d).toBeNull();
      expect(report.adoption.alertsSent7dUnavailableReason).toBe("delivery-window-coverage-unproven");
    } finally {
      clock.mockRestore();
      sqlite.close();
    }
  });
});
