import { describe, expect, it } from "vitest";
import {
  buildDispatchResult,
  shouldRecordTelegramDispatchFailure,
} from "../dispatch-telegram-result";
import {
  emptyPendingCapacitySnapshot,
} from "../../../../telegram/outbox/pending-capacity";
import { TelegramSendOriginatedError } from "../../../../telegram/delivery/transport-errors";

describe("shouldRecordTelegramDispatchFailure", () => {
  it("does not attribute a snapshot write failure after a successful drain to Telegram", () => {
    expect(shouldRecordTelegramDispatchFailure(
      new Error("snapshot write failed"),
      undefined,
      true,
    )).toBe(false);
  });

  it("records only errors thrown by the Telegram send call", () => {
    expect(shouldRecordTelegramDispatchFailure(
      new TelegramSendOriginatedError("send threw"),
      undefined,
      true,
    )).toBe(true);
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
      capacity: { before: emptyPendingCapacitySnapshot(), after: observed },
    });

    expect(result).toMatchObject({
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
