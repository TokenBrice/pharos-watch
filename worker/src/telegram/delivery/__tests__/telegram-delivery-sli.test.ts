import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
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

function insertDeliveries(
  sqlite: DatabaseSync,
  jobId: string,
  rows: {
    chatId: string;
    state: string;
    createdAt: number;
    doneAt?: number | null;
    expiresAt?: number;
    families?: string | null;
    reason?: string | null;
    errorClass?: string | null;
    attempts?: number;
    priority?: number;
  }[],
  kind = "alert",
): void {
  for (const row of rows) sqlite.prepare(
    `INSERT INTO telegram_deliveries (
       job_id, kind, chat_id, seq, body_hash, families, priority, state, attempts,
       next_attempt_at, expires_at, created_at, done_at, reason, error_class
     ) VALUES (?, ?, ?, 0, 'h', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    jobId,
    kind,
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
    insertDeliveries(sqlite, "alert:a", [
      { state: "sent", doneAt: NOW - 580 },
      { state: "sent", doneAt: NOW - 500, families: "depeg,safety" },
      { state: "suppressed_duplicate", doneAt: NOW - 590, reason: "duplicate_prior_delivery" },
      { state: "blocked", doneAt: NOW - 570, reason: "blocked", errorClass: "blocked", attempts: 1 },
      { state: "unknown", doneAt: NOW - 1000 + 100, reason: "ambiguous_send" },
      { state: "cancelled", doneAt: NOW - 590, reason: "coin_snoozed" },
    ].map((row, index) => ({ chatId: String(index + 1), createdAt: NOW - 590, ...row })));
    insertDeliveries(sqlite, "alert:b", [{ chatId: "7", state: "pending", createdAt: NOW - 100, families: "safety", priority: 20 }]);
    insertDeliveries(sqlite, "broadcast:x", [{ chatId: "1", state: "sent", createdAt: NOW - 590, doneAt: NOW - 580, families: "adminBroadcast" }], "broadcast");

    const prepare = vi.spyOn(db, "prepare");
    const rollup = await loadTelegramDeliverySliRollup(db, { nowSec: NOW });
    const sql = prepare.mock.calls[0][0];
    const read = (query: string) => sqlite.prepare(query).get(NOW - 86400, NOW);
    expect(read(sql)).toEqual(read(sql.replace("CROSS JOIN", "JOIN")));
    expect(sqlite.prepare("EXPLAIN QUERY PLAN " + sql).all(NOW - 86400, NOW).map((row) => row.detail).join()).not.toMatch(/SCAN d/);
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

  it("keeps broadcast delivery rows out of every alert-family sub-rollup", async () => {
    const { sqlite, db } = fixtures.open();
    insertJob(sqlite, "broadcast:x", "broadcast", "done", NOW - 600);
    insertDeliveries(sqlite, "broadcast:x", [
      { chatId: "1", state: "pending", createdAt: NOW - 300 },
      { chatId: "2", state: "cancelled", createdAt: NOW - 400, doneAt: NOW - 400, reason: "subscriber_missing" },
      { chatId: "3", state: "failed", createdAt: NOW - 500, doneAt: NOW - 490, reason: "bad_request", errorClass: "bad_request", attempts: 1 },
      { chatId: "4", state: "unknown", createdAt: NOW - 500, doneAt: NOW - 480, reason: "ambiguous_send" },
    ], "broadcast");

    const rollup = await loadTelegramDeliverySliRollup(db, { nowSec: NOW });

    expect(rollup.authoritativeTargetOutcomes).toMatchObject({ total: 0, telegramAcceptanceRate: null });
    expect(rollup.backlog).toMatchObject({ count: 0, oldestAgeSec: null, buckets: [] });
    expect(rollup.preferenceChangeCancellations).toMatchObject({ count: 0, reasons: [] });
    expect(rollup.observedTargetErrorReasons).toEqual({ reasons: [], truncated: false });
    expect(rollup.executionUnknown).toMatchObject({ count: 0, oldestAgeSec: null, olderThan15mCount: 0 });
    expect(rollup.deadLetters).toMatchObject({ count: 0, totalAttempts: 0, reasons: [], lastErrorReasons: [] });
    expect(rollup.evidence.freshness).toBe("empty");
  });
});
