import { describe, expect, it } from "vitest";
import type { V9OperationalResilienceFact } from "../../types/safety-score-v9-operational-resilience";
import {
  evaluateV9OperationalResilience,
  type V9OperationalResilienceMeasuredMarketDepth,
  type V9OperationalResiliencePolicy,
} from "../safety-score-v9/operational-resilience";

const POLICY: V9OperationalResiliencePolicy = {
  minimumLiveHistoryMonths: 36,
  maximumCredit: { backing: 3, exit: 8, control: 3 },
  confidenceMultipliers: {
    "issuer-reported": 0.5,
    "independent-assurance": 0.85,
    audited: 1,
    measured: 1,
  },
  redemption: {
    minimumCumulativeSupplyRatio: 0.5,
    minimumPeakStressSupplyRatio: 0.05,
    cumulativeCredit: 2,
    stressCredit: 3,
  },
  marketDepth: { minimumCompleteCycles: 3, minimumCompletionRatio: 0.8, credit: 2 },
  stressEpisodes: { minimumEpisodes: 2, maximumRecoverySec: 7 * 86_400, credit: 2 },
  reconciliation: { minimumHistoryMonths: 24, credit: 3 },
};

const NO_BLOCKERS = {
  activeDepeg: false,
  globalReserveImpairment: false,
  criticalControlFailure: false,
  criticalDependency: false,
  issuerOpacity: false,
};

const MEASURED_DEPTH: V9OperationalResilienceMeasuredMarketDepth = {
  completeProducerCycleCount: 6,
  successfulObservationCount: 6,
  conservativeCompletionRatio: 0.95,
  evidenceRefIds: ["depth-window"],
};

function facts(): V9OperationalResilienceFact {
  return {
    schemaVersion: 1,
    reviewedAtSec: 1_750_000_000,
    expiresAtSec: 1_800_000_000,
    liveHistoryEligibility: {
      minimumLiveHistoryMonths: 120,
      observedAtSec: 1_740_000_000,
      treatment: "eligibility-only",
      confidence: "audited",
      evidenceRefIds: ["live-history"],
    },
    redemptionThroughput: {
      cumulativeLifetimeRedeemedSupplyRatio: {
        value: 0.75,
        confidence: "audited",
        evidenceRefIds: ["redemption-total"],
      },
      stressWindows: [
        {
          episodeKey: "stress-1",
          observedAtSec: 1_700_000_000,
          maximumWindowDays: 7,
          redeemedUsdLowerBound: 10_000_000_000,
          redeemedSupplyRatioLowerBound: 0.08,
          settlement: {
            state: "settled-in-full",
            verification: "independently-verified",
          },
          confidence: "audited",
          evidenceRefIds: ["redemption-stress"],
        },
      ],
    },
    stressEpisodes: [
      {
        episodeKey: "stress-1",
        name: "Stress one",
        observedMonth: "2022-05",
        redemptionContinued: true,
        recoveredWithinSec: 86_400,
        confidence: "audited",
        evidenceRefIds: ["stress-1"],
      },
      {
        episodeKey: "stress-2",
        name: "Stress two",
        observedMonth: "2023-03",
        redemptionContinued: true,
        recoveredWithinSec: 172_800,
        confidence: "audited",
        evidenceRefIds: ["stress-2"],
      },
    ],
    reserveReconciliation: {
      reportHistory: {
        firstReportPeriodEnd: "2022-06-30",
        latestReportPeriodEnd: "2026-03-31",
        observedReportHistoryMonths: 45,
        reportedCadence: "quarterly",
        continuityEvidence: "independently-verified",
        missedMaterialPeriods: 0,
        confidence: "audited",
        evidenceRefIds: ["history-z", "history-a"],
      },
      latestAssurance: {
        level: "audit",
        standard: "ISA",
        periodEnd: "2026-03-31",
        confidence: "audited",
        evidenceRefIds: ["assurance"],
      },
      latestReconciliationProcedures: {
        bankAndDepositaryBalances: true,
        blockchainAssetsAndLiabilities: true,
        confidence: "audited",
        evidenceRefIds: ["procedures"],
      },
    },
    incidentReview: {
      state: "reviewed",
      windowStart: "2022-01-01",
      windowEnd: "2026-03-31",
      confidence: "audited",
      evidenceRefIds: ["incident-review"],
      incidents: [],
    },
  };
}

describe("Safety Score v9 operational resilience", () => {
  it("weights supported claims, caps each pillar, and emits a canonical trace", () => {
    const input = facts();
    input.redemptionThroughput!.stressWindows[0]!.evidenceRefIds = [
      "redemption-stress",
      "redemption-stress",
      "a-redemption-stress",
    ];
    const result = evaluateV9OperationalResilience(
      input,
      MEASURED_DEPTH,
      POLICY,
      NO_BLOCKERS,
    );

    expect(result.eligible).toBe(true);
    expect(result.eligibility).toEqual({
      requiredLiveHistoryMonths: 36,
      documentedLiveHistoryMonths: 120,
      confidence: "audited",
      evidenceRefIds: ["live-history"],
      satisfied: true,
    });
    expect(result.rawPillarCredits).toEqual({ backing: 3, exit: 9, control: 3 });
    expect(result.pillarCredits).toEqual({ backing: 3, exit: 8, control: 3 });
    expect(result.contributions.map(({ component, pillar }) => `${component}:${pillar}`)).toEqual([
      "cumulative-redemption:exit",
      "stress-redemption:exit",
      "persistent-market-depth:exit",
      "stress-recovery:exit",
      "reserve-reconciliation:backing",
      "reserve-reconciliation:control",
    ]);
    expect(result.contributions[1]).toMatchObject({
      basePoints: 3,
      confidence: "audited",
      confidenceMultiplier: 1,
      points: 3,
      evidenceRefIds: ["a-redemption-stress", "redemption-stress"],
    });
    expect(result.contributions[4]!.evidenceRefIds).toEqual([
      "assurance",
      "history-a",
      "history-z",
      "procedures",
    ]);
  });

  it("uses live history only as an eligibility gate", () => {
    const input = facts();
    input.redemptionThroughput = null;
    input.stressEpisodes = [];
    input.reserveReconciliation = null;
    const eligible = evaluateV9OperationalResilience(input, null, POLICY, NO_BLOCKERS);
    expect(eligible.eligible).toBe(true);
    expect(eligible.contributions).toEqual([]);
    expect(eligible.pillarCredits).toEqual({ backing: 0, exit: 0, control: 0 });

    input.liveHistoryEligibility.minimumLiveHistoryMonths = 35;
    const tooYoung = evaluateV9OperationalResilience(
      input,
      MEASURED_DEPTH,
      POLICY,
      NO_BLOCKERS,
    );
    expect(tooYoung.eligible).toBe(false);
    expect(tooYoung.contributions).toEqual([]);

    input.liveHistoryEligibility.minimumLiveHistoryMonths = 120;
    input.liveHistoryEligibility.confidence = "unknown";
    expect(
      evaluateV9OperationalResilience(input, MEASURED_DEPTH, POLICY, NO_BLOCKERS).eligible,
    ).toBe(false);
    expect(
      evaluateV9OperationalResilience(null, MEASURED_DEPTH, POLICY, NO_BLOCKERS).eligibility,
    ).toMatchObject({
      documentedLiveHistoryMonths: null,
      confidence: null,
      satisfied: false,
    });
  });

  it("uses canonical implementation history to qualify measured depth without an editorial overlay", () => {
    const result = evaluateV9OperationalResilience(
      null,
      MEASURED_DEPTH,
      POLICY,
      NO_BLOCKERS,
      {
        minimumLiveHistoryMonths: 120,
        evidenceRefIds: ["implementation-launch"],
      },
    );

    expect(result).toMatchObject({
      eligible: true,
      eligibility: {
        documentedLiveHistoryMonths: 120,
        confidence: "implementation-history",
        evidenceRefIds: ["implementation-launch"],
        satisfied: true,
      },
      pillarCredits: { backing: 0, exit: 2, control: 0 },
      contributions: [
        {
          component: "persistent-market-depth",
          confidence: "measured",
          points: 2,
        },
      ],
    });

    expect(
      evaluateV9OperationalResilience(
        null,
        MEASURED_DEPTH,
        POLICY,
        NO_BLOCKERS,
        { minimumLiveHistoryMonths: 35, evidenceRefIds: ["implementation-launch"] },
      ).eligible,
    ).toBe(false);
  });

  it("does not use implementation history to qualify editorial resilience claims", () => {
    const input = facts();
    input.liveHistoryEligibility.minimumLiveHistoryMonths = 12;
    const implementationHistory = {
      minimumLiveHistoryMonths: 120,
      evidenceRefIds: ["implementation-launch"],
    };

    const withoutDepth = evaluateV9OperationalResilience(
      input,
      null,
      POLICY,
      NO_BLOCKERS,
      implementationHistory,
    );
    expect(withoutDepth.eligible).toBe(false);
    expect(withoutDepth.contributions).toEqual([]);

    const withDepth = evaluateV9OperationalResilience(
      input,
      MEASURED_DEPTH,
      POLICY,
      NO_BLOCKERS,
      implementationHistory,
    );
    expect(withDepth.eligible).toBe(true);
    expect(withDepth.contributions).toEqual([
      expect.objectContaining({ component: "persistent-market-depth", points: 2 }),
    ]);
  });

  it("evaluates cumulative and stress redemption claims independently", () => {
    const input = facts();
    input.stressEpisodes = [];
    input.reserveReconciliation = null;
    input.redemptionThroughput!.cumulativeLifetimeRedeemedSupplyRatio = null;
    input.redemptionThroughput!.stressWindows[0]!.confidence = "issuer-reported";

    const stressOnly = evaluateV9OperationalResilience(input, null, POLICY, NO_BLOCKERS);
    expect(stressOnly.contributions).toEqual([
      expect.objectContaining({
        component: "stress-redemption",
        confidence: "issuer-reported",
        confidenceMultiplier: 0.5,
        points: 1.5,
      }),
    ]);

    input.redemptionThroughput!.stressWindows = [];
    input.redemptionThroughput!.cumulativeLifetimeRedeemedSupplyRatio = {
      value: 0.75,
      confidence: "independent-assurance",
      evidenceRefIds: ["cumulative"],
    };
    const cumulativeOnly = evaluateV9OperationalResilience(
      input,
      null,
      POLICY,
      NO_BLOCKERS,
    );
    expect(cumulativeOnly.contributions).toEqual([
      expect.objectContaining({
        component: "cumulative-redemption",
        confidence: "independent-assurance",
        confidenceMultiplier: 0.85,
        points: 1.7,
      }),
    ]);
  });

  it("awards no credit to unknown-confidence claims", () => {
    const input = facts();
    input.redemptionThroughput!.cumulativeLifetimeRedeemedSupplyRatio!.confidence = "unknown";
    input.redemptionThroughput!.stressWindows[0]!.confidence = "unknown";
    input.stressEpisodes.forEach((episode) => {
      episode.confidence = "unknown";
    });
    input.reserveReconciliation!.reportHistory.confidence = "unknown";

    const result = evaluateV9OperationalResilience(input, null, POLICY, NO_BLOCKERS);
    expect(result.contributions).toEqual([]);
    expect(result.pillarCredits).toEqual({ backing: 0, exit: 0, control: 0 });
  });

  it("requires enough successful measured observations, not merely complete cycles", () => {
    const input = facts();
    input.redemptionThroughput = null;
    input.stressEpisodes = [];
    input.reserveReconciliation = null;
    const sparse = {
      ...MEASURED_DEPTH,
      completeProducerCycleCount: 10,
      successfulObservationCount: 2,
    };
    expect(
      evaluateV9OperationalResilience(input, sparse, POLICY, NO_BLOCKERS).contributions,
    ).toEqual([]);

    const persistent = { ...sparse, successfulObservationCount: 3 };
    expect(
      evaluateV9OperationalResilience(input, persistent, POLICY, NO_BLOCKERS).contributions,
    ).toEqual([
      expect.objectContaining({
        component: "persistent-market-depth",
        confidence: "measured",
        confidenceMultiplier: 1,
        points: 2,
      }),
    ]);
  });

  it("uses the strongest sufficient set of documented stress recoveries", () => {
    const input = facts();
    input.redemptionThroughput = null;
    input.reserveReconciliation = null;
    input.stressEpisodes.push(
      {
        episodeKey: "stress-3",
        name: "Stress three",
        observedMonth: "2024-01",
        redemptionContinued: true,
        recoveredWithinSec: 43_200,
        confidence: "issuer-reported",
        evidenceRefIds: ["weak-extra"],
      },
      {
        episodeKey: "stress-unknown",
        name: "Unknown stress",
        observedMonth: "2025-01",
        redemptionContinued: true,
        recoveredWithinSec: 43_200,
        confidence: "unknown",
        evidenceRefIds: ["unknown"],
      },
    );
    input.stressEpisodes[1]!.confidence = "independent-assurance";

    const result = evaluateV9OperationalResilience(input, null, POLICY, NO_BLOCKERS);
    expect(result.contributions).toEqual([
      expect.objectContaining({
        component: "stress-recovery",
        confidence: "independent-assurance",
        confidenceMultiplier: 0.85,
        points: 1.7,
        evidenceRefIds: ["stress-1", "stress-2"],
      }),
    ]);
  });

  it("requires a known clean reconciliation history, procedures, and assurance", () => {
    const input = facts();
    input.redemptionThroughput = null;
    input.stressEpisodes = [];

    input.reserveReconciliation!.latestAssurance.confidence = "independent-assurance";
    const qualified = evaluateV9OperationalResilience(input, null, POLICY, NO_BLOCKERS);
    expect(qualified.pillarCredits).toEqual({ backing: 2.55, exit: 0, control: 2.55 });

    for (const mutate of [
      (value: V9OperationalResilienceFact) => {
        value.reserveReconciliation!.reportHistory.missedMaterialPeriods = null;
      },
      (value: V9OperationalResilienceFact) => {
        value.reserveReconciliation!.reportHistory.continuityEvidence = "unknown";
      },
      (value: V9OperationalResilienceFact) => {
        value.reserveReconciliation!.latestReconciliationProcedures.bankAndDepositaryBalances =
          null;
      },
      (value: V9OperationalResilienceFact) => {
        value.reserveReconciliation!.latestReconciliationProcedures
          .blockchainAssetsAndLiabilities = false;
      },
      (value: V9OperationalResilienceFact) => {
        value.reserveReconciliation!.latestAssurance.confidence = "unknown";
      },
    ]) {
      const unqualified = facts();
      unqualified.redemptionThroughput = null;
      unqualified.stressEpisodes = [];
      mutate(unqualified);
      expect(
        evaluateV9OperationalResilience(unqualified, null, POLICY, NO_BLOCKERS)
          .contributions,
      ).toEqual([]);
    }
  });

  it.each([
    "activeDepeg",
    "globalReserveImpairment",
    "criticalControlFailure",
    "criticalDependency",
    "issuerOpacity",
  ] as const)("cannot override %s", (blocker) => {
    const result = evaluateV9OperationalResilience(facts(), MEASURED_DEPTH, POLICY, {
      ...NO_BLOCKERS,
      [blocker]: true,
    });
    expect(result.eligible).toBe(false);
    expect(result.pillarCredits).toEqual({ backing: 0, exit: 0, control: 0 });
    expect(result.blockerCodes).toEqual([blocker]);
  });

  it("treats a reviewed active material incident as a blocker", () => {
    const input = facts();
    if (input.incidentReview.state !== "reviewed") throw new Error("Expected reviewed facts");
    input.incidentReview.incidents = [
      {
        incidentKey: "active-control",
        name: "Active control incident",
        category: "control",
        state: "active",
        occurredAt: "2026-01-01",
        resolvedAt: null,
        confidence: "independent-assurance",
        evidenceRefIds: ["incident"],
      },
    ];
    const result = evaluateV9OperationalResilience(
      input,
      MEASURED_DEPTH,
      POLICY,
      NO_BLOCKERS,
    );
    expect(result.eligible).toBe(false);
    expect(result.contributions).toEqual([]);
    expect(result.blockerCodes).toEqual(["activeMaterialIncident"]);
  });
});
