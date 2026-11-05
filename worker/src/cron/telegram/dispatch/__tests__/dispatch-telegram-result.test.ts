import { describe, expect, it } from "vitest";
import { createLatestSchemaSqlite } from "@shared/test-utils/latest-schema-sqlite";
import { readTelegramPendingCapacity } from "../../../../telegram/outbox/pending-capacity";
import {
  buildDispatchResult,
  shouldRecordTelegramDispatchFailure,
} from "../dispatch-telegram-result";
import {
  emptyPendingCapacitySnapshot,
} from "../../../../telegram/outbox/pending-capacity";
import { TelegramSendOriginatedError } from "../../../../telegram/delivery/transport-errors";

describe("shouldRecordTelegramDispatchFailure", () => {
  it.each([
    [new Error("snapshot write failed"), false],
    [new TelegramSendOriginatedError("send threw"), true],
  ])("attributes only transport-originated errors (%s)", (error, recorded) => {
    expect(shouldRecordTelegramDispatchFailure(error, undefined, true)).toBe(recorded);
  });
});

describe("capacity projections", () => {
  const observed = {
    ...emptyPendingCapacitySnapshot(),
    total: 7,
    active: 5,
    due: 3,
    deferred: 1,
    expired: 2,
    nearTtl: 1,
    oldestPendingAgeSec: 90,
    oldestDuePendingAgeSec: 60,
    estimatedDrainTimeSec: 600,
    drainBudgetPerRun: 900,
  };

  it("publishes the flattened fields on the built result", () => {
    const result = buildDispatchResult({
      snapshotSeeded: false,
      sourcesLoaded: true,
      capacity: { before: emptyPendingCapacitySnapshot(), after: observed },
    });

    expect(result).toMatchObject({
      suppressedSafetyChangesAtSeed: 0,
      eventsDetected: { dews: 0, freeze: 0 },
      pendingTotal: 5,
      pendingDue: 3,
      pendingDeferredCount: 1,
      pendingExpiredCount: 2,
      pendingNearTtlCount: 1,
      oldestPendingAgeSec: 90,
      oldestDuePendingAgeSec: 60,
      estimatedDrainTimeSec: 600,
      pendingDrainBudgetPerRun: 900,
      pendingCapacityBefore: emptyPendingCapacitySnapshot(),
      pendingCapacityAfter: observed,
    });
  });

  it("defaults an unread queue to the zeroed snapshot", () => {
    const result = buildDispatchResult({ snapshotSeeded: true });

    expect(result.pendingCapacityBefore).toEqual(emptyPendingCapacitySnapshot());
    expect(result.pendingCapacityAfter).toEqual(emptyPendingCapacitySnapshot());
    expect(result.pendingTotal).toBe(0);
    expect(result).toMatchObject({ chatsWithActiveSnooze: null, suppressedSafetyChangesAtSeed: null,
      safetyAlertSourceState: null, reserveAlertSourceState: null, reserveSourceUnavailable: true,
      safetyAlertsSuppressed: true, reserveAlertsSuppressed: true });
    expect(result.eventsDetected).toEqual({ dews: null, depeg: null, depegTriggered: null,
      depegResolved: null, depegWorsening: null, safety: null, launch: null, reserve: null,
      suppressedMethodologyChanges: null, freeze: 0 });
  });

  it("publishes real pending work without synthetic fresh-send or family metrics", () => {
    const result = buildDispatchResult({
      snapshotSeeded: false,
      capacity: { before: observed, after: observed },
      overrides: { messagesSent: 3, pendingAttempted: 4, pendingDrained: 3 },
    });
    expect(result).toMatchObject({ messagesSent: 3, pendingAttempted: 4, pendingDrained: 3, pendingTotal: 5 });
    for (const key of [
      "perAlertType", "perAlertTypeTargets", "freshAttempted", "freshSent", "freshRetryQueued",
      "freshPermanentFailures", "freshDeferredPerChat", "freshCandidateChats", "freshCandidateCount", "freshOverflow",
    ]) expect(result).not.toHaveProperty(key);
  });
});

describe("Telegram delivery lifecycle capacity SQL", () => {
  it("separates claimable, deferred, sending, execution-unknown, cleanup, and expired work in telegram_deliveries", async () => {
    const { sqlite, db } = createLatestSchemaSqlite();
    const now = 2_000_000;
    try {
      const insertDelivery = sqlite.prepare(
        `INSERT INTO telegram_deliveries
           (job_id, kind, chat_id, body_hash, state, next_attempt_at, expires_at, created_at, sending_at, done_at)
         VALUES ('alert:cap', 'alert', ?, 'h', ?, ?, ?, ?, ?, ?)`,
      );
      insertDelivery.run("due", "pending", now - 300, now + 3_600, now - 300, null, null);
      insertDelivery.run("deferred", "retry", now + 600, now + 3_600, now - 200, null, null);
      insertDelivery.run("expired", "pending", now - 4_000, now - 1, now - 4_000, null, null);
      insertDelivery.run("sending-recent", "sending", now - 120, now + 3_600, now - 120, now - 60, null);
      insertDelivery.run("sending-aged", "sending", now - 1_500, now + 3_600, now - 1_500, now - 1_200, null);
      insertDelivery.run("sent-cleanup", "sent", now - 100, now + 3_600, now - 100, now - 90, now - 90);
      insertDelivery.run("unknown", "unknown", now - 180, now + 3_600, now - 180, now - 120, now - 120);

      const result = await readTelegramPendingCapacity(db, now);

      expect(result.status).toBe("available");
      if (result.status !== "available") throw new Error("capacity unexpectedly unavailable");
      expect(result.value).toMatchObject({
        total: 3,
        active: 2,
        due: 1,
        deferred: 1,
        expired: 1,
        sending: 1,
        pendingExecutionUnknown: 2,
        freshExecutionUnknown: 0,
        executionUnknown: 2,
        sentCleanup: 1,
        oldestExecutionUnknownAgeSec: 1_200,
        executionUnknownLowerBound: false,
        oldestDuePendingAgeSec: 300,
      });
    } finally {
      sqlite.close();
    }
  });
});
