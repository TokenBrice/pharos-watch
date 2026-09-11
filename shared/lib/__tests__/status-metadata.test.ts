import { describe, expect, it } from "vitest";
import {
  parseTelegramDispatchCronMetadata,
  readMetadataBoolean,
  readMetadataNumber,
  readMetadataRecord,
} from "@shared/lib/status-metadata";
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

  it("coerces dispatch counts and distinguishes unavailable numbers from false flags", () => {
    expect(parseTelegramDispatchCronMetadata({
      subscribersNotified: "12",
      messagesSent: 10,
      freshAttempted: "4",
      freshSent: 3,
      pendingAttempted: "2",
      pendingDrained: 1,
      pendingRetryAfterSec: "bad",
      cappedAtLimit: "true",
      snapshotSeeded: "false",
      pendingRateLimited: "invalid",
    })).toMatchObject({
      subscribersNotified: 12,
      messagesSent: 10,
      freshAttempted: 4,
      freshSent: 3,
      pendingAttempted: 2,
      pendingDrained: 1,
      pendingRetryAfterSec: null,
      cappedAtLimit: true,
      snapshotSeeded: false,
      pendingRateLimited: false,
    });
  });

  it("parses nested event counts independently and preserves unknown counts", () => {
    expect(parseTelegramDispatchCronMetadata({
      eventsDetected: { dews: "2", depeg: 1, depegTriggered: "3", depegResolved: 0,
        depegWorsening: "4", safety: 5, launch: "6", reserve: "7", suppressedMethodologyChanges: "bad" },
    })?.eventsDetected).toEqual({
      dews: 2, depeg: 1, depegTriggered: 3, depegResolved: 0,
      depegWorsening: 4, safety: 5, launch: 6, reserve: 7, suppressedMethodologyChanges: null,
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

  it("distinguishes malformed containers from malformed category records", () => {
    expect(parseTelegramDispatchCronMetadata({ eventsDetected: [], perAlertType: [] })).toMatchObject({
      eventsDetected: null, perAlertType: null,
    });
    const metadata = parseTelegramDispatchCronMetadata({
      eventsDetected: {},
      perAlertType: { dews: [], depeg: { sent: "bad", firstSendLatencyMs: false } },
    });
    expect(metadata?.eventsDetected).toEqual({
      dews: null, depeg: null, depegTriggered: null, depegResolved: null,
      depegWorsening: null, safety: null, launch: null, reserve: null, suppressedMethodologyChanges: null,
    });
    expect(metadata?.perAlertType?.dews).toEqual({
      sent: 0, enqueued: 0, failed: 0, blocked: 0, firstSendLatencyMs: null,
    });
    expect(metadata?.perAlertType?.depeg).toEqual({
      sent: 0, enqueued: 0, failed: 0, blocked: 0, firstSendLatencyMs: null,
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
