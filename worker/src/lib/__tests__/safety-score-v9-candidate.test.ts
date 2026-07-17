import { SAFETY_SCORE_METHODOLOGY_VERSION } from "@shared/lib/safety-score-version";
import { deriveReportCardsBaseInputGenerationId } from "@shared/lib/report-cards-base-input-identity";
import { computeDexLiquidityPayloadFingerprint } from "@shared/lib/report-cards-fixed-input-identity";
import { loadV9MethodologyPolicy, V9_CANDIDATE_POLICY_V1 } from "@shared/lib/safety-score-v9/policy";
import { stableJsonStringifyV1 } from "@shared/lib/stable-json";
import type { ExitRouteObservation } from "@shared/types/exit-route";
import { SafetyScoreV9ResponseSchema } from "@shared/types/safety-score-v9-public";
import { describe, expect, it } from "vitest";
import { createReportCardsFixedInput } from "../report-cards-fixed-input";
import {
  buildSafetyScoreV9Candidate,
  computeSafetyScoreV9CandidateId,
  computeSafetyScoreV9ProducerCapabilityDigest,
} from "../safety-score-v9-candidate";
import type { SafetyScoreV9FactSetExtensionV2 } from "../safety-score-v9-fact-set";
import { buildSafetyScoreV9BaselineExtension } from "../safety-score-v9-extension";

const AS_OF_SEC = 1_784_160_000;
const OBSERVED_AT_SEC = AS_OF_SEC - 100;
const PUBLISHED_AT_SEC = AS_OF_SEC + 10;

function status(observationState: "known" | "missing" = "known", policyRuleId = "fixture.review") {
  return {
    applicability: { state: "required" as const, policyRuleId, rationale: null, gapId: null },
    observationState,
    evidenceRefIds: observationState === "known" ? ["placeholder:evidence"] : [],
    gapIds: observationState === "known" ? [] : ["placeholder:gap"],
  };
}

function notApplicableStatus(policyRuleId: string) {
  return {
    applicability: {
      state: "not-applicable" as const,
      policyRuleId,
      rationale: "Reviewed as not applicable for the fixture.",
      gapId: null,
    },
    observationState: "known" as const,
    evidenceRefIds: ["placeholder:evidence"],
    gapIds: [],
  };
}

function route(assetId: string): ExitRouteObservation {
  return {
    routeId: "dex:primary",
    routeFamily: "dex-amm",
    scope: {
      kind: "chain-contract",
      chain: "ethereum",
      contractOrPoolId: `${assetId}:primary`,
      protocol: "fixture-dex",
    },
    requestedNotionalUsd: 100_000,
    settlementHorizonSec: 300,
    maxCostBps: 200,
    executableUsd: 80_000,
    completionRatio: 0.8,
    output: { kind: "fiat", currency: "USD", assetKeys: ["fiat:USD"] },
    evidenceKind: "reserve-based-amm-simulation",
    confidence: "high",
    scoreEligible: true,
    observedAt: OBSERVED_AT_SEC,
    freshnessSeconds: AS_OF_SEC - OBSERVED_AT_SEC,
    commonModeKeys: ["chain:ethereum", "protocol:fixture-dex"],
    capacityCurve: [
      {
        requestedNotionalUsd: 100_000,
        maxCostBps: 200,
        executableUsd: 80_000,
        completionRatio: 0.8,
      },
      {
        requestedNotionalUsd: 1_000_000,
        maxCostBps: 200,
        executableUsd: 400_000,
        completionRatio: 0.4,
      },
    ],
  };
}

function exactFixedInput(
  assetId: string,
  liquidityScore = 12,
  options: {
    includeObservedDexCoverage?: boolean;
    dexMethodologyVersion?: string;
    includeDexObservations?: boolean;
  } = {},
) {
  return createReportCardsFixedInput({
    captureKind: "exact-publication-inputs",
    activeAssetIds: [assetId],
    capturedAt: "2026-07-13T00:00:00.000Z",
    sourceGeneration: `report-cards:fixture:${assetId}:${liquidityScore}`,
    dexGenerationId: `dex-liquidity-${OBSERVED_AT_SEC}`,
    redemptionGenerationId: "redemption-backstops-unavailable",
    registryRevision: "registry:fixture",
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
      [assetId]: {
        id: assetId,
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
        methodologyVersion: "peg:fixture-v1",
      },
    },
    activeDepegPeakBpsById: {},
    dexLiqMap: {
      [assetId]: {
        liquidityScore,
        concentrationHhi: 0.5,
        poolCount: 1,
        chainCount: 1,
        coverageClass: "primary",
        coverageConfidence: 1,
        liquidityEvidenceClass: "measured",
        hasMeasuredLiquidityEvidence: true,
        effectiveTvlUsd: 1_000_000,
        balanceMeasuredTvlUsd: 1_000_000,
        organicMeasuredTvlUsd: 1_000_000,
        exitRouteObservations: options.includeDexObservations === false ? [] : [route(assetId)],
        ...(options.includeObservedDexCoverage === false
          ? {}
          : {
              exitRouteObservationCoverage: {
                status: "populated" as const,
                capabilityMatrixVersion: "p4a.4",
                retainedPoolCount: 1,
                observationCount: 1,
                scoreEligibleObservationCount: 1,
                scoreEligiblePoolCount: 1,
                scoreEligibleCapabilityPoolCount: 1,
                unsupportedPoolCount: 0,
                evidenceCounts: { "reserve-based-amm-simulation": 1 },
                unsupportedReasons: {},
              },
            }),
        methodologyVersion: options.dexMethodologyVersion ?? "dex:fixture-v1",
        updatedAt: OBSERVED_AT_SEC,
      },
    },
    redemptionBackstopMap: {},
    bluechipMap: {},
    resolvedBlacklistStatuses: { [assetId]: false },
    liveReserveMap: {
      [assetId]: [
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
      ],
    },
    liveReserveProvenanceMap: {
      [assetId]: { source: "fixture-reserve-api", fetchedAt: OBSERVED_AT_SEC },
    },
    chainCirculatingById: {
      [assetId]: {
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

function reviewedExtension(fixedInput = exactFixedInput("alpha")): SafetyScoreV9FactSetExtensionV2 {
  const extension = structuredClone(
    buildSafetyScoreV9BaselineExtension(fixedInput, {
      metaById: new Map([
        [
          "alpha",
          {
            id: "alpha",
            mechanismArchetype: "fiat-cash",
          },
        ],
      ]),
    }),
  );
  const asset = extension.assets[0]!;
  const mechanismComponent = {
    status: status(),
    quality: "strong" as const,
    failureDomains: [{ kind: "reserve-issuer" as const, key: "issuer:alpha" }],
  };
  asset.launchedAtSec = 1_000;
  asset.mechanismRiskReview = {
    archetype: "fiat-cash",
    claimAndSegregation: mechanismComponent,
    custodyContinuity: mechanismComponent,
    assuranceAndReconciliation: mechanismComponent,
  };
  asset.dependencies = {
    source: "none",
    baseSource: "none",
    dependencyFromLive: false,
    mappedLiveReserveWeight: null,
    fallbackReason: null,
    edges: [],
    diagnostics: { graphState: "valid", issueCodes: [], sccMemberAssetIds: [] },
  };
  asset.routeReviews = [
    {
      lane: "dex",
      routeId: "dex:primary",
      holderAccess: "permissionless",
      executionModel: "market-depth",
      executionCertainty: "bounded",
      modelConfidence: "medium",
      coverageClass: "exact-complete",
      settlementModel: "atomic",
      settlementSlaSec: null,
      physicalResourceKeys: ["pool:dex:primary"],
      executionCosts: [
        { requestedNotionalUsd: 100_000, maxCostBps: 200, executionCostBps: 120 },
        { requestedNotionalUsd: 1_000_000, maxCostBps: 200, executionCostBps: 180 },
      ],
      output: {
        kind: "fiat",
        assetKeys: ["fiat:USD"],
        basketWeights: [],
        valuation: {
          basis: "reviewed-par",
          referenceAssetKey: "fiat:USD",
          unitValueUsd: 1,
          expectedUnitValueUsd: 1,
          sourceId: "fixture-valuation",
          sourceGenerationId: "valuation:fixture-v1",
          observedAtSec: OBSERVED_AT_SEC,
          maxAgeSec: 500,
          confidence: "high",
          url: null,
          contentSha256: null,
        },
      },
      failureDomains: [
        { kind: "chain", key: "ethereum" },
        { kind: "dex-protocol", key: "fixture-dex" },
      ],
    },
  ];
  asset.controlReview = {
    state: "no-privileged-controls",
    rationale: "The reviewed fixture implementation has no privileged deployment controls.",
  };
  asset.economicControlReview = {
    mint: {
      status: notApplicableStatus("v9.control.mint-review"),
      controlKey: null,
      reconciliation: "not-applicable",
      supervision: "unknown",
      upgrade: { state: "not-applicable", controlKey: null },
    },
    oracle: {
      status: notApplicableStatus("v9.control.oracle-review"),
      tier: null,
      branches: [],
    },
    bridge: {
      status: notApplicableStatus("v9.control.bridge-review"),
      routes: [],
    },
  };
  asset.accessReview = {
    transfer: { status: status("known", "v9.access.transfer-review"), posture: "permissionless" },
    freeze: {
      status: status("known", "v9.access.freeze-review"),
      reviews: [
        {
          reviewKey: "freeze:none-reviewed",
          source: "blacklist",
          status: status("known", "v9.access.freeze-review"),
          reach: "none",
          controlKey: null,
          upstreamAssetId: null,
          failureDomains: [],
        },
      ],
    },
  };
  asset.pegReference = {
    referenceKind: "fiat",
    referenceKey: "USD",
    failureDomains: [{ kind: "oracle-feed", key: "fixture-price" }],
  };
  // Single-chain native with no reviewed route rows: the producer places the
  // whole supply in the unknown bucket, conserving shares to 1 (VER-007).
  asset.supplyReview = {
    selectedBridgeRoutes: [],
    selectedRouteSupplyShare: 0,
    unknownRouteSupplyShare: 1,
    unreviewedRouteSupplyShare: 0,
    failureDomains: [],
  };
  return extension;
}

const V9_EVALUATION_TEST_TIMEOUT_MS = 30_000;

describe("Safety Score v9 candidate pipeline", { timeout: V9_EVALUATION_TEST_TIMEOUT_MS }, () => {
  it("is deterministic for the same exact generation and explicit publication inputs", () => {
    const fixedInput = exactFixedInput("alpha");
    const input = {
      fixedInput,
      extension: reviewedExtension(fixedInput),
      publishedAtSec: PUBLISHED_AT_SEC,
    };
    const left = buildSafetyScoreV9Candidate(input);
    const right = buildSafetyScoreV9Candidate(structuredClone(input));

    expect(stableJsonStringifyV1(right)).toBe(stableJsonStringifyV1(left));
    expect(SafetyScoreV9ResponseSchema.parse(left.candidate)).toEqual(left.candidate);
    expect(left.candidate.resultDigest).toBe(left.evaluatedSet.scoreResultDigest);
    expect(left.candidate.factSetDigest).toBe(left.compiledFacts.v9FactSetDigest);
    expect(left.compilerFactSchemaIdentity.compiledFactSchemaCapabilities).toEqual([
      "canonical-chain-supply-distribution.v1",
      "exit-route-modeled-confidence.v1",
      "journaled-cdp-shock-coverage.v1",
      "reviewed-transfer-deployments.v1",
    ]);
    expect(left.producerCapabilityIdentity.sourceAdapters.dexExitRoutes).toBe("fixed-input.dex-exit-observations.v2");
    expect(left.producerCapabilityIdentity.sourceAdapters.redemptionExitRoutes).toBe(
      "fixed-input.redemption-exit-observations.v2",
    );
    expect(left.producerCapabilityIdentity.sourceAdapters.chainSupply).toBe("fixed-input.usd-circulating-supply.v2");
    expect(left.producerCapabilityIdentity.sourceAdapters.researchOverlays).toBe(
      "v9-fact-extension.review-overlays.v3",
    );
    expect(left.producerCapabilityIdentity.sourceAdapters.shockCoverage).toBe("journal-registry.cdp-shock-coverage.v1");
    expect(left.producerCapabilityIdentity.freshnessPolicySec.accessReviews).toBe(31_536_000);
    expect(
      left.compiledFacts.assets.every((asset) =>
        Object.prototype.hasOwnProperty.call(asset.supply, "chainDistribution"),
      ),
    ).toBe(true);
    expect(left.compilerFactSchemaDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(left.producerCapabilityDigest).toBe(
      computeSafetyScoreV9ProducerCapabilityDigest(left.producerCapabilityIdentity),
    );
  });

  it("keeps one candidate across point-in-time generations and binds each publication to exact results", () => {
    const baseFixedInput = exactFixedInput("alpha", 12);
    const changedFixedInput = exactFixedInput("alpha", 13);
    const extension = reviewedExtension(baseFixedInput);
    const base = buildSafetyScoreV9Candidate({
      fixedInput: baseFixedInput,
      extension,
      publishedAtSec: PUBLISHED_AT_SEC,
    });
    const changedGeneration = buildSafetyScoreV9Candidate({
      fixedInput: changedFixedInput,
      extension: reviewedExtension(changedFixedInput),
      publishedAtSec: PUBLISHED_AT_SEC,
    });
    const changedPublication = buildSafetyScoreV9Candidate({
      fixedInput: baseFixedInput,
      extension,
      publishedAtSec: PUBLISHED_AT_SEC + 1,
    });

    expect(changedGeneration.fixedInput.baseInputGenerationId).not.toBe(base.fixedInput.baseInputGenerationId);
    expect(changedGeneration.compiledFacts.v9FactSetDigest).not.toBe(base.compiledFacts.v9FactSetDigest);
    expect(changedGeneration.candidate.resultDigest).not.toBe(base.candidate.resultDigest);
    expect(changedGeneration.candidate.candidateId).toBe(base.candidate.candidateId);
    expect(changedGeneration.candidate.publicationGenerationId).not.toBe(base.candidate.publicationGenerationId);
    expect(changedGeneration.producerCapabilityDigest).toBe(base.producerCapabilityDigest);
    expect(changedPublication.candidate.candidateId).toBe(base.candidate.candidateId);
    expect(changedPublication.candidate.publicationGenerationId).not.toBe(base.candidate.publicationGenerationId);
  });

  it("changes candidate identity only when the frozen policy, build, or producer capability changes", () => {
    const fixedInput = exactFixedInput("alpha");
    const extension = reviewedExtension(fixedInput);
    const base = buildSafetyScoreV9Candidate({
      fixedInput,
      extension,
      publishedAtSec: PUBLISHED_AT_SEC,
    });
    const changedPolicy = structuredClone(V9_CANDIDATE_POLICY_V1.policy);
    changedPolicy.policyId = "safety-score-v9-candidate-v2";
    changedPolicy.semantic.formula.pillarWeights.backing = 0.39;
    changedPolicy.semantic.formula.pillarWeights.exit = 0.36;
    const policyResult = buildSafetyScoreV9Candidate({
      fixedInput,
      extension,
      policy: loadV9MethodologyPolicy(changedPolicy),
      publishedAtSec: PUBLISHED_AT_SEC,
    });
    const changedCapability = structuredClone(extension);
    changedCapability.routeFreshness.dexMaxAgeSec += 1;
    const capabilityResult = buildSafetyScoreV9Candidate({
      fixedInput,
      extension: changedCapability,
      publishedAtSec: PUBLISHED_AT_SEC,
    });
    const alternateBuildDigest =
      base.candidateIdentity.evaluationBuildDigest === "f".repeat(64) ? "e".repeat(64) : "f".repeat(64);

    expect(policyResult.candidate.candidateId).not.toBe(base.candidate.candidateId);
    expect(policyResult.candidate.policy.semanticDigest).not.toBe(base.candidate.policy.semanticDigest);
    expect(capabilityResult.producerCapabilityDigest).not.toBe(base.producerCapabilityDigest);
    expect(capabilityResult.candidate.candidateId).not.toBe(base.candidate.candidateId);
    expect(
      computeSafetyScoreV9CandidateId({
        ...base.candidateIdentity,
        evaluationBuildDigest: alternateBuildDigest,
      }),
    ).not.toBe(base.candidate.candidateId);
  });

  it("does not treat transient observed DEX coverage as a producer capability declaration", () => {
    const observed = exactFixedInput("alpha");
    const unobserved = exactFixedInput("alpha", 12, { includeObservedDexCoverage: false });
    const observedResult = buildSafetyScoreV9Candidate({
      fixedInput: observed,
      extension: reviewedExtension(observed),
      publishedAtSec: PUBLISHED_AT_SEC,
    });
    const unobservedResult = buildSafetyScoreV9Candidate({
      fixedInput: unobserved,
      extension: reviewedExtension(unobserved),
      publishedAtSec: PUBLISHED_AT_SEC,
    });

    expect(unobservedResult.fixedInput.baseInputGenerationId).not.toBe(observedResult.fixedInput.baseInputGenerationId);
    expect(unobservedResult.producerCapabilityIdentity.dexRouteCapabilityMatrixVersions).toEqual(
      observedResult.producerCapabilityIdentity.dexRouteCapabilityMatrixVersions,
    );
    expect(unobservedResult.producerCapabilityDigest).toBe(observedResult.producerCapabilityDigest);
    expect(unobservedResult.candidate.candidateId).toBe(observedResult.candidate.candidateId);
  });

  it("accepts only an explicit, validated release-candidate ID override", () => {
    const fixedInput = exactFixedInput("alpha");
    const args = {
      fixedInput,
      extension: reviewedExtension(fixedInput),
      publishedAtSec: PUBLISHED_AT_SEC,
    };

    expect(buildSafetyScoreV9Candidate({ ...args, releaseCandidateId: "v9-rc-2" }).candidate.candidateId).toBe(
      "v9-rc-2",
    );
    expect(() => buildSafetyScoreV9Candidate({ ...args, releaseCandidateId: "candidate-latest" })).toThrow();
  });

  it("keeps reviewed-metadata enrichment not rated while critical V9 reviews remain absent", () => {
    const result = buildSafetyScoreV9Candidate({
      // The reviewed registry metadata resolves the mechanism, control, mint,
      // and access reviews, but this capture has no exit-route observations, so
      // the route pillar stays absent and the asset remains NR.
      fixedInput: exactFixedInput("usdc-circle", 12, {
        includeDexObservations: false,
        includeObservedDexCoverage: false,
      }),
      publishedAtSec: PUBLISHED_AT_SEC,
    });

    expect(result.extension.assets[0]).toMatchObject({
      assetId: "usdc-circle",
      // Reviewed reserve/proof-of-reserves and mint-authority evidence enriches
      // the mechanism, control, and mint reviews to resolved states; the
      // absent exit-route reviews stay bounded, so the asset rates under the
      // exit-unverified ceiling instead of reason-coding NR.
      mechanismRiskReview: {
        archetype: "fiat-cash",
        // D1 fiat-cash overlays are active: USDC's claim/custody components are
        // curated known (owner decision D1, 2026-07-15).
        claimAndSegregation: { status: { observationState: "known" } },
        custodyContinuity: { status: { observationState: "known" } },
        assuranceAndReconciliation: { status: { observationState: "known" } },
      },
      controlReview: { state: "reviewed-controls" },
      economicControlReview: {
        mint: {
          status: { observationState: "known" },
          reconciliation: "periodic",
          upgrade: { state: "reviewed" },
        },
      },
      accessReview: { transfer: { posture: "restrictable" } },
    });
    expect(result.candidate.cards).toHaveLength(1);
    expect(result.candidate.cards[0]).toMatchObject({ id: "usdc-circle", score: 55, grade: "C" });
    expect(result.candidate.cards[0]!.nrReasons).toEqual([]);
    expect(result.candidate.cards[0]!.caps.map((cap) => cap.kind)).toContain("reason:missing-same-notional-route");
    expect(result.candidate.completeness).toEqual({
      expectedCount: 1,
      ratedCount: 1,
      notRatedCount: 0,
      notRatedIds: [],
    });
  });

  it("reaches A+ through the normal candidate compiler and evaluator from ideal reviewed facts", () => {
    const fixedInput = exactFixedInput("alpha");
    const stressGrid = V9_CANDIDATE_POLICY_V1.policy.semantic.exit.stressRequest.notionalGridUsd;
    const peg = fixedInput.pegDataById.alpha!;
    peg.currentDeviationBps = 0;
    peg.pegScore = 100;
    peg.pegPct = 100;
    peg.worstDeviationBps = 0;
    const observation = fixedInput.dexLiqMap.alpha!.exitRouteObservations![0]!;
    observation.executableUsd = observation.requestedNotionalUsd;
    observation.completionRatio = 1;
    observation.capacityCurve = stressGrid.map((requestedNotionalUsd) => ({
      requestedNotionalUsd,
      maxCostBps: observation.maxCostBps,
      executableUsd: requestedNotionalUsd,
      completionRatio: 1,
    }));
    fixedInput.dexPayloadFingerprint = computeDexLiquidityPayloadFingerprint(
      fixedInput.dexLiqMap,
      fixedInput.dexGenerationId,
    );
    fixedInput.baseInputGenerationId = deriveReportCardsBaseInputGenerationId(fixedInput);

    const extension = reviewedExtension(fixedInput);
    const asset = extension.assets[0]!;
    asset.routeReviews[0]!.executionModel = "atomic";
    asset.routeReviews[0]!.executionCertainty = "guaranteed";
    asset.routeReviews[0]!.modelConfidence = "high";
    asset.routeReviews[0]!.executionCosts = stressGrid.map((requestedNotionalUsd) => ({
      requestedNotionalUsd,
      maxCostBps: observation.maxCostBps,
      executionCostBps: 0,
    }));

    const result = buildSafetyScoreV9Candidate({
      fixedInput,
      extension,
      publishedAtSec: PUBLISHED_AT_SEC,
    });
    expect(SafetyScoreV9ResponseSchema.parse(result.candidate)).toEqual(result.candidate);
    expect(result.candidate.cards[0]).toMatchObject({ id: "alpha", grade: "A+" });
    expect(result.candidate.cards[0]!.score).toBeGreaterThanOrEqual(87);
    expect(result.evaluatedSet.assets[0]!.trace.bindingCap).toBeNull();
  });

  it("publishes a strict rated candidate from a supplied reviewed extension", () => {
    const fixedInput = exactFixedInput("alpha");
    const result = buildSafetyScoreV9Candidate({
      fixedInput,
      extension: reviewedExtension(fixedInput),
      publishedAtSec: PUBLISHED_AT_SEC,
    });

    expect(result.candidate).toMatchObject({
      model: "v9-critical-path",
      lifecycle: "candidate",
      policyVersion: "candidate-v2",
      completeness: { expectedCount: 1, ratedCount: 1, notRatedCount: 0, notRatedIds: [] },
    });
    expect(result.candidate.cards[0]).toMatchObject({ id: "alpha", score: 81, grade: "A-" });
    expect(result.evaluatedSet.assets[0]!.trace.finalScore).toBe(result.candidate.cards[0]!.score);
  });
});
