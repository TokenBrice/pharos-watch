import { describe, expect, it, onTestFinished } from "vitest";
import { createLatestSchemaSqlite } from "@shared/test-utils/latest-schema-sqlite";
import { STATUS_OPERATOR_ALERT_PENDING_MAX_SEC as BUDGET } from "@shared/lib/status-thresholds";
import {
  loadOperatorAlertHealth,
  OPERATOR_ALERT_RECEIPT_KEYS,
  recordOperatorAlertReceipt,
  type OperatorAlertReceipt,
} from "../status/operator-alert-health";

const NOW = 1_800_000_000;
const producers = Object.keys(OPERATOR_ALERT_RECEIPT_KEYS) as OperatorAlertReceipt["producer"][];
function receipt(producer: OperatorAlertReceipt["producer"], overrides: Partial<OperatorAlertReceipt> = {}): string {
  return JSON.stringify({
    version: 1, producer, operatorConfigured: true, pendingSince: null,
    lastDeliveredAt: NOW - 600, reason: null, updatedAt: NOW - 60, ...overrides,
  } satisfies OperatorAlertReceipt);
}
function dbWith(overrides: Partial<Record<OperatorAlertReceipt["producer"], string | null>> = {}) {
  const { db, sqlite } = createLatestSchemaSqlite();
  onTestFinished(() => sqlite.close());
  const insert = sqlite.prepare("INSERT INTO cache (key, value, updated_at) VALUES (?, ?, ?)");
  for (const producer of producers) {
    const value = producer in overrides ? overrides[producer] : receipt(producer);
    if (value != null) insert.run(OPERATOR_ALERT_RECEIPT_KEYS[producer], value, NOW - 60);
  }
  return db;
}

describe("operator alert delivery receipt", () => {
  it("reports a healthy channel from fresh receipts with no pending transition", async () => {
    expect(OPERATOR_ALERT_RECEIPT_KEYS).toMatchObject({
      turnover: "operator-alert:receipt:turnover:v1",
      telegramDelivery: "operator-alert:receipt:telegramDelivery:v1",
    });
    await expect(loadOperatorAlertHealth(dbWith(), NOW)).resolves.toEqual({
      status: "healthy", operatorConfigured: true, lastDeliveredAt: NOW - 600,
      pendingSince: null, pendingAgeSec: null, maxPendingSec: BUDGET,
      pendingProducers: [], reason: null, unavailableReason: null,
    });
  });
  it.each(producers)("names pending, stopped, unconfigured, absent and malformed %s receipts", async (producer) => {
    for (const [value, expected] of [
      [receipt(producer, { pendingSince: NOW - BUDGET - 1 }), {
        status: "stale", reason: "operator-alert-delivery-pending",
        pendingAgeSec: BUDGET + 1, pendingProducers: [producer],
      }],
      [receipt(producer, { updatedAt: NOW - BUDGET - 1 }), {
        status: "stale", reason: `operator-alert-receipt-stale:${producer}`,
      }],
      [receipt(producer, { operatorConfigured: false }), {
        status: "stale", operatorConfigured: false, reason: "operator-alert-credentials-missing",
      }],
      [null, { status: "unavailable", unavailableReason: `operator-alert-receipt-missing:${producer}` }],
      ["{not-json", { status: "unavailable", unavailableReason: `operator-alert-receipt-invalid:${producer}` }],
    ] as const) {
      await expect(loadOperatorAlertHealth(dbWith({ [producer]: value }), NOW)).resolves.toMatchObject(expected);
    }
  });
  it.each(producers)("preserves %s pending age across suppressions and clears it only after delivery", async (producer) => {
    const db = dbWith({ [producer]: null });
    for (const offset of [0, 60, 120]) {
      const delivered = offset === 120;
      const result = await recordOperatorAlertReceipt(db, producer, {
        nowSec: NOW + offset, operatorConfigured: true, pending: !delivered,
        delivered, reason: delivered ? null : "operator-alert-cooldown",
      });
      expect(result).toMatchObject(delivered
        ? { pendingSince: null, lastDeliveredAt: NOW + 120 }
        : { pendingSince: NOW });
    }
  });
});
