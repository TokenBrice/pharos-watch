import { describe, expect, it } from "vitest";
import {
  parseTelegramDispatchCronMetadata,
} from "@shared/lib/status-metadata";

describe("status-metadata", () => {
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

  it("coerces dispatch counts and preserves unavailable booleans", () => {
    expect(parseTelegramDispatchCronMetadata({
      subscribersNotified: "12",
      messagesSent: 10,
      pendingAttempted: "2",
      pendingDrained: 1,
      pendingRetryAfterSec: "bad",
      cappedAtLimit: "true",
      snapshotSeeded: "false",
      pendingRateLimited: "invalid",
    })).toMatchObject({
      subscribersNotified: 12,
      messagesSent: 10,
      pendingAttempted: 2,
      pendingDrained: 1,
      pendingRetryAfterSec: null,
      cappedAtLimit: true,
      snapshotSeeded: false,
      pendingRateLimited: null,
    });
  });

  it("parses nested event counts independently and preserves unknown counts", () => {
    expect(parseTelegramDispatchCronMetadata({
      eventsDetected: { dews: "2", depeg: 1, depegTriggered: "3", depegResolved: 0,
        depegWorsening: "4", safety: 5, launch: "6", reserve: "7", suppressedMethodologyChanges: "bad" },
    })?.eventsDetected).toEqual({
      dews: 2, depeg: 1, depegTriggered: 3, depegResolved: 0,
      depegWorsening: 4, safety: 5, launch: 6, reserve: 7, freeze: null, suppressedMethodologyChanges: null,
    });
  });

  it("prefers the primary skip reason and uses the fallback for an empty primary", () => {
    expect(parseTelegramDispatchCronMetadata({ skipped: "circuit-open", skippedReason: "missing-token" })?.skipped)
      .toBe("circuit-open");
    expect(parseTelegramDispatchCronMetadata({ skipped: "", skippedReason: "missing-token" })?.skipped)
      .toBe("missing-token");
  });

  it.each([null, []])("rejects non-record dispatch metadata %j", (value) => {
    expect(parseTelegramDispatchCronMetadata(value)).toBeNull();
  });

  it("distinguishes malformed event containers from unavailable event counts", () => {
    expect(parseTelegramDispatchCronMetadata({ eventsDetected: [] })?.eventsDetected).toBeNull();
    expect(parseTelegramDispatchCronMetadata({ eventsDetected: {} })?.eventsDetected).toEqual({
      dews: null, depeg: null, depegTriggered: null, depegResolved: null,
      depegWorsening: null, safety: null, launch: null, reserve: null, freeze: null, suppressedMethodologyChanges: null,
    });
  });

  it("parses row-backed source workload without reviving historical fresh or family counters", () => {
    const metadata = parseTelegramDispatchCronMetadata({
      authoritativePlanning: { sourceEventId: "source-17", sourceEventFamilies: ["dews", "depeg"], plannedTargetCount: "4" },
      freshCandidateChats: 9,
      freshSent: 0,
      perAlertType: { dews: { sent: 0 } },
    });
    expect(metadata?.authoritativePlanning).toEqual({
      sourceEventId: "source-17", sourceEventFamilies: ["dews", "depeg"], plannedTargetCount: 4,
    });
    expect(metadata).not.toHaveProperty("freshCandidateChats");
    expect(metadata).not.toHaveProperty("freshSent");
    expect(metadata).not.toHaveProperty("perAlertType");
  });

  it.each([undefined, null, -1, 0.5, "bad"])("keeps invalid planned target counts unavailable (%s)", (plannedTargetCount) => {
    expect(parseTelegramDispatchCronMetadata({
      authoritativePlanning: { sourceEventId: "source-17", sourceEventFamilies: ["dews"], plannedTargetCount },
    })?.authoritativePlanning?.plannedTargetCount).toBeNull();
  });

  it("preserves observed zero workload and rejects unknown family scope", () => {
    expect(parseTelegramDispatchCronMetadata({
      authoritativePlanning: { sourceEventId: "source-17", sourceEventFamilies: ["future-family"], plannedTargetCount: 0 },
    })?.authoritativePlanning).toEqual({
      sourceEventId: "source-17", sourceEventFamilies: null, plannedTargetCount: 0,
    });
    expect(parseTelegramDispatchCronMetadata({})?.authoritativePlanning).toBeNull();
  });

});
