import { describe, expect, it } from "vitest";
import type { V9FactGapV2, V9FactStatusV2, V9ReserveExposureFactV2 } from "../../types/safety-score-v9-facts";
import type { V9BackingAssetInput, V9MechanismFactV1 } from "../safety-score-v9/backing";
import { V9MechanismRiskReviewSchema } from "../../types/safety-score-v9-backing";
import { evaluateV9Backing, type V9MechanismRiskReview } from "../safety-score-v9/archetypes";
import { V9_CANDIDATE_POLICY_V1 } from "../safety-score-v9/policy";

const knownStatus = (id: string): V9FactStatusV2 => ({
  applicability: { state: "required", policyRuleId: "mechanism.required", rationale: null, gapId: null },
  observationState: "known",
  evidenceRefIds: [`evidence:${id}`],
  gapIds: [],
});

const strongFact = (id: string): V9MechanismFactV1 => ({
  status: knownStatus(id),
  quality: "strong",
  failureDomains: [{ kind: "reserve-issuer", key: id }],
});

const weakObservedFact = (id: string): V9MechanismFactV1 => ({
  status: knownStatus(id),
  quality: "weak",
  failureDomains: [{ kind: "reserve-issuer", key: id }],
});

const reserveExposure = (key: string): V9ReserveExposureFactV2 => ({
  exposureKey: key,
  classificationKey: `class:${key}`,
  sourceGenerationId: "reserves:test",
  provenance: "curated",
  evidenceClass: "independent",
  status: knownStatus(key),
  name: key,
  weight: 0.25,
  trackedAssetId: null,
  assetClass: "cash",
  issuerOrObligorKey: null,
  riskFactors: [],
  liquidityHorizon: "immediate",
  maturityDaysMax: null,
  failureDomains: [{ kind: "reserve-custodian", key: `custodian:${key}` }],
});

function asset(gaps: readonly V9FactGapV2[] = []): V9BackingAssetInput {
  return {
    assetId: "asset",
    reserveStatus: knownStatus("reserves"),
    reserveExposures: ["a", "b", "c", "d"].map(reserveExposure),
    resolvedUpstreamExposures: [],
    gaps,
  };
}

const reviews: readonly V9MechanismRiskReview[] = [
  {
    archetype: "fiat-cash",
    claimAndSegregation: strongFact("claim"),
    custodyContinuity: strongFact("custody"),
    assuranceAndReconciliation: strongFact("assurance"),
  },
  {
    archetype: "tbill",
    fundClaimAndSeniority: strongFact("fund-claim"),
    navValuation: strongFact("nav"),
    durationAndLiquidity: strongFact("duration"),
    lossRecoveryDesign: strongFact("loss-recovery"),
  },
  {
    archetype: "cdp",
    collateralizationRatio: 1.5,
    liquidationCapacityRatio: 1,
    metricApplicability: {
      collateralizationRatio: { state: "measured" },
      liquidationCapacityRatio: { state: "measured" },
    },
    collateralizationParameters: strongFact("collateralization"),
    liquidationMechanics: strongFact("liquidation"),
    backstop: strongFact("backstop"),
    branchIsolation: strongFact("branch"),
    shutdownAndBadDebt: strongFact("shutdown"),
    structuralRedemption: strongFact("psm"),
  },
  {
    archetype: "synthetic-delta-neutral",
    hedgeCoverageRatio: 1,
    marginBufferPct: 10,
    lossAbsorptionShare: 0.05,
    venueShares: [{ venueKey: "venue", share: 0.2, failureDomains: [{ kind: "reserve-custodian", key: "venue" }] }],
    venueAndCustody: strongFact("venue"),
    hedgeReconciliation: strongFact("hedge"),
    fundingBasisStress: strongFact("funding"),
    marginAndLiquidation: strongFact("margin"),
    unwindCapacity: strongFact("unwind"),
    lossAbsorption: strongFact("insurance"),
  },
  {
    archetype: "algorithmic",
    exogenousBackingShare: 1,
    reflexiveBackingShare: 0,
    contractionCapacityRatio: 1,
    contractionCapacity: strongFact("contraction"),
    confidenceAndIncentives: strongFact("confidence"),
    oracleAndControlAssumptions: strongFact("oracle"),
    emergencyRecovery: strongFact("emergency"),
    lossRecovery: strongFact("algorithmic-recovery"),
  },
  {
    archetype: "rwa-credit-fund",
    weightedAverageMaturityDays: 90,
    valuationCadenceDays: 7,
    creditQuality: strongFact("credit"),
    seniority: strongFact("seniority"),
    legalEnforceability: strongFact("legal"),
    valuationCadence: strongFact("valuation"),
    maturityAndLiquidity: strongFact("maturity"),
    custody: strongFact("rwa-custody"),
    recovery: strongFact("recovery"),
  },
];

describe("Safety Score v9 archetype backing adapters", () => {
  it("validates and canonicalizes the discriminated mechanism review contract", () => {
    const review = reviews[3];
    expect(review.archetype).toBe("synthetic-delta-neutral");
    const parsed = V9MechanismRiskReviewSchema.parse({
      ...review,
      venueShares: [
        { venueKey: "z", share: 0.1, failureDomains: [{ kind: "reserve-custodian", key: "z" }] },
        { venueKey: "a", share: 0.1, failureDomains: [{ kind: "reserve-custodian", key: "a" }] },
      ],
    });
    expect(parsed.archetype === "synthetic-delta-neutral" && parsed.venueShares.map((venue) => venue.venueKey)).toEqual(
      ["a", "z"],
    );
    expect(() =>
      V9MechanismRiskReviewSchema.parse({ ...reviews[4], reflexiveBackingShare: 0.5, exogenousBackingShare: 0.6 }),
    ).toThrow();
  });

  it("routes every supported archetype to exactly one rateable adapter", () => {
    const results = reviews.map((review) => evaluateV9Backing(asset(), review, V9_CANDIDATE_POLICY_V1));
    expect(results.map((result) => result.archetype)).toEqual(reviews.map((review) => review.archetype));
    expect(results.every((result) => result.rateability === "rateable" && result.score !== null)).toBe(true);
    expect(new Set(results.map((result) => result.traceDigest)).size).toBe(6);
  });

  it("returns a reason-coded NR for an unknown archetype", () => {
    const result = evaluateV9Backing(asset(), { archetype: "new-design" }, V9_CANDIDATE_POLICY_V1);
    expect(result).toMatchObject({ rateability: "NR", score: null });
    expect(result.unresolved).toEqual([expect.objectContaining({ code: "missing-archetype", treatment: "NR" })]);
  });

  it("makes a missing non-substitutable claim NR", () => {
    const gap: V9FactGapV2 = {
      gapId: "gap:claim",
      reasonCode: "critical-unresolved",
      ownerDomain: "backing",
      policyRuleId: "fiat.claim.required",
      observationState: "missing",
      path: { kind: "local-component", componentKey: "claim-and-segregation" },
      message: "The direct reserve claim is unresolved",
      evidenceRefIds: [],
    };
    const missingClaim: V9MechanismFactV1 = {
      status: {
        applicability: { state: "required", policyRuleId: "fiat.claim.required", rationale: null, gapId: null },
        observationState: "missing",
        evidenceRefIds: [],
        gapIds: [gap.gapId],
      },
      quality: null,
      failureDomains: [],
    };
    const result = evaluateV9Backing(
      asset([gap]),
      {
        archetype: "fiat-cash",
        claimAndSegregation: missingClaim,
        custodyContinuity: strongFact("custody"),
        assuranceAndReconciliation: strongFact("assurance"),
      },
      V9_CANDIDATE_POLICY_V1,
    );

    expect(result.rateability).toBe("NR");
    expect(result.unresolved).toContainEqual(expect.objectContaining({ code: "critical-unresolved", treatment: "NR" }));
  });

  it("redistributes an explicitly inapplicable component without inventing a weak score", () => {
    const notApplicable: V9MechanismFactV1 = {
      status: {
        applicability: {
          state: "not-applicable",
          policyRuleId: "tbill.duration.not-applicable",
          rationale: "The fund has no maturity exposure",
          gapId: null,
        },
        observationState: "known",
        evidenceRefIds: ["evidence:duration-na"],
        gapIds: [],
      },
      quality: null,
      failureDomains: [],
    };
    const review = { ...reviews[1], durationAndLiquidity: notApplicable } as Extract<
      V9MechanismRiskReview,
      { archetype: "tbill" }
    >;
    const result = evaluateV9Backing(asset(), review, V9_CANDIDATE_POLICY_V1);

    expect(result.rateability).toBe("rateable");
    expect(result.contributions.some((entry) => entry.componentKey === "mechanism:duration-and-liquidity")).toBe(false);
  });

  it("requires explicit evidenced N/A metrics and skips only their CDP threshold signals", () => {
    const base = reviews[2] as Extract<V9MechanismRiskReview, { archetype: "cdp" }>;
    const measured = evaluateV9Backing(
      asset(),
      { ...base, collateralizationRatio: 0.5, liquidationCapacityRatio: 0 },
      V9_CANDIDATE_POLICY_V1,
    );
    const notApplicable = V9MechanismRiskReviewSchema.parse({
      ...base,
      collateralizationRatio: null,
      liquidationCapacityRatio: null,
      metricApplicability: {
        collateralizationRatio: {
          state: "not-applicable",
          rationale: "No independent per-token collateral system exists.",
          evidenceRefIds: ["evidence:cr-na"],
        },
        liquidationCapacityRatio: {
          state: "not-applicable",
          rationale: "No committed debt-offset liquidation pool exists.",
          evidenceRefIds: ["evidence:liquidation-na"],
        },
      },
    });
    if (notApplicable.archetype !== "cdp") throw new Error("unexpected archetype");
    const skipped = evaluateV9Backing(asset(), notApplicable, V9_CANDIDATE_POLICY_V1);

    expect(measured.structuralReasons.length).toBeGreaterThan(skipped.structuralReasons.length);
    expect(() =>
      V9MechanismRiskReviewSchema.parse({
        ...base,
        collateralizationRatio: null,
      }),
    ).toThrow(/Measured collateralizationRatio/);
    expect(() =>
      V9MechanismRiskReviewSchema.parse({
        ...base,
        collateralizationRatio: null,
        metricApplicability: {
          ...base.metricApplicability,
          collateralizationRatio: { state: "not-applicable", rationale: "No vault system.", evidenceRefIds: [] },
        },
      }),
    ).toThrow();
  });

  it("fires structural signals for unavailable sdn/rwa metrics and skips evidenced N/A ones", () => {
    const sdnBase = reviews[3] as Extract<V9MechanismRiskReview, { archetype: "synthetic-delta-neutral" }>;
    const rwaBase = reviews[5] as Extract<V9MechanismRiskReview, { archetype: "rwa-credit-fund" }>;

    const sdnFull = evaluateV9Backing(asset(), sdnBase, V9_CANDIDATE_POLICY_V1);
    const sdnUnavailable = V9MechanismRiskReviewSchema.parse({
      ...sdnBase,
      hedgeCoverageRatio: null,
      metricApplicability: {
        hedgeCoverageRatio: {
          state: "unavailable",
          rationale: "No hedge-position or venue-notional dataset is published.",
          evidenceRefIds: ["evidence:hedge-unavailable"],
        },
        marginBufferPct: { state: "measured" },
        lossAbsorptionShare: { state: "measured" },
      },
    });
    if (sdnUnavailable.archetype !== "synthetic-delta-neutral") throw new Error("unexpected archetype");
    const sdnPenalized = evaluateV9Backing(asset(), sdnUnavailable, V9_CANDIDATE_POLICY_V1);
    // Unavailable hedge coverage fires the hedge signal the full measured
    // review (ratio 1) does not.
    expect(sdnPenalized.structuralReasons.length).toBeGreaterThan(sdnFull.structuralReasons.length);
    expect(
      sdnPenalized.structuralReasons.find(
        (reason) => reason.pathKey === "mechanism:hedge-reconciliation",
      ),
    ).toMatchObject({
      responsibility: "issuer-undisclosed",
      evidenceRefIds: ["evidence:hedge-unavailable"],
    });

    const rwaFull = evaluateV9Backing(asset(), rwaBase, V9_CANDIDATE_POLICY_V1);
    const rwaUnavailable = V9MechanismRiskReviewSchema.parse({
      ...rwaBase,
      weightedAverageMaturityDays: null,
      metricApplicability: {
        weightedAverageMaturityDays: {
          state: "unavailable",
          rationale: "Portfolio tenors are undisclosed and the dominant holding is perpetual.",
          evidenceRefIds: ["evidence:wam-unavailable"],
        },
        valuationCadenceDays: { state: "measured" },
      },
    });
    if (rwaUnavailable.archetype !== "rwa-credit-fund") throw new Error("unexpected archetype");
    const rwaPenalized = evaluateV9Backing(asset(), rwaUnavailable, V9_CANDIDATE_POLICY_V1);
    expect(rwaPenalized.structuralReasons.length).toBeGreaterThan(rwaFull.structuralReasons.length);
    expect(
      rwaPenalized.structuralReasons.find(
        (reason) => reason.pathKey === "mechanism:maturity-and-liquidity",
      ),
    ).toMatchObject({
      responsibility: "issuer-undisclosed",
      evidenceRefIds: ["evidence:wam-unavailable"],
    });

    // An evidenced N/A maturity metric skips the mismatch signal entirely.
    const rwaNotApplicable = V9MechanismRiskReviewSchema.parse({
      ...rwaBase,
      weightedAverageMaturityDays: null,
      metricApplicability: {
        weightedAverageMaturityDays: {
          state: "not-applicable",
          rationale: "Demand-deposit style claim with no maturity ladder.",
          evidenceRefIds: ["evidence:wam-na"],
        },
        valuationCadenceDays: { state: "measured" },
      },
    });
    if (rwaNotApplicable.archetype !== "rwa-credit-fund") throw new Error("unexpected archetype");
    const rwaSkipped = evaluateV9Backing(asset(), rwaNotApplicable, V9_CANDIDATE_POLICY_V1);
    expect(rwaSkipped.structuralReasons.length).toBe(rwaFull.structuralReasons.length);

    // Consistency refinements: measured needs a number; unavailable must be null.
    expect(() =>
      V9MechanismRiskReviewSchema.parse({ ...sdnBase, hedgeCoverageRatio: null }),
    ).toThrow(/Measured hedgeCoverageRatio/);
    expect(() =>
      V9MechanismRiskReviewSchema.parse({
        ...rwaBase,
        metricApplicability: {
          weightedAverageMaturityDays: {
            state: "unavailable",
            rationale: "Tenors undisclosed.",
            evidenceRefIds: ["evidence:wam-unavailable"],
          },
          valuationCadenceDays: { state: "measured" },
        },
      }),
    ).toThrow(/unavailable weightedAverageMaturityDays must be null/);
  });

  it("emits the algorithmic reflexivity ceiling independently of strong components", () => {
    const base = reviews[4] as Extract<V9MechanismRiskReview, { archetype: "algorithmic" }>;
    const result = evaluateV9Backing(
      asset(),
      {
        ...base,
        exogenousBackingShare: 0.5,
        reflexiveBackingShare: 0.5,
      },
      V9_CANDIDATE_POLICY_V1,
    );

    expect(result.structuralReasons).toContainEqual(
      expect.objectContaining({
        kind: "algorithmic-reflexivity",
        severity: "critical",
        ceiling: 39,
      }),
    );
    expect(result.pillarCeiling).toBe(39);
  });

  it("does not require an issuer for direct non-obligor collateral", () => {
    const directCrypto = {
      ...reserveExposure("eth"),
      weight: 1,
      assetClass: "cryptoasset" as const,
      issuerOrObligorKey: null,
      failureDomains: [{ kind: "chain" as const, key: "ethereum" }],
    };
    const result = evaluateV9Backing(
      { ...asset(), reserveExposures: [directCrypto] },
      reviews[2],
      V9_CANDIDATE_POLICY_V1,
    );
    expect(result.rateability).toBe("rateable");
    expect(result.score).not.toBeNull();
  });
});

describe("Safety Score v9 CDP collateralization bands (Lever 4)", () => {
  const cdpBase = reviews[2] as Extract<V9MechanismRiskReview, { archetype: "cdp" }>;
  const collateralizationReason = (result: ReturnType<typeof evaluateV9Backing>) =>
    result.structuralReasons.find((reason) => reason.pathKey === "mechanism:collateralization-parameters");

  it("lifts a solvent-but-thin CDP (ratio ~1.03, no bad debt) off the critical F floor", () => {
    const result = evaluateV9Backing(asset(), { ...cdpBase, collateralizationRatio: 1.03 }, V9_CANDIDATE_POLICY_V1);
    expect(collateralizationReason(result)).toMatchObject({ kind: "unsafe-backing", severity: "high", ceiling: 59 });
    expect(result.structuralReasons.some((reason) => reason.severity === "critical")).toBe(false);
    expect(result.pillarCeiling).toBe(59);
  });

  it("keeps a moderate rung in [1.05, 1.10) so there is no critical->nothing cliff", () => {
    const result = evaluateV9Backing(asset(), { ...cdpBase, collateralizationRatio: 1.07 }, V9_CANDIDATE_POLICY_V1);
    expect(collateralizationReason(result)).toMatchObject({ severity: "moderate", ceiling: 74 });
  });

  it("never fires the CR signal for a 1:1 aggregator / PSM (metric applicability not-applicable)", () => {
    const psm = V9MechanismRiskReviewSchema.parse({
      ...cdpBase,
      collateralizationRatio: null,
      liquidationCapacityRatio: null,
      metricApplicability: {
        collateralizationRatio: {
          state: "not-applicable",
          rationale: "No per-token collateral vault exists; 1:1 aggregator.",
          evidenceRefIds: ["evidence:cr-na"],
        },
        liquidationCapacityRatio: {
          state: "not-applicable",
          rationale: "No committed debt-offset liquidation pool exists.",
          evidenceRefIds: ["evidence:liquidation-na"],
        },
      },
    });
    if (psm.archetype !== "cdp") throw new Error("unexpected archetype");
    const result = evaluateV9Backing(asset(), psm, V9_CANDIDATE_POLICY_V1);
    expect(collateralizationReason(result)).toBeUndefined();
  });

  it("still floors a genuinely undercollateralized CDP (<1.00) to critical", () => {
    const result = evaluateV9Backing(asset(), { ...cdpBase, collateralizationRatio: 0.95 }, V9_CANDIDATE_POLICY_V1);
    expect(collateralizationReason(result)).toMatchObject({
      kind: "unsafe-backing",
      severity: "critical",
      ceiling: 39,
    });
    expect(result.pillarCeiling).toBe(39);
  });

  it("escalates a thin CDP with observed material bad debt to critical via the CR predicate only", () => {
    const result = evaluateV9Backing(
      asset(),
      { ...cdpBase, collateralizationRatio: 1.03, shutdownAndBadDebt: weakObservedFact("shutdown") },
      V9_CANDIDATE_POLICY_V1,
    );
    expect(collateralizationReason(result)).toMatchObject({ severity: "critical", ceiling: 39 });
    // `weak` bad-debt quality must NOT trip the untouched shutdown-and-bad-debt component
    // (that structural component only fires on `failed`) — the critical comes from the CR gate.
    expect(result.structuralReasons.some((reason) => reason.pathKey === "mechanism:shutdown-and-bad-debt")).toBe(false);
  });
});
