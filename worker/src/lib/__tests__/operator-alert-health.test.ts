import { describe, expect, it } from "vitest";
import { createLatestSchemaSqlite } from "@shared/test-utils/latest-schema-sqlite";
import { STATUS_OPERATOR_ALERT_PENDING_MAX_SEC } from "@shared/lib/status-thresholds";
import {
  loadOperatorAlertHealth,
  OPERATOR_ALERT_RECEIPT_KEYS,
  recordOperatorAlertReceipt,
  type OperatorAlertReceipt,
} from "../status/operator-alert-health";

const NOW = 1_800_000_000;

function receipt(producer: OperatorAlertReceipt["producer"], overrides: Partial<OperatorAlertReceipt> = {}): string {
  return JSON.stringify({
    version: 1,
    producer,
    operatorConfigured: true,
    pendingSince: null,
    lastDeliveredAt: NOW - 600,
    reason: null,
    updatedAt: NOW - 60,
    ...overrides,
  } satisfies OperatorAlertReceipt);
}

function dbWith(receipts: Partial<Record<keyof typeof OPERATOR_ALERT_RECEIPT_KEYS, string>>) {
  const { db, sqlite } = createLatestSchemaSqlite();
  const insert = sqlite.prepare("INSERT INTO cache (key, value, updated_at) VALUES (?, ?, ?)");
  for (const [producer, value] of Object.entries(receipts)) {
    insert.run(OPERATOR_ALERT_RECEIPT_KEYS[producer as keyof typeof OPERATOR_ALERT_RECEIPT_KEYS], value, NOW - 60);
  }
  return { db, sqlite };
}

describe("operator alert delivery receipt", () => {
  it("reports a healthy channel from fresh receipts with no pending transition", async () => {
    const { db, sqlite } = dbWith({
      freshness: receipt("freshness"),
      digest: receipt("digest"),
    });
    try {
      await expect(loadOperatorAlertHealth(db, NOW)).resolves.toEqual({
        status: "healthy",
        operatorConfigured: true,
        lastDeliveredAt: NOW - 600,
        pendingSince: null,
        pendingAgeSec: null,
        maxPendingSec: STATUS_OPERATOR_ALERT_PENDING_MAX_SEC,
        pendingProducers: [],
        reason: null,
        unavailableReason: null,
      });
    } finally {
      sqlite.close();
    }
  });

  it("names a pending transition older than its budget and the producer holding it", async () => {
    const { db, sqlite } = dbWith({
      freshness: receipt("freshness", { pendingSince: NOW - STATUS_OPERATOR_ALERT_PENDING_MAX_SEC - 1 }),
      digest: receipt("digest"),
    });
    try {
      const health = await loadOperatorAlertHealth(db, NOW);
      expect(health).toMatchObject({
        status: "stale",
        reason: "operator-alert-delivery-pending",
        pendingAgeSec: STATUS_OPERATOR_ALERT_PENDING_MAX_SEC + 1,
        pendingProducers: ["freshness"],
      });
    } finally {
      sqlite.close();
    }
  });

  it("fails when a producer stops writing receipts", async () => {
    const { db, sqlite } = dbWith({
      freshness: receipt("freshness", { updatedAt: NOW - STATUS_OPERATOR_ALERT_PENDING_MAX_SEC - 1 }),
      digest: receipt("digest"),
    });
    try {
      await expect(loadOperatorAlertHealth(db, NOW)).resolves.toMatchObject({
        status: "stale",
        reason: "operator-alert-receipt-stale:freshness",
      });
    } finally {
      sqlite.close();
    }
  });

  it("fails the channel when the operator chat is unconfigured", async () => {
    const { db, sqlite } = dbWith({
      freshness: receipt("freshness", { operatorConfigured: false }),
      digest: receipt("digest"),
    });
    try {
      await expect(loadOperatorAlertHealth(db, NOW)).resolves.toMatchObject({
        status: "stale",
        operatorConfigured: false,
        reason: "operator-alert-credentials-missing",
      });
    } finally {
      sqlite.close();
    }
  });

  it("keeps an absent or malformed receipt unknown, never healthy", async () => {
    const absent = dbWith({ freshness: receipt("freshness") });
    try {
      await expect(loadOperatorAlertHealth(absent.db, NOW)).resolves.toMatchObject({
        status: "unavailable",
        unavailableReason: `operator-alert-receipt-missing:digest`,
      });
    } finally {
      absent.sqlite.close();
    }
    const malformed = dbWith({
      freshness: receipt("freshness"),
      digest: "{not-json",
    });
    try {
      await expect(loadOperatorAlertHealth(malformed.db, NOW)).resolves.toMatchObject({
        status: "unavailable",
        unavailableReason: `operator-alert-receipt-invalid:digest`,
      });
    } finally {
      malformed.sqlite.close();
    }
  });

  it("preserves a pending start across suppressions and clears it only after delivery", async () => {
    const { db, sqlite } = createLatestSchemaSqlite();
    try {
      const first = await recordOperatorAlertReceipt(db, "freshness", {
        nowSec: NOW,
        operatorConfigured: true,
        pending: true,
        delivered: false,
        reason: "operator-alert-cooldown",
      });
      expect(first.pendingSince).toBe(NOW);
      const retry = await recordOperatorAlertReceipt(db, "freshness", {
        nowSec: NOW + 60,
        operatorConfigured: true,
        pending: true,
        delivered: false,
        reason: "operator-alert-cooldown",
      });
      expect(retry.pendingSince).toBe(NOW);
      const delivered = await recordOperatorAlertReceipt(db, "freshness", {
        nowSec: NOW + 120,
        operatorConfigured: true,
        pending: false,
        delivered: true,
        reason: null,
      });
      expect(delivered).toMatchObject({ pendingSince: null, lastDeliveredAt: NOW + 120 });
    } finally {
      sqlite.close();
    }
  });
});
