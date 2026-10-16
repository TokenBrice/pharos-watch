import { describe, expect, it } from "vitest";
import {
  DDR_LOCK_BACKSTOP_DELAY_SEC,
  DDR_LOCK_READINESS_THRESHOLD,
  evaluateDdrLockPolicy,
} from "../maintenance/backtest-depeg-resolver-lock-policy";

const STARTED_AT = 1_800_000_000;

function row(overrides: Partial<Parameters<typeof evaluateDdrLockPolicy>[0]> = {}) {
  return {
    incidentKey: "ddr2:test",
    eventId: 1,
    startedAt: STARTED_AT,
    evaluatedAt: STARTED_AT + 12 * 3600,
    readinessScore: 0.5,
    outcomeKind: "prediction" as const,
    ...overrides,
  };
}

describe("backtest-depeg-resolver-lock-policy", () => {
  it("early-locks only when readiness score is strictly greater than 0.75", () => {
    const above = evaluateDdrLockPolicy(row({ readinessScore: DDR_LOCK_READINESS_THRESHOLD + 0.000001 }));
    const exact = evaluateDdrLockPolicy(row({ eventId: 2, readinessScore: DDR_LOCK_READINESS_THRESHOLD }));

    expect(above).toMatchObject({
      action: "lock_prediction",
      eligibilityReason: "readiness_early_lock",
      shouldSeal: true,
      eligibleAt: STARTED_AT + 12 * 3600,
      readiness: {
        threshold: DDR_LOCK_READINESS_THRESHOLD,
        earlyLockSatisfied: true,
      },
    });
    expect(exact).toMatchObject({
      action: "pending_lock",
      eligibilityReason: "readiness_not_met",
      shouldSeal: false,
      eligibleAt: STARTED_AT + DDR_LOCK_BACKSTOP_DELAY_SEC,
      readiness: {
        threshold: DDR_LOCK_READINESS_THRESHOLD,
        earlyLockSatisfied: false,
      },
    });
  });

  it("keeps below-threshold incidents pending until the 72h backstop", () => {
    const beforeBackstop = evaluateDdrLockPolicy(
      row({
        readinessScore: 0.74,
        evaluatedAt: STARTED_AT + DDR_LOCK_BACKSTOP_DELAY_SEC - 1,
      }),
    );
    const atBackstop = evaluateDdrLockPolicy(
      row({
        eventId: 2,
        readinessScore: 0.74,
        evaluatedAt: STARTED_AT + DDR_LOCK_BACKSTOP_DELAY_SEC,
      }),
    );

    expect(beforeBackstop).toMatchObject({
      action: "pending_lock",
      eligibilityReason: "readiness_not_met",
      shouldSeal: false,
    });
    expect(atBackstop).toMatchObject({
      action: "lock_prediction",
      eligibilityReason: "backstop_72h",
      shouldSeal: true,
      eligibleAt: STARTED_AT + DDR_LOCK_BACKSTOP_DELAY_SEC,
    });
  });
});
