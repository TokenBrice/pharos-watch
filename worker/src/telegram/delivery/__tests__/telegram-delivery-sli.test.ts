import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import { loadTelegramDeliverySliRollup } from "../delivery-sli";

const NOW = 1_800_000_000;
const fixtures = createLatestSchemaFixtureTracker();

afterEach(fixtures.closeAll);

function insertJob(sqlite: DatabaseSync, id: string, kind: string, state: string, createdAt: number): void {
  sqlite.prepare(
    `INSERT INTO telegram_jobs (job_id, kind, payload_json, state, created_at, expires_at)
     VALUES (?, ?, '{}', ?, ?, ?)`,
  ).run(id, kind, state, createdAt, createdAt + 7200);
}

function insertDelivery(
  sqlite: DatabaseSync,
  row: {
    jobId: string;
    chatId: string;
    kind?: string;
    state: string;
    createdAt: number;
    doneAt?: number | null;
    expiresAt?: number;
    families?: string | null;
    reason?: string | null;
    errorClass?: string | null;
    attempts?: number;
    priority?: number;
  },
): void {
  sqlite.prepare(
    `INSERT INTO telegram_deliveries (
       job_id, kind, chat_id, seq, body_hash, families, priority, state, attempts,
       next_attempt_at, expires_at, created_at, done_at, reason, error_class
     ) VALUES (?, ?, ?, 0, 'h', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.jobId,
    row.kind ?? "alert",
    row.chatId,
    row.families === undefined ? "depeg" : row.families,
    row.priority ?? 10,
    row.state,
    row.attempts ?? 0,
    row.createdAt,
    row.expiresAt ?? row.createdAt + 7200,
    row.createdAt,
    row.doneAt ?? null,
    row.reason ?? null,
    row.errorClass ?? null,
  );
}

describe("Telegram delivery SLI rollup (delivery v2)", () => {
  it("derives job and delivery SLIs from telegram_jobs/telegram_deliveries without claiming receipt", async () => {
    const { sqlite, db } = fixtures.open();
    insertJob(sqlite, "alert:a", "alert", "done", NOW - 600);
    insertJob(sqlite, "alert:b", "alert", "planning", NOW - 120);
    insertJob(sqlite, "broadcast:x", "broadcast", "done", NOW - 600);
    insertDelivery(sqlite, { jobId: "alert:a", chatId: "1", state: "sent", createdAt: NOW - 590, doneAt: NOW - 580 });
    insertDelivery(sqlite, { jobId: "alert:a", chatId: "2", state: "sent", createdAt: NOW - 590, doneAt: NOW - 500, families: "depeg,safety" });
    insertDelivery(sqlite, { jobId: "alert:a", chatId: "3", state: "suppressed_duplicate", createdAt: NOW - 590, doneAt: NOW - 590, reason: "duplicate_prior_delivery" });
    insertDelivery(sqlite, { jobId: "alert:a", chatId: "4", state: "blocked", createdAt: NOW - 590, doneAt: NOW - 570, reason: "blocked", errorClass: "blocked", attempts: 1 });
    insertDelivery(sqlite, { jobId: "alert:a", chatId: "5", state: "unknown", createdAt: NOW - 590, doneAt: NOW - 1000 + 100, reason: "ambiguous_send" });
    insertDelivery(sqlite, { jobId: "alert:a", chatId: "6", state: "cancelled", createdAt: NOW - 590, doneAt: NOW - 590, reason: "coin_snoozed" });
    insertDelivery(sqlite, { jobId: "alert:b", chatId: "7", state: "pending", createdAt: NOW - 100, families: "safety", priority: 20 });
    insertDelivery(sqlite, { jobId: "broadcast:x", chatId: "1", kind: "broadcast", state: "sent", createdAt: NOW - 590, doneAt: NOW - 580, families: "adminBroadcast" });

    const rollup = await loadTelegramDeliverySliRollup(db, { nowSec: NOW });
    expect(rollup.detectionToPlan).toMatchObject({ eligibleCount: 2, observedCount: 1, averageSec: 10 });
    expect(rollup.authoritativeTargetOutcomes).toMatchObject({
      total: 7,
      telegramAccepted: 2,
      failed: 1,
      cancelled: 2,
      executionUnknown: 1,
      unresolved: 1,
    });
    expect(rollup.planToTelegramAcceptance).toMatchObject({ eligibleCount: 2, observedCount: 2, maximumSec: 90 });
    expect(rollup.telegramAcceptanceBeforeTtl).toMatchObject({ acceptedBeforeTtlCount: 2, rate: 1 });
    expect(rollup.familyAttribution).toMatchObject({ depeg: 5, safety: 1, mixed: 1, unknown: 0 });
    expect(rollup.preferenceChangeCancellations).toMatchObject({ count: 1, reasons: [{ reason: "coin_snoozed", count: 1 }] });
    expect(rollup.observedTargetErrorReasons.reasons).toContainEqual({ reason: "duplicate_prior_delivery", count: 1 });
    expect(rollup.backlog).toMatchObject({ count: 1, buckets: [{ priority: 20, ageBucket: "lt_5m", count: 1 }] });
    expect(rollup.executionUnknown).toMatchObject({ count: 1, olderThan15mCount: 1, oldestAgeSec: 900 });
    expect(rollup.deadLetters).toMatchObject({ count: 1, totalAttempts: 1, reasons: [{ reason: "blocked", count: 1 }] });
    expect(rollup.evidence.freshness).toBe("fresh");
  });

  it("reports an empty window honestly", async () => {
    const { db } = fixtures.open();
    const rollup = await loadTelegramDeliverySliRollup(db, { nowSec: NOW, lookbackSec: 60 });
    expect(rollup.window.lookbackSec).toBe(300);
    expect(rollup.evidence).toMatchObject({ latestAt: null, freshness: "empty" });
    expect(rollup.authoritativeTargetOutcomes.total).toBe(0);
    expect(rollup.detectionToPlan.quality).toBe("empty");
  });
});
