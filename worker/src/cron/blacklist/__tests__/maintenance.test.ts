import { afterEach, describe, expect, it } from "vitest";
import { buildBlacklistAmountRepairQueueUpdate, refreshBlacklistAmountRepairQueue } from "../../../lib/blacklist/amount-repair-queue";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import { makePendingBlacklistRow } from "./blacklist.test-support";
import { insertBlacklistRows } from "../persistence";

const fixtures = createLatestSchemaFixtureTracker();
afterEach(() => fixtures.closeAll());

describe("blacklist amount repair queue", () => {
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

  it("enqueues eligible EVM and Tron events and legacy zeros but excludes resolved amounts", async () => {
    const { db, sqlite } = fixtures.open();
    await insertBlacklistRows(db, [
      makePendingBlacklistRow({ id: "pending", amount_status: "recoverable_pending" }),
      makePendingBlacklistRow({ id: "failed", amount_status: "provider_failed" }),
      makePendingBlacklistRow({ id: "ambiguous", amount_status: "ambiguous" }),
      makePendingBlacklistRow({ id: "destroy", event_type: "destroy", amount_status: "recoverable_pending" }),
      makePendingBlacklistRow({ id: "tron", chain_id: "tron", amount_status: "recoverable_pending" }),
      makePendingBlacklistRow({ id: "resolved", amount_native: 10, amount_source: "derived", amount_status: "resolved" }),
      makePendingBlacklistRow({ id: "legacy-zero", amount_native: 0, amount_source: "derived", amount_status: "resolved" }),
    ]);
    await refreshBlacklistAmountRepairQueue(db, 1000);
    expect(sqlite.prepare("SELECT event_id, priority, reason FROM blacklist_amount_repair_queue ORDER BY event_id").all()).toEqual([
      { event_id: "ambiguous", priority: 30, reason: "missing-event-amount" },
      { event_id: "destroy", priority: 10, reason: "missing-event-amount" },
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
});
