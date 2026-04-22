import { describe, expect, it } from "vitest";
import {
  parseTelegramDispatchCronMetadata,
  readMetadataBoolean,
  readMetadataNumber,
  readMetadataRecord,
} from "../status-metadata";

describe("status-metadata", () => {
  it("coerces generic metadata primitives defensively", () => {
    expect(readMetadataRecord({ ok: true })).toEqual({ ok: true });
    expect(readMetadataRecord(["not-a-record"])).toBeNull();
    expect(readMetadataNumber("42")).toBe(42);
    expect(readMetadataNumber("bad")).toBeNull();
    expect(readMetadataBoolean("true")).toBe(true);
    expect(readMetadataBoolean("false")).toBe(false);
    expect(readMetadataBoolean("nope")).toBeNull();
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
      pendingEnqueued: 5,
      pendingExpired: "2",
      skipped: "circuit-open",
      eventsDetected: {
        dews: 2,
        depeg: "1",
        depegTriggered: 1,
        depegResolved: 0,
        depegWorsening: "3",
        safety: 4,
        launch: "5",
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
      skipped: "circuit-open",
      freshAttempted: 4,
      freshSent: 3,
      freshRetryQueued: 1,
      freshPermanentFailures: 0,
      pendingAttempted: 2,
      pendingDrained: 1,
      pendingRetryQueued: 0,
      pendingDropped: 0,
      pendingEnqueued: 5,
      pendingExpired: 2,
      chatsWithActiveSnooze: null,
      safetyAlertSourceState: null,
      safetyAlertSourceAgeSeconds: null,
      safetyAlertsSuppressed: false,
      safetyAlertSourceGeneration: null,
      eventsDetected: {
        dews: 2,
        depeg: 1,
        depegTriggered: 1,
        depegResolved: 0,
        depegWorsening: 3,
        safety: 4,
        launch: 5,
        suppressedMethodologyChanges: 6,
      },
    });
  });
});
