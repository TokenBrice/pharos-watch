import { afterEach, describe, expect, it } from "vitest";
import { buildBlacklistAmountRepairQueueUpdate, refreshBlacklistAmountRepairQueue } from "../../../lib/blacklist/amount-repair-queue";
import { createLatestSchemaFixtureTracker } from "../../../test-helpers/latest-schema-sqlite";
import { makePendingBlacklistRow } from "./blacklist.test-support";
import { insertBlacklistRows } from "../persistence";

const fixtures = createLatestSchemaFixtureTracker();
afterEach(() => fixtures.closeAll());

describe("blacklist amount repair queue", () => {
  it("enqueues eligible EVM events and legacy zeros but excludes Tron and resolved amounts", async () => {
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
    ]);
  });

  it("reconciles a repaired running event and preserves its first completion timestamp", async () => {
    const { db, sqlite } = fixtures.open();
    await insertBlacklistRows(db, [makePendingBlacklistRow({ id: "repaired", amount_status: "provider_failed" })]);
    await refreshBlacklistAmountRepairQueue(db, 1000);
    sqlite.prepare("UPDATE blacklist_amount_repair_queue SET status = 'running', claim_token = 'owner', lease_expires_at = 5000, last_error_class = 'rpc'").run();
    sqlite.prepare("UPDATE blacklist_events SET amount_status = 'resolved', amount_native = 25").run();
    await refreshBlacklistAmountRepairQueue(db, 1100);
    await refreshBlacklistAmountRepairQueue(db, 1200);
    expect(sqlite.prepare("SELECT * FROM blacklist_amount_repair_queue").get()).toMatchObject({
      event_id: "repaired", status: "resolved", claim_token: null, lease_expires_at: null,
      last_error_class: null, completed_at: 1100, updated_at: 1100,
    });
  });

  it("releases a lease exactly at expiry but not one expiring a second later", async () => {
    const { db, sqlite } = fixtures.open();
    await insertBlacklistRows(db, ["expired", "live"].map((id) => makePendingBlacklistRow({ id, amount_status: "provider_failed" })));
    await refreshBlacklistAmountRepairQueue(db, 1000);
    sqlite.prepare("UPDATE blacklist_amount_repair_queue SET status = 'running', claim_token = 'owner', lease_expires_at = CASE event_id WHEN 'expired' THEN 1100 ELSE 1101 END").run();
    await refreshBlacklistAmountRepairQueue(db, 1100);
    expect(sqlite.prepare("SELECT event_id, status, claim_token, lease_expires_at, available_at, last_error_class FROM blacklist_amount_repair_queue ORDER BY event_id").all()).toEqual([
      { event_id: "expired", status: "retry", claim_token: null, lease_expires_at: null, available_at: 1300, last_error_class: "lease_expired" },
      { event_id: "live", status: "running", claim_token: "owner", lease_expires_at: 1101, available_at: 0, last_error_class: null },
    ]);
  });

  it("stores saturated retries and terminal completion while clearing ownership", async () => {
    const { db, sqlite } = fixtures.open();
    await insertBlacklistRows(db, [makePendingBlacklistRow({ id: "retry", amount_status: "provider_failed" })]);
    await refreshBlacklistAmountRepairQueue(db, 1000);
    for (const priorAttempts of [6, 100]) {
      sqlite.prepare("UPDATE blacklist_amount_repair_queue SET status = 'running', claim_token = 'owner', lease_expires_at = 5000").run();
      await buildBlacklistAmountRepairQueueUpdate(db, {
        eventId: "retry", outcome: "retry", attemptedAt: 1100, priorAttempts, errorClass: "rpc",
      }).run();
      expect(sqlite.prepare("SELECT * FROM blacklist_amount_repair_queue").get()).toMatchObject({
        status: "retry", available_at: 20300, completed_at: null, claim_token: null, lease_expires_at: null,
      });
    }
    await buildBlacklistAmountRepairQueueUpdate(db, {
      eventId: "retry", outcome: "unrecoverable", attemptedAt: 1200, priorAttempts: 101, errorClass: "unsupported",
    }).run();
    expect(sqlite.prepare("SELECT * FROM blacklist_amount_repair_queue").get()).toMatchObject({
      status: "unrecoverable", attempt_count: 3, available_at: 1200, updated_at: 1200,
      completed_at: 1200, last_error_class: "unsupported", claim_token: null, lease_expires_at: null,
    });
  });
});
