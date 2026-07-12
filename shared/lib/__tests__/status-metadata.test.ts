import { describe, expect, it } from "vitest";
import {
  parseTelegramDispatchCronMetadata,
  readMetadataBoolean,
  readMetadataNumber,
  readMetadataRecord,
} from "../status-metadata";
import { TELEGRAM_ALERT_TYPES } from "../../types/status";

describe("status-metadata", () => {
  it("coerces generic metadata primitives defensively", () => {
    expect(readMetadataRecord({ ok: true })).toEqual({ ok: true });
    expect(readMetadataRecord(["not-a-record"])).toBeNull();
    expect(readMetadataNumber("42")).toBe(42);
    expect(readMetadataNumber("bad")).toBeNull();
    expect(readMetadataNumber(null)).toBeNull();
    expect(readMetadataNumber("")).toBeNull();
    expect(readMetadataNumber("   ")).toBeNull();
    expect(readMetadataNumber(false)).toBeNull();
    expect(readMetadataBoolean("true")).toBe(true);
    expect(readMetadataBoolean("false")).toBe(false);
    expect(readMetadataBoolean("nope")).toBeNull();
  });

  it("preserves missing source ages and rejects unknown source states", () => {
    const metadata = parseTelegramDispatchCronMetadata({
      pendingRetryAfterSec: null,
      safetyAlertSourceState: "future-state",
      safetyAlertSourceAgeSeconds: null,
      reserveAlertSourceState: "recovering",
      reserveAlertSourceAgeSeconds: null,
    });

    expect(metadata).toMatchObject({
      pendingRetryAfterSec: null,
      safetyAlertSourceState: null,
      safetyAlertSourceAgeSeconds: null,
      reserveAlertSourceState: "recovering",
      reserveAlertSourceAgeSeconds: null,
    });
  });

  it("parses telegram dispatch metadata from mixed JSON-compatible values", () => {
    const metadata = parseTelegramDispatchCronMetadata({
      subscribersNotified: "12",
      messagesSent: 10,
      blockedUsersCleanedUp: "1",
      blockedUsersCleanupFailed: 0,
      cappedAtLimit: "true",
      snapshotSeeded: false,
      freshAttempted: "4",
      freshSent: 3,
      freshRetryQueued: "1",
      freshPermanentFailures: 0,
      pendingAttempted: "2",
      pendingDrained: 1,
      pendingRetryQueued: 0,
      pendingDropped: "0",
      pendingDroppedTtlExpired: "2",
      pendingDroppedPermanentFailure: 0,
      pendingDroppedMaxAttemptsFallback: "1",
      pendingDeferred: "2",
      pendingRateLimited: "true",
      pendingRetryAfterSec: "45",
      pendingEnqueued: 5,
      pendingExpired: "2",
      skipped: "circuit-open",
      suppressedSafetyChangesAtSeed: "2",
      reserveAlertSourceState: "stale",
      reserveAlertSourceAgeSeconds: "28801",
      reserveAlertsSuppressed: true,
      reserveAlertSourceGeneration: "reserve-alert-source-v1",
      eventsDetected: {
        dews: 2,
        depeg: "1",
        depegTriggered: 1,
        depegResolved: 0,
        depegWorsening: "3",
        safety: 4,
        launch: "5",
        reserve: "7",
        suppressedMethodologyChanges: "6",
      },
    });

    expect(metadata).toEqual({
      subscribersNotified: 12,
      messagesSent: 10,
      blockedUsersCleanedUp: 1,
      blockedUsersCleanupFailed: 0,
      cappedAtLimit: true,
      snapshotSeeded: false,
      eventlessFastPath: false,
      skipped: "circuit-open",
      freshAttempted: 4,
      freshSent: 3,
      freshRetryQueued: 1,
      freshPermanentFailures: 0,
      freshDeferredPerChat: null,
      freshCandidateChats: null,
      freshCandidateCount: null,
      pendingAttempted: 2,
      pendingDrained: 1,
      pendingRetryQueued: 0,
      pendingDropped: 0,
      pendingDroppedTtlExpired: 2,
      pendingDroppedPermanentFailure: 0,
      pendingDroppedMaxAttemptsFallback: 1,
      pendingDeferred: 2,
      pendingRateLimited: true,
      pendingRetryAfterSec: 45,
      pendingEnqueued: 5,
      pendingExpired: 2,
      chatsWithActiveSnooze: null,
      safetyAlertSourceState: null,
      safetyAlertSourceAgeSeconds: null,
      safetyAlertsSuppressed: false,
      safetyAlertSourceGeneration: null,
      reserveAlertSourceState: "stale",
      reserveAlertSourceAgeSeconds: 28801,
      reserveAlertsSuppressed: true,
      reserveAlertSourceGeneration: "reserve-alert-source-v1",
      presetQueryFailures: null,
      presetResolutionFailures: null,
      presetFailure: false,
      suppressedSafetyChangesAtSeed: 2,
      eventsDetected: {
        dews: 2,
        depeg: 1,
        depegTriggered: 1,
        depegResolved: 0,
        depegWorsening: 3,
        safety: 4,
        launch: 5,
        reserve: 7,
        suppressedMethodologyChanges: 6,
      },
      perAlertType: null,
    });
  });

  it("parses perAlertType delivery stats per category with defensive defaults", () => {
    const metadata = parseTelegramDispatchCronMetadata({
      perAlertType: {
        dews: { sent: "3", enqueued: 1, failed: 0, blocked: "0", firstSendLatencyMs: "240" },
        depeg: { sent: 1, enqueued: "2", failed: 1, blocked: 0, firstSendLatencyMs: null },
        // safety omitted — should fall back to zeroed stats with null latency.
        launch: {},
      },
    });

    expect(Object.keys(metadata?.perAlertType ?? {})).toEqual([...TELEGRAM_ALERT_TYPES]);
    expect(metadata?.perAlertType).toEqual({
      dews: { sent: 3, enqueued: 1, failed: 0, blocked: 0, firstSendLatencyMs: 240 },
      depeg: { sent: 1, enqueued: 2, failed: 1, blocked: 0, firstSendLatencyMs: null },
      safety: { sent: 0, enqueued: 0, failed: 0, blocked: 0, firstSendLatencyMs: null },
      launch: { sent: 0, enqueued: 0, failed: 0, blocked: 0, firstSendLatencyMs: null },
      reserve: { sent: 0, enqueued: 0, failed: 0, blocked: 0, firstSendLatencyMs: null },
      freeze: { sent: 0, enqueued: 0, failed: 0, blocked: 0, firstSendLatencyMs: null },
    });
  });

  it("accepts skippedReason as the skip reason fallback for preflight rows", () => {
    const metadata = parseTelegramDispatchCronMetadata({
      skippedReason: "missing-telegram-bot-token",
    });

    expect(metadata?.skipped).toBe("missing-telegram-bot-token");
  });
});
