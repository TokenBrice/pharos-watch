import { deriveReportCardsBaseInputGenerationId } from "@shared/lib/report-cards-base-input-identity";
import { computeDexLiquidityPayloadFingerprint } from "@shared/lib/report-cards-fixed-input-identity";
import { iterateEvidenceResponsibilityFacts } from "@shared/types/safety-score-v9-public-evidence-facts";
import { resolveCauseGapId } from "@shared/types/safety-score-v9-public-cause-gaps";
import {
  evaluateV9FactSet,
  evaluateValidatedV9FactSet,
  V9AssetEvaluationError,
} from "@shared/lib/safety-score-v9/evaluate-set";
import * as evaluateSetModule from "@shared/lib/safety-score-v9/evaluate-set";
import * as publicModule from "@shared/lib/safety-score-v9/public";
import {
  loadV9CandidateMethodologyPolicy,
  loadV9MethodologyPolicy,
  V9_CANDIDATE_POLICY_V1,
} from "@shared/lib/safety-score-v9/policy";
import { stableJsonStringifyV1 } from "@shared/lib/stable-json";
import { SafetyScoreV9ResponseSchema } from "@shared/types/safety-score-v9-public";
import { describe, expect, it, vi } from "vitest";
import {
  buildSafetyScoreV9Candidate,
  buildSafetyScoreV9PublicationFromNormalizedInput,
  computeSafetyScoreV9CandidateId,
  computeSafetyScoreV9ProducerCapabilityDigest,
  publicDependencyMetadata,
} from "../safety-score-v9/candidate";
import {
  compileSafetyScoreV9FactSetFromValidatedExtension,
  type SafetyScoreV9FactSetExtensionV2,
} from "../safety-score-v9/fact-set";
import { buildSafetyScoreV9BaselineExtension } from "../safety-score-v9/extension";
import {
  makeV9BoundedUnknownFeeRedemptionFixedInput,
  makeV9FixedInput,
  v9NotApplicableStatus as notApplicableStatus,
  v9Status as status,
  v9TestClockSec,
} from "../../test-helpers/v9-fixed-input";
import { localControl } from "./safety-score-v9-fact-set.test-support";

// One day past the newest reviewed registry date the usdc-circle capture below
// reads, so the extension's "review is later than the scoring clock" guard stays
// untripped without a hand-pinned literal that curation keeps invalidating.
const AS_OF_SEC = v9TestClockSec();
const OBSERVED_AT_SEC = AS_OF_SEC - 100;
const PUBLISHED_AT_SEC = AS_OF_SEC + 10;

const FIXTURE_RESERVES = [
  {
    name: "Custodied cash",
    pct: 100,
    risk: "very-low" as const,
    assetClass: "cash" as const,
    issuerOrObligor: "issuer:alpha",
    riskFactors: ["custody" as const, "counterparty" as const],
    liquidityHorizon: "immediate" as const,
    maturityDaysMax: 0,
  },
];

function exactFixedInput(
  assetId: string,
  liquidityScore = 12,
  options: {
    includeObservedDexCoverage?: boolean;
    dexMethodologyVersion?: string;
    includeDexObservations?: boolean;
  } = {},
) {
  return makeV9FixedInput({
    assetId,
    clockSec: AS_OF_SEC,
    liquidityScore,
    reserves: FIXTURE_RESERVES,
    sourceGeneration: `report-cards:fixture:${assetId}:${liquidityScore}`,
    routeContractOrPoolId: `${assetId}:primary`,
    dexCapabilityMatrixVersion: "p4a.4",
    includeDexCoverage: options.includeObservedDexCoverage,
    includeDexObservations: options.includeDexObservations,
    dexMethodologyVersion: options.dexMethodologyVersion,
  });
}

function reviewedExtension(fixedInput = exactFixedInput("alpha")): SafetyScoreV9FactSetExtensionV2 {
  const extension = structuredClone(
    buildSafetyScoreV9BaselineExtension(fixedInput, {
      metaById: new Map(fixedInput.activeAssetIds.map((id) => [id, { id, mechanismArchetype: "fiat-cash" }])),
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
      latestResolvedIncidentAtSec: null,
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

function reserveParentCascadeFixture() {
  const inputs = ["alpha", "beta", "gamma"].map((id) => exactFixedInput(id));
  const fixedInput = inputs[0]!;
  fixedInput.activeAssetIds = ["alpha", "beta", "gamma"];
  for (const other of inputs.slice(1)) {
    for (const key of ["dexLiqMap", "pegDataById", "liveReserveMap", "liveReserveProvenanceMap",
      "chainCirculatingById", "aggregateCirculatingById", "resolvedBlacklistStatuses"] as const) {
      Object.assign(fixedInput[key], other[key]);
    }
  }
  fixedInput.liveReserveMap.alpha = [{
    ...FIXTURE_RESERVES[0]!, name: "Beta claim", assetClass: "stablecoin", coinId: "beta", depType: "wrapper",
  }];
  fixedInput.liveReserveMap.gamma = [{
    ...FIXTURE_RESERVES[0]!, name: "Alpha holding", assetClass: "stablecoin", coinId: "alpha", depType: "collateral",
  }];
  const dex = fixedInput.dexLiqMap.alpha!;
  dex.exitRouteObservations = [];
  dex.exitRouteObservationCoverage = {
    status: "populated", capabilityMatrixVersion: "p4a.4", retainedPoolCount: 0,
    observationCount: 0, scoreEligibleObservationCount: 0, scoreEligiblePoolCount: 0,
    scoreEligibleCapabilityPoolCount: 0, unsupportedPoolCount: 0, evidenceCounts: {}, unsupportedReasons: {},
  };
  fixedInput.dexDeploymentSupplyCoverageById.alpha = {
    totalSupplyUsd: 10_000_000, observedSupplyUsd: 0, verifiedNoPoolsSupplyUsd: 10_000_000,
    providerInaccessibleSupplyUsd: 0, unknownSupplyUsd: 0, observedSupplyRatio: 0,
    verifiedNoPoolsSupplyRatio: 1, providerInaccessibleSupplyRatio: 0, unknownSupplyRatio: 0, unknownChains: [],
  };
  fixedInput.dexPayloadFingerprint = computeDexLiquidityPayloadFingerprint(fixedInput.dexLiqMap, fixedInput.dexGenerationId);
  fixedInput.baseInputGenerationId = deriveReportCardsBaseInputGenerationId(fixedInput);
  const extension = reviewedExtension(fixedInput);
  const reviewedAssets = inputs.map((input) => reviewedExtension(input).assets[0]!);
  extension.assets = extension.assets.map((asset, index) => ({
    ...reviewedAssets[index]!, reserveClassifications: asset.reserveClassifications,
  }));
  const alpha = extension.assets.find((asset) => asset.assetId === "alpha")!;
  alpha.routeReviews = [];
  const review = alpha.mechanismRiskReview;
  if (review?.archetype !== "fiat-cash") throw new Error("Cascade fixture requires a fiat-cash review");
  review.claimAndSegregation = { ...review.claimAndSegregation, status: status("missing"), quality: null };
  for (const [id, upstream, role] of [
    ["alpha", "beta", "serial-claim"], ["gamma", "alpha", "basket-exposure"],
  ] as const) {
    const asset = extension.assets.find((row) => row.assetId === id)!;
    asset.dependencies = {
      source: "manual", baseSource: "manual", dependencyFromLive: false,
      mappedLiveReserveWeight: null, fallbackReason: null,
      edges: [{
        upstreamAssetId: upstream,
        dependencyType: role === "serial-claim" ? "wrapper" : "collateral", economicRole: role,
        weight: 1, failureDomains: [],
      }],
      diagnostics: { graphState: "valid", issueCodes: [], sccMemberAssetIds: [] },
    };
  }
  return { fixedInput, extension, publishedAtSec: PUBLISHED_AT_SEC };
}

const V9_EVALUATION_TEST_TIMEOUT_MS = 30_000;

describe("Safety Score v9 publication pipeline", { timeout: V9_EVALUATION_TEST_TIMEOUT_MS }, () => {
  it("publishes evaluation supply and captured shared-book identity without using publication time", () => {
    const fixedInput = exactFixedInput("alpha");
    fixedInput.liveReserveProvenanceMap.alpha = {
      ...fixedInput.liveReserveProvenanceMap.alpha!,
      balanceSheetScope: "shared-sky-maker",
      sharedBookAssetIds: ["alpha"],
    };
    fixedInput.baseInputGenerationId = deriveReportCardsBaseInputGenerationId(fixedInput);
    const result = buildSafetyScoreV9Candidate({ fixedInput, extension: reviewedExtension(fixedInput), publishedAtSec: PUBLISHED_AT_SEC });
    const fact = result.compiledFacts.assets[0]!.supply;
    const fingerprint = Object.values(result.compiledFacts.sourceFingerprints).find((source) => source.generationId === fact.sourceGenerationId)!;
    expect(result.candidate.cards[0]!.supply).toEqual({
      circulatingUsdAtEvaluation: fact.circulatingUsd,
      generationId: fact.sourceGenerationId,
      asOfSec: fingerprint.observedAtSec,
    });
    expect(result.candidate.cards[0]!.sharedBookId).toBe("sky-maker");
  });

  it("prefers the first unverified intermediary for a structural serial claim", () => {
    const fixedInput = exactFixedInput("alpha");
    const result = buildSafetyScoreV9Candidate({ fixedInput, extension: reviewedExtension(fixedInput), publishedAtSec: PUBLISHED_AT_SEC });
    const asset = structuredClone(result.compiledFacts.assets[0]!);
    asset.dependencies.edges = [{
      edgeKey: "wrapper:beta", upstreamAssetId: "beta", dependencyType: "wrapper",
      economicRole: "serial-claim", pathKind: "serial-dependency", weight: 1, evidenceRefIds: [], failureDomains: [],
    }];
    const verified = { kind: "bridge" as const, label: "Verified bridge", verified: true };
    const unverified = { kind: "bridge" as const, label: "Unverified bridge", verified: false };
    const meta = { id: "alpha", variantOf: "beta", reserves: [
      { name: "Beta 1", pct: 40, risk: "low" as const, coinId: "beta", intermediary: verified },
      { name: "Beta 2", pct: 30, risk: "low" as const, coinId: "beta", intermediary: unverified },
      { name: "Beta 3", pct: 30, risk: "low" as const, coinId: "beta", intermediary: { ...unverified, label: "Later unverified bridge" } },
    ] };
    expect(publicDependencyMetadata(asset, result.compiledFacts, fixedInput, meta).dependencyProvenance.get("beta")).toMatchObject({ source: "variant", intermediary: unverified });
    meta.reserves[1]!.intermediary = verified;
    meta.reserves[2]!.intermediary = verified;
    expect(publicDependencyMetadata(asset, result.compiledFacts, fixedInput, meta).dependencyProvenance.get("beta")!.intermediary).toEqual(verified);
    asset.supply.circulatingUsd = null;
    expect(publicDependencyMetadata(asset, result.compiledFacts, fixedInput, meta).supply).toEqual({ circulatingUsdAtEvaluation: null, asOfSec: null, generationId: null });
  });

  it("keeps a mixed native and verified bridge aggregate unannotated, but preserves unverified risk", () => {
    const fixedInput = exactFixedInput("alpha");
    const result = buildSafetyScoreV9Candidate({ fixedInput, extension: reviewedExtension(fixedInput), publishedAtSec: PUBLISHED_AT_SEC });
    const asset = structuredClone(result.compiledFacts.assets[0]!);
    asset.dependencies.edges = [{
      edgeKey: "wrapper:beta", upstreamAssetId: "beta", dependencyType: "wrapper",
      economicRole: "serial-claim", pathKind: "serial-dependency", weight: 1, evidenceRefIds: [], failureDomains: [],
    }];
    const bridge = { kind: "bridge" as const, label: "USDC.e", verified: true };
    fixedInput.liveReserveMap.alpha = [
      { sourceKey: "fixture:native", name: "Native USDC", pct: 72.5, risk: "low", coinId: "beta" },
      { sourceKey: "fixture:bridge", name: "USDC.e", pct: 27.5, risk: "low", coinId: "beta", intermediary: bridge },
    ];
    expect(publicDependencyMetadata(asset, result.compiledFacts, fixedInput, { id: "alpha" }).dependencyProvenance.get("beta")!.intermediary).toBeNull();
    bridge.verified = false;
    expect(publicDependencyMetadata(asset, result.compiledFacts, fixedInput, { id: "alpha" }).dependencyProvenance.get("beta")!.intermediary).toEqual(bridge);
  });

  it("does not assign the Sky shared book to an unknown captured scope", () => {
    const fixedInput = exactFixedInput("alpha");
    const result = buildSafetyScoreV9Candidate({ fixedInput, extension: reviewedExtension(fixedInput), publishedAtSec: PUBLISHED_AT_SEC });
    Object.assign(fixedInput.liveReserveProvenanceMap.alpha!, { balanceSheetScope: "unknown-book", sharedBookAssetIds: ["alpha"] });
    expect(publicDependencyMetadata(result.compiledFacts.assets[0]!, result.compiledFacts, fixedInput, { id: "alpha" }).sharedBookId).toBeNull();
  });

  it("retains distinct keyed withheld slices sharing a label and preserves different reasons", () => {
    const fixedInput = exactFixedInput("alpha");
    const result = buildSafetyScoreV9Candidate({ fixedInput, extension: reviewedExtension(fixedInput), publishedAtSec: PUBLISHED_AT_SEC });
    const asset = structuredClone(result.compiledFacts.assets[0]!);
    asset.dependencies.edges = [];
    asset.gaps = [];
    asset.dependencies.rejectionReasons = [{ sliceIndex: 0, reason: "expired" }, { sliceIndex: 1, reason: "no-match" }];
    asset.dependencies.diagnostics.issueCodes = ["outside-active-set:gamma"];
    fixedInput.liveReserveMap.alpha = [
      { sourceKey: "fixture:first", name: "USDC reserves", pct: 40, risk: "low", coinId: "beta" },
      { sourceKey: "fixture:second", name: "USDC reserves", pct: 60, risk: "low", coinId: "gamma" },
    ];
    const rows = publicDependencyMetadata(asset, result.compiledFacts, fixedInput, { id: "alpha" }).dependencyCoverage;
    expect(rows.map((row) => ({ id: row.upstreamAssetId, reason: row.reason, share: row.share }))).toEqual([
      { id: "beta", reason: "expired", share: 0.4 },
      { id: "gamma", reason: "no-match", share: 0.6 },
      { id: "gamma", reason: "outside-active-set:gamma", share: 0.6 },
    ]);
  });

  it("discloses an untyped sibling even when the same upstream has a modeled edge", () => {
    const fixedInput = exactFixedInput("alpha");
    const result = buildSafetyScoreV9Candidate({ fixedInput, extension: reviewedExtension(fixedInput), publishedAtSec: PUBLISHED_AT_SEC });
    const asset = structuredClone(result.compiledFacts.assets[0]!);
    asset.dependencies.edges = [{
      edgeKey: "wrapper:beta", upstreamAssetId: "beta", dependencyType: "wrapper",
      economicRole: "serial-claim", pathKind: "serial-dependency", weight: 1, evidenceRefIds: [], failureDomains: [],
    }];
    asset.gaps = [];
    asset.dependencies.diagnostics.issueCodes = [];
    asset.dependencies.rejectionReasons = [
      { sliceIndex: 0, upstreamAssetId: "beta", reason: "coinId-without-depType" },
      { sliceIndex: 2, upstreamAssetId: "beta", reason: "expired" },
    ];
    fixedInput.liveReserveMap.alpha = [
      { sourceKey: "fixture:untyped", name: "Untyped Beta", pct: 40, risk: "low", coinId: "beta" },
      { sourceKey: "fixture:typed", name: "Typed Beta", pct: 40, risk: "low", coinId: "beta", depType: "collateral" },
      { sourceKey: "fixture:expired", name: "Expired Beta", pct: 20, risk: "low", coinId: "beta" },
    ];
    const rows = publicDependencyMetadata(asset, result.compiledFacts, fixedInput, { id: "alpha" }).dependencyCoverage;
    expect(rows).toEqual([{
      upstreamLabel: "Untyped Beta", upstreamAssetId: "beta", share: 0.4,
      reason: "coinId-without-depType", sourceAsOf: null, identityVerified: true,
    }]);
  });

  it("discloses withheld identities without inventing graph endpoints or treating cash as a relationship", () => {
    const fixedInput = exactFixedInput("alpha");
    const result = buildSafetyScoreV9Candidate({ fixedInput, extension: reviewedExtension(fixedInput), publishedAtSec: PUBLISHED_AT_SEC });
    const asset = structuredClone(result.compiledFacts.assets[0]!);
    asset.dependencies.edges = [];
    asset.dependencies.rejectionReasons = [{ sliceIndex: 0, reason: "no-match" }, { sliceIndex: 1, reason: "expired" }];
    const sourceSlices = [
      { name: "Unverified bridged Beta", pct: 40, risk: "low" as const, coinId: "beta", intermediary: { kind: "bridge" as const, label: "Beta bridge", verified: false } },
      { name: "Cash", pct: 60, risk: "very-low" as const, assetClass: "cash" as const },
    ];
    fixedInput.liveReserveMap.alpha = sourceSlices;
    const metadata = publicDependencyMetadata(asset, result.compiledFacts, fixedInput, { id: "alpha" });
    expect(metadata.dependencyCoverage).toEqual([{
      upstreamLabel: "Unverified bridged Beta", upstreamAssetId: null, share: 0.4,
      reason: "no-match", sourceAsOf: null, identityVerified: false,
    }]);
    expect(asset.dependencies.edges).toEqual([]);
  });

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
    expect(left.candidate.cards[0]?.backingFromLiveReserves).toBe(true);
    expect(left.compilerFactSchemaIdentity).toMatchObject({
      compiledFactSchemaVersion: 4,
      compilerAdapter: "exact-fixed-input-to-v9-facts.v3",
    });
    expect(left.compilerFactSchemaIdentity.compiledFactSchemaCapabilities).toEqual([
      "canonical-chain-supply-distribution.v1",
      "canonical-lock-mint-supply-attribution.v1",
      "exit-route-modeled-confidence.v1",
      "fact-gap-cause-proofs.v1",
      "governed-issuance.v1",
      "journaled-cdp-shock-coverage.v1",
      "reviewed-deployment-unit-supply-attribution.v1",
      "reviewed-transfer-deployments.v1",
      "wrapper-local-facts.v1",
    ]);
    expect(left.producerCapabilityIdentity.sourceAdapters.dexExitRoutes).toBe("fixed-input.dex-exit-observations.v2");
    expect(left.producerCapabilityIdentity.sourceAdapters.redemptionExitRoutes).toBe(
      "fixed-input.redemption-exit-observations.v2",
    );
    expect(left.producerCapabilityIdentity.sourceAdapters.chainSupply).toBe("fixed-input.usd-circulating-supply.v4");
    expect(left.producerCapabilityIdentity.sourceAdapters.researchOverlays).toBe(
      "v9-fact-extension.review-overlays.v4",
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

  it("quarantines one evaluation failure and still builds a conservative candidate", () => {
    const fixedInput = exactFixedInput("alpha");
    const evaluate = vi
      .spyOn(evaluateSetModule, "evaluateValidatedV9FactSet")
      .mockImplementationOnce(() => {
        throw new V9AssetEvaluationError("alpha", {
          issues: [
            {
              path: ["structuralSignals", 0, "materialSharePct"],
            },
          ],
        });
      });

    const result = buildSafetyScoreV9Candidate({
      fixedInput,
      extension: reviewedExtension(fixedInput),
      publishedAtSec: PUBLISHED_AT_SEC,
    });

    expect(result.quarantines).toEqual([
      expect.objectContaining({
        assetId: "alpha",
        code: "evaluation-failed",
        message: expect.stringContaining(
          "structuralSignals[0].materialSharePct",
        ),
      }),
    ]);
    expect(result.quarantineAffectedAssetIds).toEqual(["alpha"]);
    expect(result.candidate.cards).toEqual([
      expect.objectContaining({ id: "alpha", ratingStatus: "pipeline-gap", grade: null, score: null }),
    ]);
    evaluate.mockRestore();
  });

  it("quarantines an asset whose public card violates its contract instead of failing the publication", () => {
    const fixedInput = exactFixedInput("alpha");
    const build = vi
      .spyOn(publicModule, "buildSafetyScoreV9Response")
      .mockImplementationOnce(() => {
        throw new publicModule.V9PublicCardProjectionError([{ assetId: "alpha", issues: [{
          code: "custom", input: undefined, message: "Scoring disposition must agree with controlling cause",
          path: ["cards", 0, "breakdowns", "backing", "components", 4],
        }] }]);
      });

    const result = buildSafetyScoreV9Candidate({
      fixedInput,
      extension: reviewedExtension(fixedInput),
      publishedAtSec: PUBLISHED_AT_SEC,
    });

    expect(build).toHaveBeenCalledTimes(2);
    expect(result.quarantines).toEqual([
      expect.objectContaining({
        assetId: "alpha",
        code: "evaluation-failed",
        message: expect.stringContaining("breakdowns.backing.components.4: Scoring disposition must agree with controlling cause"),
      }),
    ]);
    expect(result.candidate.cards).toEqual([
      expect.objectContaining({ id: "alpha", ratingStatus: "pipeline-gap", grade: null, score: null }),
    ]);
    build.mockRestore();
  });

  it("publishes adverse authority with its real U gap and isolates one malformed causal projection", () => {
    const inputs = ["alpha", "beta"].map((assetId) => exactFixedInput(assetId));
    const reviewedAssets = inputs.map((input) => reviewedExtension(input).assets[0]!);
    const fixedInput = inputs[0]!;
    fixedInput.activeAssetIds = ["alpha", "beta"];
    for (const key of ["dexLiqMap", "pegDataById", "liveReserveMap", "liveReserveProvenanceMap",
      "chainCirculatingById", "aggregateCirculatingById", "resolvedBlacklistStatuses"] as const) {
      Object.assign(fixedInput[key], inputs[1]![key]);
    }
    fixedInput.dexPayloadFingerprint = computeDexLiquidityPayloadFingerprint(fixedInput.dexLiqMap, fixedInput.dexGenerationId);
    fixedInput.baseInputGenerationId = deriveReportCardsBaseInputGenerationId(fixedInput);
    const extension = reviewedExtension(fixedInput);
    extension.assets = reviewedAssets;
    const alpha = extension.assets[0]!;
    alpha.launchedAtSec = AS_OF_SEC - 86400;
    alpha.controlReview = { state: "reviewed-controls", controls: [localControl({
      controlKey: "mint:adverse", controlKind: "mint", capabilities: ["mint"],
      capSemantics: { kind: "unbounded", bound: null }, claimImpairment: "unbounded",
      economicLossScope: "global-claim", delaySec: null, keyCustody: "hsm",
      modulesOrGuards: "none-detected",
      failureDomains: [{ kind: "mint-control", key: "ethereum:0x4444444444444444444444444444444444444444" }],
    })] };
    alpha.economicControlReview!.mint = {
      status: status("known", "v9.control.mint-review"), controlKey: "mint:adverse",
      reconciliation: "unknown", supervision: "none", latestResolvedIncidentAtSec: null,
      upgrade: { state: "immutable", controlKey: null },
    };
    const input = { fixedInput, extension, publishedAtSec: PUBLISHED_AT_SEC };
    const baseline = buildSafetyScoreV9Candidate(input);
    expect(baseline.quarantines).toEqual([]);
    const mint = baseline.evaluatedSet.assets.find((asset) => asset.assetId === "alpha")!
      .control.components.find((component) => component.kind === "mint")!;
    expect(mint).toMatchObject({
      posture: "unbounded-adverse", score: 25, cause: "U",
      causeGapIds: ["alpha:gap:economic-control:mint::reconciliation"],
    });
    expect(baseline.evaluatedSet.assets.find((asset) => asset.assetId === "alpha")!
      .scoreInput.pillars.control.structuralSignals).toContainEqual(expect.objectContaining({
        kind: "centralized-mint", responsibility: "measured-adverse",
      }));
    expect(SafetyScoreV9ResponseSchema.parse(baseline.candidate)).toEqual(baseline.candidate);

    const evaluate = vi.spyOn(evaluateSetModule, "evaluateValidatedV9FactSet")
      .mockImplementationOnce((...args) => {
        const malformed = structuredClone(evaluateValidatedV9FactSet(...args));
        const component = malformed.assets.find((asset) => asset.assetId === "alpha")!
          .control.components.find((row) => row.kind === "mint")!;
        component.causeGapIds = [];
        return malformed;
      });
    try {
      const result = buildSafetyScoreV9Candidate(input);
      expect(result.quarantines).toEqual([expect.objectContaining({
        assetId: "alpha", code: "evaluation-failed",
      })]);
      expect(result.candidate.cards.find((row) => row.id === "alpha")).toMatchObject({
        ratingStatus: "pipeline-gap", grade: null, score: null,
      });
      const ordinaryBeta = baseline.candidate.cards.find((row) => row.id === "beta")!;
      // Shared-domain census diagnostics are recompiled after quarantine; the
      // surviving asset still publishes its rated numerical result.
      expect(result.candidate.cards.find((row) => row.id === "beta")).toMatchObject({
        id: "beta", ratingStatus: "rated", grade: ordinaryBeta.grade, score: ordinaryBeta.score,
      });
      expect(SafetyScoreV9ResponseSchema.parse(result.candidate)).toEqual(result.candidate);
    } finally {
      evaluate.mockRestore();
    }
  });

  it.each(["alpha", "gamma"])("publishes %s through a quarantined reserve parent without cascading public-contract failures", (assetId) => {
    const input = reserveParentCascadeFixture();
    const baseline = buildSafetyScoreV9Candidate(input);
    expect(baseline.quarantines).toEqual([]);
    const ordinaryAlpha = baseline.candidate.cards.find((card) => card.id === "alpha")!;
    expect(ordinaryAlpha.pillars.exit.score).toBe(0);
    expect(ordinaryAlpha.scoreTrace.adverseAttribution.items).toContainEqual(expect.objectContaining({
      source: "reason", path: "exit:no-viable-exit-path", responsibility: "measured-adverse",
    }));
    const ordinaryGamma = baseline.candidate.cards.find((card) => card.id === "gamma")!;
    const ordinaryHolding = ordinaryGamma.breakdowns!.backing.components.find((row) => row.source === "reserve-exposure")!;
    expect(ordinaryHolding.cause ?? null).toBeNull();
    expect(ordinaryHolding.score).toBeGreaterThan(0);
    const build = vi.spyOn(publicModule, "buildSafetyScoreV9Response").mockImplementationOnce(() => {
      throw new publicModule.V9PublicCardProjectionError([{ assetId: "beta", issues: [{
        code: "custom", message: "Captured parent projection failure", path: ["cards", 1, "breakdowns", "backing"],
      }] }]);
    });
    try {
      const result = buildSafetyScoreV9Candidate(input);
      expect(result.quarantines.map((quarantine) => quarantine.assetId)).toEqual(["beta"]);
      const card = result.candidate.cards.find((row) => row.id === assetId)!;
      expect(card.partialEvidence?.causes).toEqual(["A"]);
      expect(SafetyScoreV9ResponseSchema.parse(result.candidate)).toEqual(result.candidate);
      if (assetId === "alpha") {
        expect(card).toMatchObject({ ratingStatus: "pipeline-gap", grade: null, score: null });
        expect(card.pillars.exit.score).toBeNull();
        expect(card.scoreTrace.adverseAttribution.items.some((item) =>
          item.path === "exit:no-viable-exit-path" || item.path.startsWith("pillar:exit:"),
        )).toBe(false);
      } else {
        expect(card.breakdowns!.backing.components.find((row) => row.source === "reserve-exposure"))
          .toMatchObject({ score: null, cause: "A", scoringDisposition: "excluded-pipeline" });
        const unavailable = [...iterateEvidenceResponsibilityFacts(card.scoreTrace.evidenceResponsibility)]
          .find((fact) => fact[0] === "material-dependency-unavailable");
        expect(unavailable).toMatchObject({ 3: "producer-failed", 4: false, 5: "A" });
        expect(unavailable![6].map((ref) => resolveCauseGapId(result.candidate, card, ref)))
          .toContain("beta:gap:asset-compilation");
      }
    } finally {
      build.mockRestore();
    }
  });

  it("fails immediately when a compilation-quarantined stub violates its public contract", () => {
    const fixedInput = exactFixedInput("alpha");
    const extension = reviewedExtension(fixedInput);
    extension.assets[0]!.launchedAtSec = -1;
    const failure = new publicModule.V9PublicCardProjectionError([{ assetId: "alpha", issues: [{
      code: "custom", message: "Stub projection failure", path: ["cards", 0, "scoreTrace"],
    }] }]);
    const build = vi.spyOn(publicModule, "buildSafetyScoreV9Response").mockImplementationOnce(() => { throw failure; });
    try {
      expect(() => buildSafetyScoreV9Candidate({ fixedInput, extension, publishedAtSec: PUBLISHED_AT_SEC })).toThrow(failure);
      expect(build).toHaveBeenCalledTimes(1);
    } finally {
      build.mockRestore();
    }
  });

  it("keeps strict, trusted, full, and compact paths identical with provenance guards", () => {
    const fixedInput = exactFixedInput("alpha");
    const full = buildSafetyScoreV9Candidate({
      fixedInput,
      extension: reviewedExtension(fixedInput),
      publishedAtSec: PUBLISHED_AT_SEC,
    });
    const clockBoundPolicy = loadV9CandidateMethodologyPolicy(fixedInput.clockSec);
    const strictEvaluation = evaluateV9FactSet(full.compiledFacts, clockBoundPolicy);
    const trustedEvaluation = evaluateValidatedV9FactSet(full.compiledFacts, clockBoundPolicy);
    const trustedCompilation = compileSafetyScoreV9FactSetFromValidatedExtension(
      full.fixedInput,
      full.extension,
    );
    const compact = buildSafetyScoreV9PublicationFromNormalizedInput({
      fixedInput: full.fixedInput,
      extension: full.extension,
      publishedAtSec: PUBLISHED_AT_SEC,
    });

    expect(trustedEvaluation).toEqual(strictEvaluation);
    expect(trustedEvaluation).toEqual(full.evaluatedSet);
    expect(trustedCompilation).toEqual(full.compiledFacts);
    expect(compact).toEqual({
      candidate: full.candidate,
      compilerFactSchemaDigest: full.compilerFactSchemaDigest,
      producerCapabilityDigest: full.producerCapabilityDigest,
      quarantines: full.quarantines,
      quarantineAffectedAssetIds:
        full.quarantineAffectedAssetIds,
      bridgeJoinDiagnostics: full.bridgeJoinDiagnostics,
    });
    expect(() =>
      evaluateValidatedV9FactSet(structuredClone(full.compiledFacts), clockBoundPolicy),
    ).toThrow("requires an in-process compiled fact set");
    expect(() =>
      compileSafetyScoreV9FactSetFromValidatedExtension(
        full.fixedInput,
        structuredClone(full.extension),
      ),
    ).toThrow("requires an in-process materialized extension");
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
    changedPolicy.policyId = "safety-score-v9";
    changedPolicy.semantic.formula.compensabilityHeadroom += 1;
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

  it("keeps reviewed metadata provisionally rateable when bounded exit evidence is absent", () => {
    const result = buildSafetyScoreV9Candidate({
      // The reviewed registry metadata resolves the mechanism, control, mint,
      // and access reviews. This capture has no exit-route observations, so
      // the compiler retains a conservative bounded exit pillar.
      fixedInput: exactFixedInput("usdc-circle", 12, {
        includeDexObservations: false,
        includeObservedDexCoverage: false,
      }),
      publishedAtSec: PUBLISHED_AT_SEC,
    });

    expect(result.extension.assets[0]).toMatchObject({
      assetId: "usdc-circle",
      // Reviewed reserve/proof-of-reserves and mint-authority evidence enriches
      // the mechanism, control, and mint reviews to resolved states. That
      // enrichment cannot substitute for a measured exit route.
      mechanismRiskReview: {
        archetype: "fiat-cash",
        // D1 fiat-cash overlays are active: USDC's claim/custody components are
        // curated known (owner decision D1, 2026-07-15).
        claimAndSegregation: { status: { observationState: "known" } },
        custodyContinuity: { status: { observationState: "known" } },
        assuranceAndReconciliation: { status: { observationState: "known" } },
      },
      // SAFETY-SCORE-V9-25 L-08 keeps an unattributed bridge share unresolved.
      controlReview: { state: "partially-reviewed-controls" },
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
    expect(result.candidate.cards[0]).toMatchObject({ id: "usdc-circle", ratingStatus: "rated" });
    expect(result.candidate.cards[0]!.nrReasons).toEqual([]);
    expect(result.candidate.cards[0]!.reasonCodes).toContain("missing-same-notional-route");
    expect(result.candidate.completeness).toEqual({
      expectedCount: 1,
      ratedCount: 1,
      notRatedCount: 0,
      notRatedIds: [],
      pipelineGapCount: 0, pipelineGapIds: [],
    });
  });

  it("preserves distinct route-output and bounded-fee causes under diagnostic review", () => {
    const fixedInput = makeV9BoundedUnknownFeeRedemptionFixedInput({ clockSec: AS_OF_SEC });
    const extension = structuredClone(buildSafetyScoreV9BaselineExtension(fixedInput));
    for (const review of extension.assets[0]!.routeReviews) {
      review.coverageClass = "diagnostic";
    }
    const result = buildSafetyScoreV9Candidate({
      fixedInput,
      extension,
      publishedAtSec: PUBLISHED_AT_SEC,
    });
    const card = result.candidate.cards[0]!;

    expect(card.grade).not.toBe("NR");
    expect(card.score).not.toBeNull();
    expect(card.nrReasons).toEqual([]);
    expect(card.reasonCodes).toContain("missing-same-notional-route");
    expect(card.scoreTrace.boundedUncertaintyAttribution.items).toContainEqual(
      expect.objectContaining({
        source: "reason",
        code: "missing-same-notional-route",
        cause: "U", responsibility: "unresearched",
        path: expect.stringContaining(":cause:"),
      }),
    );
    expect([...iterateEvidenceResponsibilityFacts(card.scoreTrace.evidenceResponsibility)]
      .map(([reasonCode, , sourceGapRef, responsibility, critical, cause]) => ({
        reasonCode, responsibility, critical, cause,
        sourceGapId: sourceGapRef === null ? null : resolveCauseGapId(result.candidate, card, sourceGapRef),
      }))).toEqual(expect.arrayContaining([
        expect.objectContaining({
          reasonCode: "missing-same-notional-route", responsibility: "unresearched", critical: false, cause: "U",
          sourceGapId: expect.stringContaining("offchain-issuer:cost"),
        }),
        expect.objectContaining({
          reasonCode: "unresolved-exit-output", responsibility: "producer-failed", critical: false, cause: "A",
          sourceGapId: expect.stringContaining("offchain-issuer:output"),
        }),
      ]));
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
    observation.capacityEvidenceTier = "live-direct";
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
    asset.routeReviews[0]!.settlementModel = "atomic";
    asset.routeReviews[0]!.settlementSlaSec = 0;
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

  it("changes only V9 exit economics when measured points retain realized cost", () => {
    const fixedInput = exactFixedInput("alpha");
    const observation = fixedInput.dexLiqMap.alpha!.exitRouteObservations![0]!;
    observation.evidenceKind = "measured-executable-depth";
    observation.capacityCurve = observation.capacityCurve!.map((point) => ({
      ...point,
      executionCostBps: 20,
    }));
    fixedInput.dexPayloadFingerprint = computeDexLiquidityPayloadFingerprint(
      fixedInput.dexLiqMap,
      fixedInput.dexGenerationId,
    );
    fixedInput.baseInputGenerationId = deriveReportCardsBaseInputGenerationId(fixedInput);

    const baselineExtension = buildSafetyScoreV9BaselineExtension(fixedInput, {
      metaById: new Map([["alpha", { id: "alpha", mechanismArchetype: "fiat-cash" }]]),
    });
    const realizedExtension = reviewedExtension(fixedInput);
    realizedExtension.assets[0]!.routeReviews[0]!.executionCosts =
      baselineExtension.assets[0]!.routeReviews[0]!.executionCosts;
    const boundedExtension = structuredClone(realizedExtension);
    boundedExtension.assets[0]!.routeReviews[0]!.executionCosts =
      boundedExtension.assets[0]!.routeReviews[0]!.executionCosts.map((point) => ({
        ...point,
        executionCostBps: point.maxCostBps,
      }));

    const realized = buildSafetyScoreV9Candidate({
      fixedInput,
      extension: realizedExtension,
      publishedAtSec: PUBLISHED_AT_SEC,
    });
    const bounded = buildSafetyScoreV9Candidate({
      fixedInput,
      extension: boundedExtension,
      publishedAtSec: PUBLISHED_AT_SEC,
    });
    const realizedInput = realized.evaluatedSet.assets[0]!.scoreInput;
    const boundedInput = bounded.evaluatedSet.assets[0]!.scoreInput;

    expect(realizedInput.pillars.exit.score).toBeGreaterThan(boundedInput.pillars.exit.score!);
    expect(realizedInput.pillars.backing).toEqual(boundedInput.pillars.backing);
    expect(realizedInput.pillars.control).toEqual(boundedInput.pillars.control);
    expect(realizedInput.peg).toEqual(boundedInput.peg);
  });

  it("publishes a strict rated candidate from a supplied reviewed extension", () => {
    const fixedInput = exactFixedInput("alpha");
    const policy = loadV9CandidateMethodologyPolicy(fixedInput.clockSec);
    const result = buildSafetyScoreV9Candidate({
      fixedInput,
      extension: reviewedExtension(fixedInput),
      policy,
      publishedAtSec: PUBLISHED_AT_SEC,
    });

    expect(result.candidate).toMatchObject({
      model: "v9-critical-path",
      lifecycle: "active",
      policyVersion: policy.policy.releaseVersion,
      completeness: { expectedCount: 1, ratedCount: 1, notRatedCount: 0, notRatedIds: [] },
    });
    expect(result.candidate.cards[0]).toMatchObject({ id: "alpha", score: 77, grade: "B+" });
    expect(result.evaluatedSet.assets[0]!.trace.finalScore).toBe(result.candidate.cards[0]!.score);
  });

  it("projects exit-pillar freshness from the DEX input age against the lane bound", () => {
    const withDexRowAge = (ageSec: number) => {
      const fixedInput = exactFixedInput("alpha");
      const updatedAt = AS_OF_SEC - ageSec;
      fixedInput.dexLiqMap.alpha!.updatedAt = updatedAt;
      fixedInput.dexGenerationId = `dex-liquidity-${updatedAt}`;
      fixedInput.inputFreshness.dexLiquidity = { updatedAt, ageSeconds: ageSec, stale: ageSec > 14_400 };
      fixedInput.liquidityStale = ageSec > 14_400;
      fixedInput.dexPayloadFingerprint = computeDexLiquidityPayloadFingerprint(
        fixedInput.dexLiqMap,
        fixedInput.dexGenerationId,
      );
      fixedInput.baseInputGenerationId = deriveReportCardsBaseInputGenerationId(fixedInput);
      return buildSafetyScoreV9Candidate({
        fixedInput,
        extension: reviewedExtension(fixedInput),
        publishedAtSec: PUBLISHED_AT_SEC,
      });
    };

    // One hour old: inside the 4h DEX lane bound, so the exit input is current.
    expect(withDexRowAge(3_600).candidate.cards[0]?.pillars.exit.freshness).toBe("current");
    // Five hours old: past the bound, the stale DEX generation must surface on
    // the card instead of an anonymous "unknown".
    expect(withDexRowAge(5 * 3_600).candidate.cards[0]?.pillars.exit.freshness).toBe("stale");
  });
});
