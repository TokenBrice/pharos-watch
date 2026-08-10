import { describe, expect, it } from "vitest";
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

const AS_OF_SEC = 1_000;
const BASE_INPUT_GENERATION_ID = `report-cards-input:v1:${"a".repeat(64)}`;

function source(generationId: string, character: string) {
  return { generationId, payloadSha256: character.repeat(64), observedAtSec: 800 };
}

const SOURCE_FINGERPRINTS = {
  registry: source("registry:g1", "1"),
  dex: source("dex:g1", "2"),
  redemption: source("redemption:g1", "3"),
  liveReserves: source("reserves:g1", "4"),
  chainSupply: source("supply:g1", "5"),
  peg: source("peg:g1", "6"),
  researchOverlays: source("research:g1", "7"),
};

function publishedEvidence(evidenceId = "evidence:base") {
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

function knownStatus(evidenceId = "evidence:base", policyRuleId = "facts.required") {
  return createV9FactStatus({
    applicability: requiredV9Applicability(policyRuleId),
    observationState: "known",
    evidenceRefIds: [evidenceId],
  });
}

function notApplicableStatus(evidenceId = "evidence:base", policyRuleId = "facts.not-applicable") {
  return createV9FactStatus({
    applicability: notApplicableV9Fact(policyRuleId, "Reviewed as not applicable for this fixture archetype."),
    observationState: "known",
    evidenceRefIds: [evidenceId],
  });
}

function mechanismFact() {
  return {
    status: knownStatus("evidence:base", "backing.mechanism.review"),
    quality: "strong" as const,
    failureDomains: [{ kind: "reserve-issuer" as const, key: "mechanism:fixture" }],
  };
}

function mechanismReview(archetype: "algorithmic" | "fiat-cash") {
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

function noEconomicControlReview() {
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

function accessReview(freezeControlKey: string | null = null) {
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

function minimalAsset(assetId: string) {
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

function fullAsset(reversed: boolean) {
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
    peg: {
      status: knownStatus(),
      pegKey: "peg:usd",
      sourceGenerationId: SOURCE_FINGERPRINTS.peg.generationId,
      referenceKind: "fiat",
      referenceKey: "USD",
      methodologyVersion: "fixture-peg-v1",
      pegScore: 99,
      currentDeviationBps: 1,
      activeDepeg: false,
      activeDepegBps: null,
      trackingSpanDays: 365,
      failureDomains: [{ kind: "oracle-feed", key: "oracle:usd" }],
    },
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

function coreFixture(reversed = false) {
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

function completeEmptyCoreFixture() {
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

function nativeWrapperLocalFactsForFixture(asset: V9AssetFactsV2) {
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

function compileNativeV3FactSet(input: ReturnType<typeof coreFixture>) {
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

function nativeCompleteEmptyCoreFixture() {
  const native = structuredClone(compileNativeV3FactSet(completeEmptyCoreFixture()));
  const { v9FactSetDigest: _digest, ...core } = native;
  return core;
}

describe("Safety Score v9 normalized fact protocol", () => {
  it("attributes a missing parent score to the parent's causal NR owner", () => {
    const input = coreFixture();
    const parent = input.assets.find((asset) => asset.assetId === "gamma")! as unknown as V9AssetFactsV2;
    const grandparent = minimalAsset("delta");
    const grandparentFacts = grandparent as unknown as V9AssetFactsV2;
    const parentGap = createV9FactGap({
      gapId: "gamma:gap:missing-archetype",
      reasonCode: "missing-archetype",
      ownerDomain: "backing",
      policyRuleId: "backing.archetype.review",
      observationState: "missing",
      path: { kind: "local-component", componentKey: "mechanism-archetype" },
      message: "The mechanism archetype is unresolved.",
    });
    const grandparentGap = createV9FactGap({
      gapId: "delta:gap:missing-archetype",
      reasonCode: "missing-archetype",
      ownerDomain: "backing",
      policyRuleId: "backing.archetype.review",
      observationState: "missing",
      path: { kind: "local-component", componentKey: "mechanism-archetype" },
      message: "The upstream mechanism archetype is unresolved.",
    });
    parent.archetype = "unresolved";
    parent.gaps = [parentGap];
    parent.mechanismRiskReview = {
      status: createV9FactStatus({
        applicability: requiredV9Applicability("backing.archetype.review"),
        observationState: "missing",
        gapIds: [parentGap.gapId],
      }),
      review: null,
    };
    parent.dependencies = {
      status: knownStatus(),
      sourceGenerationId: SOURCE_FINGERPRINTS.researchOverlays.generationId,
      source: "manual",
      baseSource: "manual",
      dependencyFromLive: false,
      mappedLiveReserveWeight: null,
      fallbackReason: null,
      edges: [
        {
          edgeKey: canonicalV9DependencyEdgeKey("mechanism", "delta"),
          upstreamAssetId: "delta",
          dependencyType: "mechanism",
          pathKind: "serial-dependency",
          weight: 1,
          economicRole: "serial-claim",
          evidenceRefIds: ["evidence:base"],
          failureDomains: [
            { kind: "mint-control", key: "mechanism:delta" },
          ],
        },
      ],
      diagnostics: {
        graphState: "valid",
        issueCodes: [],
        sccMemberAssetIds: [],
      },
    };
    grandparentFacts.archetype = "unresolved";
    grandparentFacts.gaps = [grandparentGap];
    grandparentFacts.mechanismRiskReview = {
      status: createV9FactStatus({
        applicability: requiredV9Applicability("backing.archetype.review"),
        observationState: "missing",
        gapIds: [grandparentGap.gapId],
      }),
      review: null,
    };
    input.assets.push(grandparent);
    input.activeAssetIds.push("delta");

    const evaluated = evaluateV9FactSet(compileNativeV3FactSet(input), V9_CANDIDATE_POLICY_V1);
    const missingParentReasons = evaluated.assets
      .find((asset) => asset.assetId === "alpha")!
      .scoreInput.dependencyReasons.filter(
        (reason) => reason.code === "missing-parent-score",
      );
    expect(
      missingParentReasons.map((reason) => reason.responsibility),
    ).toContain("method-unsupported");
    expect(missingParentReasons).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path:
            "dependency:serial:gamma:cause:asset%3Amissing-pillar%3Apillars.backing",
        }),
        expect.objectContaining({
          path:
            "dependency:serial:gamma:cause:asset%3Adelta%3Amissing-pillar%3Apillars.backing",
        }),
      ]),
    );
  });

  it("attributes a derived oracle reason to the exact reviewed disclosure gap", () => {
    const native = structuredClone(compileNativeV3FactSet(coreFixture()));
    const { v9FactSetDigest: _digest, ...core } = native;
    const alpha = core.assets.find(
      (asset) => asset.assetId === "alpha",
    ) as V9AssetFactsV3;
    const gap = createV9FactGapV3({
      gapId: "alpha:gap:economic-control:oracle",
      reasonCode: "missing-oracle-profile",
      ownerDomain: "control",
      policyRuleId: "control.oracle.review",
      observationState: "bounded-unknown",
      path: {
        kind: "local-component",
        componentKey: "economic-control:oracle",
      },
      message: "The issuer review does not disclose a complete oracle profile.",
      evidenceRefIds: ["evidence:base"],
      responsibility: "issuer-undisclosed",
    });
    alpha.gaps.push(gap);
    alpha.economicControlReview.oracle = {
      status: createV9FactStatus({
        applicability: requiredV9Applicability("control.oracle.review"),
        observationState: "bounded-unknown",
        evidenceRefIds: ["evidence:base"],
        gapIds: [gap.gapId],
      }),
      tier: null,
      branches: [],
    };

    const evaluated = evaluateV9FactSet(
      compileV9FactSetV3(core),
      V9_CANDIDATE_POLICY_V1,
    );
    const reasons = evaluated.assets.find(
      (asset) => asset.assetId === "alpha",
    )!.scoreInput.pillars.control.reasons;

    expect(reasons).toContainEqual(
      expect.objectContaining({
        code: "incomplete-oracle-liquidation-branch",
        path:
          "control:oracle:cause:alpha%3Agap%3Aeconomic-control%3Aoracle",
        responsibility: "issuer-undisclosed",
      }),
    );
    expect(
      reasons.some(
        (reason) =>
          reason.code === "incomplete-oracle-liquidation-branch" &&
          reason.responsibility === "integration-missing",
      ),
    ).toBe(false);
  });

  it("scopes a control-specific reason before considering aggregate control gaps", () => {
    const native = structuredClone(compileNativeV3FactSet(coreFixture()));
    const { v9FactSetDigest: _digest, ...core } = native;
    const alpha = core.assets.find(
      (asset) => asset.assetId === "alpha",
    ) as V9AssetFactsV3;
    const admin = alpha.controls.find(
      (control) => control.controlKey === "control:admin",
    )!;
    admin.controlKind = "governance";
    const controlGap = createV9FactGapV3({
      gapId: "alpha:gap:deployment-control:admin",
      reasonCode: "unresolved-control-identity",
      ownerDomain: "control",
      policyRuleId: "control.deployment.review",
      observationState: "bounded-unknown",
      path: {
        kind: "local-component",
        componentKey: "control:control:admin",
      },
      message: "The issuer has not disclosed the admin control semantics.",
      evidenceRefIds: ["evidence:base"],
      responsibility: "issuer-undisclosed",
    });
    const aggregateGap = createV9FactGapV3({
      gapId: "alpha:gap:deployment-controls",
      reasonCode: "unresolved-control-identity",
      ownerDomain: "control",
      policyRuleId: "control.inventory.review",
      observationState: "bounded-unknown",
      path: {
        kind: "local-component",
        componentKey: "deployment-controls",
      },
      message: "The producer cannot reconcile the aggregate control inventory.",
      evidenceRefIds: ["evidence:base"],
      responsibility: "producer-failed",
    });
    alpha.gaps.push(controlGap, aggregateGap);
    admin.status = createV9FactStatus({
      applicability: requiredV9Applicability("control.deployment.review"),
      observationState: "bounded-unknown",
      evidenceRefIds: ["evidence:base"],
      gapIds: [controlGap.gapId],
    });
    alpha.controlStatus = createV9FactStatus({
      applicability: requiredV9Applicability("control.inventory.review"),
      observationState: "bounded-unknown",
      evidenceRefIds: ["evidence:base"],
      gapIds: [aggregateGap.gapId],
    });

    const evaluated = evaluateV9FactSet(
      compileV9FactSetV3(core),
      V9_CANDIDATE_POLICY_V1,
    );
    const controlSpecific = evaluated.assets
      .find((asset) => asset.assetId === "alpha")!
      .scoreInput.pillars.control.reasons.filter(
        (reason) =>
          reason.code === "unresolved-control-identity" &&
          reason.path ===
            "control:control:control:admin:cause:alpha%3Agap%3Adeployment-control%3Aadmin",
      );

    expect(controlSpecific).toHaveLength(1);
    expect(controlSpecific[0]!.responsibility).toBe("issuer-undisclosed");
  });

  it("keeps mixed upstream backing owners on distinct causal score paths", () => {
    const native = structuredClone(compileNativeV3FactSet(coreFixture()));
    const { v9FactSetDigest: _digest, ...core } = native;
    const beta = core.assets.find(
      (asset) => asset.assetId === "beta",
    ) as V9AssetFactsV3;
    const issuerGap = createV9FactGapV3({
      gapId: "beta:gap:mechanism-archetype:z-issuer",
      reasonCode: "missing-archetype",
      ownerDomain: "backing",
      policyRuleId: "backing.archetype.review",
      observationState: "missing",
      path: {
        kind: "local-component",
        componentKey: "mechanism-archetype:issuer",
      },
      message: "The issuer has not disclosed the mechanism archetype.",
      evidenceRefIds: ["evidence:base"],
      responsibility: "issuer-undisclosed",
    });
    const producerGap = createV9FactGapV3({
      gapId: "beta:gap:mechanism-archetype:a-producer",
      reasonCode: "missing-archetype",
      ownerDomain: "backing",
      policyRuleId: "backing.archetype.review",
      observationState: "missing",
      path: {
        kind: "local-component",
        componentKey: "mechanism-archetype:producer",
      },
      message: "The current producer capture cannot resolve the mechanism archetype.",
      evidenceRefIds: ["evidence:base"],
      responsibility: "producer-failed",
    });
    beta.archetype = "unresolved";
    beta.gaps = [issuerGap, producerGap];
    beta.mechanismRiskReview = {
      status: createV9FactStatus({
        applicability: requiredV9Applicability("backing.archetype.review"),
        observationState: "missing",
        evidenceRefIds: ["evidence:base"],
        gapIds: [issuerGap.gapId, producerGap.gapId],
      }),
      review: null,
    };

    const singleRootCore = structuredClone(core);
    const singleRootBeta = singleRootCore.assets.find(
      (asset) => asset.assetId === "beta",
    ) as V9AssetFactsV3;
    singleRootBeta.gaps = [issuerGap];
    singleRootBeta.mechanismRiskReview.status = createV9FactStatus({
      applicability: requiredV9Applicability("backing.archetype.review"),
      observationState: "missing",
      evidenceRefIds: ["evidence:base"],
      gapIds: [issuerGap.gapId],
    });
    const singleRootEvaluation = evaluateV9FactSet(
      compileV9FactSetV3(singleRootCore),
      V9_CANDIDATE_POLICY_V1,
    );
    const singleRootReasons = singleRootEvaluation.assets
      .find((asset) => asset.assetId === "alpha")!
      .scoreInput.pillars.backing.reasons.filter(
        (reason) => reason.code === "material-dependency-unavailable",
      );
    const evaluated = evaluateV9FactSet(
      compileV9FactSetV3(core),
      V9_CANDIDATE_POLICY_V1,
    );
    const reasons = evaluated.assets
      .find((asset) => asset.assetId === "alpha")!
      .scoreInput.pillars.backing.reasons.filter(
        (reason) => reason.code === "material-dependency-unavailable",
      );
    const singleDirectIssuerReason = singleRootEvaluation.assets
      .find((asset) => asset.assetId === "beta")!
      .scoreInput.pillars.backing.reasons.find(
        (reason) =>
          reason.code === "missing-archetype" &&
          reason.responsibility === "issuer-undisclosed",
      );
    const mixedDirectIssuerReason = evaluated.assets
      .find((asset) => asset.assetId === "beta")!
      .scoreInput.pillars.backing.reasons.find(
        (reason) =>
          reason.code === "missing-archetype" &&
          reason.responsibility === "issuer-undisclosed",
      );

    const singleIssuerReason = singleRootReasons.find(
      (reason) => reason.responsibility === "issuer-undisclosed",
    );
    const mixedIssuerReason = reasons.find(
      (reason) => reason.responsibility === "issuer-undisclosed",
    );
    expect(singleIssuerReason?.path).toContain(
      ":cause:upstream%3Abeta%3Amissing-archetype",
    );
    expect(mixedIssuerReason?.path).toBe(singleIssuerReason?.path);
    expect(mixedDirectIssuerReason?.path).toBe(singleDirectIssuerReason?.path);
    expect(reasons.map((reason) => reason.responsibility)).toEqual(
      expect.arrayContaining(["issuer-undisclosed", "producer-failed"]),
    );
    expect(new Set(reasons.map((reason) => reason.path)).size).toBe(2);
    expect(
      reasons.some((reason) => reason.path.includes(":cause:upstream%3Abeta%3A")),
    ).toBe(true);
  });

  it("defaults retained v2 fact routes without modeled confidence to low", () => {
    const retained = structuredClone(coreFixture());
    const route = retained.assets[0]!.exitRoutes.find((candidate) => candidate.routeId === "amm-main")!;
    delete (route as unknown as Record<string, unknown>).modelConfidence;

    const compiled = compileV9FactSetV2(retained);
    expect(compiled.assets[0]!.exitRoutes.find((candidate) => candidate.routeId === "amm-main")).toMatchObject({
      modelConfidence: "low",
    });
  });

  it("canonicalizes every ordered identity surface and produces a permutation-stable digest", () => {
    const ordered = compileV9FactSetV2(coreFixture(false));
    const reversed = compileV9FactSetV2(coreFixture(true));

    expect(reversed).toEqual(ordered);
    expect(ordered.activeAssetIds).toEqual(["alpha", "beta", "gamma"]);
    expect(ordered.assets.map((asset) => asset.assetId)).toEqual(["alpha", "beta", "gamma"]);
    const alpha = ordered.assets[0]!;
    expect(alpha.evidence.map((reference) => reference.evidenceId)).toEqual([
      "evidence:base",
      "evidence:rejected-route",
      "evidence:route",
    ]);
    expect(alpha.dependencies.edges.map((edge) => edge.edgeKey)).toEqual(["collateral:beta", "mechanism:gamma"]);
    expect(alpha.reserveExposures.map((exposure) => exposure.exposureKey)).toEqual(["exposure:beta", "exposure:cash"]);
    expect(alpha.controls.map((control) => control.controlKey)).toEqual([
      "control:admin",
      "control:freezer",
      "control:minter",
    ]);
    expect(alpha.exitRoutes.map((route) => route.routeKey)).toEqual(
      [...alpha.exitRoutes.map((route) => route.routeKey)].sort(),
    );
    expect(alpha.controls[0]!.failureDomains.map((domain) => `${domain.kind}:${domain.key}`)).toEqual([
      "chain:chain:ethereum",
      "upgrade-control:safe:admin",
    ]);

    expect(evaluateV9FactSet(compileNativeV3FactSet(coreFixture(true)), V9_CANDIDATE_POLICY_V1)).toEqual(
      evaluateV9FactSet(compileNativeV3FactSet(coreFixture(false)), V9_CANDIDATE_POLICY_V1),
    );
  });

  it("inherits verified live wrapper backing monotonically without escaping the parent cap", () => {
    const evaluateWithParentQuality = (quality: "adequate" | "strong", parentWeight = 1) => {
      const input = coreFixture();
      const child = input.assets[1]! as unknown as V9AssetFactsV2;
      const parent = input.assets[2]! as unknown as V9AssetFactsV2;
      child.assetId = "child";
      parent.assetId = "parent";
      child.variantKind = "savings-passthrough";
      child.reserveStatus = knownStatus("evidence:base", "backing.wrapper-live-parent");
      child.reserveExposures = [
        {
          exposureKey: "exposure:parent",
          classificationKey: "stablecoin:parent",
          sourceGenerationId: SOURCE_FINGERPRINTS.liveReserves.generationId,
          provenance: "live",
          status: knownStatus("evidence:base", "backing.wrapper-live-parent"),
          name: "Parent stablecoin",
          weight: parentWeight,
          trackedAssetId: parent.assetId,
          assetClass: "protocol-position",
          issuerOrObligorKey: "asset:parent",
          riskFactors: ["counterparty"],
          liquidityHorizon: "immediate",
          maturityDaysMax: null,
          failureDomains: [{ kind: "reserve-issuer", key: "asset:parent" }],
        },
      ];
      child.dependencies = {
        status: knownStatus("evidence:base", "dependencies.wrapper-parent"),
        sourceGenerationId: SOURCE_FINGERPRINTS.liveReserves.generationId,
        source: "variant",
        baseSource: "live-reserve",
        dependencyFromLive: true,
        mappedLiveReserveWeight: parentWeight,
        fallbackReason: null,
        edges: [
          {
            edgeKey: canonicalV9DependencyEdgeKey("wrapper", parent.assetId),
            upstreamAssetId: parent.assetId,
            dependencyType: "wrapper",
            pathKind: "serial-dependency",
            weight: 1,
            economicRole: "serial-claim",
            evidenceRefIds: ["evidence:base"],
            failureDomains: [{ kind: "mint-control", key: "asset:parent" }],
          },
        ],
        diagnostics: { graphState: "valid", issueCodes: [], sccMemberAssetIds: [] },
      };
      const parentReview = parent.mechanismRiskReview.review;
      if (parentReview === null || parentReview.archetype !== "algorithmic") {
        throw new Error("Expected algorithmic parent fixture");
      }
      for (const component of [
        parentReview.contractionCapacity,
        parentReview.confidenceAndIncentives,
        parentReview.oracleAndControlAssumptions,
        parentReview.emergencyRecovery,
        parentReview.lossRecovery,
      ]) {
        component.quality = quality;
      }
      input.activeAssetIds = [child.assetId, parent.assetId];
      input.assets = [child as never, parent as never];

      const evaluated = evaluateV9FactSet(compileNativeV3FactSet(input), V9_CANDIDATE_POLICY_V1);
      return {
        child: evaluated.assets.find((asset) => asset.assetId === child.assetId)!,
        parent: evaluated.assets.find((asset) => asset.assetId === parent.assetId)!,
      };
    };

    const adequate = evaluateWithParentQuality("adequate");
    const strong = evaluateWithParentQuality("strong");
    const belowThreshold = evaluateWithParentQuality("strong", 0.98);
    for (const result of [adequate, strong]) {
      expect(result.child.backing.score).toBeCloseTo(result.parent.backing.score!, 12);
      expect(result.child.backing.contributions).toContainEqual(
        expect.objectContaining({
          componentKey: "reserve:inherited-backing:parent",
          observationState: "known",
          provenance: "live",
        }),
      );
      expect(result.child.backing.contributions.some((entry) => entry.source === "mechanism")).toBe(false);
      expect(result.child.trace.finalScore).toBeLessThanOrEqual(result.parent.trace.finalScore!);
    }
    expect(strong.child.backing.score!).toBeGreaterThan(adequate.child.backing.score!);
    expect(
      belowThreshold.child.backing.contributions.some((entry) =>
        entry.componentKey.startsWith("reserve:inherited-backing:"),
      ),
    ).toBe(false);
    expect(belowThreshold.child.backing.contributions.some((entry) => entry.source === "mechanism")).toBe(true);
  });

  it("deduplicates overlapping DEX physical resources before applying common-mode materiality", () => {
    const input = coreFixture();
    const alpha = input.assets[0]! as unknown as V9AssetFactsV2;
    const delta = structuredClone(alpha);
    delta.assetId = "delta";
    input.activeAssetIds.push(delta.assetId);
    input.assets.push(delta as never);

    for (const asset of [alpha, delta]) {
      const primary = asset.exitRoutes.find((route) => route.routeId === "amm-main")!;
      primary.capacityCurve = primary.capacityCurve.map((point) => ({
        ...point,
        executableUsd: 30_000,
        completionRatio: 30_000 / point.requestedNotionalUsd,
      }));
    }

    const primary = alpha.exitRoutes.find((route) => route.routeId === "amm-main")!;
    const projected = projectV9ExitEvaluationRoute(primary);
    const overlappingRoute = (routeKey: string, executableUsd: number, physicalResourceKeys: string[]) => ({
      ...projected,
      routeKey,
      physicalResourceKeys,
      capacityCurve: projected.capacityCurve.map((point) => {
        const executableAtPoint = Math.min(executableUsd, point.requestedNotionalUsd);
        return {
          ...point,
          executableUsd: executableAtPoint,
          completionRatio: executableAtPoint / point.requestedNotionalUsd,
        };
      }),
    });
    expect(
      resolveV9DistinctExitCapacity(
        [
          overlappingRoute("route:a", 20_000, ["resource:a"]),
          overlappingRoute("route:b", 30_000, ["resource:a", "resource:b"]),
          overlappingRoute("route:c", 40_000, ["resource:b"]),
        ],
        {
          requestedNotionalUsd: 1_000_000,
          maxCostBps: 200,
          comparisonWindowSec: 300,
          rawSupplyRequestUsd: 1_000_000,
        },
        V9_CANDIDATE_POLICY_V1,
      ).valuedExecutableUsd,
    ).toBe(40_000);

    const evaluated = evaluateV9FactSet(compileNativeV3FactSet(input), V9_CANDIDATE_POLICY_V1);
    for (const assetId of ["alpha", "delta"]) {
      const signal = evaluated.assets
        .find((asset) => asset.assetId === assetId)!
        .scoreInput.dependencyStructuralSignals.find((candidate) =>
          candidate.failureDomainKeys.includes("dex-protocol:dex:fixture"),
        );
      expect(signal).toMatchObject({ kind: "critical-dependency", severity: "low" });
    }
  });

  it("qualifies DEX common-mode groups with score-bearing routes only", () => {
    const evaluateSharedDex = (alphaEligible: boolean, deltaEligible: boolean) => {
      const input = coreFixture();
      const alpha = input.assets[0]! as unknown as V9AssetFactsV2;
      const delta = structuredClone(alpha);
      delta.assetId = "delta";
      input.activeAssetIds.push(delta.assetId);
      input.assets.push(delta as never);
      for (const [asset, eligible] of [
        [alpha, alphaEligible],
        [delta, deltaEligible],
      ] as const) {
        if (eligible) continue;
        const route = asset.exitRoutes.find((candidate) => candidate.routeId === "amm-main")!;
        route.coverageClass = "diagnostic";
        route.scoreEligible = false;
      }
      return evaluateV9FactSet(compileNativeV3FactSet(input), V9_CANDIDATE_POLICY_V1);
    };
    const dexSignal = (evaluated: ReturnType<typeof evaluateV9FactSet>, assetId: string) =>
      evaluated.assets
        .find((asset) => asset.assetId === assetId)!
        .scoreInput.dependencyStructuralSignals.find((signal) =>
          signal.failureDomainKeys.includes("dex-protocol:dex:fixture"),
        );

    const diagnosticOnly = evaluateSharedDex(false, false);
    expect(dexSignal(diagnosticOnly, "alpha")).toBeUndefined();
    expect(dexSignal(diagnosticOnly, "delta")).toBeUndefined();

    const oneEligible = evaluateSharedDex(true, false);
    expect(dexSignal(oneEligible, "alpha")).toBeUndefined();
    expect(dexSignal(oneEligible, "delta")).toBeUndefined();

    const twoEligible = evaluateSharedDex(true, true);
    expect(dexSignal(twoEligible, "alpha")).toMatchObject({
      severity: "high",
      responsibility: "measured-adverse",
    });
    expect(dexSignal(twoEligible, "delta")).toMatchObject({
      severity: "high",
      responsibility: "measured-adverse",
    });
  });

  it("joins dependency-owned mint-control groups through asset issuer identity", () => {
    const evaluateSharedMint = (betaIssuer: string | null, gammaIssuer: string | null) => {
      const input = coreFixture();
      const beta = input.assets[1]! as unknown as V9AssetFactsV2;
      const gamma = input.assets[2]! as unknown as V9AssetFactsV2;
      for (const [asset, issuer] of [
        [beta, betaIssuer],
        [gamma, gammaIssuer],
      ] as const) {
        asset.assetIssuerKey = issuer;
        asset.dependencies = {
          status: knownStatus(),
          sourceGenerationId: SOURCE_FINGERPRINTS.researchOverlays.generationId,
          source: "manual",
          baseSource: "manual",
          dependencyFromLive: false,
          mappedLiveReserveWeight: null,
          fallbackReason: null,
          edges: [
            {
              edgeKey: canonicalV9DependencyEdgeKey("mechanism", "alpha"),
              upstreamAssetId: "alpha",
              dependencyType: "mechanism",
              pathKind: "serial-dependency",
              weight: 1,
              economicRole: "serial-claim",
              evidenceRefIds: ["evidence:base"],
              failureDomains: [{ kind: "mint-control", key: "shared:dependency-minter" }],
            },
          ],
          diagnostics: { graphState: "valid", issueCodes: [], sccMemberAssetIds: [] },
        };
      }
      return evaluateV9FactSet(compileNativeV3FactSet(input), V9_CANDIDATE_POLICY_V1);
    };
    const signal = (evaluated: ReturnType<typeof evaluateV9FactSet>, assetId: string) =>
      evaluated.assets
        .find((asset) => asset.assetId === assetId)!
        .scoreInput.dependencyStructuralSignals.find((candidate) =>
          candidate.failureDomainKeys.includes("mint-control:shared:dependency-minter"),
        );

    const sameIssuer = evaluateSharedMint("issuer:shared", "issuer:shared");
    expect(signal(sameIssuer, "beta")).toMatchObject({ severity: "low" });
    expect(signal(sameIssuer, "gamma")).toMatchObject({ severity: "low" });

    const crossIssuer = evaluateSharedMint("issuer:shared", "issuer:other");
    expect(signal(crossIssuer, "beta")).toMatchObject({
      severity: "high",
      responsibility: "measured-adverse",
    });
    expect(signal(crossIssuer, "gamma")).toMatchObject({
      severity: "high",
      responsibility: "measured-adverse",
    });

    const unresolved = evaluateSharedMint("issuer:shared", null);
    expect(signal(unresolved, "beta")).toMatchObject({
      severity: "high",
      responsibility: "integration-missing",
    });
    expect(signal(unresolved, "gamma")).toMatchObject({
      severity: "high",
      responsibility: "integration-missing",
    });
  });

  it("derives bridge share bounds through reviewed control and deployment joins", () => {
    type BridgeJoinVariant =
      | "known"
      | "aggregate-mismatch"
      | "contradictory-share"
      | "missing-capability"
      | "null-control-share"
      | "same-domain-epsilon-no-row"
      | "same-domain-invalid"
      | "same-domain-null-no-row"
      | "same-domain-zero-no-row"
      | "separate-domain-unjoined"
      | "supply-mismatch"
      | "stale-control"
      | "stale-review"
      | "unmatched"
      | "wrong-kind";
    const evaluateBridgeSignal = (
      targetShare: number,
      variant: BridgeJoinVariant = "known",
      requestedDomainKey = "protocol:fixture-bridge",
    ) => {
      const input = coreFixture();
      const alpha = input.assets[0]! as unknown as V9AssetFactsV2;
      const delta = structuredClone(alpha);
      delta.assetId = "delta";
      input.activeAssetIds.push(delta.assetId);
      input.assets.push(delta as never);

      for (const asset of [alpha, delta]) {
        const targetDomain = { kind: "bridge-route" as const, key: "protocol:fixture-bridge" };
        const nativeDomain = {
          kind: "bridge-route" as const,
          key: variant === "separate-domain-unjoined" ? "bridge:native" : `native:${asset.assetId}`,
        };
        const controlTemplate = asset.controls.find((control) => control.controlKey === "control:minter")!;
        const targetControl: V9AssetFactsV2["controls"][number] = {
          ...structuredClone(controlTemplate),
          controlKey: "control:bridge-target",
          deploymentKey: "bridge:target",
          controlKind: variant === "wrong-kind" ? "mint" : "bridge",
          scope: "deployment",
          capabilities: variant === "missing-capability" ? [] : ["bridge-mint"],
          materialSupplyShare:
            variant === "null-control-share" ? null : variant === "contradictory-share" ? 1 : targetShare,
          failureDomains: [targetDomain],
        };
        const nativeControl: V9AssetFactsV2["controls"][number] = {
          ...structuredClone(controlTemplate),
          controlKey: "control:bridge-native",
          deploymentKey: "bridge:native",
          controlKind: "bridge",
          scope: "deployment",
          capabilities: ["bridge-mint"],
          materialSupplyShare: 1 - targetShare,
          failureDomains: [nativeDomain],
        };
        const sameDomainMissingRow = [
          "same-domain-epsilon-no-row",
          "same-domain-invalid",
          "same-domain-null-no-row",
          "same-domain-zero-no-row",
        ].includes(variant);
        const invalidSameDomainControl: V9AssetFactsV2["controls"][number] | null = sameDomainMissingRow
          ? {
              ...structuredClone(controlTemplate),
              controlKey: "control:bridge-invalid",
              deploymentKey: "bridge:invalid",
              controlKind: "bridge",
              scope: "deployment",
              capabilities: ["bridge-mint"],
              materialSupplyShare:
                variant === "same-domain-zero-no-row"
                  ? 0
                  : variant === "same-domain-null-no-row"
                    ? null
                    : variant === "same-domain-epsilon-no-row"
                      ? Number.EPSILON
                      : targetShare,
              failureDomains: [targetDomain],
            }
          : null;
        if (variant === "stale-control") {
          const staleEvidence = createV9EvidenceReference(
            {
              evidenceId: `evidence:stale-bridge-control:${asset.assetId}`,
              sourceId: "bridge-control-source",
              sourceGenerationId: SOURCE_FINGERPRINTS.researchOverlays.generationId,
              disposition: "published",
              observedAtSec: 600,
              publishedAtSec: 610,
              maxAgeSec: 100,
            },
            AS_OF_SEC,
          );
          const staleGap = createV9FactGap({
            gapId: `gap:stale-bridge-control:${asset.assetId}`,
            reasonCode: "selected-bridge-route-unresolved",
            ownerDomain: "control",
            policyRuleId: "control.bridge.current",
            observationState: "stale",
            path: {
              kind: "deployment-control",
              deploymentKey: targetControl.deploymentKey,
              controlKey: targetControl.controlKey,
            },
            message: "The bridge control review is stale.",
            evidenceRefIds: [staleEvidence.evidenceId],
          });
          asset.evidence.push(staleEvidence);
          asset.gaps.push(staleGap);
          targetControl.status = createV9FactStatus({
            applicability: requiredV9Applicability("control.bridge.current"),
            observationState: "stale",
            evidenceRefIds: [staleEvidence.evidenceId],
            gapIds: [staleGap.gapId],
          });
        }
        asset.controls.push(
          targetControl,
          ...(variant === "separate-domain-unjoined" ? [] : [nativeControl]),
          ...(invalidSameDomainControl === null ? [] : [invalidSameDomainControl]),
        );
        const targetUsesLowRiskTier = sameDomainMissingRow || variant === "separate-domain-unjoined";
        asset.economicControlReview.bridge = {
          status: knownStatus("evidence:base", "control.bridge.review"),
          routes: [
            {
              controlKey: targetControl.controlKey,
              tier: targetUsesLowRiskTier ? "external-validated-network" : "opaque-or-unknown",
            },
            ...(variant === "separate-domain-unjoined"
              ? []
              : [{ controlKey: nativeControl.controlKey, tier: "single-chain-or-native" as const }]),
            ...(invalidSameDomainControl === null
              ? []
              : [{ controlKey: invalidSameDomainControl.controlKey, tier: "canonical-rollup-bridge" as const }]),
          ],
        };
        if (variant === "stale-review") {
          const staleEvidence = createV9EvidenceReference(
            {
              evidenceId: `evidence:stale-bridge-review:${asset.assetId}`,
              sourceId: "bridge-review-source",
              sourceGenerationId: SOURCE_FINGERPRINTS.researchOverlays.generationId,
              disposition: "published",
              observedAtSec: 600,
              publishedAtSec: 610,
              maxAgeSec: 100,
            },
            AS_OF_SEC,
          );
          const staleGap = createV9FactGap({
            gapId: `gap:stale-bridge-review:${asset.assetId}`,
            reasonCode: "selected-bridge-route-unresolved",
            ownerDomain: "control",
            policyRuleId: "control.bridge.review.current",
            observationState: "stale",
            path: {
              kind: "deployment-control",
              deploymentKey: targetControl.deploymentKey,
              controlKey: targetControl.controlKey,
            },
            message: "The bridge review envelope is stale.",
            evidenceRefIds: [staleEvidence.evidenceId],
          });
          asset.evidence.push(staleEvidence);
          asset.gaps.push(staleGap);
          asset.economicControlReview.bridge.status = createV9FactStatus({
            applicability: requiredV9Applicability("control.bridge.review.current"),
            observationState: "stale",
            evidenceRefIds: [staleEvidence.evidenceId],
            gapIds: [staleGap.gapId],
          });
        }
        asset.supply.selectedBridgeRoutes = [
          {
            deploymentRouteKey: variant === "unmatched" ? "bridge:unmatched" : targetControl.deploymentKey,
            supplyUsd: (variant === "supply-mismatch" ? 9_000_000 : 10_000_000) * targetShare,
            supplyShare: targetShare,
            reviewState: "selected-reviewed",
          },
          {
            deploymentRouteKey: nativeControl.deploymentKey,
            supplyUsd: 10_000_000 * (1 - targetShare),
            supplyShare: 1 - targetShare,
            reviewState: "selected-reviewed",
          },
        ];
        asset.supply.selectedRouteSupplyShare = variant === "aggregate-mismatch" ? 0.99 : 1;
        asset.supply.unknownRouteSupplyShare = 0;
        asset.supply.unreviewedRouteSupplyShare = 0;
        asset.supply.failureDomains.push(targetDomain, nativeDomain);
      }

      const evaluated = evaluateV9FactSet(compileNativeV3FactSet(input), V9_CANDIDATE_POLICY_V1);
      return evaluated.assets
        .find((asset) => asset.assetId === "alpha")!
        .scoreInput.dependencyStructuralSignals.find((signal) =>
          signal.failureDomainKeys.includes(`bridge-route:${requestedDomainKey}`),
        )!;
    };
    const evaluateBridgeSeverity = (
      targetShare: number,
      variant: BridgeJoinVariant = "known",
      requestedDomainKey = "protocol:fixture-bridge",
    ) => evaluateBridgeSignal(targetShare, variant, requestedDomainKey).severity;

    expect(evaluateBridgeSeverity(0.0999)).toBe("low");
    expect(evaluateBridgeSeverity(0.1)).toBe("moderate");
    expect(evaluateBridgeSeverity(0.2499)).toBe("moderate");
    expect(evaluateBridgeSeverity(0.25)).toBe("high");
    expect(evaluateBridgeSeverity(0.0499, "aggregate-mismatch")).toBe("high");
    expect(evaluateBridgeSeverity(0.0499, "contradictory-share")).toBe("high");
    expect(evaluateBridgeSeverity(0.0499, "missing-capability")).toBe("high");
    expect(evaluateBridgeSeverity(0.0499, "null-control-share")).toBe("high");
    expect(evaluateBridgeSeverity(0.0499, "same-domain-zero-no-row")).toBe("low");
    expect(evaluateBridgeSeverity(0.0499, "same-domain-null-no-row")).toBe("high");
    expect(evaluateBridgeSeverity(0.0499, "same-domain-epsilon-no-row")).toBe("high");
    expect(evaluateBridgeSeverity(0.0499, "same-domain-invalid")).toBe("high");
    expect(evaluateBridgeSeverity(0.0499, "separate-domain-unjoined")).toBe("low");
    expect(evaluateBridgeSeverity(0.0499, "separate-domain-unjoined", "bridge:native")).toBe("high");
    expect(evaluateBridgeSeverity(0.0499, "supply-mismatch")).toBe("high");
    expect(evaluateBridgeSeverity(0.0499, "unmatched")).toBe("high");
    expect(evaluateBridgeSeverity(0.0499, "wrong-kind")).toBe("high");
    expect(evaluateBridgeSeverity(0.0499, "stale-control")).toBe("high");
    expect(evaluateBridgeSeverity(0.0499, "stale-review")).toBe("high");
    expect(evaluateBridgeSignal(0.25)).toMatchObject({
      severity: "high",
      responsibility: "measured-adverse",
    });
    expect(evaluateBridgeSignal(0.0499, "aggregate-mismatch")).toMatchObject({
      severity: "high",
      responsibility: "integration-missing",
    });
  });

  it("does not treat a control-only bridge domain as exact supply attribution", () => {
    const input = coreFixture();
    const alpha = input.assets[0]! as unknown as V9AssetFactsV2;
    const delta = structuredClone(alpha);
    delta.assetId = "delta";
    input.activeAssetIds.push(delta.assetId);
    input.assets.push(delta as never);

    for (const asset of [alpha, delta]) {
      const targetDomain = { kind: "bridge-route" as const, key: "protocol:fixture-bridge" };
      const controlOnlyDomain = { kind: "bridge-route" as const, key: "bridge:native" };
      const controlTemplate = asset.controls.find((control) => control.controlKey === "control:minter")!;
      const targetControl: V9AssetFactsV2["controls"][number] = {
        ...structuredClone(controlTemplate),
        controlKey: "control:bridge-target",
        deploymentKey: "bridge:target",
        controlKind: "bridge",
        scope: "deployment",
        capabilities: ["bridge-mint"],
        materialSupplyShare: 0.0499,
        failureDomains: [targetDomain],
      };
      const decoyControl: V9AssetFactsV2["controls"][number] = {
        ...structuredClone(controlTemplate),
        controlKey: "control:bridge-decoy",
        deploymentKey: "bridge:decoy",
        controlKind: "bridge",
        scope: "deployment",
        capabilities: ["bridge-mint"],
        materialSupplyShare: 0,
        failureDomains: [controlOnlyDomain],
      };
      asset.controls.push(targetControl, decoyControl);
      asset.economicControlReview.bridge = {
        status: knownStatus("evidence:base", "control.bridge.review"),
        routes: [
          { controlKey: targetControl.controlKey, tier: "external-validated-network" },
          { controlKey: decoyControl.controlKey, tier: "canonical-rollup-bridge" },
        ],
      };
      asset.supply.selectedBridgeRoutes = [
        {
          deploymentRouteKey: targetControl.deploymentKey,
          supplyUsd: 499_000,
          supplyShare: 0.0499,
          reviewState: "selected-reviewed",
        },
        {
          deploymentRouteKey: "bridge:native",
          supplyUsd: 9_501_000,
          supplyShare: 0.9501,
          reviewState: "selected-reviewed",
        },
      ];
      asset.supply.selectedRouteSupplyShare = 1;
      asset.supply.unknownRouteSupplyShare = 0;
      asset.supply.unreviewedRouteSupplyShare = 0;
      asset.supply.failureDomains.push(targetDomain);
    }

    const evaluated = evaluateV9FactSet(compileNativeV3FactSet(input), V9_CANDIDATE_POLICY_V1);
    for (const assetId of ["alpha", "delta"]) {
      expect(
        evaluated.assets
          .find((asset) => asset.assetId === assetId)!
          .scoreInput.dependencyStructuralSignals.find((signal) =>
            signal.failureDomainKeys.includes("bridge-route:protocol:fixture-bridge"),
          ),
      ).toMatchObject({ severity: "high" });
    }
  });

  it("rejects bridge reviews that reference a missing control before evaluation", () => {
    const input = coreFixture();
    const alpha = input.assets[0]! as unknown as V9AssetFactsV2;
    alpha.economicControlReview.bridge = {
      status: knownStatus("evidence:base", "control.bridge.review"),
      routes: [{ controlKey: "control:missing-bridge", tier: "external-validated-network" }],
    };
    expect(() => compileV9FactSetV2(input)).toThrow(/review references unknown control control:missing-bridge/);
  });

  it("does not turn pillar or diagnostic reasons into a global limited-evidence cap", () => {
    const pillarInput = coreFixture();
    const pillarAsset = pillarInput.assets[0]! as unknown as V9AssetFactsV2;
    const pillarGap = createV9FactGap({
      gapId: "gap:bounded-mechanism",
      reasonCode: "bounded-mechanism-review",
      ownerDomain: "backing",
      policyRuleId: "backing.mechanism.bounded",
      observationState: "bounded-unknown",
      path: { kind: "local-component", componentKey: "assurance-and-reconciliation" },
      message: "The assurance component is conservatively bounded.",
      evidenceRefIds: ["evidence:base"],
    });
    pillarAsset.gaps.push(pillarGap);
    const pillarReview = pillarAsset.mechanismRiskReview.review!;
    if (pillarReview.archetype !== "fiat-cash") throw new Error("Expected fiat fixture");
    pillarReview.assuranceAndReconciliation = {
      ...pillarReview.assuranceAndReconciliation,
      status: createV9FactStatus({
        applicability: requiredV9Applicability("backing.mechanism.bounded"),
        observationState: "bounded-unknown",
        evidenceRefIds: ["evidence:base"],
        gapIds: [pillarGap.gapId],
      }),
      quality: null,
    };
    const pillarEvaluated = evaluateV9FactSet(compileNativeV3FactSet(pillarInput), V9_CANDIDATE_POLICY_V1).assets.find(
      (asset) => asset.assetId === "alpha",
    )!;
    expect(pillarEvaluated.scoreInput.pillars.backing).toMatchObject({
      evidenceLevel: "strong",
      reasons: [expect.objectContaining({ code: "bounded-mechanism-review" })],
    });
    expect(pillarEvaluated.trace.caps.map((cap) => cap.kind)).not.toContain("evidence:limited");

    const diagnosticInput = coreFixture();
    const diagnosticAsset = diagnosticInput.assets[0]! as unknown as V9AssetFactsV2;
    const dexRoute = diagnosticAsset.exitRoutes.find((route) => route.routeId === "amm-main")!;
    const redemptionRoute = diagnosticAsset.exitRoutes.find((route) => route.routeId === "issuer-main")!;
    redemptionRoute.failureDomains.push(dexRoute.failureDomains.find((domain) => domain.kind === "dex-protocol")!);
    const diagnosticEvaluated = evaluateV9FactSet(
      compileNativeV3FactSet(diagnosticInput),
      V9_CANDIDATE_POLICY_V1,
    ).assets.find((asset) => asset.assetId === "alpha")!;
    expect(diagnosticEvaluated.exit.reasons).toContain("correlated-exit-routes");
    expect(diagnosticEvaluated.scoreInput.pillars.exit.evidenceLevel).toBe("adequate");
    expect(diagnosticEvaluated.trace.caps.map((cap) => cap.kind)).not.toContain("evidence:limited");
  });

  it("attributes an immaterial score-bearing lower-bound exit instead of withholding its F score", () => {
    const input = coreFixture();
    const alpha = input.assets.find((asset) => asset.assetId === "alpha")! as unknown as V9AssetFactsV2;
    const beta = input.assets.find((asset) => asset.assetId === "beta")! as unknown as V9AssetFactsV2;
    const routeEvidence = alpha.evidence.find((evidence) => evidence.evidenceId === "evidence:route")!;
    const measuredRoute = structuredClone(
      alpha.exitRoutes.find((route) => route.routeId === "amm-main")!,
    );
    measuredRoute.coverageClass = "exact-lower-bound";
    measuredRoute.capacityCurve = measuredRoute.capacityCurve.map((point) => ({
      ...point,
      executableUsd: 1,
      completionRatio: 1 / point.requestedNotionalUsd,
      executionCostBps: point.maxCostBps,
    }));
    beta.evidence.push(routeEvidence);
    beta.exitStatus = knownStatus(routeEvidence.evidenceId, "exit.portfolio.reviewed");
    beta.exitRoutes = [measuredRoute];

    const evaluated = evaluateV9FactSet(
      compileNativeV3FactSet(input),
      V9_CANDIDATE_POLICY_V1,
    ).assets.find((asset) => asset.assetId === "beta")!;
    const primaryRoute = evaluated.exit.routes.find(
      (route) => route.routeKey === evaluated.exit.primaryRouteKey,
    )!;

    expect(primaryRoute.capsApplied).toContain("immaterial-executable-capacity");
    expect(evaluated.scoreInput.pillars.exit).toMatchObject({
      score: 0,
      adverseAttribution: [
        {
          source: "pillar-score",
          path: `pillar:exit:route:${measuredRoute.routeKey}:capacity`,
          responsibility: "measured-adverse",
        },
      ],
    });
    expect(evaluated.trace.finalGrade).toBe("F");
    expect(evaluated.trace.finalScore).not.toBeNull();
    expect(evaluated.trace.nrReasons).not.toContainEqual(
      expect.objectContaining({ field: "adverseAttribution" }),
    );
    expect(evaluated.trace.adverseAttribution).toContainEqual(
      expect.objectContaining({
        source: "pillar-score",
        path: `pillar:exit:route:${measuredRoute.routeKey}:capacity`,
      }),
    );
  });

  it("keeps ceiling reasons limited and NR conditions insufficient", () => {
    const ceilingInput = coreFixture();
    const ceilingAsset = ceilingInput.assets[0]! as unknown as V9AssetFactsV2;
    const staleEvidence = createV9EvidenceReference(
      {
        evidenceId: "evidence:stale-assurance",
        sourceId: "assurance-source",
        sourceGenerationId: "assurance:g1",
        disposition: "published",
        observedAtSec: 600,
        publishedAtSec: 610,
        maxAgeSec: 100,
      },
      AS_OF_SEC,
    );
    const ceilingGap = createV9FactGap({
      gapId: "gap:stale-assurance",
      reasonCode: "missing-latest-assurance-report",
      ownerDomain: "backing",
      policyRuleId: "backing.assurance.current",
      observationState: "stale",
      path: { kind: "local-component", componentKey: "assurance-and-reconciliation" },
      message: "The latest assurance report is stale.",
      evidenceRefIds: [staleEvidence.evidenceId],
    });
    ceilingAsset.evidence.push(staleEvidence);
    ceilingAsset.gaps.push(ceilingGap);
    const ceilingReview = ceilingAsset.mechanismRiskReview.review!;
    if (ceilingReview.archetype !== "fiat-cash") throw new Error("Expected fiat fixture");
    ceilingReview.assuranceAndReconciliation = {
      ...ceilingReview.assuranceAndReconciliation,
      status: createV9FactStatus({
        applicability: requiredV9Applicability("backing.assurance.current"),
        observationState: "stale",
        evidenceRefIds: [staleEvidence.evidenceId],
        gapIds: [ceilingGap.gapId],
      }),
    };
    const ceilingEvaluated = evaluateV9FactSet(compileNativeV3FactSet(ceilingInput), V9_CANDIDATE_POLICY_V1).assets.find(
      (asset) => asset.assetId === "alpha",
    )!;
    expect(ceilingEvaluated.scoreInput.pillars.backing.evidenceLevel).toBe("limited");
    expect(ceilingEvaluated.trace.caps.map((cap) => cap.kind)).toContain("evidence:limited");

    const nrInput = coreFixture();
    const nrAsset = nrInput.assets[0]! as unknown as V9AssetFactsV2;
    const nrGap = createV9FactGap({
      gapId: "gap:missing-mechanism-review",
      reasonCode: "missing-pillar-evidence",
      ownerDomain: "backing",
      policyRuleId: "backing.mechanism.required",
      observationState: "missing",
      path: { kind: "local-component", componentKey: "mechanism-review" },
      message: "The mechanism review is missing.",
    });
    nrAsset.gaps.push(nrGap);
    nrAsset.mechanismRiskReview = {
      status: createV9FactStatus({
        applicability: requiredV9Applicability("backing.mechanism.required"),
        observationState: "missing",
        gapIds: [nrGap.gapId],
      }),
      review: null,
    };
    const nrEvaluated = evaluateV9FactSet(compileNativeV3FactSet(nrInput), V9_CANDIDATE_POLICY_V1).assets.find(
      (asset) => asset.assetId === "alpha",
    )!;
    expect(nrEvaluated.scoreInput.pillars.backing.evidenceLevel).toBe("insufficient");
    expect(nrEvaluated.trace.finalScore).toBeNull();
  });

  it("propagates serial SCC failure while keeping every active asset in the result", () => {
    const input = coreFixture();
    const beta = input.assets[1]! as unknown as V9AssetFactsV2;
    const gamma = input.assets[2]! as unknown as V9AssetFactsV2;
    const configureCycleMember = (
      asset: V9AssetFactsV2,
      upstreamAssetId: string,
      dependencyType: "wrapper" | "mechanism",
    ) => {
      asset.dependencies = {
        status: knownStatus(),
        sourceGenerationId: SOURCE_FINGERPRINTS.researchOverlays.generationId,
        source: "manual",
        baseSource: "manual",
        dependencyFromLive: false,
        mappedLiveReserveWeight: null,
        fallbackReason: null,
        edges: [
          {
            edgeKey: canonicalV9DependencyEdgeKey(dependencyType, upstreamAssetId),
            upstreamAssetId,
            dependencyType,
            pathKind: "serial-dependency",
            weight: 1,
            economicRole: "serial-claim",
            evidenceRefIds: ["evidence:base"],
            failureDomains: [{ kind: "mint-control", key: `cycle:${upstreamAssetId}` }],
          },
        ],
        diagnostics: { graphState: "cycle", issueCodes: ["serial-scc"], sccMemberAssetIds: ["beta", "gamma"] },
      };
    };
    configureCycleMember(beta, "gamma", "wrapper");
    configureCycleMember(gamma, "beta", "mechanism");

    const evaluated = evaluateV9FactSet(compileNativeV3FactSet(input), V9_CANDIDATE_POLICY_V1);
    expect(evaluated.assets.map((asset) => asset.assetId)).toEqual(["alpha", "beta", "gamma"]);
    expect(evaluated.assets.find((asset) => asset.assetId === "beta")!.compactTrace.reasonCodes).toContain(
      "implementation-parent-cycle",
    );
    expect(evaluated.assets.find((asset) => asset.assetId === "gamma")!.compactTrace.reasonCodes).toContain(
      "implementation-parent-cycle",
    );
    expect(evaluated.assets.find((asset) => asset.assetId === "alpha")!.compactTrace.reasonCodes).toContain(
      "parent-cycle",
    );
    expect(evaluated.assets.every((asset) => asset.trace.finalScore === null)).toBe(true);
  });

  it("requires every active asset exactly once and keeps dependencies inside the active set", () => {
    const missing = coreFixture();
    missing.assets.pop();
    expect(() => compileV9FactSetV2(missing)).toThrow("Assets must match the exact active asset set");

    const duplicate = coreFixture();
    duplicate.activeAssetIds.push("alpha");
    expect(() => compileV9FactSetV2(duplicate)).toThrow("Duplicate canonical key: alpha");

    const external = coreFixture();
    external.assets[0]!.dependencies.edges[0]!.upstreamAssetId = "outside";
    external.assets[0]!.dependencies.edges[0]!.edgeKey = "collateral:outside";
    expect(() => compileV9FactSetV2(external)).toThrow("Dependency is outside active set");

    const compiled = compileV9FactSetV2(coreFixture());
    expect(() => assertExactV9ActiveAssetSet(compiled, ["gamma", "alpha", "beta"])).not.toThrow();
    expect(() => assertExactV9ActiveAssetSet(compiled, ["alpha", "beta"])).toThrow("exact active asset set");
  });

  it("canonicalizes and reconciles explicit chain supply attribution", () => {
    const attributed = coreFixture();
    attributed.assets[0]!.supply.chainDistribution = {
      chains: [
        { chainId: "fantom", supplyUsd: 499_000, supplyShare: 0.0499 },
        { chainId: "ethereum", supplyUsd: 8_501_000, supplyShare: 0.8501 },
      ],
      unattributedSupplyUsd: 1_000_000,
      unattributedSupplyShare: 0.1,
    };
    expect(compileV9FactSetV2(attributed).assets[0]!.supply.chainDistribution).toEqual({
      chains: [
        { chainId: "ethereum", supplyUsd: 8_501_000, supplyShare: 0.8501 },
        { chainId: "fantom", supplyUsd: 499_000, supplyShare: 0.0499 },
      ],
      unattributedSupplyUsd: 1_000_000,
      unattributedSupplyShare: 0.1,
    });

    const duplicate = structuredClone(attributed);
    duplicate.assets[0]!.supply.chainDistribution!.chains[1]!.chainId = "fantom";
    expect(() => compileV9FactSetV2(duplicate)).toThrow("Duplicate canonical key: fantom");

    const usdMismatch = structuredClone(attributed);
    usdMismatch.assets[0]!.supply.chainDistribution!.chains[0]!.supplyUsd -= 1_000;
    expect(() => compileV9FactSetV2(usdMismatch)).toThrow("Chain supply USD must reconcile");

    const shareMismatch = structuredClone(attributed);
    shareMismatch.assets[0]!.supply.chainDistribution!.unattributedSupplyShare = 0.2;
    expect(() => compileV9FactSetV2(shareMismatch)).toThrow("Chain supply shares must reconcile");

    const zeroSupply = coreFixture();
    zeroSupply.assets[1]!.supply.circulatingUsd = 0;
    zeroSupply.assets[1]!.supply.chainDistribution = {
      chains: [{ chainId: "chain:fixture", supplyUsd: 0, supplyShare: 0 }],
      unattributedSupplyUsd: 0,
      unattributedSupplyShare: 0,
    };
    expect(compileV9FactSetV2(zeroSupply).assets[1]!.supply.chainDistribution).toEqual(
      zeroSupply.assets[1]!.supply.chainDistribution,
    );
    zeroSupply.assets[1]!.supply.chainDistribution.chains[0]!.supplyShare = 0.01;
    expect(() => compileV9FactSetV2(zeroSupply)).toThrow("Chain supply shares must reconcile");
  });

  it("parses retained V2 facts without injecting the additive chain distribution field", () => {
    const retainedCore = coreFixture();
    for (const asset of retainedCore.assets) {
      delete (asset.supply as { chainDistribution?: unknown }).chainDistribution;
    }
    const retained = compileV9FactSetV2(retainedCore);
    expect(
      retained.assets.every((asset) => !Object.prototype.hasOwnProperty.call(asset.supply, "chainDistribution")),
    ).toBe(true);
    expect(
      retained.assets.every((asset) => !Object.prototype.hasOwnProperty.call(asset, "operationalResilience")),
    ).toBe(true);

    const retainedBytes = stableJsonStringifyV1(retained);
    const reparsed = parseCompiledV9FactSetV2(JSON.parse(retainedBytes));
    expect(stableJsonStringifyV1(reparsed)).toBe(retainedBytes);
    expect(reparsed.v9FactSetDigest).toBe(retained.v9FactSetDigest);
  });

  it("rejects retained V2 fact sets closed", () => {
    const retained = compileV9FactSetV2(coreFixture());
    expect(() => readCompiledV9FactSetForEvaluation(retained)).toThrow(
      "Unsupported Safety Score v9 fact-set schema version: 2; expected 3",
    );
  });

  it.each([
    { observationState: "bounded-unknown", evidenceKind: "current" },
    { observationState: "stale", evidenceKind: "stale" },
  ] as const)("keeps $observationState empty coverage non-measured", ({
    observationState,
    evidenceKind,
  }) => {
    const core = nativeCompleteEmptyCoreFixture();
    const asset = core.assets.find(
      (candidate) => candidate.assetId === "alpha",
    ) as V9AssetFactsV3;
    const evidence =
      evidenceKind === "stale"
        ? createV9EvidenceReference(
            {
              evidenceId: "evidence:stale-exit-coverage",
              sourceId: "route-source",
              sourceGenerationId: SOURCE_FINGERPRINTS.dex.generationId,
              disposition: "observed",
              observedAtSec: 100,
              maxAgeSec: 100,
            },
            AS_OF_SEC,
          )
        : asset.evidence.find(
            (candidate) => candidate.evidenceId === "evidence:base",
          )!;
    const gap = createV9FactGapV3({
      gapId: `alpha:gap:exit-coverage:${observationState}`,
      reasonCode: "missing-same-notional-route",
      ownerDomain: "exit",
      policyRuleId: "exit.route.coverage",
      observationState,
      path: {
        kind: "local-component",
        componentKey: "exit-route-coverage",
      },
      message: "The empty exit surface is not a current complete observation.",
      evidenceRefIds: [evidence.evidenceId],
      responsibility: "producer-failed",
    });
    if (evidenceKind === "stale") asset.evidence.push(evidence);
    asset.gaps.push(gap);
    asset.exitStatus = createV9FactStatus({
      applicability: requiredV9Applicability("exit.route.coverage"),
      observationState,
      evidenceRefIds: [evidence.evidenceId],
      gapIds: [gap.gapId],
    });

    const evaluated = evaluateV9FactSet(
      compileV9FactSetV3(core),
      V9_CANDIDATE_POLICY_V1,
    ).assets.find((candidate) => candidate.assetId === "alpha")!;
    const reasons = evaluated.scoreInput.pillars.exit.reasons.filter(
      (reason) => reason.code === "missing-same-notional-route",
    );

    expect(evaluated.exit.reasons).toContain("missing-same-notional-route");
    expect(reasons).not.toHaveLength(0);
    expect(
      reasons.every(
        (reason) => reason.responsibility === "producer-failed",
      ),
    ).toBe(true);
  });

  it("preserves explicit exit-gap and mechanism-profile ownership over native complete-empty fallback", () => {
    const nativeWithGap = structuredClone(compileNativeV3FactSet(coreFixture()));
    const { v9FactSetDigest: _gapDigest, ...gapCore } = nativeWithGap;
    const gapAsset = gapCore.assets.find(
      (candidate) => candidate.assetId === "alpha",
    ) as V9AssetFactsV3;
    gapAsset.exitRoutes = gapAsset.exitRoutes.filter(
      (route) => !route.scoreEligible,
    );
    gapAsset.evidence = gapAsset.evidence.filter(
      (evidence) => evidence.evidenceId !== "evidence:route",
    );
    const exitGap = gapAsset.gaps.find(
      (gap) => gap.ownerDomain === "exit",
    )!;
    exitGap.reasonCode = "no-viable-exit-path";
    exitGap.responsibility = "issuer-undisclosed";

    const gapEvaluated = evaluateV9FactSet(
      compileV9FactSetV3(gapCore),
      V9_CANDIDATE_POLICY_V1,
    ).assets.find((asset) => asset.assetId === "alpha")!;
    expect(gapEvaluated.scoreInput.pillars.exit.reasons).toContainEqual(
      expect.objectContaining({
        code: "no-viable-exit-path",
        responsibility: "issuer-undisclosed",
      }),
    );

    const profileCore = nativeCompleteEmptyCoreFixture();
    const profileAsset = profileCore.assets.find(
      (candidate) => candidate.assetId === "alpha",
    ) as V9AssetFactsV3;
    profileAsset.mechanismExitFacts = [{
      factKey: "protocol-redemption",
      disposition: "supported",
      quality: "adequate",
      evidenceRefIds: ["evidence:base"],
    }];
    const profileEvaluated = evaluateV9FactSet(
      compileV9FactSetV3(profileCore),
      V9_CANDIDATE_POLICY_V1,
    ).assets.find((asset) => asset.assetId === "alpha")!;

    expect(profileEvaluated.scoreInput.pillars.exit.reasons).toContainEqual(
      expect.objectContaining({
        code: "missing-runtime-route-evidence",
        responsibility: "integration-missing",
      }),
    );
    expect(
      profileEvaluated.scoreInput.pillars.exit.reasons.some(
        (reason) =>
          reason.code === "no-viable-exit-path" &&
          reason.responsibility === "measured-adverse",
      ),
    ).toBe(false);
  });

  it("canonicalizes the retained Hyperliquid alias and applies R2 maturity after collisions", () => {
    const configure = (
      input: ReturnType<typeof coreFixture>,
      chains: Array<{ chainId: string; supplyUsd: number; supplyShare: number }>,
    ) => {
      for (const asset of input.assets.slice(1)) {
        asset.supply.chainDistribution = {
          chains,
          unattributedSupplyUsd: 0,
          unattributedSupplyShare: 0,
        };
        asset.supply.failureDomains = [{ kind: "chain", key: "hyperliquid" }];
      }
    };
    const severity = (input: ReturnType<typeof coreFixture>) =>
      evaluateV9FactSet(compileNativeV3FactSet(input), V9_CANDIDATE_POLICY_V1)
        .assets.find((asset) => asset.assetId === "beta")!
        .scoreInput.dependencyStructuralSignals.find((signal) => signal.failureDomainKeys.includes("chain:hyperliquid"))
        ?.severity;

    const alias = coreFixture();
    configure(alias, [{ chainId: "hyperliquid-l1", supplyUsd: 1_000_000, supplyShare: 1 }]);
    expect(severity(alias)).toBe("low");

    const collision = coreFixture();
    configure(collision, [
      { chainId: "ethereum", supplyUsd: 950_200, supplyShare: 0.9502 },
      { chainId: "hyperliquid", supplyUsd: 24_900, supplyShare: 0.0249 },
      { chainId: "hyperliquid-l1", supplyUsd: 24_900, supplyShare: 0.0249 },
    ]);
    expect(severity(collision)).toBe("low");
  });

  it("fails chain attribution closed when the distribution is unavailable or the supply fact is bounded", () => {
    const configureImmaterialChain = (input: ReturnType<typeof coreFixture>) => {
      for (const asset of input.assets.slice(1)) {
        asset.supply.chainDistribution = {
          chains: [
            { chainId: "chain:fixture", supplyUsd: 49_900, supplyShare: 0.0499 },
            { chainId: "other", supplyUsd: 950_100, supplyShare: 0.9501 },
          ],
          unattributedSupplyUsd: 0,
          unattributedSupplyShare: 0,
        };
      }
    };
    const chainSignal = (input: ReturnType<typeof coreFixture>, assetId: string) =>
      evaluateV9FactSet(compileNativeV3FactSet(input), V9_CANDIDATE_POLICY_V1)
        .assets.find((asset) => asset.assetId === assetId)!
        .scoreInput.dependencyStructuralSignals.find((signal) =>
          signal.failureDomainKeys.includes("chain:chain:fixture"),
        );

    const known = coreFixture();
    configureImmaterialChain(known);
    expect(chainSignal(known, "beta")?.severity).toBe("low");

    const unavailable = coreFixture();
    configureImmaterialChain(unavailable);
    (unavailable.assets[1]! as unknown as V9AssetFactsV2).supply.chainDistribution = null;
    expect(chainSignal(unavailable, "beta")?.severity).toBe("high");

    const bounded = coreFixture();
    configureImmaterialChain(bounded);
    const beta = bounded.assets[1]! as unknown as V9AssetFactsV2;
    const gap = createV9FactGap({
      gapId: "gap:bounded-chain-supply",
      reasonCode: "runtime-bridge-materiality-unavailable",
      ownerDomain: "control",
      policyRuleId: "v9.supply.current",
      observationState: "bounded-unknown",
      path: { kind: "local-component", componentKey: "chain-supply" },
      message: "The retained chain distribution is not current enough for score-bearing attribution.",
      evidenceRefIds: ["evidence:base"],
    });
    beta.gaps.push(gap);
    beta.supply.status = createV9FactStatus({
      applicability: requiredV9Applicability("v9.supply.current"),
      observationState: "bounded-unknown",
      evidenceRefIds: ["evidence:base"],
      gapIds: [gap.gapId],
    });
    expect(chainSignal(bounded, "beta")?.severity).toBe("high");
  });

  it("retains an unresolved archetype as an explicit fact state", () => {
    const input = coreFixture();
    const beta = input.assets[1]! as unknown as V9AssetFactsV2;
    const gap = createV9FactGap({
      gapId: "gap:missing-archetype",
      reasonCode: "missing-archetype",
      ownerDomain: "backing",
      policyRuleId: "backing.archetype.review",
      observationState: "missing",
      path: { kind: "local-component", componentKey: "mechanism-archetype" },
      message: "The mechanism archetype is unresolved.",
    });
    beta.archetype = "unresolved";
    beta.gaps = [gap];
    beta.mechanismRiskReview = {
      status: createV9FactStatus({
        applicability: requiredV9Applicability("backing.archetype.review"),
        observationState: "missing",
        gapIds: [gap.gapId],
      }),
      review: null,
    };
    const compiled = compileV9FactSetV2(input);
    expect(compiled.assets.find((asset) => asset.assetId === "beta")?.archetype).toBe("unresolved");
  });

  it("retains last-known stale and rejected route observations instead of erasing their facts", () => {
    const input = coreFixture();
    const alpha = input.assets[0] as ReturnType<typeof fullAsset>;
    const route = alpha.exitRoutes[0]!;
    const staleEvidence = createV9EvidenceReference(
      {
        evidenceId: "evidence:stale-route",
        sourceId: "route-source",
        sourceGenerationId: SOURCE_FINGERPRINTS.dex.generationId,
        disposition: "published",
        observedAtSec: 600,
        publishedAtSec: 610,
        maxAgeSec: 100,
      },
      AS_OF_SEC,
    );
    const staleGap = createV9FactGap({
      gapId: "gap:stale-route",
      reasonCode: "missing-runtime-route-evidence",
      ownerDomain: "exit",
      policyRuleId: "exit.route.freshness",
      observationState: "stale",
      path: optionalExitV9Path(route.routeKey),
      message: "The last-known route observation is outside its freshness window.",
      evidenceRefIds: [staleEvidence.evidenceId],
    });
    const staleStatus = createV9FactStatus({
      applicability: requiredV9Applicability("exit.route.freshness"),
      observationState: "stale",
      evidenceRefIds: [staleEvidence.evidenceId],
      gapIds: [staleGap.gapId],
    });
    alpha.evidence.push(staleEvidence);
    alpha.gaps.push(staleGap);
    route.status = staleStatus;
    route.settlementEvidenceRefIds = [staleEvidence.evidenceId];
    route.output.status = staleStatus;
    route.output.valuation = {
      ...route.output.valuation!,
      observedAtSec: staleEvidence.observedAtSec,
      freshness: staleEvidence.freshness,
      evidenceRefIds: [staleEvidence.evidenceId],
    };
    const rejectedRoute = alpha.exitRoutes[2]!;
    rejectedRoute.request = { requestedNotionalUsd: 100_000, maxCostBps: 200, settlementHorizonSec: 300 };
    rejectedRoute.capacityCurve = [
      {
        requestedNotionalUsd: 100_000,
        maxCostBps: 200,
        executableUsd: 25_000,
        completionRatio: 0.25,
        executionCostBps: 190,
      },
    ];

    const compiledAlpha = compileV9FactSetV2(input).assets[0]!;
    const compiledStaleRoute = compiledAlpha.exitRoutes.find((candidate) => candidate.routeId === "amm-main")!;
    expect(compiledStaleRoute).toMatchObject({
      status: { observationState: "stale" },
      output: { valuation: { valueRetentionRatio: 1, freshness: { state: "stale" } } },
    });
    expect(compiledStaleRoute.capacityCurve).toContainEqual(expect.objectContaining({ executableUsd: 80_000 }));
    expect(compiledAlpha.exitRoutes.find((candidate) => candidate.routeId === "unsupported")).toMatchObject({
      status: { observationState: "unsupported" },
      capacityCurve: [{ executableUsd: 25_000 }],
    });
  });

  it.each([
    [
      "compile clock",
      (input: ReturnType<typeof coreFixture>) => (input.compiledAtSec = AS_OF_SEC - 1),
      "compiledAtSec cannot predate",
    ],
    [
      "source clock",
      (input: ReturnType<typeof coreFixture>) => (input.sourceFingerprints.dex.observedAtSec = AS_OF_SEC + 1),
      "Source observation is later",
    ],
    [
      "evidence clock",
      (input: ReturnType<typeof coreFixture>) => (input.assets[0]!.evidence[0]!.observedAtSec = AS_OF_SEC + 1),
      "Evidence is later",
    ],
    [
      "evidence age",
      (input: ReturnType<typeof coreFixture>) => (input.assets[0]!.evidence[0]!.freshness.ageSec = 99),
      "Evidence age is not clock-derived",
    ],
    [
      "implementation clock",
      (input: ReturnType<typeof coreFixture>) => (input.assets[0]!.implementation.launchedAtSec = AS_OF_SEC + 1),
      "Implementation date is later",
    ],
    [
      "valuation clock",
      (input: ReturnType<typeof coreFixture>) =>
        (input.assets[0]!.exitRoutes[0]!.output.valuation!.asOfSec = AS_OF_SEC - 1),
      "Valuation clock does not match",
    ],
  ])("rejects an invalid %s", (_label, mutate, message) => {
    const input = coreFixture();
    mutate(input);
    expect(() => compileV9FactSetV2(input)).toThrow(message);
  });

  it.each([
    [
      "self dependency",
      (input: ReturnType<typeof coreFixture>) => {
        const edge = input.assets[0]!.dependencies.edges[0]!;
        edge.upstreamAssetId = "alpha";
        edge.edgeKey = "collateral:alpha";
      },
      "Self dependency is invalid",
    ],
    [
      "dependency key",
      (input: ReturnType<typeof coreFixture>) => (input.assets[0]!.dependencies.edges[0]!.edgeKey = "wrong"),
      "Expected collateral:beta",
    ],
    [
      "route key",
      (input: ReturnType<typeof coreFixture>) => (input.assets[0]!.exitRoutes[0]!.routeKey = "wrong"),
      "Canonical route key must",
    ],
    [
      "route generation",
      (input: ReturnType<typeof coreFixture>) => {
        const route = input.assets[0]!.exitRoutes[0]!;
        route.sourceGenerationId = "dex:other";
        route.routeKey = canonicalV9RouteKey("dex", route.sourceGenerationId, route.routeId);
      },
      "Route generation does not match",
    ],
    [
      "evidence reference",
      (input: ReturnType<typeof coreFixture>) =>
        (input.assets[0]!.implementation.status.evidenceRefIds = ["evidence:unknown"]),
      "Unknown evidence reference",
    ],
    [
      "gap path",
      (input: ReturnType<typeof coreFixture>) =>
        (input.assets[0]!.gaps[0]!.path = optionalExitV9Path("dex:dex:g1:absent")),
      "Exit path does not reference",
    ],
    [
      "reserve generation",
      (input: ReturnType<typeof coreFixture>) => (input.assets[0]!.reserveExposures[0]!.sourceGenerationId = "wrong"),
      "Reserve provenance generation is inconsistent",
    ],
    [
      "control generation",
      (input: ReturnType<typeof coreFixture>) => (input.assets[0]!.controls[0]!.sourceGenerationId = "wrong"),
      "Control provenance generation is inconsistent",
    ],
  ])("rejects an invalid %s identity", (_label, mutate, message) => {
    const input = coreFixture();
    mutate(input);
    expect(() => compileV9FactSetV2(input)).toThrow(message);
  });

  it("requires explicit evidence classes for curated reserve rows", () => {
    const input = coreFixture();
    const exposure = input.assets[0]!.reserveExposures[0]! as V9AssetFactsV2["reserveExposures"][number];
    exposure.provenance = "curated";
    exposure.sourceGenerationId = SOURCE_FINGERPRINTS.researchOverlays.generationId;
    delete exposure.evidenceClass;

    expect(() => compileV9FactSetV2(input)).toThrow("Curated reserve exposure requires an evidence class");
  });

  it("rejects static evidence classes on live reserve rows", () => {
    const input = coreFixture();
    const exposure = input.assets[0]!.reserveExposures[0]! as V9AssetFactsV2["reserveExposures"][number];
    exposure.evidenceClass = "independent";

    expect(() => compileV9FactSetV2(input)).toThrow("Live reserve exposure must not carry a static evidence class");
  });

  it.each([
    [
      "execution cost",
      (input: ReturnType<typeof coreFixture>) =>
        (input.assets[0]!.exitRoutes[0]!.capacityCurve[0]!.executionCostBps = 201),
      "Execution cost exceeds",
    ],
    [
      "value retention",
      (input: ReturnType<typeof coreFixture>) =>
        (input.assets[0]!.exitRoutes[0]!.output.valuation!.valueRetentionRatio = 0.9),
      "Value retention is inconsistent",
    ],
    [
      "holder access",
      (input: ReturnType<typeof coreFixture>) => (input.assets[0]!.exitRoutes[0]!.holderAccess = "unknown"),
      "explicit access, execution",
    ],
    [
      "coverage class",
      (input: ReturnType<typeof coreFixture>) => (input.assets[0]!.exitRoutes[0]!.coverageClass = "diagnostic"),
      "Diagnostic coverage cannot",
    ],
    [
      "settlement evidence",
      (input: ReturnType<typeof coreFixture>) => (input.assets[0]!.exitRoutes[0]!.settlementEvidenceRefIds = []),
      "lacks resource identity or settlement evidence",
    ],
    [
      "physical resource reuse",
      (input: ReturnType<typeof coreFixture>) =>
        (input.assets[0]!.exitRoutes[1]!.physicalResourceKeys = ["pool:fixture-main"]),
      "Physical resource pool:fixture-main is reused",
    ],
    [
      "bounded control without bound",
      (input: ReturnType<typeof coreFixture>) => (input.assets[0]!.controls[1]!.capSemantics.bound = null),
      "Bounded control requires a bound",
    ],
    [
      "unknown control cap",
      (input: ReturnType<typeof coreFixture>) => (input.assets[0]!.controls[0]!.capSemantics.kind = "unknown"),
      "reviewed cap and economic-loss semantics",
    ],
    [
      "freeze-only loss scope",
      (input: ReturnType<typeof coreFixture>) => {
        input.assets[0]!.controls[2]!.claimImpairment = "unbounded";
        input.assets[0]!.controls[2]!.economicLossScope = "global-claim";
      },
      "Freeze-only posture cannot",
    ],
  ])("rejects incomplete score-bearing %s facts", (_label, mutate, message) => {
    const input = coreFixture();
    mutate(input);
    expect(() => compileV9FactSetV2(input)).toThrow(message);
  });

  it("binds semantic facts and source identities but excludes compilation time and all policy fields", () => {
    const first = compileV9FactSetV2(coreFixture());
    const laterInput = coreFixture();
    laterInput.compiledAtSec += 500;
    const later = compileV9FactSetV2(laterInput);
    expect(later.v9FactSetDigest).toBe(first.v9FactSetDigest);

    const factChanged = coreFixture();
    factChanged.assets[0]!.supply.circulatingUsd += 1;
    factChanged.assets[0]!.supply.chainDistribution!.chains[0]!.supplyUsd += 1;
    expect(compileV9FactSetV2(factChanged).v9FactSetDigest).not.toBe(first.v9FactSetDigest);

    const mechanismChanged = coreFixture();
    const mechanismReviewChanged = mechanismChanged.assets[0]!.mechanismRiskReview.review!;
    if (mechanismReviewChanged.archetype !== "fiat-cash") throw new Error("Fixture archetype changed");
    mechanismReviewChanged.claimAndSegregation.failureDomains[0]!.key = "mechanism:changed";
    expect(compileV9FactSetV2(mechanismChanged).v9FactSetDigest).not.toBe(first.v9FactSetDigest);

    const sourceChanged = coreFixture();
    sourceChanged.sourceFingerprints.chainSupply.payloadSha256 = "f".repeat(64);
    expect(compileV9FactSetV2(sourceChanged).v9FactSetDigest).not.toBe(first.v9FactSetDigest);

    expect(() => compileV9FactSetV2({ ...coreFixture(), policyDigest: "f".repeat(64) })).toThrow("Unrecognized key");
    expect(computeV9FactSetDigest(first)).toBe(first.v9FactSetDigest);

    const tampered = { ...first, v9FactSetDigest: "0".repeat(64) };
    expect(() => parseCompiledV9FactSetV2(tampered)).toThrow("does not match");
  });

  it("rejects v8 report-card fields at the independent fact boundary", () => {
    const input = coreFixture();
    expect(() =>
      compileV9FactSetV2({
        ...input,
        overallScore: 90,
        dimensions: {},
        rawInputs: {},
      }),
    ).toThrow("Unrecognized key");
  });
});
