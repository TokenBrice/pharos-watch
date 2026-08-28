import {
  compileV9FactSetV2,
  compileV9FactSetV3,
  assertExactV9ActiveAssetSet,
} from "../safety-score-v9/compile";
import { evaluateV9FactSet } from "../safety-score-v9/evaluate-set";
import { projectV9ExitEvaluationRoute, resolveV9DistinctExitCapacity } from "../safety-score-v9/exit";
import {
  canonicalV9DependencyEdgeKey,
  canonicalV9RouteKey,
  computeV9FactSetDigest,
  parseCompiledV9FactSetV2,
  readCompiledV9FactSetForEvaluation,
  upgradeV9FactGapV2,
} from "../safety-score-v9/facts";
import {
  createV9EvidenceReference,
  createV9FactStatus,
  notApplicableV9Fact,
  requiredV9Applicability,
} from "../safety-score-v9/evidence";
import { createV9FactGap, createV9FactGapV3, optionalExitV9Path } from "../safety-score-v9/reasons";
import { V9_CANDIDATE_POLICY_V1 } from "../safety-score-v9/policy";
import { stableJsonStringifyV1 } from "../stable-json";
import type {
  V9AssetFactsV2,
  V9AssetFactsV3,
} from "../../types/safety-score-v9-facts";
import type { DependencyType, V9DependencyEconomicRole } from "../../types/dependency-types";

export {
  assertExactV9ActiveAssetSet,
  canonicalV9DependencyEdgeKey,
  canonicalV9RouteKey,
  compileV9FactSetV2,
  compileV9FactSetV3,
  computeV9FactSetDigest,
  createV9EvidenceReference,
  createV9FactGap,
  createV9FactGapV3,
  createV9FactStatus,
  evaluateV9FactSet,
  notApplicableV9Fact,
  optionalExitV9Path,
  parseCompiledV9FactSetV2,
  projectV9ExitEvaluationRoute,
  readCompiledV9FactSetForEvaluation,
  requiredV9Applicability,
  resolveV9DistinctExitCapacity,
  stableJsonStringifyV1,
  upgradeV9FactGapV2,
  V9_CANDIDATE_POLICY_V1,
};
export type { V9AssetFactsV2, V9AssetFactsV3 };

export const AS_OF_SEC = 1_000;
export const BASE_INPUT_GENERATION_ID = `report-cards-input:v1:${"a".repeat(64)}`;

export function source(generationId: string, character: string) {
  return { generationId, payloadSha256: character.repeat(64), observedAtSec: 800 };
}

export const SOURCE_FINGERPRINTS = {
  registry: source("registry:g1", "1"),
  dex: source("dex:g1", "2"),
  redemption: source("redemption:g1", "3"),
  liveReserves: source("reserves:g1", "4"),
  chainSupply: source("supply:g1", "5"),
  peg: source("peg:g1", "6"),
  researchOverlays: source("research:g1", "7"),
};

export function publishedEvidence(evidenceId = "evidence:base") {
  return createV9EvidenceReference(
    {
      evidenceId,
      sourceId: "fixture-source",
      sourceGenerationId: "fixture:g1",
      disposition: "published",
      observedAtSec: 900,
      publishedAtSec: 910,
      maxAgeSec: 200,
    },
    AS_OF_SEC,
  );
}

export function knownStatus(evidenceId = "evidence:base", policyRuleId = "facts.required") {
  return createV9FactStatus({
    applicability: requiredV9Applicability(policyRuleId),
    observationState: "known",
    evidenceRefIds: [evidenceId],
  });
}

export function notApplicableStatus(evidenceId = "evidence:base", policyRuleId = "facts.not-applicable") {
  return createV9FactStatus({
    applicability: notApplicableV9Fact(policyRuleId, "Reviewed as not applicable for this fixture archetype."),
    observationState: "known",
    evidenceRefIds: [evidenceId],
  });
}

export function mechanismFact() {
  return {
    status: knownStatus("evidence:base", "backing.mechanism.review"),
    quality: "strong" as const,
    failureDomains: [{ kind: "reserve-issuer" as const, key: "mechanism:fixture" }],
  };
}

export function mechanismReview(archetype: "algorithmic" | "fiat-cash") {
  if (archetype === "fiat-cash") {
    return {
      status: knownStatus("evidence:base", "backing.mechanism.review"),
      review: {
        archetype,
        claimAndSegregation: mechanismFact(),
        custodyContinuity: mechanismFact(),
        assuranceAndReconciliation: mechanismFact(),
      },
    };
  }
  return {
    status: knownStatus("evidence:base", "backing.mechanism.review"),
    review: {
      archetype,
      exogenousBackingShare: 1,
      reflexiveBackingShare: 0,
      contractionCapacityRatio: 1,
      contractionCapacity: mechanismFact(),
      confidenceAndIncentives: mechanismFact(),
      oracleAndControlAssumptions: mechanismFact(),
      emergencyRecovery: mechanismFact(),
      lossRecovery: mechanismFact(),
    },
  };
}

export function noEconomicControlReview() {
  return {
    mint: {
      status: notApplicableStatus("evidence:base", "control.mint.not-applicable"),
      controlKey: null,
      reconciliation: "not-applicable" as const,
      upgrade: { state: "not-applicable" as const, controlKey: null },
    },
    oracle: {
      status: notApplicableStatus("evidence:base", "control.oracle.not-applicable"),
      tier: null,
      branches: [],
    },
    bridge: {
      status: notApplicableStatus("evidence:base", "control.bridge.not-applicable"),
      routes: [],
    },
  };
}

export function accessReview(freezeControlKey: string | null = null) {
  return {
    transfer: {
      status: knownStatus("evidence:base", "access.transfer.review"),
      posture: "permissionless" as const,
    },
    freeze: {
      status: knownStatus("evidence:base", "access.freeze.review"),
      reviews: [
        {
          reviewKey: freezeControlKey ? "freeze:direct" : "freeze:none-reviewed",
          source: freezeControlKey ? ("freeze" as const) : ("blacklist" as const),
          status: knownStatus("evidence:base", "access.freeze.review"),
          reach: freezeControlKey ? ("individual" as const) : ("none" as const),
          controlKey: freezeControlKey,
          upstreamAssetId: null,
          failureDomains: freezeControlKey ? [{ kind: "mint-control" as const, key: "safe:freezer" }] : [],
        },
      ],
    },
  };
}

export function fixturePegFact(
  status: V9AssetFactsV2["peg"]["status"],
  sourceGenerationId: string,
): V9AssetFactsV2["peg"] {
  return {
    status,
    pegKey: "peg:usd",
    sourceGenerationId,
    referenceKind: "fiat",
    referenceKey: "USD",
    methodologyVersion: "fixture-peg-v1",
    pegScore: 99,
    currentDeviationBps: 1,
    activeDepeg: false,
    activeDepegBps: null,
    trackingSpanDays: 365,
    failureDomains: [{ kind: "oracle-feed", key: "oracle:usd" }],
  };
}

export function minimalAsset(assetId: string) {
  const base = publishedEvidence();
  return {
    assetId,
    archetype: "algorithmic",
    evidence: [base],
    gaps: [],
    implementation: { status: knownStatus(), launchedAtSec: 100 },
    mechanismRiskReview: mechanismReview("algorithmic"),
    dependencies: {
      status: knownStatus(),
      sourceGenerationId: SOURCE_FINGERPRINTS.researchOverlays.generationId,
      source: "none",
      baseSource: "none",
      dependencyFromLive: false,
      mappedLiveReserveWeight: null,
      fallbackReason: null,
      edges: [],
      diagnostics: { graphState: "valid", issueCodes: [], sccMemberAssetIds: [] },
    },
    reserveStatus: notApplicableStatus(),
    reserveExposures: [],
    exitStatus: notApplicableStatus(),
    exitRoutes: [],
    controlStatus: notApplicableStatus(),
    controls: [],
    economicControlReview: noEconomicControlReview(),
    accessReview: accessReview(),
    peg: {
      status: knownStatus(),
      pegKey: "peg:usd",
      sourceGenerationId: SOURCE_FINGERPRINTS.peg.generationId,
      referenceKind: "fiat",
      referenceKey: "USD",
      methodologyVersion: "fixture-peg-v1",
      pegScore: 98,
      currentDeviationBps: 2,
      activeDepeg: false,
      activeDepegBps: null,
      trackingSpanDays: 365,
      failureDomains: [{ kind: "oracle-feed", key: "oracle:fixture" }],
    },
    supply: {
      status: knownStatus(),
      sourceGenerationId: SOURCE_FINGERPRINTS.chainSupply.generationId,
      sourceKind: "usd-denominated-circulating",
      circulatingUnits: null,
      referencePriceUsd: null,
      circulatingUsd: 1_000_000,
      chainDistribution: {
        chains: [{ chainId: "chain:fixture", supplyUsd: 1_000_000, supplyShare: 1 }],
        unattributedSupplyUsd: 0,
        unattributedSupplyShare: 0,
      },
      selectedBridgeRoutes: [],
      selectedRouteSupplyShare: 0,
      unknownRouteSupplyShare: 0,
      unreviewedRouteSupplyShare: 0,
      failureDomains: [{ kind: "chain", key: "chain:fixture" }],
    },
  };
}

export function fullAsset(reversed: boolean) {
  const order = <T>(values: T[]) => (reversed ? [...values].reverse() : values);
  const base = publishedEvidence();
  const routeEvidence = createV9EvidenceReference(
    {
      evidenceId: "evidence:route",
      sourceId: "route-source",
      sourceGenerationId: SOURCE_FINGERPRINTS.dex.generationId,
      disposition: "observed",
      observedAtSec: 920,
      maxAgeSec: 200,
    },
    AS_OF_SEC,
  );
  const rejectedEvidence = createV9EvidenceReference(
    {
      evidenceId: "evidence:rejected-route",
      sourceId: "route-source",
      sourceGenerationId: SOURCE_FINGERPRINTS.dex.generationId,
      disposition: "rejected",
      observedAtSec: 930,
      maxAgeSec: 200,
      rejection: { code: "unsupported-pool", reason: "Pool model is unsupported.", rejectedAtSec: 940 },
    },
    AS_OF_SEC,
  );

  const unsupportedRouteKey = canonicalV9RouteKey("dex", SOURCE_FINGERPRINTS.dex.generationId, "unsupported");
  const unsupportedGap = createV9FactGap({
    gapId: "gap:unsupported-route",
    reasonCode: "unsupported-same-notional-route",
    ownerDomain: "exit",
    policyRuleId: "exit.route.supported-model",
    observationState: "unsupported",
    path: optionalExitV9Path(unsupportedRouteKey),
    message: "The retained pool does not have a supported executable-depth model.",
    evidenceRefIds: [rejectedEvidence.evidenceId],
  });
  const unsupportedStatus = createV9FactStatus({
    applicability: requiredV9Applicability("exit.route.supported-model"),
    observationState: "unsupported",
    evidenceRefIds: [rejectedEvidence.evidenceId],
    gapIds: [unsupportedGap.gapId],
  });

  const capacityCurve = order([
    {
      requestedNotionalUsd: 100_000,
      maxCostBps: 200,
      executableUsd: 80_000,
      completionRatio: 0.8,
      executionCostBps: 120,
    },
    {
      requestedNotionalUsd: 1_000_000,
      maxCostBps: 200,
      executableUsd: 400_000,
      completionRatio: 0.4,
      executionCostBps: 180,
    },
  ]);
  const output = {
    status: knownStatus(routeEvidence.evidenceId, "exit.output.valuation"),
    kind: "fiat",
    assetKeys: ["fiat:USD"],
    basketWeights: [],
    valuation: {
      basis: "reviewed-par",
      referenceAssetKey: "fiat:USD",
      unitValueUsd: 1,
      expectedUnitValueUsd: 1,
      valueRetentionRatio: 1,
      sourceId: "route-source",
      sourceGenerationId: "valuation:g1",
      observedAtSec: routeEvidence.observedAtSec,
      asOfSec: AS_OF_SEC,
      confidence: "high",
      freshness: routeEvidence.freshness,
      evidenceRefIds: [routeEvidence.evidenceId],
    },
  };
  const routeDomains = order([
    { kind: "redemption-rail", key: "rail:issuer" },
    { kind: "output-asset", key: "fiat:USD" },
  ]);
  const dexRouteKey = canonicalV9RouteKey("dex", SOURCE_FINGERPRINTS.dex.generationId, "amm-main");
  const redemptionRouteKey = canonicalV9RouteKey(
    "redemption",
    SOURCE_FINGERPRINTS.redemption.generationId,
    "issuer-main",
  );

  return {
    assetId: "alpha",
    archetype: "fiat-cash",
    evidence: order([rejectedEvidence, routeEvidence, base]),
    gaps: [unsupportedGap],
    implementation: { status: knownStatus(), launchedAtSec: 100 },
    mechanismRiskReview: mechanismReview("fiat-cash"),
    dependencies: {
      status: knownStatus(),
      sourceGenerationId: SOURCE_FINGERPRINTS.liveReserves.generationId,
      source: "live-reserve",
      baseSource: "live-reserve",
      dependencyFromLive: true,
      mappedLiveReserveWeight: 0.4,
      fallbackReason: null,
      edges: order([
        {
          edgeKey: canonicalV9DependencyEdgeKey("collateral", "beta"),
          upstreamAssetId: "beta",
          dependencyType: "collateral",
          pathKind: "collateral-exposure",
          weight: 0.4,
          economicRole: "basket-exposure",
          evidenceRefIds: [base.evidenceId],
          failureDomains: [{ kind: "reserve-issuer", key: "issuer:beta" }],
        },
        {
          edgeKey: canonicalV9DependencyEdgeKey("mechanism", "gamma"),
          upstreamAssetId: "gamma",
          dependencyType: "mechanism",
          pathKind: "serial-dependency",
          weight: 1,
          economicRole: "serial-claim",
          evidenceRefIds: [base.evidenceId],
          failureDomains: [{ kind: "mint-control", key: "mechanism:gamma" }],
        },
      ]),
      diagnostics: { graphState: "valid", issueCodes: [], sccMemberAssetIds: [] },
    },
    reserveStatus: knownStatus(),
    reserveExposures: order([
      {
        exposureKey: "exposure:cash",
        classificationKey: "cash:issuer-a",
        sourceGenerationId: SOURCE_FINGERPRINTS.liveReserves.generationId,
        provenance: "live",
        status: knownStatus(),
        name: "Cash",
        weight: 0.6,
        trackedAssetId: null,
        assetClass: "cash",
        issuerOrObligorKey: "issuer:a",
        riskFactors: order(["custody", "counterparty"]),
        liquidityHorizon: "immediate",
        maturityDaysMax: 0,
        failureDomains: order([
          { kind: "reserve-custodian", key: "custodian:a" },
          { kind: "reserve-issuer", key: "issuer:a" },
        ]),
      },
      {
        exposureKey: "exposure:beta",
        classificationKey: "stablecoin:beta",
        sourceGenerationId: SOURCE_FINGERPRINTS.liveReserves.generationId,
        provenance: "live",
        status: knownStatus(),
        name: "Beta stablecoin",
        weight: 0.4,
        trackedAssetId: "beta",
        assetClass: "stablecoin",
        issuerOrObligorKey: "issuer:beta",
        riskFactors: ["credit"],
        liquidityHorizon: "one-day",
        maturityDaysMax: null,
        failureDomains: [{ kind: "reserve-issuer", key: "issuer:beta" }],
      },
    ]),
    exitStatus: knownStatus(),
    exitRoutes: order([
      {
        routeKey: dexRouteKey,
        routeId: "amm-main",
        lane: "dex",
        sourceGenerationId: SOURCE_FINGERPRINTS.dex.generationId,
        routeFamily: "dex-amm",
        holderAccess: "permissionless",
        executionModel: "market-depth",
        executionCertainty: "bounded",
        modelConfidence: "medium",
        observationConfidence: "high",
        evidenceKind: "reserve-based-amm-simulation",
        coverageClass: "exact-complete",
        settlementModel: "atomic",
        settlementSlaSec: null,
        settlementEvidenceRefIds: [routeEvidence.evidenceId],
        physicalResourceKeys: ["pool:fixture-main"],
        status: knownStatus(routeEvidence.evidenceId, "exit.route.current"),
        scoreEligible: true,
        request: { requestedNotionalUsd: 100_000, maxCostBps: 200, settlementHorizonSec: 300 },
        capacityCurve,
        output,
        failureDomains: order([
          { kind: "dex-protocol", key: "dex:fixture" },
          { kind: "chain", key: "chain:fixture" },
        ]),
      },
      {
        routeKey: redemptionRouteKey,
        routeId: "issuer-main",
        lane: "redemption",
        sourceGenerationId: SOURCE_FINGERPRINTS.redemption.generationId,
        routeFamily: "issuer-redemption",
        holderAccess: "retail-open",
        executionModel: "deterministic",
        executionCertainty: "guaranteed",
        modelConfidence: "high",
        observationConfidence: "high",
        evidenceKind: "documented-terms",
        coverageClass: "exact-complete",
        settlementModel: "same-day",
        settlementSlaSec: 86_400,
        settlementEvidenceRefIds: [routeEvidence.evidenceId],
        physicalResourceKeys: ["rail:issuer-main"],
        status: knownStatus(routeEvidence.evidenceId, "exit.route.current"),
        scoreEligible: true,
        request: { requestedNotionalUsd: 100_000, maxCostBps: 200, settlementHorizonSec: 300 },
        capacityCurve,
        output,
        failureDomains: routeDomains,
      },
      {
        routeKey: unsupportedRouteKey,
        routeId: "unsupported",
        lane: "dex",
        sourceGenerationId: SOURCE_FINGERPRINTS.dex.generationId,
        routeFamily: "dex-amm",
        holderAccess: "unknown",
        executionModel: "unknown",
        executionCertainty: "unknown",
        modelConfidence: "low",
        observationConfidence: "unknown",
        evidenceKind: "unobserved",
        coverageClass: "diagnostic",
        settlementModel: "unknown",
        settlementSlaSec: null,
        settlementEvidenceRefIds: [],
        physicalResourceKeys: [],
        status: unsupportedStatus,
        scoreEligible: false,
        request: null,
        capacityCurve: [],
        output: {
          status: unsupportedStatus,
          kind: "unknown",
          assetKeys: [],
          basketWeights: [],
          valuation: null,
        },
        failureDomains: [],
      },
    ]),
    controlStatus: knownStatus(),
    controls: order([
      {
        controlKey: "control:admin",
        deploymentKey: "deployment:ethereum",
        sourceGenerationId: SOURCE_FINGERPRINTS.researchOverlays.generationId,
        controlKind: "upgrade",
        scope: "global",
        status: knownStatus(),
        capabilities: order(["parameter-change", "upgrade"]),
        capSemantics: { kind: "raiseable", bound: { amount: 1, unit: "supply-fraction" } },
        claimImpairment: "unbounded",
        economicLossScope: "global-claim",
        authority: { authorityKey: "safe:admin", model: "multisig", threshold: { required: 2, total: 3 } },
        delaySec: 86_400,
        materialSupplyShare: 1,
        incidentState: "none",
        failureDomains: order([
          { kind: "upgrade-control", key: "safe:admin" },
          { kind: "chain", key: "chain:ethereum" },
        ]),
      },
      {
        controlKey: "control:minter",
        deploymentKey: "deployment:ethereum",
        sourceGenerationId: SOURCE_FINGERPRINTS.researchOverlays.generationId,
        controlKind: "mint",
        scope: "global",
        status: knownStatus(),
        capabilities: ["mint"],
        capSemantics: { kind: "bounded", bound: { amount: 10_000_000, unit: "token-units" } },
        claimImpairment: "bounded",
        economicLossScope: "global-claim",
        authority: { authorityKey: "governance:issuer", model: "governance", threshold: null },
        delaySec: 172_800,
        materialSupplyShare: 1,
        incidentState: "none",
        failureDomains: [{ kind: "mint-control", key: "governance:issuer" }],
      },
      {
        controlKey: "control:freezer",
        deploymentKey: "deployment:ethereum",
        sourceGenerationId: SOURCE_FINGERPRINTS.researchOverlays.generationId,
        controlKind: "freeze",
        scope: "deployment",
        status: knownStatus(),
        capabilities: ["freeze"],
        capSemantics: { kind: "not-applicable", bound: null },
        claimImpairment: "none",
        economicLossScope: "access-only",
        authority: { authorityKey: "safe:freezer", model: "multisig", threshold: { required: 2, total: 3 } },
        delaySec: 0,
        materialSupplyShare: 1,
        incidentState: "none",
        failureDomains: [{ kind: "mint-control", key: "safe:freezer" }],
      },
    ]),
    economicControlReview: {
      mint: {
        status: knownStatus("evidence:base", "control.mint.review"),
        controlKey: "control:minter",
        reconciliation: "continuous",
        upgrade: { state: "reviewed", controlKey: "control:admin" },
      },
      oracle: {
        status: notApplicableStatus("evidence:base", "control.oracle.not-applicable"),
        tier: null,
        branches: [],
      },
      bridge: {
        status: notApplicableStatus("evidence:base", "control.bridge.not-applicable"),
        routes: [],
      },
    },
    accessReview: accessReview("control:freezer"),
    peg: fixturePegFact(knownStatus(), SOURCE_FINGERPRINTS.peg.generationId),
    supply: {
      status: knownStatus(),
      sourceGenerationId: SOURCE_FINGERPRINTS.chainSupply.generationId,
      sourceKind: "usd-denominated-circulating",
      circulatingUnits: null,
      referencePriceUsd: null,
      circulatingUsd: 10_000_000,
      chainDistribution: {
        chains: [{ chainId: "chain:ethereum", supplyUsd: 10_000_000, supplyShare: 1 }],
        unattributedSupplyUsd: 0,
        unattributedSupplyShare: 0,
      },
      selectedBridgeRoutes: order([
        {
          deploymentRouteKey: "bridge:ethereum",
          supplyUsd: 8_000_000,
          supplyShare: 0.8,
          reviewState: "selected-reviewed",
        },
        {
          deploymentRouteKey: "bridge:base",
          supplyUsd: 2_000_000,
          supplyShare: 0.2,
          reviewState: "selected-unresolved",
        },
      ]),
      selectedRouteSupplyShare: 0.8,
      unknownRouteSupplyShare: 0,
      unreviewedRouteSupplyShare: 0.2,
      failureDomains: order([
        { kind: "chain", key: "chain:ethereum" },
        { kind: "bridge-route", key: "bridge:base" },
      ]),
    },
  };
}

export function coreFixture(reversed = false) {
  const assets = [fullAsset(reversed), minimalAsset("beta"), minimalAsset("gamma")];
  return {
    schemaVersion: 2,
    baseInputGenerationId: BASE_INPUT_GENERATION_ID,
    asOfSec: AS_OF_SEC,
    compiledAtSec: AS_OF_SEC + 1,
    sourceFingerprints: structuredClone(SOURCE_FINGERPRINTS),
    activeAssetIds: reversed ? ["gamma", "beta", "alpha"] : ["alpha", "beta", "gamma"],
    assets: reversed ? [...assets].reverse() : assets,
  };
}

export function completeEmptyCoreFixture() {
  const input = coreFixture();
  const asset = input.assets.find(
    (candidate) => candidate.assetId === "alpha",
  ) as unknown as V9AssetFactsV2;
  asset.exitRoutes = [];
  asset.gaps = asset.gaps.filter(
    (gap) => gap.ownerDomain !== "exit",
  );
  asset.evidence = asset.evidence.filter(
    (evidence) => evidence.evidenceId === "evidence:base",
  );
  return input;
}

export function nativeWrapperLocalFactsForFixture(asset: V9AssetFactsV2) {
  const wrapperEdge = asset.dependencies.edges.find(
    (edge) => edge.pathKind === "serial-dependency" && edge.dependencyType === "wrapper",
  );
  const form =
    asset.variantKind === "pure-wrapper"
      ? "pure"
      : asset.variantKind === "savings-passthrough" || asset.variantKind === "risk-absorption"
        ? "native-staked"
        : asset.variantKind === "strategy-vault" || wrapperEdge !== undefined
          ? "strategy-vault"
          : null;
  const evidenceRefIds = [
    ...new Set([
      ...asset.implementation.status.evidenceRefIds,
      ...asset.dependencies.status.evidenceRefIds,
      ...(wrapperEdge?.evidenceRefIds ?? []),
    ]),
  ].sort();
  if (form === null) {
    return { schemaVersion: 1 as const, applicability: "not-wrapper" as const, evidenceRefIds };
  }
  const unavailableFact = (factKey: string) => ({
    disposition: "integration-missing" as const,
    assessment: null,
    signals: [`fixture-wrapper-local-fact:${factKey}`],
    evidenceRefIds: [],
  });
  return {
    schemaVersion: 1 as const,
    applicability: "wrapper" as const,
    form,
    formDisposition: evidenceRefIds.length > 0 ? "reviewed" as const : "integration-missing" as const,
    formSignals: [`fixture-wrapper-form:${form}`],
    formEvidenceRefIds: evidenceRefIds,
    facts: Object.fromEntries(
      [
        "contractMutability",
        "custodyEscrow",
        "strategyComplexity",
        "leverage",
        "rehypothecationCorrelation",
        "shareAccountingNavOracle",
        "withdrawalTerms",
        "measuredUnwind",
        "lossAbsorptionEmergencyControls",
      ].map((factKey) => [factKey, unavailableFact(factKey)]),
    ),
    riskTransfer: {
      disposition: "integration-missing" as const,
      mechanism: "unknown" as const,
      maximumParentLossAbsorptionPoints: 0,
      signals: ["fixture-wrapper-risk-transfer"],
      evidenceRefIds: [],
    },
  };
}

export function compileNativeV3FactSet(input: ReturnType<typeof coreFixture>) {
  return compileV9FactSetV3({
    ...input,
    schemaVersion: 3,
    assets: input.assets.map((asset) => ({
      ...asset,
      dependencies: {
        ...asset.dependencies,
        edges: asset.dependencies.edges.map((edge) => ({
          ...edge,
          edgeKey: canonicalV9DependencyEdgeKey(
            edge.dependencyType as DependencyType,
            edge.upstreamAssetId,
            edge.economicRole as V9DependencyEconomicRole | undefined,
          ),
        })),
      },
      wrapperLocalFacts: nativeWrapperLocalFactsForFixture(asset as unknown as V9AssetFactsV2),
      gaps: asset.gaps.map(upgradeV9FactGapV2),
    })),
  });
}

export function nativeCompleteEmptyCoreFixture() {
  const native = structuredClone(compileNativeV3FactSet(completeEmptyCoreFixture()));
  const { v9FactSetDigest: _digest, ...core } = native;
  return core;
}
