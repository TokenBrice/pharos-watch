import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { createSqliteD1 } from "../../test-helpers/sqlite-d1";
import { loadTelegramDeliverySliRollup } from "../telegram-delivery-sli";

const NOW = 1_800_000_000;
const databases: DatabaseSync[] = [];

function setupLatestSchema(): { sqlite: DatabaseSync; db: D1Database } {
  const sqlite = new DatabaseSync(":memory:");
  const migrationDir = process.cwd().endsWith("/worker")
    ? join(process.cwd(), "migrations")
    : join(process.cwd(), "worker/migrations");
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- checked-in migration directory.
  for (const file of readdirSync(migrationDir).filter((entry) => entry.endsWith(".sql")).sort()) {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- checked-in migration replay.
    sqlite.exec(readFileSync(join(migrationDir, file), "utf8"));
  }
  databases.push(sqlite);
  return { sqlite, db: createSqliteD1(sqlite) };
}

afterEach(() => {
  while (databases.length > 0) databases.pop()?.close();
});

function insertSource(sqlite: DatabaseSync, id: string, detectedAt: number, expiresAt: number, plannedAt: number | null): void {
  sqlite.prepare(
    `INSERT INTO telegram_alert_source_events (
       source_event_id, status, detected_at, expires_at, event_payload, baseline_payload,
       target_plan_state, target_plan_generation, target_plan_completed_at
     ) VALUES (?, 'planned', ?, ?, '{}', '{}', 'delivery_open', 1, ?)`,
  ).run(id, detectedAt, expiresAt, plannedAt);
}

function insertJob(sqlite: DatabaseSync, id: string, sourceId: string, alertType: string, createdAt: number, expiresAt: number): void {
  sqlite.prepare(
    `INSERT INTO telegram_alert_jobs (
       job_id, alert_type, source_event_id, severity, created_at, expires_at, status
     ) VALUES (?, ?, ?, 'critical', ?, ?, 'queued')`,
  ).run(id, alertType, sourceId, createdAt, expiresAt);
}

function insertTarget(
  sqlite: DatabaseSync,
  input: {
    jobId: string;
    sourceId: string;
    key: string;
    alertType: string;
    createdAt: number;
    expiresAt?: number | null;
    state?: string | null;
    finalAt?: number | null;
    error?: string | null;
    cancellationReason?: string | null;
  },
): void {
  sqlite.prepare(
    `INSERT INTO telegram_alert_job_targets (
       job_id, target_key, chat_id, alert_type, status, pending_dedupe_key, created_at,
       source_event_id, target_expires_at, final_delivery_state, final_delivery_at,
       final_delivery_error, error_class, cancellation_reason
     ) VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.jobId,
    input.key,
    `chat-${input.key}`,
    input.alertType,
    `dedupe-${input.key}`,
    input.createdAt,
    input.sourceId,
    input.expiresAt ?? null,
    input.state ?? null,
    input.finalAt ?? null,
    input.error ?? null,
    input.error ?? null,
    input.cancellationReason ?? null,
  );
}

describe("Telegram delivery SLI rollup", () => {
  it("derives event and authoritative target SLIs without claiming end-user receipt", async () => {
    const { sqlite, db } = setupLatestSchema();
    insertSource(sqlite, "event-a", NOW - 1_000, NOW + 2_000, NOW - 900);
    insertSource(sqlite, "event-unplanned", NOW - 800, NOW + 2_000, null);
    insertJob(sqlite, "job-a", "event-a", "depeg", NOW - 900, NOW - 100);

    insertTarget(sqlite, {
      jobId: "job-a", sourceId: "event-a", key: "accepted-before", alertType: "depeg",
      createdAt: NOW - 850, state: "accepted", finalAt: NOW - 700,
    });
    insertTarget(sqlite, {
      jobId: "job-a", sourceId: "event-a", key: "accepted-after", alertType: "depeg",
      createdAt: NOW - 840, state: "accepted", finalAt: NOW - 50,
    });
    insertTarget(sqlite, {
      jobId: "job-a", sourceId: "event-a", key: "unknown", alertType: "depeg",
      createdAt: NOW - 2_000, state: "execution_unknown", finalAt: NOW - 1_000, error: "timeout",
    });
    insertTarget(sqlite, {
      jobId: "job-a", sourceId: "event-a", key: "cancel", alertType: "depeg",
      createdAt: NOW - 500, state: "cancelled", finalAt: NOW - 400,
      error: "preference_changed", cancellationReason: "scope_disabled",
    });
    insertTarget(sqlite, {
      jobId: "job-a", sourceId: "event-a", key: "subscriber-gone", alertType: "depeg",
      createdAt: NOW - 450, state: "cancelled", finalAt: NOW - 350,
      cancellationReason: "subscriber_missing",
    });
    insertTarget(sqlite, {
      jobId: "job-a", sourceId: "event-a", key: "preference-variant", alertType: "depeg",
      createdAt: NOW - 430, state: "cancelled", finalAt: NOW - 330,
      cancellationReason: "preference_policy_changed",
    });
    insertTarget(sqlite, {
      jobId: "job-a", sourceId: "event-a", key: "backlog", alertType: "depeg",
      createdAt: NOW - 400,
    });

    sqlite.prepare(
      `INSERT INTO telegram_alert_dead_letters (
         chat_id, message_html, created_at, expired_at, attempts, reason, last_error_class
       ) VALUES ('chat-dead', 'message', ?, ?, 4, 'max_attempts', 'server_error')`,
    ).run(NOW - 700, NOW - 300);

    const report = await loadTelegramDeliverySliRollup(db, { nowSec: NOW });

    expect(report.detectionToPlan).toEqual({
      eligibleCount: 2, observedCount: 1, averageSec: 100, maximumSec: 100, quality: "partial",
    });
    expect(report.planToTelegramAcceptance).toMatchObject({
      eligibleCount: 2, observedCount: 2, averageSec: 525, maximumSec: 850, quality: "complete",
    });
    expect(report.telegramAcceptanceBeforeTtl).toMatchObject({
      telegramAcceptedCount: 2, knownTtlCount: 2, acceptedBeforeTtlCount: 1,
      acceptedAfterTtlCount: 1, rate: 0.5, quality: "complete",
    });
    expect(report.authoritativeTargetOutcomes).toEqual({
      total: 7, telegramAccepted: 2, failed: 0, cancelled: 3, expired: 0,
      executionUnknown: 1, unresolved: 1, telegramAcceptanceRate: 2 / 7,
    });
    expect(report.preferenceChangeCancellations).toMatchObject({
      count: 2,
      reasons: [
        { reason: "preference_policy_changed", count: 1 },
        { reason: "scope_disabled", count: 1 },
      ],
      reasonsTruncated: false,
    });
    expect(report.backlog).toMatchObject({
      windowStartsAt: NOW - 86_400, windowBounded: true, count: 1, oldestAgeSec: 400,
      buckets: [{ priority: 10, ageBucket: "5m_15m", count: 1, oldestAgeSec: 400 }],
    });
    expect(report.executionUnknown).toEqual({ count: 1, oldestAgeSec: 1_000, olderThan15mCount: 1 });
    expect(report.deadLetters).toMatchObject({
      count: 1, totalAttempts: 4,
      reasons: [{ reason: "max_attempts", count: 1 }],
      lastErrorReasons: [{ reason: "server_error", count: 1 }],
    });
    expect(report.evidence).toMatchObject({ latestAt: NOW - 50, ageSec: 50, freshness: "fresh" });
    expect(Object.keys(report.planToTelegramAcceptance).join(" ")).not.toContain("receipt");
  });

  it("caps the scan window and reports empty, stale, and bounded dimensions honestly", async () => {
    const { sqlite, db } = setupLatestSchema();
    insertSource(sqlite, "too-old", NOW - 8 * 86_400, NOW - 7 * 86_400, NOW - 8 * 86_400 + 60);

    const empty = await loadTelegramDeliverySliRollup(db, { nowSec: NOW, lookbackSec: 30 * 86_400 });
    expect(empty.window).toMatchObject({ lookbackSec: 7 * 86_400, bounded: true });
    expect(empty.evidence).toEqual({ latestAt: null, ageSec: null, freshness: "empty", freshnessThresholdSec: 900 });
    expect(empty.detectionToPlan.quality).toBe("empty");

    insertSource(sqlite, "stale", NOW - 4_000, NOW + 1_000, NOW - 3_900);
    insertJob(sqlite, "job-stale", "stale", "reserve", NOW - 3_900, NOW + 1_000);
    for (let index = 0; index < 3; index++) {
      insertTarget(sqlite, {
        jobId: "job-stale", sourceId: "stale", key: `error-${index}`, alertType: "reserve",
        createdAt: NOW - 3_800 + index, state: "failed", finalAt: NOW - 3_700 + index,
        error: `error-${index}`,
      });
    }

    const stale = await loadTelegramDeliverySliRollup(db, {
      nowSec: NOW, lookbackSec: 7_200, freshnessSec: 60, reasonLimit: 2,
    });
    expect(stale.evidence.freshness).toBe("stale");
    expect(stale.observedTargetErrorReasons).toEqual({
      reasons: [
        { reason: "error-0", count: 1 },
        { reason: "error-1", count: 1 },
      ],
      truncated: true,
    });
  });

  it("rejects an invalid observation clock", async () => {
    const { db } = setupLatestSchema();
    await expect(loadTelegramDeliverySliRollup(db, { nowSec: -1 })).rejects.toThrow("nowSec is invalid");
  });
});
