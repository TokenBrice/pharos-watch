import { describe, expect, it } from "vitest";
import type {
  CompiledV9FactSetV3,
  V9AssetFactsV3,
  V9ExitRouteFactV2,
} from "../../types/safety-score-v9-facts";
import { compileV9FactSetV3 } from "../safety-score-v9/compile";
import { evaluateV9FactSet } from "../safety-score-v9/evaluate-set";
import {
  projectV9ExitEvaluationRoute,
  resolveV9DistinctExitCapacity,
  selectV9ExitStressRequest,
} from "../safety-score-v9/exit";
import {
  createV9EvidenceReference,
  createV9FactStatus,
  notApplicableV9Fact,
  requiredV9Applicability,
} from "../safety-score-v9/evidence";
import {
  canonicalV9RouteKey,
  computeV9FactSetDigest,
  parseCompiledV9FactSetV3,
} from "../safety-score-v9/facts";
import { V9_CANDIDATE_POLICY_V1 } from "../safety-score-v9/policy";
import { createV9FactGapV3 } from "../safety-score-v9/reasons";
import { fixturePegFact } from "./safety-score-v9-facts.fixture-support";

const AS_OF_SEC = 1_800_000_000;
const BASE_EVIDENCE_ID = "evidence:base";
const BASE_INPUT_GENERATION_ID = `report-cards-input:v1:${"a".repeat(64)}`;
const DEX_GENERATION_ID = "dex:g1";
const SUPPLY_USD = 100_000_000;

function source(generationId: string, character: string) {
  return {
    generationId,
    payloadSha256: character.repeat(64),
    observedAtSec: AS_OF_SEC - 1_000,
  };
}

const SOURCE_FINGERPRINTS = {
  registry: source("registry:g1", "1"),
  dex: source(DEX_GENERATION_ID, "2"),
  redemption: source("redemption:g1", "3"),
  liveReserves: source("reserves:g1", "4"),
  chainSupply: source("supply:g1", "5"),
  peg: source("peg:g1", "6"),
  researchOverlays: source("research:g1", "7"),
};

function evidence(evidenceId: string, sourceGenerationId = "registry:g1") {
  return createV9EvidenceReference(
    {
      evidenceId,
      sourceId: `fixture:${evidenceId}`,
      sourceGenerationId,
      disposition: "observed",
      observedAtSec: AS_OF_SEC - 100,
      maxAgeSec: 1_000,
    },
    AS_OF_SEC,
  );
}

function knownStatus(evidenceId = BASE_EVIDENCE_ID, policyRuleId = "fixture.required") {
  return createV9FactStatus({
    applicability: requiredV9Applicability(policyRuleId),
    observationState: "known",
    evidenceRefIds: [evidenceId],
  });
}

function notApplicableStatus(policyRuleId: string) {
  return createV9FactStatus({
    applicability: notApplicableV9Fact(policyRuleId, "Reviewed as not applicable in this fixture."),
    observationState: "known",
    evidenceRefIds: [BASE_EVIDENCE_ID],
  });
}

function mechanismFact() {
  return {
    status: knownStatus(),
    quality: "strong" as const,
    failureDomains: [{ kind: "reserve-issuer" as const, key: "mechanism:fixture" }],
  };
}

interface MeasuredRouteOptions {
  routeId: string;
  physicalResourceKey: string;
  executableUsdAtStress: number;
  completeProducerCycleCount?: number;
  successfulObservationCount?: number;
}

function measuredRoute({
  routeId,
  physicalResourceKey,
  executableUsdAtStress,
  completeProducerCycleCount = 3,
  successfulObservationCount = completeProducerCycleCount,
}: MeasuredRouteOptions): V9ExitRouteFactV2 {
  const evidenceId = `evidence:${routeId}`;
  const capacityCurve = [100_000, 1_000_000, 10_000_000, 25_000_000].map(
    (requestedNotionalUsd) => {
      const executableUsd = Math.min(requestedNotionalUsd, executableUsdAtStress);
      return {
        requestedNotionalUsd,
        maxCostBps: 200,
        executableUsd,
        completionRatio: executableUsd / requestedNotionalUsd,
        executionCostBps: 50,
      };
    },
  );
  return {
    routeKey: canonicalV9RouteKey("dex", DEX_GENERATION_ID, routeId),
    routeId,
    lane: "dex",
    sourceGenerationId: DEX_GENERATION_ID,
    routeFamily: "dex-amm",
    holderAccess: "permissionless",
    executionModel: "market-depth",
    executionCertainty: "bounded",
    modelConfidence: "high",
    observationConfidence: "high",
    observationHistory: {
      completeProducerCycleCount,
      successfulObservationCount,
      consecutiveSuccessCount: successfulObservationCount,
      observationWindowStartedAt: AS_OF_SEC - 900,
      observationWindowEndedAt: AS_OF_SEC - 100,
      latestOperationalFailureAt: null,
      conservativeStatistic: "pointwise-minimum",
      conservativeCapacityCurve: capacityCurve.map(
        ({ requestedNotionalUsd, maxCostBps, executableUsd, completionRatio }) => ({
          requestedNotionalUsd,
          maxCostBps,
          executableUsd,
          completionRatio,
        }),
      ),
    },
    evidenceKind: "measured-executable-depth",
    coverageClass: "exact-complete",
    capacityScoringHorizon: "immediate",
    settlementModel: "atomic",
    settlementSlaSec: 0,
    queueDepthUsd: null,
    dailyLimitUsd: null,
    minRedeemUsd: null,
    settlementEvidenceRefIds: [evidenceId],
    physicalResourceKeys: [physicalResourceKey],
    status: knownStatus(evidenceId, "exit.route.current"),
    scoreEligible: true,
    request: {
      requestedNotionalUsd: 10_000_000,
      maxCostBps: 200,
      settlementHorizonSec: 300,
    },
    capacityCurve,
    output: {
      status: knownStatus(evidenceId, "exit.output.valuation"),
      kind: "fiat",
      assetKeys: ["fiat:USD"],
      basketWeights: [],
      valuation: {
        basis: "reviewed-par",
        referenceAssetKey: "fiat:USD",
        unitValueUsd: 1,
        expectedUnitValueUsd: 1,
        valueRetentionRatio: 1,
        sourceId: "fixture-route-source",
        sourceGenerationId: DEX_GENERATION_ID,
        observedAtSec: AS_OF_SEC - 100,
        asOfSec: AS_OF_SEC,
        confidence: "high",
        freshness: {
          state: "current",
          ageSec: 100,
          maxAgeSec: 1_000,
        },
        evidenceRefIds: [evidenceId],
      },
    },
    failureDomains: [
      { kind: "chain", key: "ethereum" },
      { kind: "dex-protocol", key: `dex:${routeId}` },
    ],
  };
}

function operationalResilienceFact() {
  return {
    schemaVersion: 1 as const,
    reviewedAtSec: AS_OF_SEC - 200,
    expiresAtSec: AS_OF_SEC + 86_400,
    liveHistoryEligibility: {
      minimumLiveHistoryMonths: 120,
      observedAtSec: AS_OF_SEC - 200,
      treatment: "eligibility-only" as const,
      confidence: "audited" as const,
      evidenceRefIds: [BASE_EVIDENCE_ID],
    },
    redemptionThroughput: null,
    stressEpisodes: [],
    reserveReconciliation: null,
    incidentReview: {
      state: "reviewed" as const,
      windowStart: "2020-01-01",
      windowEnd: "2026-12-31",
      confidence: "audited" as const,
      evidenceRefIds: [BASE_EVIDENCE_ID],
      incidents: [],
    },
  };
}

function sealFactSet(factSet: CompiledV9FactSetV3): CompiledV9FactSetV3 {
  factSet.v9FactSetDigest = computeV9FactSetDigest(factSet);
  return parseCompiledV9FactSetV3(factSet);
}

function compiledFactSet(routes: readonly V9ExitRouteFactV2[]): CompiledV9FactSetV3 {
  const baseEvidence = evidence(BASE_EVIDENCE_ID);
  const routeEvidence = routes.map((route) => evidence(route.status.evidenceRefIds[0]!, DEX_GENERATION_ID));
  return compileV9FactSetV3({
    schemaVersion: 3,
    baseInputGenerationId: BASE_INPUT_GENERATION_ID,
    asOfSec: AS_OF_SEC,
    compiledAtSec: AS_OF_SEC,
    sourceFingerprints: structuredClone(SOURCE_FINGERPRINTS),
    activeAssetIds: ["fixture-asset"],
    assets: [
      {
        assetId: "fixture-asset",
        archetype: "algorithmic",
        evidence: [baseEvidence, ...routeEvidence],
        gaps: [],
        wrapperLocalFacts: {
          schemaVersion: 1,
          applicability: "not-wrapper",
          evidenceRefIds: [],
        },
        implementation: {
          status: knownStatus(),
          launchedAtSec: 1_400_000_000,
        },
        mechanismRiskReview: {
          status: knownStatus(),
          review: {
            archetype: "algorithmic",
            exogenousBackingShare: 1,
            reflexiveBackingShare: 0,
            contractionCapacityRatio: 1,
            contractionCapacity: mechanismFact(),
            confidenceAndIncentives: mechanismFact(),
            oracleAndControlAssumptions: mechanismFact(),
            emergencyRecovery: mechanismFact(),
            lossRecovery: mechanismFact(),
          },
        },
        dependencies: {
          status: knownStatus(),
          sourceGenerationId: SOURCE_FINGERPRINTS.researchOverlays.generationId,
          source: "none",
          baseSource: "none",
          dependencyFromLive: false,
          mappedLiveReserveWeight: null,
          fallbackReason: null,
          edges: [],
          diagnostics: {
            graphState: "valid",
            issueCodes: [],
            sccMemberAssetIds: [],
          },
        },
        reserveStatus: notApplicableStatus("backing.reserve.not-applicable"),
        reserveExposures: [],
        exitStatus: knownStatus(BASE_EVIDENCE_ID, "exit.portfolio.current"),
        exitRoutes: [...routes],
        controlStatus: notApplicableStatus("control.not-applicable"),
        controls: [],
        economicControlReview: {
          mint: {
            status: notApplicableStatus("control.mint.not-applicable"),
            controlKey: null,
            reconciliation: "not-applicable",
            upgrade: { state: "not-applicable", controlKey: null },
          },
          oracle: {
            status: notApplicableStatus("control.oracle.not-applicable"),
            tier: null,
            branches: [],
          },
          bridge: {
            status: notApplicableStatus("control.bridge.not-applicable"),
            routes: [],
          },
        },
        accessReview: {
          transfer: {
            status: knownStatus(BASE_EVIDENCE_ID, "access.transfer.review"),
            posture: "permissionless",
          },
          freeze: {
            status: knownStatus(BASE_EVIDENCE_ID, "access.freeze.review"),
            reviews: [
              {
                reviewKey: "freeze:none-reviewed",
                source: "blacklist",
                status: knownStatus(BASE_EVIDENCE_ID, "access.freeze.review"),
                reach: "none",
                controlKey: null,
                upstreamAssetId: null,
                failureDomains: [],
              },
            ],
          },
        },
        peg: fixturePegFact(knownStatus(BASE_EVIDENCE_ID, "peg.current"), SOURCE_FINGERPRINTS.peg.generationId),
        supply: {
          status: knownStatus(BASE_EVIDENCE_ID, "supply.current"),
          sourceGenerationId: SOURCE_FINGERPRINTS.chainSupply.generationId,
          sourceKind: "usd-denominated-circulating",
          circulatingUnits: null,
          referencePriceUsd: null,
          circulatingUsd: SUPPLY_USD,
          chainDistribution: {
            chains: [{ chainId: "ethereum", supplyUsd: SUPPLY_USD, supplyShare: 1 }],
            unattributedSupplyUsd: 0,
            unattributedSupplyShare: 0,
          },
          selectedBridgeRoutes: [],
          selectedRouteSupplyShare: 0,
          unknownRouteSupplyShare: 0,
          unreviewedRouteSupplyShare: 0,
          failureDomains: [{ kind: "chain", key: "ethereum" }],
        },
        operationalResilience: operationalResilienceFact(),
      },
    ],
  });
}

function evaluatedAsset(factSet: CompiledV9FactSetV3) {
  return evaluateV9FactSet(factSet, V9_CANDIDATE_POLICY_V1).assets[0]!;
}

function persistentMarketDepthContribution(factSet: CompiledV9FactSetV3) {
  return evaluatedAsset(factSet).operationalResilience?.contributions.find(
    (contribution) => contribution.component === "persistent-market-depth",
  );
}

function mutateFactSet(
  factSet: CompiledV9FactSetV3,
  mutate: (asset: V9AssetFactsV3) => void,
): CompiledV9FactSetV3 {
  const candidate = structuredClone(factSet);
  mutate(candidate.assets[0]!);
  return sealFactSet(candidate);
}

describe("Safety Score v9 operational-resilience full-pipeline integration", () => {
  it("uses the supply-relative stress request instead of a fixed $1m quote", () => {
    const factSet = compiledFactSet([
      measuredRoute({
        routeId: "fixed-notional-trap",
        physicalResourceKey: "pool:fixed-notional-trap",
        executableUsdAtStress: 1_000_000,
      }),
    ]);
    const asset = evaluatedAsset(factSet);

    expect(asset.exit.stressRequest).toMatchObject({
      requestedNotionalUsd: 10_000_000,
      rawSupplyRequestUsd: 5_000_000,
    });
    expect(asset.operationalResilience?.eligible).toBe(true);
    expect(persistentMarketDepthContribution(factSet)).toBeUndefined();
  });

  it("combines distinct measured routes and retains their causal evidence", () => {
    const factSet = compiledFactSet([
      measuredRoute({
        routeId: "route-a",
        physicalResourceKey: "pool:route-a",
        executableUsdAtStress: 4_000_000,
      }),
      measuredRoute({
        routeId: "route-b",
        physicalResourceKey: "pool:route-b",
        executableUsdAtStress: 4_000_000,
      }),
    ]);

    expect(persistentMarketDepthContribution(factSet)).toMatchObject({
      component: "persistent-market-depth",
      points: 2,
      evidenceRefIds: ["evidence:route-a", "evidence:route-b"],
    });
  });

  it("credits persistent measured depth without a bespoke operational overlay", () => {
    const factSet = mutateFactSet(
      compiledFactSet([
        measuredRoute({
          routeId: "deep-route",
          physicalResourceKey: "pool:deep",
          executableUsdAtStress: 10_000_000,
        }),
      ]),
      (asset) => {
        asset.operationalResilience = null;
      },
    );
    const evaluated = evaluatedAsset(factSet);

    expect(evaluated.operationalResilience).toMatchObject({
      eligible: true,
      eligibility: {
        confidence: "implementation-history",
        evidenceRefIds: [BASE_EVIDENCE_ID],
        satisfied: true,
      },
      pillarCredits: { backing: 0, exit: 2, control: 0 },
    });
    expect(persistentMarketDepthContribution(factSet)).toMatchObject({
      component: "persistent-market-depth",
      confidence: "measured",
      points: 2,
    });
  });

  it("does not let implementation history qualify an immature operational overlay", () => {
    const factSet = mutateFactSet(compiledFactSet([]), (asset) => {
      asset.operationalResilience!.liveHistoryEligibility.minimumLiveHistoryMonths = 12;
    });
    const evaluated = evaluatedAsset(factSet);

    expect(evaluated.operationalResilience).toMatchObject({
      eligible: false,
      pillarCredits: { backing: 0, exit: 0, control: 0 },
      contributions: [],
    });
  });

  it("uses distinct physical capacity instead of summing shared resources twice", () => {
    const request = selectV9ExitStressRequest(SUPPLY_USD, V9_CANDIDATE_POLICY_V1)!;
    const first = measuredRoute({
      routeId: "resource-a",
      physicalResourceKey: "pool:shared",
      executableUsdAtStress: 4_000_000,
    });
    const overlapping = measuredRoute({
      routeId: "resource-b",
      physicalResourceKey: "pool:shared",
      executableUsdAtStress: 4_000_000,
    });
    const distinct = {
      ...overlapping,
      physicalResourceKeys: ["pool:distinct"],
    };

    expect(
      resolveV9DistinctExitCapacity(
        [first, distinct].map(projectV9ExitEvaluationRoute),
        request,
        V9_CANDIDATE_POLICY_V1,
      ).valuedExecutableUsd,
    ).toBe(8_000_000);
    expect(
      resolveV9DistinctExitCapacity(
        [first, overlapping].map(projectV9ExitEvaluationRoute),
        request,
        V9_CANDIDATE_POLICY_V1,
      ).valuedExecutableUsd,
    ).toBe(4_000_000);
  });

  it("takes observation maturity from the weakest included route", () => {
    const factSet = compiledFactSet([
      measuredRoute({
        routeId: "a-mature-route",
        physicalResourceKey: "pool:mature",
        executableUsdAtStress: 4_000_000,
      }),
      measuredRoute({
        routeId: "z-immature-route",
        physicalResourceKey: "pool:immature",
        executableUsdAtStress: 4_000_000,
        completeProducerCycleCount: 2,
        successfulObservationCount: 2,
      }),
    ]);

    expect(persistentMarketDepthContribution(factSet)).toBeUndefined();
  });

  it("blocks resilience credit for ordinary and peg issuer opacity", () => {
    const base = compiledFactSet([
      measuredRoute({
        routeId: "deep-route",
        physicalResourceKey: "pool:deep",
        executableUsdAtStress: 10_000_000,
      }),
    ]);
    expect(persistentMarketDepthContribution(base)).toBeDefined();

    const ordinaryOpacity = mutateFactSet(base, (asset) => {
      const gap = createV9FactGapV3({
        gapId: "gap:ordinary-opacity",
        reasonCode: "bounded-mechanism-review",
        ownerDomain: "backing",
        policyRuleId: "backing.mechanism.component",
        observationState: "bounded-unknown",
        responsibility: "issuer-undisclosed",
        path: { kind: "local-component", componentKey: "contraction-capacity" },
        message: "The issuer has not disclosed an ordinary mechanism component.",
        evidenceRefIds: [BASE_EVIDENCE_ID],
      });
      asset.gaps.push(gap);
      if (asset.mechanismRiskReview.review?.archetype !== "algorithmic") {
        throw new Error("Expected algorithmic fixture");
      }
      asset.mechanismRiskReview.review.contractionCapacity.status = createV9FactStatus({
        applicability: requiredV9Applicability("backing.mechanism.component"),
        observationState: "bounded-unknown",
        evidenceRefIds: [BASE_EVIDENCE_ID],
        gapIds: [gap.gapId],
      });
      asset.mechanismRiskReview.review.contractionCapacity.quality = null;
    });
    expect(evaluatedAsset(ordinaryOpacity).operationalResilience).toMatchObject({
      eligible: false,
      blockerCodes: ["issuerOpacity"],
      contributions: [],
    });

    const pegOpacity = mutateFactSet(base, (asset) => {
      const gap = createV9FactGapV3({
        gapId: "gap:peg-opacity",
        reasonCode: "missing-peg-input",
        ownerDomain: "peg",
        policyRuleId: "peg.current",
        observationState: "bounded-unknown",
        responsibility: "issuer-undisclosed",
        path: { kind: "peg", pegKey: asset.peg.pegKey },
        message: "The issuer has not disclosed the applicable peg input.",
        evidenceRefIds: [BASE_EVIDENCE_ID],
      });
      asset.gaps.push(gap);
      asset.peg.status = createV9FactStatus({
        applicability: requiredV9Applicability("peg.current"),
        observationState: "bounded-unknown",
        evidenceRefIds: [BASE_EVIDENCE_ID],
        gapIds: [gap.gapId],
      });
      asset.peg.pegScore = null;
      asset.peg.currentDeviationBps = null;
      asset.peg.activeDepeg = null;
      asset.peg.activeDepegBps = null;
      asset.peg.trackingSpanDays = null;
    });
    expect(evaluatedAsset(pegOpacity).operationalResilience).toMatchObject({
      eligible: false,
      blockerCodes: ["issuerOpacity"],
      contributions: [],
    });
  });
});
