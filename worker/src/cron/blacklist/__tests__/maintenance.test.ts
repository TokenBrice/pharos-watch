import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildBlacklistAmountRepairQueueUpdate, refreshBlacklistAmountRepairQueue } from "../../../lib/blacklist/amount-repair-queue";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import { makePendingBlacklistRow } from "./blacklist.test-support";
import { insertBlacklistRows } from "../persistence";

const fixtures = createLatestSchemaFixtureTracker();
afterEach(() => fixtures.closeAll());

describe("blacklist amount repair queue", () => {
  it("backs off initial enqueue after an ingestion attempt while untouched pending rows stay due", async () => {
    const { db, sqlite } = fixtures.open();
    await insertBlacklistRows(db, [
      makePendingBlacklistRow({ id: "deferred" }),
      makePendingBlacklistRow({ id: "failed", amount_status: "provider_failed", amount_attempt_count: 1, amount_last_attempted_at: 1000 }),
      makePendingBlacklistRow({ id: "old-failure", amount_status: "provider_failed", amount_attempt_count: 1, amount_last_attempted_at: 500 }),
    ]);

    await refreshBlacklistAmountRepairQueue(db, 1000);
    expect(sqlite.prepare("SELECT event_id, available_at, attempt_count FROM blacklist_amount_repair_queue ORDER BY event_id").all()).toEqual([
      { event_id: "deferred", available_at: 0, attempt_count: 0 },
      { event_id: "failed", available_at: 1300, attempt_count: 0 },
      { event_id: "old-failure", available_at: 800, attempt_count: 0 },
    ]);
    expect(sqlite.prepare("SELECT event_id FROM blacklist_amount_repair_queue WHERE available_at <= ? ORDER BY event_id").all(1000))
      .toEqual([{ event_id: "deferred" }, { event_id: "old-failure" }]);

    await refreshBlacklistAmountRepairQueue(db, 1200);
    expect(sqlite.prepare("SELECT available_at FROM blacklist_amount_repair_queue WHERE event_id = 'failed'").get())
      .toEqual({ available_at: 1300 });
    expect(sqlite.prepare("SELECT event_id FROM blacklist_amount_repair_queue WHERE available_at <= ? ORDER BY event_id").all(1300))
      .toEqual([{ event_id: "deferred" }, { event_id: "failed" }, { event_id: "old-failure" }]);
  });

  it("enqueues legacy EVM proof reviews without reopening gap status or terminal queue attempts", async () => {
    const { db, sqlite } = fixtures.open();
    await insertBlacklistRows(db, [
      makePendingBlacklistRow({ id: "legacy", amount_status: "permanently_unavailable", amount_last_error_class: "event_time_unproven" }),
      makePendingBlacklistRow({ id: "suppressed", amount_status: "permanently_unavailable", amount_last_error_class: "event_time_unproven" }),
      makePendingBlacklistRow({ id: "other", amount_status: "permanently_unavailable", amount_last_error_class: "event_time_unreconciled" }),
      makePendingBlacklistRow({ id: "destroy", event_type: "destroy", amount_status: "permanently_unavailable", amount_last_error_class: "event_time_unproven" }),
      makePendingBlacklistRow({ id: "tron", chain_id: "tron", amount_status: "permanently_unavailable", amount_last_error_class: "event_time_unproven" }),
    ]);
    sqlite.prepare("UPDATE blacklist_events SET suppression_reason = 'operator-suppressed' WHERE id = 'suppressed'").run();
    await refreshBlacklistAmountRepairQueue(db, 1000);
    expect(sqlite.prepare("SELECT event_id, reason, status FROM blacklist_amount_repair_queue").all()).toEqual([
      { event_id: "legacy", reason: "legacy-evm-event-time-unproven", status: "pending" },
    ]);
    expect(sqlite.prepare("SELECT DISTINCT amount_status FROM blacklist_events").all())
      .toEqual([{ amount_status: "permanently_unavailable" }]);
    sqlite.prepare("UPDATE blacklist_amount_repair_queue SET status = 'unrecoverable', attempt_count = 3 WHERE event_id = 'legacy'").run();
    await refreshBlacklistAmountRepairQueue(db, 2000);
    expect(sqlite.prepare("SELECT status, attempt_count FROM blacklist_amount_repair_queue").get())
      .toEqual({ status: "unrecoverable", attempt_count: 3 });
  });

  it("enqueues eligible EVM and Tron events and legacy zeros while excluding resolved amounts and Tron releases", async () => {
    const { db, sqlite } = fixtures.open();
    await insertBlacklistRows(db, [
      makePendingBlacklistRow({ id: "pending", amount_status: "recoverable_pending" }),
      makePendingBlacklistRow({ id: "failed", amount_status: "provider_failed" }),
      makePendingBlacklistRow({ id: "ambiguous", amount_status: "ambiguous" }),
      makePendingBlacklistRow({ id: "destroy", event_type: "destroy", amount_status: "recoverable_pending" }),
      makePendingBlacklistRow({ id: "evm-release", event_type: "unblacklist", amount_status: "recoverable_pending" }),
      makePendingBlacklistRow({ id: "tron", chain_id: "tron", amount_status: "recoverable_pending" }),
      makePendingBlacklistRow({
        id: "tron-release-terminal",
        chain_id: "tron",
        event_type: "unblacklist",
        amount_status: "permanently_unavailable",
        amount_last_error_class: "tron_release_amount_not_tracked",
      }),
      makePendingBlacklistRow({
        id: "tron-release-legacy-pending",
        chain_id: "tron",
        event_type: "unblacklist",
        amount_status: "recoverable_pending",
      }),
      makePendingBlacklistRow({ id: "resolved", amount_native: 10, amount_source: "derived", amount_status: "resolved" }),
      makePendingBlacklistRow({ id: "legacy-zero", amount_native: 0, amount_source: "derived", amount_status: "resolved" }),
    ]);
    await refreshBlacklistAmountRepairQueue(db, 1000);
    expect(sqlite.prepare("SELECT event_id, priority, reason FROM blacklist_amount_repair_queue ORDER BY event_id").all()).toEqual([
      { event_id: "ambiguous", priority: 30, reason: "missing-event-amount" },
      { event_id: "destroy", priority: 10, reason: "missing-event-amount" },
      { event_id: "evm-release", priority: 20, reason: "missing-event-amount" },
      { event_id: "failed", priority: 40, reason: "missing-event-amount" },
      { event_id: "legacy-zero", priority: 40, reason: "legacy-derived-zero" },
      { event_id: "pending", priority: 20, reason: "missing-event-amount" },
      { event_id: "tron", priority: 20, reason: "missing-event-amount" },
    ]);
  });

  it("stores saturated retries and terminal completion", async () => {
    const { db, sqlite } = fixtures.open();
    await insertBlacklistRows(db, [makePendingBlacklistRow({ id: "retry", amount_status: "provider_failed" })]);
    await refreshBlacklistAmountRepairQueue(db, 1000);
    for (const priorAttempts of [6, 100]) {
      await buildBlacklistAmountRepairQueueUpdate(db, {
        eventId: "retry", outcome: "retry", attemptedAt: 1100, priorAttempts, errorClass: "rpc",
      }).run();
      expect(sqlite.prepare("SELECT * FROM blacklist_amount_repair_queue").get()).toMatchObject({
        status: "retry", available_at: 20300, completed_at: null,
      });
    }
    await buildBlacklistAmountRepairQueueUpdate(db, {
      eventId: "retry", outcome: "unrecoverable", attemptedAt: 1200, priorAttempts: 101, errorClass: "unsupported",
    }).run();
    expect(sqlite.prepare("SELECT * FROM blacklist_amount_repair_queue").get()).toMatchObject({
      status: "unrecoverable", attempt_count: 3, available_at: 1200, updated_at: 1200,
      completed_at: 1200, last_error_class: "unsupported",
    });
  });

  it("backfill migration 0322 terminalizes only unsuppressed amountless Tron releases and closes their queue rows", async () => {
    const { db, sqlite } = fixtures.open();
    await insertBlacklistRows(db, [
      makePendingBlacklistRow({ id: "tron-release-pending", chain_id: "tron", chain_name: "Tron", event_type: "unblacklist", amount_status: "recoverable_pending" }),
      makePendingBlacklistRow({ id: "tron-release-failed", chain_id: "tron", chain_name: "Tron", event_type: "unblacklist", amount_status: "provider_failed" }),
      makePendingBlacklistRow({ id: "tron-release-suppressed", chain_id: "tron", chain_name: "Tron", event_type: "unblacklist", amount_status: "recoverable_pending", suppression_reason: "duplicate_log_identity" }),
      makePendingBlacklistRow({ id: "tron-freeze-pending", chain_id: "tron", chain_name: "Tron", event_type: "blacklist", amount_status: "recoverable_pending" }),
      makePendingBlacklistRow({ id: "evm-release-pending", chain_id: "ethereum", chain_name: "Ethereum", event_type: "unblacklist", amount_status: "recoverable_pending" }),
    ]);
    sqlite.exec(`
      INSERT INTO blacklist_amount_repair_queue (event_id, status, priority, reason, attempt_count, available_at, claim_token, lease_expires_at, created_at, updated_at) VALUES
        ('tron-release-pending', 'pending', 20, 'missing-event-amount', 0, 0, NULL, NULL, 1000, 1000),
        ('tron-release-failed', 'running', 40, 'missing-event-amount', 1, 0, 'claim-1', 2000, 1000, 1000),
        ('tron-freeze-pending', 'pending', 20, 'missing-event-amount', 0, 0, NULL, NULL, 1000, 1000),
        ('evm-release-pending', 'pending', 20, 'missing-event-amount', 0, 0, NULL, NULL, 1000, 1000);
    `);

    const migrationSql = readFileSync(
      resolve(process.cwd(), "worker/migrations/0322_tron_unblacklist_amount_status.sql"),
      "utf8",
    );
    sqlite.exec(migrationSql);
    sqlite.exec(migrationSql);

    expect(
      sqlite.prepare("SELECT id, amount_status, amount_last_error_class, amount_attempt_count FROM blacklist_events ORDER BY id").all(),
    ).toEqual([
      { id: "evm-release-pending", amount_status: "recoverable_pending", amount_last_error_class: null, amount_attempt_count: 0 },
      { id: "tron-freeze-pending", amount_status: "recoverable_pending", amount_last_error_class: null, amount_attempt_count: 0 },
      { id: "tron-release-failed", amount_status: "permanently_unavailable", amount_last_error_class: "tron_release_amount_not_tracked", amount_attempt_count: 0 },
      { id: "tron-release-pending", amount_status: "permanently_unavailable", amount_last_error_class: "tron_release_amount_not_tracked", amount_attempt_count: 0 },
      { id: "tron-release-suppressed", amount_status: "recoverable_pending", amount_last_error_class: null, amount_attempt_count: 0 },
    ]);
    expect(
      sqlite.prepare("SELECT event_id, status, last_error_class, claim_token, lease_expires_at, completed_at IS NOT NULL AS has_completed_at FROM blacklist_amount_repair_queue ORDER BY event_id").all(),
    ).toEqual([
      { event_id: "evm-release-pending", status: "pending", last_error_class: null, claim_token: null, lease_expires_at: null, has_completed_at: 0 },
      { event_id: "tron-freeze-pending", status: "pending", last_error_class: null, claim_token: null, lease_expires_at: null, has_completed_at: 0 },
      { event_id: "tron-release-failed", status: "unrecoverable", last_error_class: "tron_release_amount_not_tracked", claim_token: null, lease_expires_at: null, has_completed_at: 1 },
      { event_id: "tron-release-pending", status: "unrecoverable", last_error_class: "tron_release_amount_not_tracked", claim_token: null, lease_expires_at: null, has_completed_at: 1 },
    ]);
  });
});
