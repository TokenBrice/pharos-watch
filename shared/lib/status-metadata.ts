import type { TelegramDispatchCronMetadata } from "../types/status";

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
    skipped: readMetadataString(record.skipped),
    freshAttempted: readMetadataNumber(record.freshAttempted),
    freshSent: readMetadataNumber(record.freshSent),
    freshRetryQueued: readMetadataNumber(record.freshRetryQueued),
    freshPermanentFailures: readMetadataNumber(record.freshPermanentFailures),
    pendingAttempted: readMetadataNumber(record.pendingAttempted),
    pendingDrained: readMetadataNumber(record.pendingDrained),
    pendingRetryQueued: readMetadataNumber(record.pendingRetryQueued),
    pendingDropped: readMetadataNumber(record.pendingDropped),
    pendingEnqueued: readMetadataNumber(record.pendingEnqueued),
    pendingExpired: readMetadataNumber(record.pendingExpired),
    chatsWithActiveSnooze: readMetadataNumber(record.chatsWithActiveSnooze),
    safetyAlertSourceState: readMetadataString(record.safetyAlertSourceState) as TelegramDispatchCronMetadata["safetyAlertSourceState"],
    safetyAlertSourceAgeSeconds: readMetadataNumber(record.safetyAlertSourceAgeSeconds),
    safetyAlertsSuppressed: readMetadataBoolean(record.safetyAlertsSuppressed) === true,
    safetyAlertSourceGeneration: readMetadataString(record.safetyAlertSourceGeneration),
    eventsDetected: eventsRecord
      ? {
          dews: readMetadataNumber(eventsRecord.dews),
          depeg: readMetadataNumber(eventsRecord.depeg),
          depegTriggered: readMetadataNumber(eventsRecord.depegTriggered),
          depegResolved: readMetadataNumber(eventsRecord.depegResolved),
          depegWorsening: readMetadataNumber(eventsRecord.depegWorsening),
          safety: readMetadataNumber(eventsRecord.safety),
          launch: readMetadataNumber(eventsRecord.launch),
          suppressedMethodologyChanges: readMetadataNumber(eventsRecord.suppressedMethodologyChanges),
        }
      : null,
  };
}
