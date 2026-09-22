import { describe, expect, it } from "vitest";
import {
  buildDispatchResult,
  pendingTailState,
  shouldRecordTelegramDispatchFailure,
} from "../dispatch-telegram-result";
import {
  emptyPendingCapacitySnapshot,
  pendingCapacityProgressFields,
} from "../../lib/telegram/pending-capacity";
import { TelegramSendOriginatedError } from "../../lib/telegram/transport-errors";

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

  it("flattens the published run-metadata fields from the snapshot", () => {
    expect(pendingCapacityProgressFields(observed)).toEqual({
      pendingTotal: 5,
      pendingDue: 3,
      pendingDeferredCount: 1,
      pendingExpiredCount: 2,
      pendingNearTtlCount: 1,
      oldestPendingAgeSec: 90,
      oldestDuePendingAgeSec: 60,
      estimatedDrainTimeSec: 600,
      pendingDrainBudgetPerRun: 900,
    });
  });

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

  it("keeps the published progress-tail key set", () => {
    expect(Object.keys(pendingTailState(observed) ?? {})).toEqual([
      "total",
      "active",
      "due",
      "deferred",
      "expired",
      "nearTtl",
      "oldestPendingAgeSec",
      "estimatedDrainTimeSec",
    ]);
    expect(pendingTailState(observed)).toEqual({
      total: 7,
      active: 5,
      due: 3,
      deferred: 1,
      expired: 2,
      nearTtl: 1,
      oldestPendingAgeSec: 90,
      estimatedDrainTimeSec: 600,
    });
    expect(pendingTailState(null)).toBeNull();
  });
});
