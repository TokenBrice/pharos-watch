import { describe, expect, it } from "vitest";
import type { V9FactGapV2 } from "../../types/safety-score-v9-facts";
import type { V9BackingAssetInput, V9MechanismFactV1 } from "../safety-score-v9/backing-primitives";
import { V9MechanismRiskReviewSchema } from "../../types/safety-score-v9-backing";
import { MECHANISM_ARCHETYPE_VALUES } from "../../types/stablecoin-taxonomy";
import { evaluateV9Backing, type V9MechanismRiskReview } from "../safety-score-v9/archetypes";
import { V9_CANDIDATE_POLICY_V1 } from "../safety-score-v9/policy";

import { asset as backingAsset, exposure, knownStatus, missingMechanism } from "./safety-score-v9-backing.test-support";

const strongFact = (id: string): V9MechanismFactV1 => ({
  status: knownStatus(`evidence:${id}`, "mechanism.required"),
  quality: "strong",
  failureDomains: [{ kind: "reserve-issuer", key: id }],
});

const weakObservedFact = (id: string): V9MechanismFactV1 => ({
  status: knownStatus(`evidence:${id}`, "mechanism.required"),
  quality: "weak",
  failureDomains: [{ kind: "reserve-issuer", key: id }],
});

const reserveExposure = (key: string) => exposure({ key, weight: 0.25, policyRuleId: "mechanism.required" });

function asset(gaps: readonly V9FactGapV2[] = []): V9BackingAssetInput {
  return {
    ...backingAsset(["a", "b", "c", "d"].map(reserveExposure), gaps, knownStatus("evidence:reserves", "mechanism.required")),
    asOfSec: Date.parse("2026-07-22T00:00:00Z") / 1_000,
  };
}

const measurementPin = {
  measuredAt: "2026-07-20",
  measurementId: "measurement:lvusd-vault-census",
  sourceUrl: "https://example.com/vault-census",
};

const reviews: { [A in V9MechanismRiskReview["archetype"]]: Extract<V9MechanismRiskReview, { archetype: A }> } = {
  "fiat-cash": {
    archetype: "fiat-cash",
    claimAndSegregation: strongFact("claim"),
    custodyContinuity: strongFact("custody"),
    assuranceAndReconciliation: strongFact("assurance"),
  },
  tbill: {
    archetype: "tbill",
    fundClaimAndSeniority: strongFact("fund-claim"),
    navValuation: strongFact("nav"),
    durationAndLiquidity: strongFact("duration"),
    lossRecoveryDesign: strongFact("loss-recovery"),
  },
  cdp: {
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
  "synthetic-delta-neutral": {
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
  algorithmic: {
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
  "rwa-credit-fund": {
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
  "commodity-claim": {
    archetype: "commodity-claim",
    titleAndAllocation: strongFact("title"),
    custodyContinuity: strongFact("vault-custody"),
    assuranceAndReconciliation: strongFact("bar-list"),
    physicalRedemption: strongFact("delivery"),
  },
  "ucits-trs-fund": {
    archetype: "ucits-trs-fund",
    fundClaimAndSegregation: strongFact("fund-claim"),
    navAndReconciliation: strongFact("nav-book"),
    portfolioHedge: strongFact("portfolio-hedge"),
    counterpartyAndCollateral: strongFact("swap-collateral"),
    custodyContinuity: strongFact("fund-custody"),
    defaultRecovery: strongFact("fund-recovery"),
  },
  "shared-reserve": {
    archetype: "shared-reserve",
    holderClaim: strongFact("operational-claim"),
    liabilityConservation: strongFact("pool-ledger"),
    reserveCustody: strongFact("reserve-custody"),
    encumbranceAndAllocation: strongFact("pool-allocation"),
    defaultRecovery: strongFact("pool-recovery"),
  },
  "protocol-position": {
    archetype: "protocol-position",
    holderClaim: strongFact("position-claim"),
    liabilityConservation: strongFact("position-ledger"),
    positionCustody: strongFact("position-custody"),
    encumbranceAndAllocation: strongFact("position-allocation"),
    defaultRecovery: strongFact("position-recovery"),
  },
};

describe("Safety Score v9 archetype backing adapters", () => {
  it.each(["ucits-trs-fund", "shared-reserve", "protocol-position"] as const)(
    "prices unvalued residuals in %s and grants credit only to evidenced conservation",
    (archetype) => {
      const base = reviews[archetype];
      const field = archetype === "ucits-trs-fund" ? "navAndReconciliation" : "liabilityConservation";
      const key = archetype === "ucits-trs-fund" ? "nav-and-reconciliation" : "liability-conservation";
      const unknown = {
        status: { ...knownStatus("evidence:searched-ledger", "mechanism.required"), observationState: "bounded-unknown" as const },
        quality: null,
        failureDomains: [],
      };
      const bounded = evaluateV9Backing(asset(), { ...base, [field]: unknown }, V9_CANDIDATE_POLICY_V1);
      const proved = evaluateV9Backing(asset(), base, V9_CANDIDATE_POLICY_V1);
      const weight = V9_CANDIDATE_POLICY_V1.policy.semantic.backing.archetypes[archetype].componentWeights[key]!;
      const quality = V9_CANDIDATE_POLICY_V1.policy.semantic.backing;
      expect(bounded.contributions).toContainEqual(expect.objectContaining({
        componentKey: `mechanism:${key}`,
        observationState: "bounded-unknown",
        score: quality.boundedUnknownQuality,
      }));
      expect(bounded.contributions.find((row) => row.componentKey === `mechanism:${key}`)?.effectiveWeight).toBeCloseTo(weight, 8);
      expect(proved.score! - bounded.score!).toBeCloseTo(
        weight * (quality.componentQuality.strong - quality.boundedUnknownQuality), 8,
      );
      const adverse = evaluateV9Backing(asset(), { ...base, [field]: weakObservedFact("bad-ledger") }, V9_CANDIDATE_POLICY_V1);
      expect(adverse.score!).toBeLessThan(proved.score!);
      expect(adverse.contributions.find((row) => row.componentKey === `mechanism:${key}`)?.observationState).toBe("known");
    },
  );

  it.each(["shared-reserve", "protocol-position"] as const)(
    "withholds %s when the exact holder claim is missing rather than borrowing a reserve total",
    (archetype) => {
      const missing = missingMechanism("holder-claim", "missing-holder", "mechanism.required", "Unknown exact-token claim");
      const result = evaluateV9Backing(asset([missing.gap]), { ...reviews[archetype], holderClaim: missing.fact }, V9_CANDIDATE_POLICY_V1);
      expect(result.rateability).toBe("NR");
      expect(result.score).toBeNull();
    },
  );

  it("withholds an unidentified UCITS share claim and caps a proved failed position claim rather than calling it unknown", () => {
    const missing = missingMechanism("fund-claim-and-segregation", "missing-share", "mechanism.required", "Exact share class unverified");
    const unidentified = evaluateV9Backing(asset([missing.gap]), {
      ...reviews["ucits-trs-fund"], fundClaimAndSegregation: missing.fact,
    }, V9_CANDIDATE_POLICY_V1);
    expect(unidentified.rateability).toBe("NR");
    expect(unidentified.score).toBeNull();
    const failed = evaluateV9Backing(asset(), {
      ...reviews["protocol-position"],
      holderClaim: { ...strongFact("failed-position-claim"), quality: "failed" },
    }, V9_CANDIDATE_POLICY_V1);
    expect(failed.structuralReasons).toContainEqual(expect.objectContaining({
      kind: "unsafe-backing", severity: "critical", responsibility: "measured-adverse",
      pathKey: "mechanism:holder-claim",
    }));
    expect(failed.pillarCeiling).toBe(V9_CANDIDATE_POLICY_V1.policy.semantic.structural.signalLimits["unsafe-backing"].critical);
  });

  it("retains protocol-position local risk under complete live parent backing, while legacy inheritance stays unchanged", () => {
    const inheritedAsset: V9BackingAssetInput = {
      ...asset(),
      reserveExposures: [{ ...reserveExposure("dai"), weight: 1, provenance: "live", trackedAssetId: "dai-makerdao" }],
      inheritedStablecoinBacking: {
        parentAssetId: "dai-makerdao", parentBackingScore: 90, weight: 1, tier: "wrapped", failureDomains: [],
      },
    };
    const unknown = {
      status: { ...knownStatus("evidence:unreconciled", "mechanism.required"), observationState: "bounded-unknown" as const },
      quality: null, failureDomains: [],
    };
    const local = evaluateV9Backing(inheritedAsset, {
      ...reviews["protocol-position"],
      liabilityConservation: unknown,
      positionCustody: unknown,
      encumbranceAndAllocation: unknown,
      defaultRecovery: unknown,
    }, V9_CANDIDATE_POLICY_V1);
    expect(local.contributions).toContainEqual(expect.objectContaining({
      componentKey: "mechanism:liability-conservation", effectiveWeight: 0.15, observationState: "bounded-unknown",
    }));
    expect(local.contributions).toContainEqual(expect.objectContaining({
      componentKey: "mechanism:encumbrance-and-allocation", effectiveWeight: 0.1, observationState: "bounded-unknown",
    }));
    expect(local.score!).toBeLessThan(90);
    const legacy = evaluateV9Backing(inheritedAsset, reviews.algorithmic, V9_CANDIDATE_POLICY_V1);
    expect(legacy.score).toBe(90);
    expect(legacy.contributions.some((row) => row.source === "mechanism")).toBe(false);
  });

  it("rejects not-applicable residuals instead of reallocating their charge to healthy components", () => {
    const fact = {
      ...strongFact("missing-allocation"),
      quality: null,
      status: {
        ...knownStatus("evidence:missing-allocation", "mechanism.required"),
        applicability: { state: "not-applicable", policyRuleId: "mechanism.required", rationale: "No disclosure found", gapId: null },
      },
    };
    expect(V9MechanismRiskReviewSchema.safeParse({
      ...reviews["protocol-position"], encumbranceAndAllocation: fact,
    }).success).toBe(false);
  });

  it("validates and canonicalizes the discriminated mechanism review contract", () => {
    const review = reviews["synthetic-delta-neutral"];
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
      V9MechanismRiskReviewSchema.parse({ ...reviews.algorithmic, reflexiveBackingShare: 0.5, exogenousBackingShare: 0.6 }),
    ).toThrow();
  });

  it("routes every supported archetype to exactly one rateable adapter", () => {
    const results = Object.values(reviews).map((review) => evaluateV9Backing(asset(), review, V9_CANDIDATE_POLICY_V1));
    expect(results.map((result) => result.archetype)).toEqual(Object.keys(reviews));
    expect(results.every((result) => result.rateability === "rateable" && result.score !== null)).toBe(true);
  });

  it.each(Object.keys(reviews) as V9MechanismRiskReview["archetype"][])(
    "caps %s Backing by the measured covered liability share",
    (archetype) => {
      const review = reviews[archetype];
      const baseline = evaluateV9Backing(asset(), review, V9_CANDIDATE_POLICY_V1);
      const result = evaluateV9Backing(asset(), {
        ...review,
        collateralizationMeasurement: {
          ...measurementPin,
          ratio: 0.64,
          status: knownStatus("evidence:vault-census", "mechanism.required"),
        },
      }, V9_CANDIDATE_POLICY_V1);
      expect(result.score).toBeCloseTo(baseline.score! * 0.64, 8);
      expect(result.structuralReasons).toContainEqual(expect.objectContaining({
        kind: "unsafe-backing",
        responsibility: "measured-adverse",
        pathKey: "mechanism:collateralization-ratio",
        ceiling: baseline.score! * 0.64,
        evidenceRefIds: ["evidence:vault-census"],
      }));
      expect(result.contributions.reduce((sum, row) => sum + row.score * row.effectiveWeight, 0))
        .toBeCloseTo(result.score!, 8);
    },
  );

  it.each([null, 1, 1.5])("does not credit absent or solvent collateralization (%s)", (ratio) => {
    const baseline = evaluateV9Backing(asset(), reviews.algorithmic, V9_CANDIDATE_POLICY_V1);
    const result = evaluateV9Backing(asset(), {
      ...reviews.algorithmic,
      collateralizationMeasurement: ratio === null ? null : {
        ...measurementPin,
        ratio,
        status: knownStatus("evidence:vault-census", "mechanism.required"),
      },
    }, V9_CANDIDATE_POLICY_V1);
    expect(result).toEqual(baseline);
  });

  it("admits a dated shortfall only after its UTC day and before the policy expiry boundary", () => {
    const measuredAtSec = Date.parse(`${measurementPin.measuredAt}T00:00:00Z`) / 1_000;
    const maxAgeSec = V9_CANDIDATE_POLICY_V1.policy.semantic.evidence.evidenceExpiry.mechanismOverlayMaxAgeSec;
    const review = {
      ...reviews.algorithmic,
      collateralizationMeasurement: {
        ...measurementPin,
        ratio: 0.64,
        status: knownStatus("evidence:vault-census", "mechanism.required"),
      },
    };
    for (const asOfSec of [measuredAtSec + 86_400 - 1, measuredAtSec + maxAgeSec]) {
      const input = { ...asset(), asOfSec };
      const baseline = evaluateV9Backing(input, reviews.algorithmic, V9_CANDIDATE_POLICY_V1);
      expect(evaluateV9Backing(input, review, V9_CANDIDATE_POLICY_V1)).toEqual(baseline);
    }
    for (const asOfSec of [measuredAtSec + 86_400, measuredAtSec + maxAgeSec - 1]) {
      const input = { ...asset(), asOfSec };
      const baseline = evaluateV9Backing(input, reviews.algorithmic, V9_CANDIDATE_POLICY_V1);
      expect(evaluateV9Backing(input, review, V9_CANDIDATE_POLICY_V1).score)
        .toBeCloseTo(baseline.score! * 0.64, 8);
    }
  });

  it("treats undated or unevidenced ratios as unknown rather than perpetual adverse measurements", () => {
    const baseline = evaluateV9Backing(asset(), reviews.algorithmic, V9_CANDIDATE_POLICY_V1);
    const measurement = {
      ...measurementPin,
      ratio: 0.64,
      status: knownStatus("evidence:vault-census", "mechanism.required"),
    };
    for (const unadmitted of [
      { ...measurement, measuredAt: null },
      { ...measurement, status: { ...measurement.status, evidenceRefIds: [] } },
    ]) {
      expect(evaluateV9Backing(asset(), {
        ...reviews.algorithmic,
        collateralizationMeasurement: unadmitted,
      }, V9_CANDIDATE_POLICY_V1)).toEqual(baseline);
    }
    expect(evaluateV9Backing({ ...asset(), asOfSec: undefined }, {
      ...reviews.algorithmic,
      collateralizationMeasurement: measurement,
    }, V9_CANDIDATE_POLICY_V1)).toEqual(baseline);
  });

  it("applies a shared parent measurement once across serial wrappers but still charges a distinct local shortfall", () => {
    const measurement = {
      ...measurementPin,
      ratio: 0.64,
      status: knownStatus("evidence:vault-census", "mechanism.required"),
    };
    const parent = evaluateV9Backing({ ...asset(), assetId: "parent" }, {
      ...reviews.algorithmic,
      collateralizationMeasurement: measurement,
    }, V9_CANDIDATE_POLICY_V1);
    const wrappedInput = (assetId: string, upstream: typeof parent): V9BackingAssetInput => ({
      ...asset(),
      assetId,
      reserveExposures: [{
        ...reserveExposure(upstream.assetId),
        weight: 1,
        provenance: "live",
        trackedAssetId: upstream.assetId,
      }],
      inheritedStablecoinBacking: {
        parentAssetId: upstream.assetId,
        parentBackingScore: upstream.score!,
        weight: 1,
        tier: "wrapped",
        failureDomains: [],
        collateralizationApplications: upstream.collateralizationApplications,
      },
    });
    const wrapperInput = wrappedInput("wrapper", parent);
    const duplicateReview = { ...reviews.algorithmic, collateralizationMeasurement: measurement };
    const wrapper = evaluateV9Backing(wrapperInput, duplicateReview, V9_CANDIDATE_POLICY_V1);
    expect(wrapper.score).toBeCloseTo(parent.score!, 8);
    expect(wrapper.collateralizationApplications).toEqual([{
      measurementId: measurement.measurementId,
      measuredAt: measurement.measuredAt,
      ratio: measurement.ratio,
      evidenceRefIds: ["evidence:vault-census"],
      appliedByAssetId: "parent",
      inheritedFromAssetId: "parent",
    }]);
    const outer = evaluateV9Backing(wrappedInput("outer", wrapper), duplicateReview, V9_CANDIDATE_POLICY_V1);
    expect(outer.score).toBeCloseTo(parent.score!, 8);
    expect(outer.collateralizationApplications?.[0]).toMatchObject({
      appliedByAssetId: "parent",
      inheritedFromAssetId: "wrapper",
    });
    const local = evaluateV9Backing(wrapperInput, {
      ...reviews.algorithmic,
      collateralizationMeasurement: {
        ...measurement,
        measurementId: "measurement:wrapper-local-census",
        ratio: 0.8,
        status: knownStatus("evidence:wrapper-census", "mechanism.required"),
      },
    }, V9_CANDIDATE_POLICY_V1);
    expect(local.score).toBeCloseTo(parent.score! * 0.8, 8);
    expect(local.pillarCeiling).toBeCloseTo(parent.score! * 0.8, 8);
    expect(local.collateralizationApplications).toContainEqual(expect.objectContaining({
      measurementId: "measurement:wrapper-local-census",
      appliedByAssetId: "wrapper",
      inheritedFromAssetId: null,
    }));
  });

  it("retains the measured solvency haircut when a complete live reserve inherits parent quality", () => {
    const inheritedAsset: V9BackingAssetInput = {
      ...asset(),
      reserveExposures: [{
        ...reserveExposure("usdc"),
        weight: 1,
        provenance: "live",
        trackedAssetId: "usdc-circle",
      }],
      inheritedStablecoinBacking: {
        parentAssetId: "usdc-circle",
        parentBackingScore: 90,
        weight: 1,
        tier: "wrapped",
        failureDomains: [],
      },
    };
    const baseline = evaluateV9Backing(inheritedAsset, reviews.algorithmic, V9_CANDIDATE_POLICY_V1);
    const result = evaluateV9Backing(inheritedAsset, {
      ...reviews.algorithmic,
      collateralizationMeasurement: {
        ...measurementPin,
        ratio: 0.64,
        status: knownStatus("evidence:vault-census", "mechanism.required"),
      },
    }, V9_CANDIDATE_POLICY_V1);
    expect(baseline.score).toBe(90);
    expect(result.score).toBeCloseTo(57.6, 8);
    expect(result.pillarCeiling).toBeCloseTo(57.6, 8);
    expect(result.structuralReasons).toContainEqual(expect.objectContaining({
      pathKey: "mechanism:collateralization-ratio",
      responsibility: "measured-adverse",
    }));
    expect(result.contributions).toContainEqual(expect.objectContaining({
      componentKey: "reserve:inherited-backing:usdc-circle",
      score: 90,
      effectiveWeight: 0.64 * 0.85,
    }));
    expect(result.contributions).toContainEqual(expect.objectContaining({
      componentKey: "mechanism:uncovered-liability",
      score: 0,
      effectiveWeight: 0.36,
      observationState: "known",
    }));
  });

  it("prices a measured zero as uncovered rather than missing collateralization", () => {
    const result = evaluateV9Backing(asset(), {
      ...reviews.algorithmic,
      collateralizationMeasurement: {
        ...measurementPin,
        ratio: 0,
        status: knownStatus("evidence:vault-census", "mechanism.required"),
      },
    }, V9_CANDIDATE_POLICY_V1);
    expect(result.rateability).toBe("rateable");
    expect(result.score).toBe(0);
    expect(result.pillarCeiling).toBe(0);
  });

  it("does not replace an unrated required mechanism with a measured solvency result", () => {
    const missing = missingMechanism("contraction-capacity", "missing-contraction", "mechanism.required", "Unbounded contraction");
    const result = evaluateV9Backing(asset([missing.gap]), {
      ...reviews.algorithmic,
      contractionCapacity: missing.fact,
      collateralizationMeasurement: {
        ...measurementPin,
        ratio: 0.64,
        status: knownStatus("evidence:vault-census", "mechanism.required"),
      },
    }, V9_CANDIDATE_POLICY_V1);
    expect(result.rateability).toBe("NR");
    expect(result.score).toBeNull();
    expect(result.structuralReasons.some((reason) => reason.pathKey === "mechanism:collateralization-ratio")).toBe(false);
  });

  it.each(["bounded-unknown", "stale", "missing"] as const)(
    "rejects a %s observation posing as a measured collateralization ratio",
    (observationState) => {
      expect(V9MechanismRiskReviewSchema.safeParse({
        ...reviews.algorithmic,
        collateralizationMeasurement: {
          ...measurementPin,
          ratio: 0.64,
          status: {
            ...knownStatus("evidence:vault-census", "mechanism.required"),
            observationState,
            gapIds: ["unadmitted-measurement"],
          },
        },
      }).success).toBe(false);
    },
  );

  describe("commodity-claim (v9.14)", () => {
    const commodityReview = reviews["commodity-claim"];

    it("weights distinct commodity component qualities in the evaluated backing score", () => {
      const result = evaluateV9Backing(asset(), {
        ...commodityReview,
        titleAndAllocation: { ...strongFact("title"), quality: "adequate" },
        custodyContinuity: { ...strongFact("custody"), quality: "limited" },
        assuranceAndReconciliation: weakObservedFact("assurance"),
        physicalRedemption: { ...strongFact("delivery"), quality: "failed" },
      }, V9_CANDIDATE_POLICY_V1);
      // Four equal cash slices yield 97.355 reserve quality. Component grades
      // 87 / 60 / 35 / 10 carry weights .15 / .10 / .13 / .07.
      expect(result.rateability).toBe("rateable");
      expect(result.score).toBeCloseTo(77.84525, 8);
    });

    it("publishes one mechanism contribution per component under the commodity archetype", () => {
      const result = evaluateV9Backing(asset(), commodityReview, V9_CANDIDATE_POLICY_V1);
      expect(result.archetype).toBe("commodity-claim");
      expect(result.rateability).toBe("rateable");
      expect(
        result.contributions
          .filter((contribution) => contribution.source === "mechanism")
          .map((contribution) => contribution.componentKey),
      ).toEqual([
        "mechanism:assurance-and-reconciliation",
        "mechanism:custody-continuity",
        "mechanism:physical-redemption",
        "mechanism:title-and-allocation",
      ]);
    });

    it("fails closed on a missing title claim but stays rateable without redemption evidence", () => {
      const { gap, fact: missing } = missingMechanism(
        "title-and-allocation", "gap:title", "commodity.title.required", "Title to allocated metal is unresolved",
      );

      expect(
        evaluateV9Backing(asset([gap]), { ...commodityReview, titleAndAllocation: missing }, V9_CANDIDATE_POLICY_V1)
          .rateability,
      ).toBe("NR");
      const withoutRedemption = evaluateV9Backing(
        asset([{ ...gap, gapId: "gap:redemption", path: { kind: "local-component", componentKey: "physical-redemption" } }]),
        {
          ...commodityReview,
          physicalRedemption: { ...missing, status: { ...missing.status, gapIds: ["gap:redemption"] } },
        },
        V9_CANDIDATE_POLICY_V1,
      );
      expect(withoutRedemption.rateability).toBe("rateable");
      expect(withoutRedemption.score).not.toBeNull();
    });

    it("grades a failed title claim as a critical unsafe-backing signal", () => {
      const result = evaluateV9Backing(
        asset(),
        { ...commodityReview, titleAndAllocation: { ...strongFact("title"), quality: "failed" } },
        V9_CANDIDATE_POLICY_V1,
      );
      expect(result.structuralReasons).toContainEqual(
        expect.objectContaining({ kind: "unsafe-backing", severity: "critical" }),
      );
    });

    it("does not treat a failed physical-redemption grade as a structural backing signal", () => {
      const result = evaluateV9Backing(
        asset(),
        { ...commodityReview, physicalRedemption: { ...strongFact("delivery"), quality: "failed" } },
        V9_CANDIDATE_POLICY_V1,
      );
      expect(result.structuralReasons).toEqual([]);
      expect(result.rateability).toBe("rateable");
    });
  });

  it("dispatches on exactly the archetypes the mechanism-review union declares", () => {
    // evaluateV9Backing tests membership against MECHANISM_ARCHETYPE_VALUES
    // instead of walking Zod's internal `options`; this is the coincidence that
    // makes that substitution safe.
    expect([...MECHANISM_ARCHETYPE_VALUES].sort()).toEqual(
      V9MechanismRiskReviewSchema.options.map((schema) => schema.shape.archetype.value).sort(),
    );
  });

  it("returns a reason-coded NR for an unknown archetype", () => {
    const result = evaluateV9Backing(asset(), { archetype: "new-design" }, V9_CANDIDATE_POLICY_V1);
    expect(result).toMatchObject({ rateability: "NR", score: null });
    expect(result.unresolved).toEqual([expect.objectContaining({ code: "missing-archetype", treatment: "NR" })]);
  });

  it("makes a missing non-substitutable claim NR", () => {
    const { gap, fact: missingClaim } = missingMechanism(
      "claim-and-segregation", "gap:claim", "fiat.claim.required", "The direct reserve claim is unresolved",
    );
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
    const review = { ...reviews.tbill, durationAndLiquidity: notApplicable };
    const result = evaluateV9Backing(asset(), review, V9_CANDIDATE_POLICY_V1);

    expect(result.rateability).toBe("rateable");
    expect(result.contributions.some((entry) => entry.componentKey === "mechanism:duration-and-liquidity")).toBe(false);
  });

  it("requires explicit evidenced N/A metrics and skips only their CDP threshold signals", () => {
    const base = reviews.cdp;
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
    const sdnBase = reviews["synthetic-delta-neutral"];
    const rwaBase = reviews["rwa-credit-fund"];

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
    const base = reviews.algorithmic;
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
      reviews.cdp,
      V9_CANDIDATE_POLICY_V1,
    );
    expect(result.rateability).toBe("rateable");
    expect(result.score).not.toBeNull();
  });
});

describe("Safety Score v9 CDP collateralization bands (Lever 4)", () => {
  const cdpBase = reviews.cdp;
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
