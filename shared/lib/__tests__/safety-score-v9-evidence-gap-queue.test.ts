import { describe, expect, it } from "vitest";
import policyAsset from "@shared/data/safety-score-v9/methodology-policy-candidate-v1.json";
import { compileV9FactSetV3 } from "@shared/lib/safety-score-v9/compile";
import {
  buildV9EvidenceGapQueue,
  isV9DocumentationGapEntry,
  parseV9EvidenceGapQueue,
  v9ResearchedTerminalReviewState,
} from "@shared/lib/safety-score-v9/evidence-gap-queue";
import { loadV9MethodologyPolicy } from "@shared/lib/safety-score-v9/policy";
import { createV9FactGapV3 } from "@shared/lib/safety-score-v9/reasons";

import {
  V9EvidenceGapQueueV3Schema,
} from "@shared/types/safety-score-v9-evidence-queue";
import { V9DocumentationReasonSchema } from "@shared/types/safety-score-v9";
import type { V9EvidenceResponsibility } from "@shared/types/safety-score-v9-fact-primitives";
import { factStatuses, V9FactStatusV2Schema, type V9FactSetCoreV3, type V9FactStatusV2 } from "@shared/types/safety-score-v9-facts";
import { compileNativeV3FactSet, coreFixture } from "./safety-score-v9-facts.fixture-support";

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

function knownStatus(policyRuleId: string) {
  return {
    applicability: { state: "required" as const, policyRuleId, rationale: null, gapId: null },
    observationState: "known" as const,
    evidenceRefIds: [EVIDENCE.evidenceId],
    gapIds: [],
  };
}

function notApplicableStatus(policyRuleId: string) {
  return {
    applicability: {
      state: "not-applicable" as const,
      policyRuleId,
      rationale: "Reviewed as not applicable.",
      gapId: null,
    },
    observationState: "known" as const,
    evidenceRefIds: [EVIDENCE.evidenceId],
    gapIds: [],
  };
}

function mechanismFact(policyRuleId: string) {
  return {
    status: knownStatus(policyRuleId),
    quality: "strong" as const,
    failureDomains: [{ kind: "reserve-issuer" as const, key: "mechanism:fixture" }],
  };
}

function factSetCore(message = "Launch date evidence has not been established."): V9FactSetCoreV3 {
  const gapId = "asset-001:gap:implementation-date";
  return {
    schemaVersion: 4,
    baseInputGenerationId: BASE_INPUT_GENERATION_ID,
    asOfSec: AS_OF_SEC,
    compiledAtSec: 1_100,
    sourceFingerprints: SOURCES,
    activeAssetIds: ["asset-001"],
    assets: [
      {
        assetId: "asset-001",
        archetype: "algorithmic",
        evidence: [EVIDENCE],
        gaps: [
          {
            gapId,
            reasonCode: "missing-implementation-date",
            ownerDomain: "evidence",
            policyRuleId: "v9.implementation.launch-date",
            observationState: "missing",
            path: { kind: "local-component", componentKey: "implementation.launch-date" },
            message,
            evidenceRefIds: [],
            responsibility: "unresearched",
            causeProof: { cause: "U", reason: "not-yet-researched", evidenceRefIds: [] },
            causeScope: { pillar: "control", componentKey: "implementation.launch-date", factorKey: null, routeKey: null, exposureId: null, requiredDatum: "launch-date" },
          },
        ],
        wrapperLocalFacts: {
          schemaVersion: 1,
          applicability: "not-wrapper",
          evidenceRefIds: [],
        },
        implementation: {
          status: {
            applicability: {
              state: "required",
              policyRuleId: "v9.implementation.launch-date",
              rationale: null,
              gapId: null,
            },
            observationState: "missing",
            evidenceRefIds: [],
            gapIds: [gapId],
          },
          launchedAtSec: null,
        },
        mechanismRiskReview: {
          status: knownStatus("v9.backing.mechanism"),
          review: {
            archetype: "algorithmic",
            exogenousBackingShare: 1,
            reflexiveBackingShare: 0,
            contractionCapacityRatio: 1,
            contractionCapacity: mechanismFact("v9.backing.contraction"),
            confidenceAndIncentives: mechanismFact("v9.backing.confidence"),
            oracleAndControlAssumptions: mechanismFact("v9.backing.oracle"),
            emergencyRecovery: mechanismFact("v9.backing.emergency"),
            lossRecovery: mechanismFact("v9.backing.loss"),
          },
        },
        dependencies: {
          status: knownStatus("v9.dependencies"),
          sourceGenerationId: SOURCES.researchOverlays.generationId,
          source: "none",
          baseSource: "none",
          dependencyFromLive: false,
          mappedLiveReserveWeight: null,
          fallbackReason: null,
          edges: [],
          diagnostics: { graphState: "valid", issueCodes: [], sccMemberAssetIds: [] },
        },
        reserveStatus: notApplicableStatus("v9.reserve.not-applicable"),
        reserveExposures: [],
        reserveResiduals: [],
        exitStatus: notApplicableStatus("v9.exit.not-applicable"),
        exitRoutes: [],
        controlStatus: notApplicableStatus("v9.control.not-applicable"),
        controls: [],
        economicControlReview: {
          mint: {
            status: notApplicableStatus("v9.control.mint.not-applicable"),
            controlKey: null,
            reconciliation: "not-applicable",
            supervision: "unknown",
            latestResolvedIncidentAtSec: null,
            upgrade: { state: "not-applicable", controlKey: null },
          },
          oracle: {
            status: notApplicableStatus("v9.control.oracle.not-applicable"),
            tier: null,
            branches: [],
          },
          bridge: { status: notApplicableStatus("v9.control.bridge.not-applicable"), routes: [] },
        },
        accessReview: {
          transfer: { status: knownStatus("v9.access.transfer"), posture: "permissionless" },
          freeze: { status: notApplicableStatus("v9.access.freeze.not-applicable"), reviews: [] },
        },
        peg: {
          status: knownStatus("v9.peg"),
          pegKey: "peg:usd",
          sourceGenerationId: SOURCES.peg.generationId,
          referenceKind: "fiat",
          referenceKey: "USD",
          methodologyVersion: "fixture-v1",
          pegScore: 99,
          currentDeviationBps: 1,
          activeDepeg: false,
          activeDepegBps: null,
          trackingSpanDays: 365,
          failureDomains: [{ kind: "oracle-feed", key: "peg:fixture" }],
        },
        supply: {
          status: knownStatus("v9.supply"),
          sourceGenerationId: SOURCES.chainSupply.generationId,
          sourceKind: "usd-denominated-circulating",
          circulatingUnits: null,
          referencePriceUsd: null,
          circulatingUsd: 10_000_000,
          chainDistribution: {
            chains: [{ chainId: "chain:fixture", supplyUsd: 10_000_000, supplyShare: 1 }],
            unattributedSupplyUsd: 0,
            unattributedSupplyShare: 0,
          },
          selectedBridgeRoutes: [],
          selectedRouteSupplyShare: 0,
          unknownRouteSupplyShare: 0,
          unreviewedRouteSupplyShare: 0,
          failureDomains: [{ kind: "chain", key: "chain:fixture" }],
        },
      },
    ],
  };
}

/**
 * One asset whose only gap is a deployment-scoped control identity gap, as the
 * fact-set builder emits it for a bridge control with unresolved authority or
 * economic semantics. A null materialSupplyShare models the unmatched targets
 * whose deployment share cannot be attributed.
 */
function deploymentControlFactSetCore(
  deploymentKey: string,
  materialSupplyShare: number | null,
): V9FactSetCoreV3 {
  const core = factSetCore();
  const asset = core.assets[0]!;
  const controlKey = `bridge-supply:${asset.assetId}`;
  const gapId = `${asset.assetId}:gap:deployment-control:${controlKey}`;
  asset.gaps = [
    {
      gapId,
      reasonCode: "unresolved-control-identity",
      ownerDomain: "control",
      policyRuleId: "v9.control.review",
      observationState: "bounded-unknown",
      path: { kind: "deployment-control", deploymentKey, controlKey },
      message: "The control inventory is known, but this control's authority remains unresolved.",
      evidenceRefIds: [EVIDENCE.evidenceId],
      responsibility: "unresearched",
      causeProof: { cause: "U", reason: "not-yet-researched", evidenceRefIds: [] },
      causeScope: { pillar: "control", componentKey: controlKey, factorKey: "authority", routeKey: null, exposureId: null, requiredDatum: "control-authority" },
    },
  ];
  asset.implementation.status = knownStatus("v9.implementation.launch-date");
  asset.implementation.launchedAtSec = 500;
  asset.controlStatus = knownStatus("v9.control.review");
  asset.controls = [
    {
      controlKey,
      deploymentKey,
      sourceGenerationId: SOURCES.researchOverlays.generationId,
      controlKind: "bridge",
      scope: "deployment",
      status: {
        applicability: {
          state: "required" as const,
          policyRuleId: "v9.control.review",
          rationale: null,
          gapId: null,
        },
        observationState: "bounded-unknown" as const,
        evidenceRefIds: [EVIDENCE.evidenceId],
        gapIds: [gapId],
      },
      capabilities: [],
      capSemantics: { kind: "unknown", bound: null },
      claimImpairment: "unknown",
      economicLossScope: "deployment",
      authority: { authorityKey: `bridge-route:${deploymentKey}`, model: "unknown", threshold: null },
      delaySec: null,
      materialSupplyShare,
      keyCustody: "unknown",
      modulesOrGuards: "unknown",
      incidentState: "unknown",
      failureDomains: [{ kind: "bridge-route", key: deploymentKey }],
    },
  ];
  return core;
}

function factSetV3WithResponsibility(responsibility: V9EvidenceResponsibility) {
  const core = structuredClone(factSetCore());
  const { evidenceHistory: _history, ...gap } = core.assets[0]!.gaps[0]!;
  core.assets[0]!.gaps[0] = createV9FactGapV3({ ...gap, responsibility });
  return compileV9FactSetV3(core);
}

/**
 * Alpha from the shared fixture retains an exit route, so the DEX coverage
 * label is admitted (the zero-route veto stays untouched). The gap is appended
 * where the producer emits it, so the rest of alpha's census stays intact.
 */
function coverageLabelFactSetCore(): V9FactSetCoreV3 {
  const compiled = compileNativeV3FactSet(coreFixture());
  const { v9FactSetDigest: _digest, ...core } = structuredClone(compiled) as unknown as V9FactSetCoreV3 & {
    v9FactSetDigest: string;
  };
  const asset = core.assets.find((candidate) => candidate.assetId === "alpha")!;
  const gapId = "alpha:gap:exit-portfolio-coverage";
  asset.gaps.push(createV9FactGapV3({
    gapId,
    reasonCode: "incomplete-dex-route-coverage",
    ownerDomain: "exit",
    policyRuleId: "v9.exit.same-notional-route",
    observationState: "bounded-unknown",
    responsibility: "unresearched",
    path: { kind: "local-component", componentKey: "exit-portfolio-coverage" },
    message: "Reviewed DEX execution-capability pools do not all carry score-eligible exact route observations.",
    evidenceRefIds: [],
    causeScope: {
      pillar: "exit",
      componentKey: "exit-portfolio-coverage",
      factorKey: null,
      routeKey: null,
      exposureId: null,
      requiredDatum: "dex-route-coverage",
    },
  }));
  asset.exitStatus = {
    applicability: { state: "required", policyRuleId: "v9.exit.same-notional-route", rationale: null, gapId: null },
    observationState: "bounded-unknown",
    evidenceRefIds: [asset.evidence[0]!.evidenceId],
    gapIds: [gapId],
  };
  return core;
}

describe("Safety Score v9 evidence-gap queue", () => {
  it("matches every nested status location against an independent structural census", () => {
    const asset: V9FactSetCoreV3["assets"][number] =
      structuredClone(compileNativeV3FactSet(coreFixture()).assets[0]!);
    const status = asset.implementation.status;
    const review = asset.mechanismRiskReview.review;
    if (review?.archetype !== "fiat-cash") throw new Error("Expected fiat-cash fixture");
    review.claimAndSegregation = {
      ...review.claimAndSegregation,
      constraints: [{ factKey: "constraint", quality: "strong", status }],
      scopedAssessments: [{ scopeId: "scope", share: 1, quality: "strong", status }],
    };
    asset.lenderBook = { status, acceptedSourceStatus: status, latestAttemptStatus: status,
      observation: null, collaterals: [] };
    asset.reserveExposures[0]!.factorStatuses = { assetClass: status };
    asset.reserveResiduals = [{ residualId: "residual", weight: 0.1, status }];
    asset.reserveBoundFacts = [{
      status, sourceGenerationId: "research:g1", freshnessMaxAgeSec: 200, rejectionReason: null,
      fact: { factKey: "bound", kind: "maturity-applicability", scope: { kind: "exposure", exposureKey: "exposure:cash" },
        asOfSec: 900, publisher: "fixture", sourceUrls: ["https://example.com/bound"], assertion: "Open-ended claim.",
        contentDigest: "a".repeat(64), claimId: "claim", conclusion: "open-ended", governingInstrument: "terms",
        allInScope: true, provenance: { kind: "reviewed-research", reviewedAt: "1970-01-01", reviewer: "fixture", confidence: "high" } },
    }];
    asset.exitRoutes[0]!.factorStatuses = { capacity: status };
    asset.controls[0]!.factorStatuses = { authority: status };
    asset.wrapperLocalFacts = {
      schemaVersion: 1, applicability: "wrapper", form: "pure", formDisposition: "unresearched",
      formStatus: status, formSignals: [], formEvidenceRefIds: [],
    };
    asset.economicControlReview.mint.factorStatuses = { reconciliation: status };
    asset.economicControlReview.oracle.factorStatuses = { tier: status };
    asset.economicControlReview.oracle.branches = [{ branch: "collateral-parameter", status,
      controlKey: null, mechanismKey: null, inheritedFromAssetId: null }];
    asset.economicControlReview.bridge.factorStatuses = { tier: status };
    asset.economicControlReview.bridge.routes = [{ controlKey: "bridge", tier: "opaque-or-unknown", factorStatuses: { tier: status } }];
    const identity = { chainId: "ethereum", claimAddress: "claim" };
    asset.accessReview.freeze.reviews = [{ reviewKey: "freeze", source: "freeze", status,
      reach: "none", controlKey: null, upstreamAssetId: null, failureDomains: [] }];
    asset.accessReview.freeze.claimGraph = {
      assetId: asset.assetId, graphKey: "graph", rootNodeKey: "node", clockSec: AS_OF_SEC, generationId: BASE_INPUT_GENERATION_ID,
      nodes: [{ nodeKey: "node", identity, assetId: asset.assetId, noCurrentReach: true, status }],
      edges: [{ edgeKey: "edge", fromNodeKey: "node", toNodeKey: "node", kind: "reserve-position",
        positionKey: "position", partitionKey: "partition", basis: { kind: "selected-observation" },
        reachesHeldClaim: false, enabled: true, weight: 1, status }],
      authorities: [{ authorityKey: "authority", nodeKey: "node", actingDeployment: identity,
        controllerKey: null, capability: "freeze", reach: "none", failureDomains: [], status }],
      partitions: [{ partitionKey: "partition", nodeKey: "node", disjoint: true, complete: true,
        denominatorEstablished: true, status }],
      unresolved: [{ branchKey: "branch", nodeKey: "node", reason: "research-incomplete", responsibility: "unresearched", status }],
    };
    const structuralStatuses = (value: unknown): V9FactStatusV2[] => {
      const parsed = V9FactStatusV2Schema.safeParse(value);
      if (parsed.success) return [parsed.data];
      return value !== null && typeof value === "object" ? Object.values(value).flatMap(structuralStatuses) : [];
    };
    const rows = factStatuses(asset);
    expect(rows.map(row => JSON.stringify(row.status)).sort()).toEqual(
      structuralStatuses(asset).map(status => JSON.stringify(status)).sort(),
    );
    expect(rows.map(row => row.label).sort()).toEqual([
      "implementation", "mechanism-review", "dependencies", "reserve-envelope",
      "mechanism-review:claimAndSegregation", "mechanism-review:custodyContinuity",
      "mechanism-review:assuranceAndReconciliation",
      "mechanism-review:claimAndSegregation:factor:constraint", "mechanism-review:claimAndSegregation:scope:scope",
      "lenderBook", "lenderBook:accepted-source", "lenderBook:latest-attempt",
      ...asset.reserveExposures.map(row => `reserve:${row.exposureKey}`),
      `reserve:${asset.reserveExposures[0]!.exposureKey}:assetClass`, "residual:residual", "reserve-bound:bound",
      "exit-envelope", ...asset.exitRoutes.flatMap(row => [`route:${row.routeKey}`, `route-output:${row.routeKey}`]),
      `route:${asset.exitRoutes[0]!.routeKey}:capacity`,
      "control-envelope",  ...asset.controls.map(row => `control:${row.controlKey}`),
      `control:${asset.controls[0]!.controlKey}:authority`,
      "wrapper:form",
      "economic-control:mint", "economic-control:mint:reconciliation", "economic-control:oracle",
      "economic-control:oracle:tier", "economic-control:oracle:collateral-parameter", "economic-control:bridge",
      "economic-control:bridge:tier", "economic-control:bridge:bridge:tier", "access:transfer", "access:freeze",
      "access:freeze:freeze", "access:graph:node:node", "access:graph:edge:edge",
      "access:graph:authority:authority", "access:graph:partition:partition", "access:graph:unresolved:branch",
      "peg", "supply",
    ].sort());
    const { wrapperLocalFacts: _wrapper, reserveResiduals: _residuals, ...historical } = asset;
    expect(factStatuses(historical).some(row => row.label.startsWith("wrapper:") || row.label.startsWith("residual:"))).toBe(false);
  });

  it.each([false, true])("keeps mixed shared-gap applicability unresolved with unresolved-first=%s", (unresolvedFirst) => {
    const core = factSetCore();
    const asset = core.assets[0]!;
    const original = asset.implementation.status;
    const status: V9FactStatusV2 = { ...original,
      applicability: {
        state: "unresolved", policyRuleId: original.applicability.policyRuleId, rationale: "Applicability remains unresolved.",
        gapId: original.gapIds[0]!,
      } };
    asset.implementation.status = unresolvedFirst ? status : original;
    asset.lenderBook = { status: unresolvedFirst ? original : status,
      acceptedSourceStatus: original, observation: null, collaterals: [] };
    const queue = buildV9EvidenceGapQueue({ factSet: compileV9FactSetV3(core), policy: loadV9MethodologyPolicy(policyAsset) });
    expect(queue.entries).toHaveLength(1);
    expect(queue.entries[0]).toMatchObject({ applicability: "unresolved", cause: "U", action: "resolve-applicability" });
  });

  it("collects lender collateral, accepted-source and latest-attempt gaps from their fact statuses", () => {
    const core = factSetCore();
    const asset = core.assets[0]!;
    const rule = "v10.19.backing.lender-collateral-book";
    // The first component is the armusdcs-wintermute market/account that made
    // both sweep generators fail: the compiler status was valid but unvisited.
    const components = [
      "lender-collateral:ethereum:0xbbbbbbbbbb9cc5e90e3b3af64bdaf62c37eeffcb:0xecabc12c73a97c766d0c6aeb4c15c635630d78158b2ac8370455a09efcc50837:0x3b9e060a2b05588126fda01b95e9485687fc91d7",
      "lender-collateral-accepted-source",
      "lender-book-latest-attempt",
    ];
    const statuses = components.map(componentKey => {
      const gapId = `${asset.assetId}:gap:${componentKey}`;
      asset.gaps.push(createV9FactGapV3({
        gapId, reasonCode: "partial-reserve-review", ownerDomain: "backing",
        policyRuleId: rule, observationState: "missing", responsibility: "unresearched",
        causeScope: { pillar: "backing", componentKey, factorKey: null, routeKey: null,
          exposureId: null, requiredDatum: componentKey },
        path: { kind: "local-component", componentKey },
        message: "Frozen lender-book evidence is unavailable.", evidenceRefIds: [],
      }));
      return { ...knownStatus(rule), observationState: "missing" as const, evidenceRefIds: [], gapIds: [gapId] };
    });
    asset.lenderBook = {
      status: statuses[0]!, acceptedSourceStatus: statuses[1]!, latestAttemptStatus: statuses[2]!,
      observation: null, collaterals: [],
    };
    const factSet = compileV9FactSetV3(core);
    const queue = buildV9EvidenceGapQueue({ factSet, policy: loadV9MethodologyPolicy(policyAsset) });
    for (const status of statuses) {
      expect(queue.entries).toContainEqual(expect.objectContaining({
        gapId: status.gapIds[0], applicability: "required", action: "collect-evidence",
      }));
    }
  });

  it("derives policy, applicability, materiality, owner, and action from typed facts", () => {
    const factSet = compileV9FactSetV3(
      factSetCore("This message deliberately says unsupported but is not classified."),
    );
    const queue = buildV9EvidenceGapQueue({ factSet, policy: loadV9MethodologyPolicy(policyAsset) });

    expect(V9EvidenceGapQueueV3Schema.parse(queue)).toEqual(queue);
    expect(queue).toMatchObject({
      schemaVersion: 4,
      purpose: "evidence-work-queue-not-release-gate",
      status: "work-required",
      facts: {
        sourceSchemaVersion: 4,
        sourceFactSetDigest: factSet.v9FactSetDigest,
      },
      summary: {
        gapCount: 1,
        criticalGapCount: 0,
        knownSupplyWeightGapCount: 1,
        policyBindingMismatchGapCount: 0,
        responsibilityCounts: expect.arrayContaining([
          { responsibility: "unresearched", count: 1 },
          { responsibility: "issuer-undisclosed", count: 0 },
          { responsibility: "measured-adverse", count: 0 },
          { responsibility: "method-unsupported", count: 0 },
          { responsibility: "producer-failed", count: 0 },
        ]),
      },
    });
    expect(queue.facts.evaluationFactSetDigest).toBe(queue.facts.sourceFactSetDigest);
    expect(queue.entries[0]).toMatchObject({
      priority: 1,
      assetId: "asset-001",
      reasonCode: "missing-implementation-date",
      ownerDomain: "evidence",
      factOwnerDomain: "evidence",
      policyBindingIssues: [],
      applicability: "required",
      observationState: "missing",
      action: "collect-evidence",
      responsibility: "unresearched",
      releaseSeverity: "review-required",
      critical: false,
      materiality: { basis: "asset-wide", fractionOfAsset: 1 },
      supplyWeight: { state: "current-valid", canonicalUsd: 10_000_000, materialityWeightedUsd: 10_000_000 },
    });
    expect(parseV9EvidenceGapQueue(queue)).toEqual(queue);
    expect(buildV9EvidenceGapQueue({ factSet, policy: loadV9MethodologyPolicy(policyAsset) }).queueDigest).toBe(
      queue.queueDigest,
    );
  });

  it.each([
    "issuer-undisclosed",
    "integration-missing",
    "producer-failed",
    "method-unsupported",
    "measured-adverse",
  ] as const)("does not treat an unproven historical %s label as a cause", (responsibility) => {
    const factSet = factSetV3WithResponsibility(responsibility);
    const queue = buildV9EvidenceGapQueue({ factSet, policy: loadV9MethodologyPolicy(policyAsset) });

    expect(queue.facts).toMatchObject({
      sourceSchemaVersion: 4,
      sourceFactSetDigest: factSet.v9FactSetDigest,
      evaluationFactSetDigest: factSet.v9FactSetDigest,
    });
    expect(queue.entries[0]?.responsibility).toBe("unresearched");
    expect(queue.entries[0]?.cause).toBe("U");
  });

  it("surfaces fact-to-policy ownership drift as reconciliation work", () => {
    const core = factSetCore();
    core.assets[0]!.gaps[0]!.ownerDomain = "control";
    const queue = buildV9EvidenceGapQueue({
      factSet: compileV9FactSetV3(core),
      policy: loadV9MethodologyPolicy(policyAsset),
    });

    expect(queue.summary.policyBindingMismatchGapCount).toBe(1);
    expect(queue.entries[0]).toMatchObject({
      ownerDomain: "evidence",
      factOwnerDomain: "control",
      policyBindingIssues: ["fact-owner-domain-mismatch"],
      action: "reconcile-policy-binding",
    });
  });

  it.each([
    ["registered chain/address", "eip155:1:0x0000000000000000000000000000000000000001", 0.25],
    ["unmatched chain", "unmatched-chain:asset-001", 0.25],
    ["unmatched chain/label/pool", "unmatched-chain-label-pool:asset-001", null],
  ] as const)(
    "admits a %s deployment-control target as a closure path without closing the fact",
    (_label, deploymentKey, materialSupplyShare) => {
      const core = deploymentControlFactSetCore(deploymentKey, materialSupplyShare);
      const queue = buildV9EvidenceGapQueue({
        factSet: compileV9FactSetV3(core),
        policy: loadV9MethodologyPolicy(policyAsset),
      });

      expect(queue.summary.policyBindingMismatchGapCount).toBe(0);
      expect(queue.entries[0]).toMatchObject({
        reasonCode: "unresolved-control-identity",
        ownerDomain: "control",
        factOwnerDomain: "control",
        path: { kind: "deployment-control", deploymentKey },
        policyBindingIssues: [],
      });
      // Admitting the path kind decides where the fact may close, not that it
      // has closed: the row keeps its unresolved observation state and gains no
      // evidence beyond what the unresolved control already carried.
      expect(queue.entries[0]).toMatchObject({
        observationState: "bounded-unknown",
        action: "collect-evidence",
        cause: "U",
        evidenceRefIds: [EVIDENCE.evidenceId],
        documentation: null,
        reviewState: null,
      });
      expect(queue.entries[0]!.materiality).toEqual(
        materialSupplyShare === null
          ? { basis: "unresolved", fractionOfAsset: null }
          : { basis: "deployment-supply-share", fractionOfAsset: materialSupplyShare },
      );
    },
  );

  it("joins the bridge diagnostics and names the failing row on a bridge-scoped entry", () => {
    // ODR-D5a. The queue used to carry neither the producer's bridge join
    // diagnostics nor any hint of which supply row failed the completeness
    // proof, so a bridge work item read as "some residue is unattributed".
    const deploymentKey = "eip155:1:0x0000000000000000000000000000000000000001";
    const core = deploymentControlFactSetCore(deploymentKey, 0.00002);
    const asset = core.assets[0]!;
    const controlKey = `bridge-supply:${asset.assetId}`;
    // A sub-threshold bounded-unknown control with a reconciled share now proves
    // its row; a share that does not reconcile with the row keeps the proof open.
    asset.controls.find((control) => control.controlKey === controlKey)!.materialSupplyShare = 0.00005;
    const diagnostics = {
      profileRouteCount: 2,
      canonicalSupplyRowCount: 2,
      unmatchedRowIdentities: ["icp"],
      reviewedNativeCoverage: {
        reviewedRowCount: 1,
        canonicalSupplyRowCount: 2,
        supplyShare: 0.99997,
        complete: false,
      },
      bridgeClaimControls: [controlKey],
      applicabilityBranch: "applicable" as const,
      unprovenRouteJoins: [
        {
          deploymentRouteKey: deploymentKey,
          reviewState: "selected-reviewed" as const,
          reviewedRouteKind: "controlled" as const,
          supplyShare: 0.00002,
          joinedControlKeys: [controlKey],
          joinedControlSemanticsResolved: false,
          joinedControlSupplyShare: 0.00002,
        },
      ],
    };
    asset.supply.selectedBridgeRoutes = [
      {
        deploymentRouteKey: "ethereum:native",
        supplyUsd: 9_999_700,
        supplyShare: 0.99997,
        reviewState: "selected-reviewed",
        reviewedRouteKind: "native",
      },
      {
        deploymentRouteKey: deploymentKey,
        supplyUsd: 200,
        supplyShare: 0.00002,
        reviewState: "selected-reviewed",
        reviewedRouteKind: "controlled",
      },
      {
        deploymentRouteKey: "unmatched-chain:asset-001:icp",
        supplyUsd: 100,
        supplyShare: 0.00001,
        reviewState: "unmatched",
      },
    ];
    asset.supply.selectedRouteSupplyShare = 0.99999;
    asset.supply.unknownRouteSupplyShare = 0.00001;
    asset.supply.unreviewedRouteSupplyShare = 0;
    asset.economicControlReview.bridge = {
      status: knownStatus("v9.control.bridge-review"),
      routes: [{ controlKey, tier: "external-validated-network" }],
      diagnostics,
    };

    const queue = buildV9EvidenceGapQueue({
      factSet: compileV9FactSetV3(core),
      policy: loadV9MethodologyPolicy(policyAsset),
    });

    const entry = queue.entries[0]!;
    expect(entry.reasonCode).toBe("unresolved-control-identity");
    // (a) the producer's diagnostics now reach the terse queue verbatim.
    expect(entry.bridgeJoin?.diagnostics).toEqual(diagnostics);
    // (b) the completeness proof names the row it failed on.
    expect(entry.bridgeJoin?.subthresholdUnresolvedJoin).toEqual({
      complete: false,
      cause: {
        code: "reviewed-row-control-unproven",
        deploymentRouteKey: deploymentKey,
        reviewState: "selected-reviewed",
        reviewedRouteKind: "controlled",
        supplyShare: 0.00002,
        controlKeys: [controlKey],
      },
    });
    expect(V9EvidenceGapQueueV3Schema.parse(queue)).toEqual(queue);
  });

  it("leaves bridgeJoin null on a gap that is not bridge-scoped", () => {
    const queue = buildV9EvidenceGapQueue({
      factSet: compileV9FactSetV3(factSetCore()),
      policy: loadV9MethodologyPolicy(policyAsset),
    });
    expect(queue.entries[0]!.reasonCode).toBe("missing-implementation-date");
    expect(queue.entries[0]!.bridgeJoin).toBeNull();
  });

  it("surfaces fact-to-policy archetype drift as reconciliation work", () => {
    const core = factSetCore();
    core.assets[0]!.gaps[0]!.reasonCode = "incomplete-oracle-liquidation-branch";
    core.assets[0]!.gaps[0]!.ownerDomain = "control";
    const queue = buildV9EvidenceGapQueue({
      factSet: compileV9FactSetV3(core),
      policy: loadV9MethodologyPolicy(policyAsset),
    });

    expect(queue.summary.policyBindingMismatchGapCount).toBe(1);
    expect(queue.entries[0]).toMatchObject({
      archetype: "algorithmic",
      ownerDomain: "control",
      factOwnerDomain: "control",
      path: { kind: "local-component" },
      policyBindingIssues: ["archetype-not-permitted"],
      action: "reconcile-policy-binding",
    });
  });

  it.each([
    ["missing-pillar-evidence", "evidence"],
    ["missing-access-review", "control"],
  ] as const)("keeps %s %s-owned and locally bound", (reasonCode, ownerDomain) => {
    const core = factSetCore();
    core.assets[0]!.gaps[0]!.reasonCode = reasonCode;
    core.assets[0]!.gaps[0]!.ownerDomain = ownerDomain;
    const queue = buildV9EvidenceGapQueue({
      factSet: compileV9FactSetV3(core),
      policy: loadV9MethodologyPolicy(policyAsset),
    });

    expect(queue.summary.policyBindingMismatchGapCount).toBe(0);
    expect(queue.entries[0]).toMatchObject({
      reasonCode,
      ownerDomain,
      factOwnerDomain: ownerDomain,
      path: { kind: "local-component" },
      policyBindingIssues: [],
      action: "collect-evidence",
    });
  });

  it("flags a DEX coverage label as documentation and keeps the datum counted and addressable", () => {
    const core = coverageLabelFactSetCore();
    const inputGapCount = core.assets.reduce((total, asset) => total + asset.gaps.length, 0);
    const queue = buildV9EvidenceGapQueue({
      factSet: compileV9FactSetV3(core),
      policy: loadV9MethodologyPolicy(policyAsset),
    });
    const entry = queue.entries.find((candidate) => candidate.gapId === "alpha:gap:exit-portfolio-coverage")!;

    expect(entry.documentation).toEqual({
      class: "documentation",
      reason: "coverage-label",
      policyRef: "semantic.evidence.documentation.reasons.coverage-label",
      threshold: null,
    });
    expect(isV9DocumentationGapEntry(entry)).toBe(true);
    expect(entry.reviewState).toBeNull();
    // Documentation work leaves the default drain, never the queue: the datum
    // keeps its address and priority and the census still counts it.
    expect(queue.entries).toContain(entry);
    expect(entry.priority).toBeGreaterThan(0);
    expect(queue.summary.gapCount).toBe(inputGapCount);
    expect(queue.summary.documentationGapCount).toBe(queue.entries.filter(isV9DocumentationGapEntry).length);
    expect(queue.summary.documentationReasonCounts.map((row) => row.reason)).toEqual([
      ...V9DocumentationReasonSchema.options,
    ]);
    expect(queue.summary.documentationReasonCounts.find((row) => row.reason === "coverage-label")!.count).toBe(1);
    expect(queue.summary.documentationReasonCounts.reduce((total, row) => total + row.count, 0)).toBe(
      queue.summary.documentationGapCount,
    );
    expect(queue.summary.researchedTerminalGapCount).toBe(0);
  });

  it("dates the issuer researched-terminal recheck one research horizon after the proof's review", () => {
    const maxAgeSec = loadV9MethodologyPolicy(policyAsset).policy.semantic.evidence.evidenceExpiry
      .reviewedResearchMaxAgeSec;
    expect(maxAgeSec).toBe(31_536_000);
    const proof = {
      cause: "C" as const,
      classificationId: "fixture:issuer-nondisclosure",
      assertion: "researched-nondisclosure" as const,
      reviewedAt: "2026-10-03T00:00:00Z",
      reviewer: "fixture",
      searchedSurfaces: ["https://issuer.example/terms"],
      rationale: "The issuer does not publish the required datum.",
      sources: [{
        url: "https://issuer.example/terms",
        observedAt: "2026-10-03T00:00:00Z",
        datumAsOf: null,
        location: "Terms",
        excerpt: "The required datum is not published.",
        assertion: "The required datum is not published.",
      }],
      evidenceRefIds: ["evidence:research"],
    };

    expect(v9ResearchedTerminalReviewState(proof, maxAgeSec)).toEqual({
      state: "researched-terminal",
      reviewedAtSec: Date.parse("2026-10-03T00:00:00Z") / 1_000,
      recheckAtSec: Date.parse("2026-10-03T00:00:00Z") / 1_000 + 31_536_000,
      trigger: "cause-proof-expiry",
    });
    // A date-only review keeps the same UTC-day pin, and a non-issuer proof
    // stays in the default drain.
    expect(v9ResearchedTerminalReviewState(
      { ...proof, reviewedAt: "2026-10-03" },
      maxAgeSec,
    )?.recheckAtSec).toBe(Date.parse("2026-10-03T00:00:00Z") / 1_000 + 31_536_000);
    expect(v9ResearchedTerminalReviewState(
      { cause: "B", classificationId: "fixture", assertion: "required-data-public", reviewedAt: "2026-10-03T00:00:00Z",
        reviewer: "fixture", sources: proof.sources, evidenceRefIds: ["evidence:research"] },
      maxAgeSec,
    )).toBeNull();
    expect(v9ResearchedTerminalReviewState(
      { cause: "U", reason: "not-yet-researched", evidenceRefIds: [] },
      maxAgeSec,
    )).toBeNull();
  });
});
