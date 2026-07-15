import { SAFETY_SCORE_METHODOLOGY_VERSION } from "@shared/lib/safety-score-version";
import { evaluateV9EconomicControl, type V9EconomicControlAssetFacts } from "@shared/lib/safety-score-v9/control";
import { evaluateV9FactSet } from "@shared/lib/safety-score-v9/evaluate-set";
import { evaluateV9Exit } from "@shared/lib/safety-score-v9/exit";
import { V9_CANDIDATE_POLICY_V1 } from "@shared/lib/safety-score-v9/policy";
import type { V9FactStatusV2 } from "@shared/types/safety-score-v9-facts";
import type { ReserveSlice } from "@shared/types/reserves";
import { describe, expect, it } from "vitest";
import { createReportCardsFixedInput } from "../report-cards-fixed-input";
import { compileSafetyScoreV9FactSetFromFixedInput } from "../safety-score-v9-fact-set";
import { buildSafetyScoreV9BaselineExtension } from "../safety-score-v9-extension";

const AS_OF_SEC = 10_000;
const OBSERVED_AT_SEC = 9_900;

const DEFAULT_RESERVES: readonly ReserveSlice[] = [
  {
    name: "Custodied cash",
    pct: 100,
    risk: "very-low",
    assetClass: "cash",
    issuerOrObligor: "issuer:alpha",
    riskFactors: ["custody", "counterparty"],
    liquidityHorizon: "immediate",
    maturityDaysMax: 0,
  },
];

function requiredStatus(observationState: "known" | "missing", rule: string): V9FactStatusV2 {
  return {
    applicability: { state: "required", policyRuleId: rule, rationale: null, gapId: null },
    observationState,
    evidenceRefIds: observationState === "known" ? [`evidence:${rule}`] : [],
    gapIds: observationState === "known" ? [] : [`gap:${rule}`],
  };
}

function notApplicableStatus(rule: string): V9FactStatusV2 {
  return {
    applicability: {
      state: "not-applicable",
      policyRuleId: rule,
      rationale: "Reviewed as not applicable for the VERITAS fixture.",
      gapId: null,
    },
    observationState: "known",
    evidenceRefIds: [],
    gapIds: [],
  };
}

function exactFixedInput(reserves: readonly ReserveSlice[] = DEFAULT_RESERVES) {
  return createReportCardsFixedInput({
    captureKind: "exact-publication-inputs",
    activeAssetIds: ["alpha"],
    capturedAt: "2026-07-13T00:00:00.000Z",
    sourceGeneration: "report-cards:veritas:10000",
    dexGenerationId: `dex-liquidity-${OBSERVED_AT_SEC}`,
    redemptionGenerationId: "redemption-backstops-unavailable",
    registryRevision: "registry:veritas",
    methodologyVersion: SAFETY_SCORE_METHODOLOGY_VERSION,
    clockSec: AS_OF_SEC,
    updatedAt: AS_OF_SEC,
    liquidityStale: false,
    redemptionStale: true,
    inputFreshness: {
      dexLiquidity: { updatedAt: OBSERVED_AT_SEC, ageSeconds: 100, stale: false },
      redemptionBackstops: { updatedAt: null, ageSeconds: null, stale: true },
    },
    pegDataById: {
      alpha: {
        id: "alpha",
        symbol: "ALPHA",
        name: "Alpha",
        pegType: "peggedUSD",
        pegCurrency: "USD",
        governance: "centralized",
        currentDeviationBps: 1,
        pegScore: 99,
        priceSource: "fixture-price",
        priceObservedAt: OBSERVED_AT_SEC,
        pegPct: 99,
        severityScore: 0,
        spreadPenalty: 0,
        eventCount: 0,
        worstDeviationBps: 1,
        activeDepeg: false,
        lastEventAt: null,
        trackingSpanDays: 365,
        methodologyVersion: "peg:veritas-v1",
      },
    },
    activeDepegPeakBpsById: {},
    dexLiqMap: {
      alpha: {
        liquidityScore: 0,
        concentrationHhi: 0,
        poolCount: 0,
        chainCount: 0,
        coverageClass: "primary",
        coverageConfidence: 1,
        liquidityEvidenceClass: "measured",
        hasMeasuredLiquidityEvidence: true,
        effectiveTvlUsd: 0,
        balanceMeasuredTvlUsd: 0,
        organicMeasuredTvlUsd: 0,
        exitRouteObservations: [],
        exitRouteObservationCoverage: {
          status: "populated",
          capabilityMatrixVersion: "veritas-zero-route-v1",
          retainedPoolCount: 0,
          observationCount: 0,
          scoreEligibleObservationCount: 0,
          scoreEligiblePoolCount: 0,
          unsupportedPoolCount: 0,
          evidenceCounts: {},
          unsupportedReasons: {},
        },
        methodologyVersion: "dex:veritas-v1",
        updatedAt: OBSERVED_AT_SEC,
      },
    },
    redemptionBackstopMap: {},
    bluechipMap: {},
    resolvedBlacklistStatuses: { alpha: false },
    liveReserveMap: { alpha: [...reserves] },
    liveReserveProvenanceMap: {
      alpha: { source: "fixture-reserve-api", fetchedAt: OBSERVED_AT_SEC },
    },
    chainCirculatingById: {
      alpha: {
        ethereum: {
          current: 10_000_000,
          circulatingPrevDay: 10_000_000,
          circulatingPrevWeek: 10_000_000,
          circulatingPrevMonth: 10_000_000,
        },
      },
    },
    dexDeploymentSupplyCoverageById: {},
    collateralDriftCoins: [],
    liveToFallbackCoins: [],
  });
}

function baselineExtension(fixedInput: ReturnType<typeof exactFixedInput>) {
  return structuredClone(
    buildSafetyScoreV9BaselineExtension(fixedInput, {
      metaById: new Map([
        [
          "alpha",
          {
            id: "alpha",
            mechanismArchetype: "fiat-cash" as const,
            launchDate: "2020-01-01",
          },
        ],
      ]),
    }),
  );
}

// VER-006: the route compiler currently returns bounded-unknown before consulting the
// explicit complete coverage row, producing the bounded score instead of zero.
describe("VERITAS finding VER-006: zero-route completeness is compiled as missing evidence", () => {
  it("maps a reviewed-complete empty route surface to the no-viable-exit path", () => {
    const fixedInput = exactFixedInput();
    const compiled = compileSafetyScoreV9FactSetFromFixedInput(fixedInput, baselineExtension(fixedInput));
    const asset = compiled.assets[0]!;
    const actual = evaluateV9FactSet(compiled, V9_CANDIDATE_POLICY_V1).assets[0]!.exit;
    const expected = evaluateV9Exit(
      { circulatingUsd: 10_000_000, portfolioStatus: "reviewed-complete", routes: [] },
      V9_CANDIDATE_POLICY_V1,
    );

    expect(asset.exitStatus.observationState).toBe("known");
    expect(asset.exitRoutes).toEqual([]);
    expect(actual).toEqual(expected);
    expect(actual).toMatchObject({ score: 0, reasons: expect.arrayContaining(["no-viable-exit-path"]) });
  });
});

// VER-007: a non-null review currently makes positive circulating supply known even
// though none of that supply is selected, unknown, or unreviewed.
describe("VERITAS finding VER-007: nonconserving supply review is accepted as known", () => {
  it("rejects a positive-supply review whose accounting shares sum to zero", () => {
    const fixedInput = exactFixedInput();
    const extension = baselineExtension(fixedInput);
    extension.assets[0]!.supplyReview = {
      selectedBridgeRoutes: [],
      selectedRouteSupplyShare: 0,
      unknownRouteSupplyShare: 0,
      unreviewedRouteSupplyShare: 0,
      failureDomains: [],
    };

    expect(() => compileSafetyScoreV9FactSetFromFixedInput(fixedInput, extension)).toThrow(
      /bridge.*supply.*share|supply.*reconcil/i,
    );
  });
});

// VER-008: reserve compilation currently enforces <=100% only within each exposure
// identity. Two distinct 60% rows therefore survive into canonical facts.
describe.skip("VERITAS finding VER-008: aggregate reserve weights above 100% pass fact compilation", () => {
  it("rejects a reserve envelope whose distinct exposure weights total 120%", () => {
    const fixedInput = exactFixedInput([
      {
        name: "Custodied cash A",
        pct: 60,
        risk: "very-low",
        assetClass: "cash",
        issuerOrObligor: "issuer:a",
        riskFactors: ["custody", "counterparty"],
        liquidityHorizon: "immediate",
        maturityDaysMax: 0,
      },
      {
        name: "Custodied cash B",
        pct: 60,
        risk: "very-low",
        assetClass: "cash",
        issuerOrObligor: "issuer:b",
        riskFactors: ["custody", "counterparty"],
        liquidityHorizon: "immediate",
        maturityDaysMax: 0,
      },
    ]);

    expect(() => compileSafetyScoreV9FactSetFromFixedInput(fixedInput, baselineExtension(fixedInput))).toThrow(
      /reserve.*(?:100|full notional|total weight)/i,
    );
  });
});

// VER-009: oracle review is required for this archetype and the evaluator emits the
// missing-profile reason, while the policy currently authorizes it only for CDPs.
describe("VERITAS finding VER-009: oracle reasons can escape their archetype allowlist", () => {
  it("keeps every emitted reason compatible with the evaluated asset archetype", () => {
    const facts: V9EconomicControlAssetFacts = {
      assetId: "veritas-synthetic",
      archetype: "synthetic-delta-neutral",
      controlStatus: notApplicableStatus("v9.control.inventory"),
      controls: [],
      supply: {
        status: requiredStatus("known", "v9.supply.current"),
        selectedBridgeRoutes: [
          {
            deploymentRouteKey: "ethereum:native",
            supplyUsd: 10_000_000,
            supplyShare: 1,
            reviewState: "selected-reviewed",
          },
        ],
        selectedRouteSupplyShare: 1,
        unknownRouteSupplyShare: 0,
        unreviewedRouteSupplyShare: 0,
      },
    };
    const result = evaluateV9EconomicControl({
      policy: V9_CANDIDATE_POLICY_V1,
      facts,
      mint: {
        status: notApplicableStatus("v9.control.mint-review"),
        controlKey: null,
        reconciliation: "not-applicable",
        upgrade: { state: "not-applicable", controlKey: null },
      },
      oracle: {
        status: requiredStatus("missing", "v9.control.oracle-review"),
        tier: null,
        branches: [],
      },
      bridge: {
        status: notApplicableStatus("v9.control.bridge-review"),
        routes: [],
      },
    });

    expect(result.reasons).toContainEqual(expect.objectContaining({ code: "missing-oracle-profile" }));
    for (const emitted of result.reasons) {
      const registration = V9_CANDIDATE_POLICY_V1.policy.reasonRegistry.find((entry) => entry.code === emitted.code)!;
      expect(
        registration.archetypes.includes("*") ||
          registration.archetypes.some((archetype) => archetype === facts.archetype),
        `${emitted.code} is not authorized for ${facts.archetype}`,
      ).toBe(true);
    }
  });
});
