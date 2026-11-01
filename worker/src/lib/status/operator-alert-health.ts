import { STATUS_OPERATOR_ALERT_PENDING_MAX_SEC } from "@shared/lib/status-thresholds";
import type { OperatorAlertHealth } from "@shared/types/status/public-health";
import { getCache, getCaches, setCache } from "../db-cache";

/**
 * Receipts prove the operator-alert channel itself still evaluates and
 * delivers. They are written by each sender on every run, so an external
 * monitor can distinguish "no alert was due" from "alerts are stuck".
 */
export const OPERATOR_ALERT_RECEIPT_KEYS = {
  freshness: "operator-alert:receipt:freshness:v1",
  digest: "operator-alert:receipt:digest:v1",
} as const;

export type OperatorAlertProducer = keyof typeof OPERATOR_ALERT_RECEIPT_KEYS;

export interface OperatorAlertReceipt {
  version: 1;
  producer: OperatorAlertProducer;
  operatorConfigured: boolean;
  pendingSince: number | null;
  lastDeliveredAt: number | null;
  reason: string | null;
  updatedAt: number;
}

function parseReceipt(value: string | undefined, producer: OperatorAlertProducer): OperatorAlertReceipt | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<OperatorAlertReceipt>;
    if (
      parsed.version !== 1
      || parsed.producer !== producer
      || typeof parsed.operatorConfigured !== "boolean"
      || (parsed.pendingSince != null && !Number.isFinite(parsed.pendingSince))
      || (parsed.lastDeliveredAt != null && !Number.isFinite(parsed.lastDeliveredAt))
      || (parsed.reason != null && typeof parsed.reason !== "string")
      || typeof parsed.updatedAt !== "number" || !Number.isFinite(parsed.updatedAt) || parsed.updatedAt <= 0
    ) {
      return null;
    }
    return {
      version: 1,
      producer,
      operatorConfigured: parsed.operatorConfigured,
      pendingSince: parsed.pendingSince ?? null,
      lastDeliveredAt: parsed.lastDeliveredAt ?? null,
      reason: parsed.reason ?? null,
      updatedAt: parsed.updatedAt,
    };
  } catch {
    return null;
  }
}

export async function recordOperatorAlertReceipt(
  db: D1Database,
  producer: OperatorAlertProducer,
  params: {
    nowSec: number;
    operatorConfigured: boolean;
    pending: boolean;
    delivered: boolean;
    reason: string | null;
  },
  signal?: AbortSignal,
): Promise<OperatorAlertReceipt> {
  const key = OPERATOR_ALERT_RECEIPT_KEYS[producer];
  const previous = parseReceipt((await getCache(db, key, signal))?.value, producer);
  const receipt: OperatorAlertReceipt = {
    version: 1,
    producer,
    operatorConfigured: params.operatorConfigured,
    pendingSince: params.pending ? previous?.pendingSince ?? params.nowSec : null,
    lastDeliveredAt: params.delivered ? params.nowSec : previous?.lastDeliveredAt ?? null,
    reason: params.reason,
    updatedAt: params.nowSec,
  };
  await setCache(db, key, JSON.stringify(receipt), signal);
  return receipt;
}

function unavailableHealth(unavailableReason: string): OperatorAlertHealth {
  return {
    status: "unavailable",
    operatorConfigured: null,
    lastDeliveredAt: null,
    pendingSince: null,
    pendingAgeSec: null,
    maxPendingSec: STATUS_OPERATOR_ALERT_PENDING_MAX_SEC,
    pendingProducers: [],
    reason: null,
    unavailableReason,
  };
}

export async function loadOperatorAlertHealth(
  db: D1Database,
  now: number,
): Promise<OperatorAlertHealth> {
  try {
    const rows = await getCaches(db, Object.values(OPERATOR_ALERT_RECEIPT_KEYS));
    const receipts: OperatorAlertReceipt[] = [];
    const missing: string[] = [];
    const invalid: string[] = [];
    for (const [producer, key] of Object.entries(OPERATOR_ALERT_RECEIPT_KEYS) as Array<[OperatorAlertProducer, string]>) {
      const row = rows.get(key);
      if (!row) {
        missing.push(producer);
        continue;
      }
      const receipt = parseReceipt(row.value, producer);
      if (!receipt) invalid.push(producer);
      else receipts.push(receipt);
    }
    // Absence of a receipt is unknown evidence, never proof that the channel works.
    if (invalid.length > 0) return unavailableHealth(`operator-alert-receipt-invalid:${invalid.join(",")}`);
    if (missing.length > 0) return unavailableHealth(`operator-alert-receipt-missing:${missing.join(",")}`);

    const pending = receipts.filter((receipt) => receipt.pendingSince != null);
    const pendingSince = pending.length > 0
      ? Math.min(...pending.map((receipt) => receipt.pendingSince as number))
      : null;
    const delivered = receipts.flatMap((receipt) => receipt.lastDeliveredAt == null ? [] : [receipt.lastDeliveredAt]);
    const lastDeliveredAt = delivered.length > 0 ? Math.max(...delivered) : null;
    const pendingAgeSec = pendingSince == null ? null : Math.max(0, now - pendingSince);
    const operatorConfigured = receipts.every((receipt) => receipt.operatorConfigured);
    const stoppedProducers = receipts
      .filter((receipt) => now - receipt.updatedAt > STATUS_OPERATOR_ALERT_PENDING_MAX_SEC)
      .map((receipt) => receipt.producer)
      .sort();
    const reason = !operatorConfigured
      ? "operator-alert-credentials-missing"
      : pendingAgeSec != null && pendingAgeSec > STATUS_OPERATOR_ALERT_PENDING_MAX_SEC
        ? "operator-alert-delivery-pending"
        : stoppedProducers.length > 0
          ? `operator-alert-receipt-stale:${stoppedProducers.join(",")}`
          : null;
    return {
      status: reason ? "stale" : "healthy",
      operatorConfigured,
      lastDeliveredAt,
      pendingSince,
      pendingAgeSec,
      maxPendingSec: STATUS_OPERATOR_ALERT_PENDING_MAX_SEC,
      pendingProducers: pending.map((receipt) => receipt.producer).sort(),
      reason,
      unavailableReason: null,
    };
  } catch {
    return unavailableHealth("operator-alert-receipt-read-failed");
  }
}
