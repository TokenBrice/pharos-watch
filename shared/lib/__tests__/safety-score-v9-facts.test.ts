import { describe, expect, it } from "vitest";
import { compileV9FactSetV2, assertExactV9ActiveAssetSet } from "../safety-score-v9/compile";
import { evaluateV9FactSet } from "../safety-score-v9/evaluate-set";
import {
  canonicalV9DependencyEdgeKey,
  canonicalV9RouteKey,
  computeV9FactSetDigest,
  parseCompiledV9FactSetV2,
  projectPublicV9FactSetV2,
} from "../safety-score-v9/facts";
import {
  createV9EvidenceReference,
  createV9FactStatus,
  notApplicableV9Fact,
  requiredV9Applicability,
} from "../safety-score-v9/evidence";
import { createV9FactGap, optionalExitV9Path } from "../safety-score-v9/reasons";
import { V9_CANDIDATE_POLICY_V1 } from "../safety-score-v9/policy";
import type { V9AssetFactsV2 } from "../../types/safety-score-v9-facts";

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

describe("Safety Score v9 normalized fact protocol", () => {
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

    expect(evaluateV9FactSet(reversed, V9_CANDIDATE_POLICY_V1)).toEqual(
      evaluateV9FactSet(ordered, V9_CANDIDATE_POLICY_V1),
    );
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

    const evaluated = evaluateV9FactSet(compileV9FactSetV2(input), V9_CANDIDATE_POLICY_V1);
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

  it("emits a compact public projection without full evidence, reserve, control, or gap-message data", () => {
    const projection = projectPublicV9FactSetV2(compileV9FactSetV2(coreFixture()));
    const alpha = projection.assets[0]!;
    expect(alpha.dependencies).toHaveLength(2);
    expect(alpha.exitRoutes).toHaveLength(3);
    expect(alpha.supply.circulatingUsd).toBe(10_000_000);
    expect(alpha.gaps[0]).toMatchObject({
      reasonCode: "unsupported-same-notional-route",
      policyRuleId: "exit.route.supported-model",
      pathKind: "optional-exit",
    });
    const serialized = JSON.stringify(projection);
    expect(serialized).not.toContain("fixture-source");
    expect(serialized).not.toContain("Cash");
    expect(serialized).not.toContain("safe:admin");
    expect(serialized).not.toContain("retained pool");
    expect(serialized).not.toContain("claimAndSegregation");
    expect(serialized).not.toContain("reconciliation");
    expect(serialized).not.toContain("freeze:none-reviewed");
  });
});
