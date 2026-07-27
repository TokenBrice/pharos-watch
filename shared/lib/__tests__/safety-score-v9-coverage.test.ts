import { describe, expect, it } from "vitest";
import { SAFETY_SCORE_V9_EVALUATION_BUILD_DIGEST } from "../../data/safety-score-v9/evaluation-build-manifest-v1";
import { compileV9FactSetV3 } from "../safety-score-v9/compile";
import { computeV9CoverageEvaluationProjectionDigest, evaluateV9ReleaseCoverage } from "../safety-score-v9/coverage";

const AS_OF_SEC = 1_000;
const BASE_INPUT_GENERATION_ID = `report-cards-input:v1:${"a".repeat(64)}`;

function source(generationId: string, character: string) {
  return { generationId, payloadSha256: character.repeat(64), observedAtSec: 900 };
}

const SOURCES = {
  registry: source("registry:g1", "1"),
  dex: source("dex:g1", "2"),
  redemption: source("redemption:g1", "3"),
  liveReserves: source("reserves:g1", "4"),
  chainSupply: source("supply:g1", "5"),
  peg: source("peg:g1", "6"),
  researchOverlays: source("research:g1", "7"),
};

const EVIDENCE = {
  evidenceId: "evidence:current",
  sourceId: "fixture",
  sourceGenerationId: "fixture:g1",
  disposition: "observed" as const,
  observedAtSec: 900,
  publishedAtSec: null,
  url: null,
  contentSha256: null,
  freshness: { state: "current" as const, ageSec: 100, maxAgeSec: 200 },
  rejection: null,
};

function knownStatus(rule: string) {
  return {
    applicability: { state: "required" as const, policyRuleId: rule, rationale: null, gapId: null },
    observationState: "known" as const,
    evidenceRefIds: [EVIDENCE.evidenceId],
    gapIds: [],
  };
}

function notApplicableStatus(rule: string) {
  return {
    applicability: {
      state: "not-applicable" as const,
      policyRuleId: rule,
      rationale: "Reviewed as not applicable.",
      gapId: null,
    },
    observationState: "known" as const,
    evidenceRefIds: [EVIDENCE.evidenceId],
    gapIds: [],
  };
}

function mechanismFact(rule: string) {
  return {
    status: knownStatus(rule),
    quality: "strong" as const,
    failureDomains: [{ kind: "reserve-issuer" as const, key: "mechanism:fixture" }],
  };
}

function route(assetId: string, lane: "dex" | "redemption") {
  const sourceGenerationId = lane === "dex" ? SOURCES.dex.generationId : SOURCES.redemption.generationId;
  const routeId = `${assetId}-${lane}`;
  return {
    routeKey: `${lane}:${sourceGenerationId}:${routeId}`,
    routeId,
    lane,
    sourceGenerationId,
    routeFamily: lane === "dex" ? ("dex-amm" as const) : ("issuer-redemption" as const),
    holderAccess: lane === "dex" ? ("permissionless" as const) : ("retail-open" as const),
    executionModel: lane === "dex" ? ("market-depth" as const) : ("deterministic" as const),
    executionCertainty: "bounded" as const,
    modelConfidence: "medium" as const,
    observationConfidence: "high" as const,
    evidenceKind: lane === "dex" ? ("measured-executable-depth" as const) : ("documented-terms" as const),
    coverageClass: "exact-complete" as const,
    settlementModel: lane === "dex" ? ("atomic" as const) : ("same-day" as const),
    settlementSlaSec: lane === "dex" ? null : 86_400,
    settlementEvidenceRefIds: [EVIDENCE.evidenceId],
    physicalResourceKeys: [`resource:${assetId}:${lane}`],
    status: knownStatus(`exit.${lane}`),
    scoreEligible: true,
    request: { requestedNotionalUsd: 1_000_000, maxCostBps: 200, settlementHorizonSec: 300 },
    capacityCurve: [
      {
        requestedNotionalUsd: 1_000_000,
        maxCostBps: 200,
        executableUsd: 1_000_000,
        completionRatio: 1,
        executionCostBps: 100,
      },
    ],
    output: {
      status: knownStatus(`exit.${lane}.output`),
      kind: "fiat" as const,
      assetKeys: ["USD"],
      basketWeights: [],
      valuation: {
        basis: "reviewed-par" as const,
        referenceAssetKey: "USD",
        unitValueUsd: 1,
        expectedUnitValueUsd: 1,
        valueRetentionRatio: 1,
        sourceId: "fixture",
        sourceGenerationId,
        observedAtSec: 900,
        asOfSec: AS_OF_SEC,
        confidence: "high" as const,
        freshness: { state: "current" as const, ageSec: 100, maxAgeSec: 200 },
        evidenceRefIds: [EVIDENCE.evidenceId],
      },
    },
    failureDomains: [
      {
        kind: lane === "dex" ? ("dex-protocol" as const) : ("redemption-rail" as const),
        key: `${lane}:${assetId}`,
      },
    ],
  };
}

function asset(assetId: string, index: number) {
  const routes = [
    ...(index < 45 ? [route(assetId, "dex")] : []),
    ...(index < 27 ? [route(assetId, "redemption")] : []),
  ];
  return {
    assetId,
    archetype: "algorithmic" as const,
    evidence: [EVIDENCE],
    gaps: [],
    implementation: { status: knownStatus("implementation"), launchedAtSec: 100 },
    mechanismRiskReview: {
      status: knownStatus("backing.mechanism"),
      review: {
        archetype: "algorithmic" as const,
        exogenousBackingShare: 1,
        reflexiveBackingShare: 0,
        contractionCapacityRatio: 1,
        contractionCapacity: mechanismFact("backing.contraction"),
        confidenceAndIncentives: mechanismFact("backing.confidence"),
        oracleAndControlAssumptions: mechanismFact("backing.oracle"),
        emergencyRecovery: mechanismFact("backing.emergency"),
        lossRecovery: mechanismFact("backing.loss"),
      },
    },
    dependencies: {
      status: knownStatus("dependencies"),
      sourceGenerationId: SOURCES.researchOverlays.generationId,
      source: "none" as const,
      baseSource: "none" as const,
      dependencyFromLive: false,
      mappedLiveReserveWeight: null,
      fallbackReason: null,
      edges: [],
      diagnostics: { graphState: "valid" as const, issueCodes: [], sccMemberAssetIds: [] },
    },
    wrapperLocalFacts: {
      schemaVersion: 1 as const,
      applicability: "not-wrapper" as const,
      evidenceRefIds: [],
    },
    reserveStatus: notApplicableStatus("reserve.not-applicable"),
    reserveExposures: [],
    exitStatus: routes.length > 0 ? knownStatus("exit") : notApplicableStatus("exit.not-applicable"),
    exitRoutes: routes,
    controlStatus: notApplicableStatus("control.not-applicable"),
    controls: [],
    economicControlReview: {
      mint: {
        status: notApplicableStatus("control.mint.not-applicable"),
        controlKey: null,
        reconciliation: "not-applicable" as const,
        upgrade: { state: "not-applicable" as const, controlKey: null },
      },
      oracle: {
        status: notApplicableStatus("control.oracle.not-applicable"),
        tier: null,
        branches: [],
      },
      bridge: { status: notApplicableStatus("control.bridge.not-applicable"), routes: [] },
    },
    accessReview: {
      transfer: { status: knownStatus("access.transfer"), posture: "permissionless" as const },
      freeze: { status: notApplicableStatus("access.freeze.not-applicable"), reviews: [] },
    },
    peg: {
      status: knownStatus("peg"),
      pegKey: "peg:usd",
      sourceGenerationId: SOURCES.peg.generationId,
      referenceKind: "fiat" as const,
      referenceKey: "USD",
      methodologyVersion: "fixture-v1",
      pegScore: 99,
      currentDeviationBps: 1,
      activeDepeg: false,
      activeDepegBps: null,
      trackingSpanDays: 365,
      failureDomains: [{ kind: "oracle-feed" as const, key: "peg:fixture" }],
    },
    supply: {
      status: knownStatus("supply"),
      sourceGenerationId: SOURCES.chainSupply.generationId,
      sourceKind: "usd-denominated-circulating" as const,
      circulatingUnits: null,
      referencePriceUsd: null,
      circulatingUsd: (305 - index) * 1_000_000,
      chainDistribution: {
        chains: [
          {
            chainId: "chain:fixture",
            supplyUsd: (305 - index) * 1_000_000,
            supplyShare: 1,
          },
        ],
        unattributedSupplyUsd: 0,
        unattributedSupplyShare: 0,
      },
      selectedBridgeRoutes: [],
      selectedRouteSupplyShare: 0,
      unknownRouteSupplyShare: 0,
      unreviewedRouteSupplyShare: 0,
      failureDomains: [{ kind: "chain" as const, key: "chain:fixture" }],
    },
  };
}

function fixture(withShockCoverage = false) {
  const ids = Array.from({ length: 305 }, (_, index) => `asset-${String(index + 1).padStart(3, "0")}`);
  const shockCoverage = withShockCoverage ? source("shock:g1", "f") : null;
  const sourceFingerprints = {
    ...SOURCES,
    ...(shockCoverage === null ? {} : { shockCoverage }),
  };
  const factSet = compileV9FactSetV3({
    schemaVersion: 3,
    baseInputGenerationId: BASE_INPUT_GENERATION_ID,
    asOfSec: AS_OF_SEC,
    compiledAtSec: 1_100,
    sourceFingerprints,
    activeAssetIds: ids,
    assets: ids.map(asset),
  });
  const sourceGenerations = {
    registry: SOURCES.registry.generationId,
    dex: SOURCES.dex.generationId,
    redemption: SOURCES.redemption.generationId,
    liveReserves: SOURCES.liveReserves.generationId,
    chainSupply: SOURCES.chainSupply.generationId,
    peg: SOURCES.peg.generationId,
    researchOverlays: SOURCES.researchOverlays.generationId,
    ...(shockCoverage === null ? {} : { shockCoverage: shockCoverage.generationId }),
  };
  const evaluationPayload = {
    schemaVersion: 1 as const,
    factSetDigest: factSet.v9FactSetDigest,
    baseInputGenerationId: BASE_INPUT_GENERATION_ID,
    policyId: "safety-score-v9",
    policyDigest: "8".repeat(64),
    evaluationBuildDigest: SAFETY_SCORE_V9_EVALUATION_BUILD_DIGEST,
    producerCapabilityDigest: "c".repeat(64),
    evaluatedSetDigest: "9".repeat(64),
    scoreResultDigest: "a".repeat(64),
    asOfSec: AS_OF_SEC,
    sourceGenerations,
    assets: factSet.assets.map((entry) => {
      const includedExitRouteKeys = entry.exitRoutes.map((candidate) => candidate.routeKey);
      return {
        assetId: entry.assetId,
        finalScore: 90,
        nrReasonCodes: [],
        primaryExitRouteKey: includedExitRouteKeys[0] ?? null,
        includedExitRouteKeys,
      };
    }),
  };
  const evaluation = {
    ...evaluationPayload,
    evaluationProjectionDigest: computeV9CoverageEvaluationProjectionDigest(evaluationPayload),
  };
  const manifest = {
    schemaVersion: 1 as const,
    releaseCandidateId: "v9-rc-1",
    cohortId: "release-cohort-1",
    capturedAtSec: AS_OF_SEC,
    bindings: {
      factSetDigest: factSet.v9FactSetDigest,
      baseInputGenerationId: BASE_INPUT_GENERATION_ID,
      policyId: evaluation.policyId,
      policyDigest: evaluation.policyDigest,
      evaluationBuildDigest: evaluation.evaluationBuildDigest,
      producerCapabilityDigest: evaluation.producerCapabilityDigest,
      evaluatedSetDigest: evaluation.evaluatedSetDigest,
      scoreResultDigest: evaluation.scoreResultDigest,
      evaluationProjectionDigest: evaluation.evaluationProjectionDigest,
      registryPayloadDigest: SOURCES.registry.payloadSha256,
      weightPayloadDigest: SOURCES.chainSupply.payloadSha256,
    },
    continuingActiveV8RateableCount: 305,
    assets: factSet.assets.map((entry, index) => ({
      assetId: entry.assetId,
      archetype: "algorithmic" as const,
      weight: {
        disposition: "current-valid" as const,
        canonicalUsd: entry.supply.circulatingUsd,
        conservativeUpperBoundUsd: null,
        sourceGenerationId: SOURCES.chainSupply.generationId,
        observedAtSec: SOURCES.chainSupply.observedAtSec,
        rank: index + 1,
        topCutoffMember: index < 25,
      },
      calibrationDisposition:
        index < 21
          ? ("required-rateable" as const)
          : index < 24
            ? ("intentional-evidence-gap" as const)
            : ("not-member" as const),
      nrReview: {
        state: "not-required" as const,
        reasonCodes: [],
        disposition: null,
        owner: null,
        reviewedAtSec: null,
      },
    })),
  };
  return { factSet, evaluation, manifest };
}

describe("Safety Score v9 release coverage", () => {
  it("passes only when every locked economic and producer floor is met", () => {
    const input = fixture();
    const report = evaluateV9ReleaseCoverage(input);

    expect(report.decision).toBe("gate-passed");
    expect(report.blockers).toEqual([]);
    expect(report.rateability.rateableCount).toBe(305);
    expect(report.weights.rateableWeightBps).toBe(10_000);
    expect(report.topCutoff.derivedMemberIds).toHaveLength(25);
    expect(report.exit.lanes.map((lane) => [lane.lane, lane.v9ContributingAssetIds.length])).toEqual([
      ["dex", 45],
      ["redemption", 27],
    ]);
    expect(report.producerCapabilityDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(evaluateV9ReleaseCoverage(input).reportDigest).toBe(report.reportDigest);
  });

  it("preserves legacy source sets and requires the current shock source generation exactly", () => {
    const legacy = fixture();
    expect(evaluateV9ReleaseCoverage(legacy).identityChecks.sourceGenerations).toBe(true);
    expect(legacy.evaluation.sourceGenerations).not.toHaveProperty("shockCoverage");

    const current = fixture(true);
    expect(evaluateV9ReleaseCoverage(current).identityChecks.sourceGenerations).toBe(true);
    expect(current.evaluation.sourceGenerations.shockCoverage).toBe("shock:g1");

    const missing = structuredClone(current);
    delete missing.evaluation.sourceGenerations.shockCoverage;
    expect(evaluateV9ReleaseCoverage(missing).identityChecks.sourceGenerations).toBe(false);
  });

  it("fails closed on an identity mismatch without changing the frozen floor", () => {
    const input = fixture();
    const report = evaluateV9ReleaseCoverage({
      ...input,
      manifest: {
        ...input.manifest,
        bindings: { ...input.manifest.bindings, policyDigest: "b".repeat(64) },
      },
    });

    expect(report.decision).toBe("no-go");
    expect(report.blockers.map((blocker) => blocker.code)).toContain("policy-digest-mismatch");
    expect(report.floors.minimumRateableAssets).toBe(271);
  });

  it("rejects schema-valid score and route projections that retain scorer identities", () => {
    const input = fixture();
    const mutatedAssets = input.evaluation.assets.map((asset, index) =>
      index === 0
        ? {
            ...asset,
            finalScore: 100,
            primaryExitRouteKey: asset.includedExitRouteKeys[1] ?? asset.primaryExitRouteKey,
          }
        : asset,
    );
    const retainedDigest = evaluateV9ReleaseCoverage({
      ...input,
      evaluation: { ...input.evaluation, assets: mutatedAssets },
    });
    const forgedProjection = { ...input.evaluation, assets: mutatedAssets };
    forgedProjection.evaluationProjectionDigest = computeV9CoverageEvaluationProjectionDigest(forgedProjection);
    const recomputedDigest = evaluateV9ReleaseCoverage({ ...input, evaluation: forgedProjection });

    expect(retainedDigest.identityChecks.evaluationProjectionDigest).toBe(false);
    expect(recomputedDigest.identityChecks.evaluationProjectionDigest).toBe(false);
    expect(retainedDigest.blockers.map((blocker) => blocker.code)).toContain("evaluation-projection-digest-mismatch");
    expect(recomputedDigest.blockers.map((blocker) => blocker.code)).toContain("evaluation-projection-digest-mismatch");
  });

  it("binds scores, NR reasons, routes, and evaluator identities into the projection digest", () => {
    const { evaluation } = fixture();
    const original = evaluation.evaluationProjectionDigest;
    const first = evaluation.assets[0]!;
    const alternateRoute = first.includedExitRouteKeys[1]!;
    const mutations = [
      { ...evaluation, assets: [{ ...first, finalScore: 91 }, ...evaluation.assets.slice(1)] },
      {
        ...evaluation,
        assets: [
          { ...first, finalScore: null, nrReasonCodes: ["insufficient-evidence" as const] },
          ...evaluation.assets.slice(1),
        ],
      },
      {
        ...evaluation,
        assets: [{ ...first, primaryExitRouteKey: alternateRoute }, ...evaluation.assets.slice(1)],
      },
      { ...evaluation, evaluatedSetDigest: "b".repeat(64) },
    ];

    for (const mutation of mutations) {
      expect(computeV9CoverageEvaluationProjectionDigest(mutation)).not.toBe(original);
    }
  });

  it("binds the stable producer capability identity instead of deriving it from evidence generations", () => {
    const input = fixture();
    const original = evaluateV9ReleaseCoverage(input);
    const changedCapabilityDigest = "d".repeat(64);
    const changedEvaluationPayload = {
      ...input.evaluation,
      producerCapabilityDigest: changedCapabilityDigest,
    };
    const { evaluationProjectionDigest: _oldProjectionDigest, ...projectionPayload } = changedEvaluationPayload;
    const changedProjectionDigest = computeV9CoverageEvaluationProjectionDigest(projectionPayload);
    const changedCapability = evaluateV9ReleaseCoverage({
      ...input,
      evaluation: { ...changedEvaluationPayload, evaluationProjectionDigest: changedProjectionDigest },
      manifest: {
        ...input.manifest,
        bindings: {
          ...input.manifest.bindings,
          producerCapabilityDigest: changedCapabilityDigest,
          evaluationProjectionDigest: changedProjectionDigest,
        },
      },
    });
    const mismatched = evaluateV9ReleaseCoverage({
      ...input,
      evaluation: { ...changedEvaluationPayload, evaluationProjectionDigest: changedProjectionDigest },
    });

    expect(original.producerCapabilityDigest).toBe(input.evaluation.producerCapabilityDigest);
    expect(changedCapability.producerCapabilityDigest).toBe(changedCapabilityDigest);
    expect(changedCapability.decision).toBe("gate-passed");
    expect(changedCapability.reportDigest).not.toBe(original.reportDigest);
    expect(mismatched.blockers.map((blocker) => blocker.code)).toContain("producer-capability-digest-mismatch");
  });
});
