import { TELEGRAM_ALERT_TYPES } from "../types/status";
import type {
  PerAlertTypeDelivery,
  PerAlertTypeDeliveryStats,
  TelegramDispatchCronMetadata,
} from "../types/status";

/**
 * Maps each tracked cache key to the primary upstream provider whose outage
 * would most directly affect that cache. Used to annotate the public cache
 * freshness table so "DefiLlama is down → these caches drift" is a one-glance
 * read. Keep aligned with `CACHE_FRESHNESS_THRESHOLDS` in
 * `worker/src/lib/constants.ts`.
 */
export const CACHE_UPSTREAM_PROVIDER: Record<string, string> = {
  stablecoins: "DefiLlama",
  "stablecoin-charts": "DefiLlama",
  "usds-status": "Etherscan",
  "fx-rates": "Frankfurter",
  "bluechip-ratings": "Bluechip",
  "dex-liquidity": "DefiLlama",
  "yield-data": "DefiLlama",
  dews: "Internal compute",
};

export function readMetadataRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function readMetadataNumber(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function readMetadataString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function readMetadataArray(value: unknown): unknown[] | null {
  return Array.isArray(value) ? value : null;
}

export function readMetadataBoolean(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (value === "true") return true;
    if (value === "false") return false;
  }
  return null;
}

function parsePerAlertTypeStats(value: unknown): PerAlertTypeDeliveryStats {
  const record = readMetadataRecord(value);
  // `firstSendLatencyMs` is intentionally nullable to mean "no successful send
  // recorded for this category". `readMetadataNumber(null)` returns 0 because
  // `Number(null) === 0`, so guard explicitly to preserve the null signal.
  const rawLatency = record?.firstSendLatencyMs;
  return {
    sent: readMetadataNumber(record?.sent) ?? 0,
    enqueued: readMetadataNumber(record?.enqueued) ?? 0,
    failed: readMetadataNumber(record?.failed) ?? 0,
    blocked: readMetadataNumber(record?.blocked) ?? 0,
    firstSendLatencyMs: rawLatency == null ? null : readMetadataNumber(rawLatency),
  };
}

function parsePerAlertTypeDelivery(value: unknown): PerAlertTypeDelivery | null {
  const record = readMetadataRecord(value);
  if (!record) return null;
  const result = {} as PerAlertTypeDelivery;
  for (const type of TELEGRAM_ALERT_TYPES) {
    result[type] = parsePerAlertTypeStats(record[type]);
  }
  return result;
}

export function parseTelegramDispatchCronMetadata(value: unknown): TelegramDispatchCronMetadata | null {
  const record = readMetadataRecord(value);
  if (!record) return null;

  const eventsRecord = readMetadataRecord(record.eventsDetected);
  return {
    subscribersNotified: readMetadataNumber(record.subscribersNotified),
    messagesSent: readMetadataNumber(record.messagesSent),
    blockedUsersCleanedUp: readMetadataNumber(record.blockedUsersCleanedUp),
    blockedUsersCleanupFailed: readMetadataNumber(record.blockedUsersCleanupFailed),
    cappedAtLimit: readMetadataBoolean(record.cappedAtLimit) === true,
    snapshotSeeded: readMetadataBoolean(record.snapshotSeeded) === true,
    eventlessFastPath: readMetadataBoolean(record.eventlessFastPath) === true,
    skipped: readMetadataString(record.skipped) ?? readMetadataString(record.skippedReason),
    freshAttempted: readMetadataNumber(record.freshAttempted),
    freshSent: readMetadataNumber(record.freshSent),
    freshRetryQueued: readMetadataNumber(record.freshRetryQueued),
    freshPermanentFailures: readMetadataNumber(record.freshPermanentFailures),
    freshDeferredPerChat: readMetadataNumber(record.freshDeferredPerChat),
    freshCandidateChats: readMetadataNumber(record.freshCandidateChats),
    freshCandidateCount: readMetadataNumber(record.freshCandidateCount),
    pendingAttempted: readMetadataNumber(record.pendingAttempted),
    pendingDrained: readMetadataNumber(record.pendingDrained),
    pendingRetryQueued: readMetadataNumber(record.pendingRetryQueued),
    pendingDropped: readMetadataNumber(record.pendingDropped),
    pendingDroppedTtlExpired: readMetadataNumber(record.pendingDroppedTtlExpired),
    pendingDroppedPermanentFailure: readMetadataNumber(record.pendingDroppedPermanentFailure),
    pendingDroppedMaxAttemptsFallback: readMetadataNumber(record.pendingDroppedMaxAttemptsFallback),
    pendingDeferred: readMetadataNumber(record.pendingDeferred),
    pendingRateLimited: readMetadataBoolean(record.pendingRateLimited) === true,
    pendingRetryAfterSec: readMetadataNumber(record.pendingRetryAfterSec),
    pendingEnqueued: readMetadataNumber(record.pendingEnqueued),
    pendingExpired: readMetadataNumber(record.pendingExpired),
    chatsWithActiveSnooze: readMetadataNumber(record.chatsWithActiveSnooze),
    safetyAlertSourceState: readMetadataString(record.safetyAlertSourceState) as TelegramDispatchCronMetadata["safetyAlertSourceState"],
    safetyAlertSourceAgeSeconds: readMetadataNumber(record.safetyAlertSourceAgeSeconds),
    safetyAlertsSuppressed: readMetadataBoolean(record.safetyAlertsSuppressed) === true,
    safetyAlertSourceGeneration: readMetadataString(record.safetyAlertSourceGeneration),
    reserveAlertSourceState: readMetadataString(record.reserveAlertSourceState) as TelegramDispatchCronMetadata["reserveAlertSourceState"],
    reserveAlertSourceAgeSeconds: readMetadataNumber(record.reserveAlertSourceAgeSeconds),
    reserveAlertsSuppressed: readMetadataBoolean(record.reserveAlertsSuppressed) === true,
    reserveAlertSourceGeneration: readMetadataString(record.reserveAlertSourceGeneration),
    presetQueryFailures: readMetadataNumber(record.presetQueryFailures),
    presetResolutionFailures: readMetadataNumber(record.presetResolutionFailures),
    presetFailure: readMetadataBoolean(record.presetFailure) === true,
    suppressedSafetyChangesAtSeed: readMetadataNumber(record.suppressedSafetyChangesAtSeed),
    eventsDetected: eventsRecord
      ? {
          dews: readMetadataNumber(eventsRecord.dews),
          depeg: readMetadataNumber(eventsRecord.depeg),
          depegTriggered: readMetadataNumber(eventsRecord.depegTriggered),
          depegResolved: readMetadataNumber(eventsRecord.depegResolved),
          depegWorsening: readMetadataNumber(eventsRecord.depegWorsening),
          safety: readMetadataNumber(eventsRecord.safety),
          launch: readMetadataNumber(eventsRecord.launch),
          reserve: readMetadataNumber(eventsRecord.reserve),
          suppressedMethodologyChanges: readMetadataNumber(eventsRecord.suppressedMethodologyChanges),
        }
      : null,
    perAlertType: parsePerAlertTypeDelivery(record.perAlertType),
  };
}
