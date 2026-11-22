import { describe, expect, it, vi } from "vitest";
import {
  AS_OF_SEC,
  SOURCE_FINGERPRINTS,
  V9_CANDIDATE_POLICY_V1,
  canonicalV9DependencyEdgeKey,
  compileNativeV3FactSet,
  compileV9FactSetV2,
  compileV9FactSetV3,
  createV9EvidenceReference,
  createV9FactStatus,
  createV9FactGap,
  createV9FactGapV3,
  evaluateV9FactSet,
  knownStatus,
  mechanismFact,
  minimalAsset,
  projectV9ExitEvaluationRoute,
  requiredV9Applicability,
  coreFixture,
  resolveV9DistinctExitCapacity,
} from "./safety-score-v9-facts.fixture-support";
import type { V9AssetFactsV2, V9AssetFactsV3 } from "./safety-score-v9-facts.fixture-support";
import { bridgeControl, bridgeSupplyRow, commonDomainFixture, staleBridgeStatus, unresolvedArchetype } from "./safety-score-v9-facts.test-support";
import { resolveV9EvidenceCause } from "../safety-score-v9/evidence";
import { CompiledV9FactSetV3Schema, V9AssetFactsV3Schema } from "../../types/safety-score-v9-facts";
import { buildV9EvidenceGapQueue } from "../safety-score-v9/evidence-gap-queue";
import { unknownQuality } from "../safety-score-v9/policy";
import { projectSafetyScoreV9Card } from "../safety-score-v9/public";
import { computeV9UnknownPricedWeightShare } from "../../types/safety-score-v9-public-breakdowns";
import * as backingArchetypes from "../safety-score-v9/archetypes";

const P = V9_CANDIDATE_POLICY_V1;
type V3Core = Omit<ReturnType<typeof CompiledV9FactSetV3Schema.parse>, "v9FactSetDigest">;
type EvalResult = ReturnType<typeof evaluateV9FactSet>;

const mutableNativeFactSet = () => CompiledV9FactSetV3Schema.parse(compileNativeV3FactSet(coreFixture()));
const nativeCore = (assetId = "alpha") => {
  const { v9FactSetDigest: _digest, ...core } = mutableNativeFactSet();
  return { core, asset: core.assets.find((r) => r.assetId === assetId)! };
};
const evalCoreAll = (core: V3Core) => evaluateV9FactSet(compileV9FactSetV3(core), P);
const evalCore = (core: V3Core, assetId = "alpha") => evalCoreAll(core).assets.find((r) => r.assetId === assetId)!;
const evalInput = (input: ReturnType<typeof coreFixture>) => evaluateV9FactSet(compileNativeV3FactSet(input), P);
const evalInputAsset = (input: ReturnType<typeof coreFixture>, assetId = "alpha") =>
  evalInput(input).assets.find((r) => r.assetId === assetId)!;
const assetById = (evaluated: EvalResult, assetId: string) => evaluated.assets.find((a) => a.assetId === assetId)!;
const depSignal = (evaluated: EvalResult, assetId: string, domainKey: string) =>
  assetById(evaluated, assetId).scoreInput.dependencyStructuralSignals.find((s) => s.failureDomainKeys.includes(domainKey));

const reqStatus = (
  rule: string,
  observationState: Parameters<typeof createV9FactStatus>[0]["observationState"],
  gapIds: string[],
  evidenceRefIds: string[] = ["evidence:base"],
) => createV9FactStatus({ applicability: requiredV9Applicability(rule), observationState, gapIds, evidenceRefIds });

const manualSerialDeps = (
  upstreamAssetId: string,
  failureDomains: Array<{ kind: "mint-control"; key: string }>,
) => ({
  status: knownStatus(),
  sourceGenerationId: SOURCE_FINGERPRINTS.researchOverlays.generationId,
  source: "manual" as const, baseSource: "manual" as const,
  dependencyFromLive: false, mappedLiveReserveWeight: null, fallbackReason: null,
  edges: [{
    edgeKey: canonicalV9DependencyEdgeKey("mechanism", upstreamAssetId),
    upstreamAssetId, dependencyType: "mechanism" as const, pathKind: "serial-dependency" as const,
    weight: 1, economicRole: "serial-claim" as const, evidenceRefIds: ["evidence:base"], failureDomains,
  }],
  diagnostics: { graphState: "valid" as const, issueCodes: [], sccMemberAssetIds: [] },
});

it("rejects a known ordinary reserve with a missing asset class marked not applicable", () => {
  const asset = mutableNativeFactSet().assets.find((r) => r.assetId === "alpha")!;
  const exposure = asset.reserveExposures.find((r) => r.exposureKey === "exposure:cash")!;
  exposure.assetClass = null;
  exposure.factorStatuses = {
    ...exposure.factorStatuses,
    assetClass: { ...exposure.status, applicability: { state: "not-applicable", policyRuleId: "fixture.reserve-class", rationale: "Fixture", gapId: null } },
  };
  expect(V9AssetFactsV3Schema.safeParse(asset).error?.issues ?? []).toContainEqual(
    expect.objectContaining({ path: ["reserveExposures", expect.any(Number), "assetClass"] }),
  );
});

function certifyGap(asset: V9AssetFactsV3, gap: V9AssetFactsV3["gaps"][number], cause: "A" | "C") {
  if (gap.path.kind !== "local-component") throw new Error("Fixture proof requires an exact local component");
  const scope = {
    pillar: gap.ownerDomain === "backing" ? ("backing" as const) : gap.ownerDomain === "exit" ? ("exit" as const) : ("control" as const),
    componentKey: gap.path.componentKey, factorKey: null, routeKey: null, exposureId: null, requiredDatum: gap.policyRuleId,
  };
  gap.causeScope = scope;
  if (cause === "C") {
    const resolved = resolveV9EvidenceCause({
      assetId: asset.assetId, scope, asOfSec: AS_OF_SEC, sourceGenerationId: "fixture:research", evidenceReferences: asset.evidence,
      classification: {
        id: `classification:${gap.gapId}`, assetId: asset.assetId, scope, cause,
        reviewedAt: "1970-01-01T00:10:00Z", reviewer: "fixture-reviewer",
        sources: [{ url: "https://issuer.example/disclosure", observedAt: "1970-01-01T00:08:20Z", datumAsOf: null, location: "Disclosure section", excerpt: "The required datum is omitted.", assertion: "Required datum is not disclosed" }],
        assertion: "researched-nondisclosure", searchedSurfaces: ["https://issuer.example/disclosure"], rationale: "Fixture reviewer searched the required issuer surface.",
      },
    });
    if (resolved.causeProof.cause !== "C") throw new Error("Fixture C proof was not admitted");
    gap.causeProof = resolved.causeProof;
    gap.evidenceRefIds = resolved.causeProof.evidenceRefIds;
    gap.responsibility = resolved.responsibility;
    asset.evidence.push(...resolved.evidenceReferences.filter((r) => gap.evidenceRefIds.includes(r.evidenceId)));
    return;
  }
  const evidenceId = `proof:${gap.gapId}`;
  gap.evidenceRefIds = [evidenceId];
  gap.responsibility = "producer-failed";
  gap.causeProof = {
    cause, sourceId: "registry", sourceGenerationId: SOURCE_FINGERPRINTS.registry.generationId,
    observedAtSec: 800, evidenceRefIds: [evidenceId], rejectionCode: "fixture-reader-failure", producerState: "producer-failed",
  };
  asset.evidence.push(createV9EvidenceReference({
    evidenceId, sourceId: "registry", sourceGenerationId: SOURCE_FINGERPRINTS.registry.generationId,
    disposition: "rejected", observedAtSec: 800, maxAgeSec: 365 * 86400,
    rejection: { code: "fixture-reader-failure", reason: "Captured failed reader", rejectedAtSec: 800 },
    causeBinding: { assetId: asset.assetId, scope, adverseFactId: null, producerState: "producer-failed", rejectionCode: "fixture-reader-failure" },
  }, AS_OF_SEC));
}

function exitFactorGap(
  asset: V9AssetFactsV3,
  route: V9AssetFactsV3["exitRoutes"][number],
  cause: "A" | "B" | "C",
  factorKey: "cost" | "settlement" | "observationConfidence" = "cost",
) {
  const gap = createV9FactGapV3({
    gapId: `alpha:gap:${route.routeKey}:${factorKey}`, reasonCode: "missing-same-notional-route", ownerDomain: "exit",
    policyRuleId: "v9.exit.route-factors", observationState: "missing",
    path: { kind: "local-component", componentKey: "exit-route" },
    message: `The route ${factorKey} factor is not admitted.`, responsibility: "unresearched",
  });
  const scope = { pillar: "exit" as const, componentKey: "exit-route", factorKey, routeKey: route.routeKey, exposureId: null, requiredDatum: factorKey };
  if (cause === "A") {
    certifyGap(asset, gap, cause);
    asset.evidence.find((r) => r.evidenceId === gap.evidenceRefIds[0])!.causeBinding!.scope = scope;
  } else {
    const reviewedAt = new Date(AS_OF_SEC * 1_000).toISOString().replace(".000Z", "Z");
    const resolved = resolveV9EvidenceCause({
      assetId: asset.assetId, scope, asOfSec: AS_OF_SEC,
      sourceGenerationId: SOURCE_FINGERPRINTS.researchOverlays.generationId, evidenceReferences: asset.evidence,
      classification: {
        id: `classification:${gap.gapId}`, assetId: asset.assetId, scope, reviewedAt, reviewer: "fixture-reviewer",
        ...(cause === "C"
          ? { cause, assertion: "researched-nondisclosure" as const, searchedSurfaces: ["https://issuer.example/route-evidence"], rationale: "The required route datum is not disclosed on the reviewed surface." }
          : { cause, assertion: "required-data-public" as const }),
        sources: [{
          url: "https://issuer.example/route-evidence", observedAt: reviewedAt, datumAsOf: null, location: `Route ${factorKey} evidence`,
          excerpt: cause === "C" ? "The issuer does not publish a current execution-cost bound." : `The route ${factorKey} datum is published.`,
          assertion: cause === "C" ? "The required route datum is undisclosed." : `The required route ${factorKey} datum is public but uncurated.`,
        }],
      },
    });
    gap.causeProof = resolved.causeProof;
    gap.evidenceRefIds = resolved.causeProof.evidenceRefIds;
    gap.responsibility = resolved.responsibility;
    asset.evidence = [...resolved.evidenceReferences];
  }
  expect(gap.causeProof.cause).toBe(cause);
  gap.path = { kind: "optional-exit", routeKey: route.routeKey };
  gap.causeScope = scope;
  asset.gaps.push(gap);
  route.factorStatuses = { ...route.factorStatuses, [factorKey]: reqStatus(gap.policyRuleId, "missing", [gap.gapId], gap.evidenceRefIds) };
  return gap;
}

function exitPromotionFixture() {
  const { core, asset } = nativeCore();
  asset.dependencies.edges = [];
  asset.gaps = asset.gaps.filter((g) => g.ownerDomain !== "exit");
  asset.exitRoutes = asset.exitRoutes.filter((r) => r.scoreEligible);
  asset.evidence = asset.evidence.filter((r) => r.evidenceId !== "evidence:rejected-route");
  return { core, asset };
}

describe("Safety Score v9 fact evaluation", () => {
  it.each([
    { absent: ["exit"], included: ["backing", "control"], ratingStatus: "rated" },
    { absent: ["control"], included: ["backing", "exit"], ratingStatus: "rated" },
    { absent: ["exit", "control"], included: ["backing"], ratingStatus: "pipeline-gap" },
  ] as const)("does not count evidence-free $absent subjects toward rating availability", ({ absent, included, ratingStatus }) => {
    const { core, asset } = exitPromotionFixture();
    if (absent.some((p) => p === "exit")) {
      const gap = createV9FactGapV3({
        gapId: "alpha:no-exit-subject", reasonCode: "missing-runtime-route-evidence", ownerDomain: "exit",
        policyRuleId: "exit.routes.review", observationState: "missing", responsibility: "unresearched",
        path: { kind: "local-component", componentKey: "exit-routes" },
        message: "No reviewed route inventory or admitted route establishes an Exit subject.",
      });
      asset.gaps.push(gap);
      asset.exitStatus = reqStatus(gap.policyRuleId, "missing", [gap.gapId], []);
      asset.exitRoutes = [];
      asset.evidence = asset.evidence.filter((r) => r.evidenceId !== "evidence:route");
    }
    if (absent.some((p) => p === "control")) {
      asset.gaps = asset.gaps.filter((g) => g.ownerDomain !== "control");
      const emptyControlAsset = core.assets.find((r) => r.assetId === "beta")!;
      asset.controls = [];
      asset.accessReview = structuredClone(emptyControlAsset.accessReview);
      asset.economicControlReview = structuredClone(emptyControlAsset.economicControlReview);
      for (const [componentKey, reasonCode] of [
        ["inventory", "unresolved-control-identity"], ["mint", "missing-mint-authority"],
        ["oracle", "missing-oracle-profile"], ["bridge", "missing-bridge-routes"],
      ] as const) {
        const gap = createV9FactGapV3({
          gapId: `alpha:no-control-subject:${componentKey}`, reasonCode, ownerDomain: "control",
          policyRuleId: `control.${componentKey}.review`, observationState: "missing", responsibility: "unresearched",
          path: { kind: "local-component", componentKey: `economic-control:${componentKey}` },
          message: "No admitted authority or mechanism review establishes this Control subject.",
        });
        asset.gaps.push(gap);
        const status = reqStatus(gap.policyRuleId, "missing", [gap.gapId], []);
        if (componentKey === "inventory") asset.controlStatus = status;
        else {
          asset.economicControlReview[componentKey].status = status;
          if (componentKey === "mint") asset.economicControlReview.mint.factorStatuses = { reconciliation: status, supervision: status };
          else if (componentKey === "oracle") asset.economicControlReview.oracle.factorStatuses = { tier: status };
          else asset.economicControlReview.bridge.factorStatuses = { tier: status };
        }
      }
    }
    const evaluated = evalCore(core);
    for (const pillar of absent) {
      expect(evaluated[pillar].score).toEqual(expect.any(Number));
      expect(evaluated.scoreInput.pillars[pillar]).toMatchObject({ score: null, aggregationDisposition: "unavailable", supportedComponentKeys: [] });
      expect(evaluated.trace.includedPillars).not.toContain(pillar);
    }
    expect(evaluated.trace.includedPillars).toEqual(expect.arrayContaining([...included]));
    expect(evaluated.trace.includedPillars).toHaveLength(included.length);
    expect(evaluated.trace.ratingStatus).toBe(ratingStatus);
    if (ratingStatus === "rated") {
      expect(evaluated.trace.finalScore).not.toBeNull();
      expect(evaluated.trace.effectiveScoringWeights).toEqual(P.policy.semantic.formula.pillarWeights);
      for (const pillar of absent) {
        expect(evaluated.trace.aggregation?.pricedUnknownPillars).toContainEqual(expect.objectContaining({ pillar, cause: "U", score: unknownQuality(pillar, "U") }));
        expect(evaluated.trace.diagnosticPillarScores[pillar]).toBeNull();
      }
    } else {
      expect(evaluated.trace).toMatchObject({ finalScore: null, finalGrade: null, aggregation: null, effectiveScoringWeights: null });
    }
  });

  it.each(["A", "B"] as const)("publishes no partial flag for a diagnostic-only optional Exit factor (%s)", (cause) => {
    const { core, asset } = exitPromotionFixture();
    const primary = asset.exitRoutes.find((r) => r.lane === "dex")!;
    const alternative = asset.exitRoutes.find((r) => r.lane === "redemption")!;
    alternative.scoreEligible = false;
    alternative.coverageClass = "diagnostic";
    const baseline = evalCore(core);
    const gap = exitFactorGap(asset, alternative, cause);
    const evaluated = evalCore(core);
    expect(evaluated.exit.primaryRouteKey).toBe(primary.routeKey);
    expect(evaluated.exit.routes.find((r) => r.routeKey === alternative.routeKey)).toMatchObject({ included: false, score: null, components: null });
    expect(evaluated.exit.causeGapIds).toContain(gap.gapId);
    expect(evaluated.scoreInput.pillars.exit).toMatchObject({
      causeGapIds: expect.arrayContaining([gap.gapId]), excludedCauseGapIds: [], excludedComponentKeys: [],
    });
    expect([evaluated.trace.partialEvidence, evaluated.trace.limitingPillars, evaluated.trace.nrReasons, evaluated.trace.finalScore, evaluated.trace.finalGrade])
      .toEqual([null, baseline.trace.limitingPillars, baseline.trace.nrReasons, baseline.trace.finalScore, baseline.trace.finalGrade]);
  });

  it.each(["A", "B"] as const)("keeps a diagnostic-only Exit factor out of partial evidence when no route is admitted (%s)", (cause) => {
    const { core, asset } = exitPromotionFixture();
    const alternative = asset.exitRoutes.find((r) => r.lane === "redemption")!;
    asset.exitRoutes = [alternative];
    alternative.scoreEligible = false;
    alternative.coverageClass = "diagnostic";
    const capacityGap = createV9FactGapV3({
      gapId: "alpha:gap:exit:capacity", reasonCode: "missing-same-notional-route", ownerDomain: "exit",
      policyRuleId: "v9.exit.route-factors", observationState: "missing",
      path: { kind: "optional-exit", routeKey: alternative.routeKey },
      causeScope: { pillar: "exit", componentKey: "exit-route", factorKey: "capacity", routeKey: alternative.routeKey, exposureId: null, requiredDatum: "capacity" },
      message: "Executable capacity has not been researched.", responsibility: "unresearched",
    });
    asset.gaps.push(capacityGap);
    alternative.factorStatuses = { capacity: reqStatus(capacityGap.policyRuleId, "missing", [capacityGap.gapId], []) };
    const baseline = evalCore(core);
    const gap = exitFactorGap(asset, alternative, cause);
    const evaluated = evalCore(core);
    expect(evaluated.exit).toMatchObject({ primaryRouteKey: null, diversificationRouteKey: null, score: unknownQuality("exit", "U") });
    expect(evaluated.exit.routes.every((r) => !r.included && r.score === null && r.components === null)).toBe(true);
    expect(evaluated.scoreInput.pillars.exit.causeGapIds).toEqual(expect.arrayContaining([gap.gapId, capacityGap.gapId]));
    expect(evaluated.trace.partialEvidence).toBeNull();
    expect(evaluated.trace.limitingPillars).toEqual(baseline.trace.limitingPillars);
    expect(evaluated.trace.limitingPillars).toContainEqual({ pillar: "exit", causes: ["U"], causeGapIds: [capacityGap.gapId] });
    expect([evaluated.trace.nrReasons, evaluated.trace.finalScore, evaluated.trace.finalGrade])
      .toEqual([baseline.trace.nrReasons, baseline.trace.finalScore, baseline.trace.finalGrade]);
  });

  it("preserves the published C/U causes when whole-Exit uncertainty has one price", () => {
    const { core, asset } = exitPromotionFixture();
    const candidate = asset.exitRoutes.find((r) => r.lane === "redemption")!;
    asset.exitRoutes = [candidate];
    candidate.scoreEligible = false;
    candidate.coverageClass = "diagnostic";
    const capacityGap = createV9FactGapV3({
      gapId: "alpha:gap:exit:capacity", reasonCode: "missing-same-notional-route", ownerDomain: "exit",
      policyRuleId: "v9.exit.route-factors", observationState: "missing",
      path: { kind: "optional-exit", routeKey: candidate.routeKey },
      causeScope: { pillar: "exit", componentKey: "exit-route", factorKey: "capacity", routeKey: candidate.routeKey, exposureId: null, requiredDatum: "capacity" },
      message: "Executable capacity has not been researched.", responsibility: "unresearched",
    });
    asset.gaps.push(capacityGap);
    candidate.status = reqStatus(capacityGap.policyRuleId, "missing", [capacityGap.gapId], []);
    candidate.factorStatuses = { capacity: candidate.status };
    candidate.capacityCurve = [];
    candidate.request = null;
    exitFactorGap(asset, candidate, "C");
    const evaluated = evalCore(core);
    expect(evaluated.exit).toMatchObject({ score: 50, limitedEvidenceCauses: ["C", "U"] });
    expect(evaluated.scoreInput.pillars.exit).toMatchObject({ score: 50, limitedEvidenceCauses: ["C", "U"] });
  });

  it.each(["A", "B"] as const)("retains a no-primary admission gap without an independent blocker (%s)", (cause) => {
    const { core, asset } = exitPromotionFixture();
    const dust = asset.exitRoutes.find((r) => r.lane === "dex")!;
    dust.capacityCurve = dust.capacityCurve.map((p) => ({ ...p, executableUsd: 0, completionRatio: 0 }));
    const candidate = asset.exitRoutes.find((r) => r.lane === "redemption")!;
    asset.exitRoutes = [candidate];
    Object.assign(candidate, { scoreEligible: false, coverageClass: "diagnostic", settlementModel: "bounded-delay", settlementSlaSec: null });
    const gap = exitFactorGap(asset, candidate, cause, "settlement");
    const evaluated = evalCore(core);
    expect(evaluated.exit.primaryRouteKey).toBeNull();
    expect(evaluated.trace.partialEvidence).toMatchObject({ excludedPillars: [], excludedComponentKeys: [], causes: [cause], causeGapIds: [gap.gapId] });
    expect(evaluated.scoreInput.pillars.exit.limitingCauseGapIds).not.toContain(gap.gapId);
    asset.exitRoutes.push(dust);
    expect(evalCore(core).scoreInput.pillars.exit).toMatchObject({ score: evaluated.exit.score, evidenceLevel: evaluated.scoreInput.pillars.exit.evidenceLevel });
  });

  it.each(["A", "B"] as const)("preserves a selected primary Exit route's factor exclusion (%s)", (cause) => {
    const { core, asset } = exitPromotionFixture();
    const primary = asset.exitRoutes.find((r) => r.lane === "dex")!;
    asset.exitRoutes = [primary];
    const gap = exitFactorGap(asset, primary, cause, "observationConfidence");
    const evaluated = evalCore(core);
    expect(evaluated.exit.primaryRouteKey).toBe(primary.routeKey);
    expect(evaluated.trace.partialEvidence).toMatchObject({ excludedPillars: [], excludedComponentKeys: [], causes: [cause], causeGapIds: [gap.gapId] });
  });

  it.each(["A", "B"] as const)("preserves excluded factors on an admitted alternative inside an included Exit pillar (%s)", (cause) => {
    const { core, asset } = exitPromotionFixture();
    const alternative = asset.exitRoutes.find((r) => r.lane === "redemption")!;
    const gap = exitFactorGap(asset, alternative, cause);
    const evaluated = evalCore(core);
    expect(evaluated.exit.routes.find((r) => r.routeKey === alternative.routeKey)?.included).toBe(true);
    expect(evaluated.scoreInput.pillars.exit.aggregationDisposition).toBe("included");
    expect(evaluated.trace.partialEvidence).toMatchObject({ excludedPillars: [], excludedComponentKeys: [`${alternative.routeKey}:cost`], causes: [cause], causeGapIds: [gap.gapId] });
  });

  it.each(["protocol-position", "shared-reserve", "ucits-trs-fund"] as const)("admits %s oracle tier gaps without relaxing path binding", (archetype) => {
    const { core, asset } = nativeCore();
    asset.archetype = archetype;
    const review = archetype === "ucits-trs-fund"
      ? { archetype, fundClaimAndSegregation: mechanismFact(), navAndReconciliation: mechanismFact(), portfolioHedge: mechanismFact(), counterpartyAndCollateral: mechanismFact(), custodyContinuity: mechanismFact(), defaultRecovery: mechanismFact() }
      : archetype === "shared-reserve"
        ? { archetype, holderClaim: mechanismFact(), liabilityConservation: mechanismFact(), reserveCustody: mechanismFact(), encumbranceAndAllocation: mechanismFact(), defaultRecovery: mechanismFact() }
        : { archetype, holderClaim: mechanismFact(), liabilityConservation: mechanismFact(), positionCustody: mechanismFact(), encumbranceAndAllocation: mechanismFact(), defaultRecovery: mechanismFact() };
    asset.mechanismRiskReview = { status: knownStatus("evidence:base", "backing.mechanism.review"), review };
    const gap = createV9FactGapV3({
      gapId: "alpha:gap:economic-control:oracle::tier", reasonCode: "missing-oracle-profile", ownerDomain: "control",
      policyRuleId: "v9.control.tier", observationState: "bounded-unknown",
      path: { kind: "local-component", componentKey: "economic-control:oracle" },
      causeScope: { pillar: "control", componentKey: "economic-control:oracle", factorKey: "tier", routeKey: null, exposureId: null, requiredDatum: "tier" },
      message: `The ${archetype} oracle tier requires review.`, responsibility: "unresearched",
    });
    asset.gaps.push(gap);
    asset.economicControlReview.oracle.factorStatuses = { tier: reqStatus("v9.control.tier", "bounded-unknown", [gap.gapId]) };
    const queueEntry = () => buildV9EvidenceGapQueue({ factSet: compileV9FactSetV3(core), policy: P }).entries.find((r) => r.gapId === gap.gapId)!;
    expect(queueEntry()).toMatchObject({ policyBindingIssues: [], action: "collect-evidence", cause: "U", treatment: "pillar" });

    gap.path = { kind: "methodology", componentKey: "economic-control:oracle" };
    expect(queueEntry()).toMatchObject({ policyBindingIssues: ["path-kind-not-permitted"], action: "reconcile-policy-binding" });
  });

  it.each(["A", "C", "U"] as const)("classifies nonbinding inventory evidence independently of its numeric score (%s)", (cause) => {
    const { core, asset } = nativeCore();
    const baseline = evalCore(core);
    const gap = createV9FactGapV3({
      gapId: "alpha:inventory-review", reasonCode: "unresolved-control-identity", ownerDomain: "control",
      policyRuleId: "control.inventory.review", observationState: "bounded-unknown",
      path: { kind: "local-component", componentKey: "deployment-controls" },
      message: "The complete control inventory is not admitted.", responsibility: "unresearched", evidenceRefIds: ["evidence:base"],
    });
    if (cause !== "U") certifyGap(asset, gap, cause);
    asset.gaps.push(gap);
    asset.controlStatus = reqStatus("control.inventory.review", "bounded-unknown", [gap.gapId], gap.evidenceRefIds);
    const evaluated = evalCore(core);
    expect(evaluated.scoreInput.pillars.control).toMatchObject({
      score: baseline.scoreInput.pillars.control.score,
      evidenceLevel: cause === "A" ? "strong" : "limited",
      limitedEvidenceCauses: cause === "A" ? [] : [cause],
      limitingCauseGapIds: cause === "A" ? [] : [gap.gapId],
    });
    expect(evaluated.trace.finalGrade).not.toBe("NR");
  });

  it("rates an USDSM-shaped limited mint review after independent control questions close", () => {
    const { core, asset } = nativeCore();
    asset.dependencies.edges = [];
    asset.reserveExposures = [];
    const reserveGap = createV9FactGapV3({
      gapId: "alpha:reserve-composition", reasonCode: "missing-reserve-composition", ownerDomain: "backing",
      policyRuleId: "backing.reserve.review", observationState: "bounded-unknown",
      path: { kind: "local-component", componentKey: "reserve-composition" },
      message: "The issuer does not disclose its reserve composition.", responsibility: "unresearched",
    });
    certifyGap(asset, reserveGap, "C");
    asset.gaps.push(reserveGap);
    asset.reserveStatus = reqStatus(reserveGap.policyRuleId, "bounded-unknown", [reserveGap.gapId], reserveGap.evidenceRefIds);
    asset.reserveResiduals = [{ residualId: "unidentified", weight: 1, status: asset.reserveStatus }];
    const review = asset.mechanismRiskReview.review!;
    if (review.archetype !== "fiat-cash") throw new Error("Expected fiat fixture");
    for (const key of ["claimAndSegregation", "custodyContinuity", "assuranceAndReconciliation"] as const) {
      const gap = createV9FactGapV3({
        gapId: `alpha:mechanism:${key}`, reasonCode: "bounded-mechanism-review", ownerDomain: "backing",
        policyRuleId: "backing.mechanism.review", observationState: "bounded-unknown",
        path: { kind: "local-component", componentKey: `mechanism:${key}` },
        message: "The reviewed issuer surface does not disclose this backing datum.", responsibility: "unresearched",
      });
      certifyGap(asset, gap, "C");
      asset.gaps.push(gap);
      review[key] = { ...review[key], quality: null, status: reqStatus(gap.policyRuleId, "bounded-unknown", [gap.gapId], gap.evidenceRefIds) };
    }
    const mintGap = createV9FactGapV3({
      gapId: "alpha:economic-control:mint", reasonCode: "missing-mint-authority", ownerDomain: "control",
      policyRuleId: "control.mint.review", observationState: "bounded-unknown",
      path: { kind: "local-component", componentKey: "economic-control:mint" },
      message: "The aggregate mint review remains unresearched.", responsibility: "unresearched",
    });
    asset.gaps.push(mintGap);
    asset.economicControlReview.mint.status = reqStatus(mintGap.policyRuleId, "bounded-unknown", [mintGap.gapId]);
    const evaluated = evalCore(core);
    expect(asset.controls.find((c) => c.controlKey === asset.economicControlReview.mint.controlKey)?.status.gapIds).toEqual([]);
    expect(evaluated.scoreInput.pillars.control).toMatchObject({ evidenceLevel: "limited", limitedEvidenceCauses: ["U"], limitingCauseGapIds: [mintGap.gapId] });
    expect(evaluated.scoreInput.pillars.control.reasons).toContainEqual(expect.objectContaining({ code: "unresolved-mint-authority", cause: "U", causeGapIds: [mintGap.gapId] }));
    expect(evaluated.scoreInput.pillars.backing.evidenceLevel).toBe("limited");
    expect(evaluated.scoreInput.pillars.exit.evidenceLevel).toBe("adequate");
    expect(evaluated.trace).toMatchObject({ ratingStatus: "rated", finalScore: expect.any(Number), nrReasons: [] });
  });

  it.each(["C", "U"] as const)("joins issuer reconciliation questions only to their exact aggregate factor (%s)", (cause) => {
    const { core, asset } = nativeCore();
    const minter = asset.controls.find((c) => c.controlKey === asset.economicControlReview.mint.controlKey)!;
    minter.authority = { authorityKey: "issuer:backend", model: "issuer-backend", threshold: null };
    asset.economicControlReview.mint.reconciliation = "unknown";
    const gap = createV9FactGapV3({
      gapId: "alpha:mint:reconciliation", reasonCode: "missing-mint-authority", ownerDomain: "control",
      policyRuleId: "control.reconciliation", observationState: "bounded-unknown",
      path: { kind: "local-component", componentKey: "economic-control:mint" },
      message: "Issuer whole-supply reconciliation is unavailable.", responsibility: "unresearched",
    });
    if (cause === "C") certifyGap(asset, gap, cause);
    asset.gaps.push(gap);
    asset.economicControlReview.mint.factorStatuses = {
      ...asset.economicControlReview.mint.factorStatuses,
      reconciliation: reqStatus(gap.policyRuleId, "bounded-unknown", [gap.gapId], cause === "C" ? gap.evidenceRefIds : ["evidence:base"]),
    };
    const evaluated = evalCore(core);
    expect(evaluated.scoreInput.pillars.control.reasons).toContainEqual(expect.objectContaining({ code: "mint-control-question", cause, causeGapIds: [gap.gapId] }));
    expect(evaluated.scoreInput.pillars.control.limitingCauseGapIds).toContain(gap.gapId);
  });

  it("keeps real bounded exit witnesses when a reviewed physical profile explains the missing runtime route", () => {
    const { core, asset } = nativeCore();
    const gap = createV9FactGapV3({
      gapId: "alpha:physical-runtime", reasonCode: "missing-same-notional-route", ownerDomain: "exit",
      policyRuleId: "exit.runtime.required", observationState: "missing",
      path: { kind: "local-component", componentKey: "exit-routes" },
      message: "The reviewed physical redemption has no admitted execution model.", responsibility: "unresearched",
    });
    asset.gaps = [...asset.gaps.filter((r) => r.ownerDomain !== "exit"), gap];
    asset.exitRoutes = [];
    asset.evidence = asset.evidence.filter((r) => r.evidenceId !== "evidence:route" && r.evidenceId !== "evidence:rejected-route");
    asset.exitStatus = reqStatus("exit.runtime.required", "missing", [gap.gapId], []);
    asset.mechanismExitFacts = [{ factKey: "physical-redemption", disposition: "supported", quality: "limited", evidenceRefIds: ["evidence:base"] }];
    const evaluated = evalCore(core);
    expect(evaluated.exit.score).toBe(unknownQuality("exit", "U", P.policy.semantic));
    expect(evaluated.scoreInput.pillars.exit).toMatchObject({ aggregationDisposition: "included", score: evaluated.exit.score });
    expect(evaluated.trace.boundedUncertaintyAttribution).toContainEqual(expect.objectContaining({ cause: "U", code: "missing-same-notional-route", causeGapIds: [gap.gapId] }));
    expect(evaluated.trace.nrReasons.some((r) => r.field === "boundedUncertaintyAttribution")).toBe(false);
  });

  it("keeps a missing runtime-route subject unavailable without borrowing another surface", () => {
    const { core, asset } = nativeCore();
    const gap = createV9FactGapV3({
      gapId: "alpha:runtime-inventory", reasonCode: "missing-runtime-route-evidence", ownerDomain: "exit",
      policyRuleId: "exit.runtime.required", observationState: "missing",
      path: { kind: "local-component", componentKey: "exit-routes" },
      message: "Runtime routes are not admitted.", responsibility: "unresearched",
    });
    const decoy = createV9FactGapV3({
      gapId: "alpha:unrelated-runtime", reasonCode: "missing-runtime-route-evidence", ownerDomain: "exit",
      policyRuleId: "exit.unrelated.required", observationState: "missing",
      path: { kind: "local-component", componentKey: "unrelated-exit-factor" },
      message: "An unrelated Exit datum is missing.", responsibility: "unresearched",
    });
    asset.exitRoutes = [];
    asset.gaps = [...asset.gaps.filter((r) => r.ownerDomain !== "exit"), gap, decoy];
    asset.evidence = asset.evidence.filter((r) => r.evidenceId !== "evidence:route" && r.evidenceId !== "evidence:rejected-route");
    asset.exitStatus = reqStatus("exit.runtime.required", "missing", [gap.gapId, decoy.gapId], []);
    asset.mechanismExitFacts = [];
    const evaluated = evalCore(core);
    expect(evaluated.scoreInput.pillars.exit).toMatchObject({ score: null, evidenceLevel: "insufficient", aggregationDisposition: "unavailable", limitedEvidenceCauses: [], limitingCauseGapIds: [] });
    expect(evaluated.trace.includedPillars).not.toContain("exit");
    expect(evaluated.trace.boundedUncertaintyAttribution.flatMap((r) => r.causeGapIds ?? [])).not.toContain(decoy.gapId);
  });

  it.each([
    { label: "in-range", cashWeights: [0.5, 0.1, 0.013], betaWeight: 0.118, remainderWeight: 0.269, clamped: false },
    { label: "floating-point tail", cashWeights: [0.7020000000000001, 0.17600000000000002, 0.004], betaWeight: 0.11800000000000001, remainderWeight: 0, clamped: true },
  ])("preserves the backing structural percentage contract for $label shares", ({ cashWeights, betaWeight, remainderWeight, clamped }) => {
    const input = coreFixture();
    const alpha = input.assets.find((a) => a.assetId === "alpha")! as unknown as V9AssetFactsV2;
    const [cash, beta] = alpha.reserveExposures as [V9AssetFactsV2["reserveExposures"][number], V9AssetFactsV2["reserveExposures"][number]];
    const sharedCustodian = [{ kind: "reserve-custodian" as const, key: "custodian:shared" }];
    alpha.reserveExposures = [
      { ...cash, exposureKey: "exposure:base", weight: cashWeights[0]!, failureDomains: sharedCustodian },
      { ...cash, exposureKey: "exposure:avalanche", weight: cashWeights[1]!, failureDomains: sharedCustodian },
      { ...beta, weight: betaWeight, failureDomains: sharedCustodian },
      { ...cash, exposureKey: "exposure:katana", weight: cashWeights[2]!, failureDomains: sharedCustodian },
      ...(remainderWeight > 0 ? [{ ...cash, exposureKey: "exposure:remainder", weight: remainderWeight }] : []),
    ];
    alpha.dependencies.mappedLiveReserveWeight = betaWeight;
    alpha.dependencies.edges = alpha.dependencies.edges.map((e) => (e.dependencyType === "collateral" ? { ...e, weight: betaWeight } : e));
    const factSet = compileNativeV3FactSet(input);
    const evaluateBacking = backingArchetypes.evaluateV9Backing;
    const backing = clamped ? vi.spyOn(backingArchetypes, "evaluateV9Backing").mockImplementation((a, rev, pol) => {
      const res = evaluateBacking(a, rev, pol);
      return a.assetId !== "alpha" ? res : {
        ...res,
        structuralReasons: res.structuralReasons.map((r) => (r.pathKey === "common-mode:reserve-custodian:custodian:shared" ? { ...r, materialShare: 1.0000000000308 } : r)),
      };
    }) : null;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const evaluated = evaluateV9FactSet(factSet, P).assets.find((a) => a.assetId === "alpha")!;
      const reason = evaluated.backing.structuralReasons.find((i) => i.pathKey === "common-mode:reserve-custodian:custodian:shared")!;
      const signal = evaluated.scoreInput.pillars.backing.structuralSignals.find((i) => i.failureDomainKeys?.includes("reserve-custodian:custodian:shared"));
      if (clamped) {
        expect(reason.materialShare).toBeGreaterThan(1);
        expect(signal?.materialSharePct).toBe(100);
        expect(warn).toHaveBeenCalledWith("safety_score_v9_structural_signal_percentage_clamped", {
          assetId: "alpha", fieldPath: "structuralSignals[*].materialSharePct", rawValue: reason.materialShare! * 100, arithmetic: `${reason.materialShare} * 100`,
        });
      } else {
        expect(reason.materialShare).toBeCloseTo(0.731);
        expect(signal?.materialSharePct).toBe(reason.materialShare! * 100);
        expect(warn).not.toHaveBeenCalledWith("safety_score_v9_structural_signal_percentage_clamped", expect.anything());
      }
    } finally {
      backing?.mockRestore();
      warn.mockRestore();
    }
  });

  it.each([-0.01, 1.01])("rejects an out-of-range backing structural share (%s) at the asset quarantine boundary", (materialShare) => {
    const factSet = compileNativeV3FactSet(coreFixture());
    const evaluateBacking = backingArchetypes.evaluateV9Backing;
    const backing = vi.spyOn(backingArchetypes, "evaluateV9Backing").mockImplementation((a, rev, pol) => {
      const res = evaluateBacking(a, rev, pol);
      return a.assetId !== "alpha" ? res : {
        ...res,
        structuralReasons: [...res.structuralReasons, {
          kind: "unsafe-backing", severity: "high", responsibility: "measured-adverse", pathKey: "fixture:out-of-range",
          materialShare, ceiling: pol.policy.semantic.backing.structural.unsafeExposureQuality, evidenceRefIds: [], failureDomains: [],
        }],
      };
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      expect(() => evaluateV9FactSet(factSet, P)).toThrowError(/asset alpha evaluation failed at structuralSignals\[\d+\]\.materialSharePct/);
      expect(warn).not.toHaveBeenCalledWith("safety_score_v9_structural_signal_percentage_clamped", expect.anything());
    } finally {
      backing.mockRestore();
      warn.mockRestore();
    }
  });

  it("transports a technical serial parent gap without manufacturing NR or parent quality", () => {
    const { core, asset: parent } = nativeCore("beta");
    const child = core.assets.find((a) => a.assetId === "gamma")!;
    const baselineControl = evalCore(core, child.assetId).trace.diagnosticPillarScores.control;
    const backingGap = createV9FactGapV3({
      gapId: "beta:backing-reader", reasonCode: "missing-pillar-evidence", ownerDomain: "backing",
      policyRuleId: "backing.mechanism.required", observationState: "missing",
      path: { kind: "local-component", componentKey: "mechanism-review" }, message: "Captured backing reader failure.", responsibility: "unresearched",
    });
    const exitGap = createV9FactGapV3({
      gapId: "beta:exit-reader", reasonCode: "missing-runtime-route-evidence", ownerDomain: "exit",
      policyRuleId: "exit.routes.review", observationState: "missing",
      path: { kind: "local-component", componentKey: "exit-routes" }, message: "Captured route reader failure.", responsibility: "unresearched",
    });
    certifyGap(parent, backingGap, "A");
    certifyGap(parent, exitGap, "A");
    parent.gaps.push(backingGap, exitGap);
    parent.mechanismRiskReview = { status: reqStatus("backing.mechanism.required", "missing", [backingGap.gapId], []), review: null };
    parent.exitStatus = reqStatus("exit.routes.review", "missing", [exitGap.gapId], []);
    Object.assign(child.dependencies, {
      source: "manual", baseSource: "manual", status: knownStatus("evidence:base", "dependencies.parent"),
      edges: [{
        edgeKey: canonicalV9DependencyEdgeKey("mechanism", parent.assetId, "serial-claim"),
        upstreamAssetId: parent.assetId, dependencyType: "mechanism", economicRole: "serial-claim",
        pathKind: "serial-dependency", weight: 1, evidenceRefIds: ["evidence:base"], failureDomains: [],
      }],
    });
    const result = evalCoreAll(core);
    for (const id of ["beta", "gamma"]) {
      const evaluated = assetById(result, id);
      expect(evaluated.trace).toMatchObject({ ratingStatus: "pipeline-gap", finalScore: null, finalGrade: null, aggregation: null, limitedEvidenceCauses: [] });
      expect(evaluated.trace.partialEvidence).toMatchObject({ causes: ["A"], excludedPillars: ["backing", "exit"] });
      expect(evaluated.trace.nrReasons.every((r) => r.code !== "missing-parent-score")).toBe(true);
    }
    const childResult = assetById(result, child.assetId);
    expect(childResult.scoreInput.parent).toMatchObject({ score: null, ratingStatus: "pipeline-gap" });
    expect(childResult.dependencyInputs.serial[0]).toMatchObject({
      score: null, blocked: false, ratingStatus: "pipeline-gap", causeGapIds: expect.arrayContaining([backingGap.gapId, exitGap.gapId]),
    });
    expect(childResult.trace.diagnosticPillarScores.control).toBe(baselineControl);
  });

  it("bounds unproven serial-parent uncertainty without pipeline relief or direct missing-parent NR", () => {
    const input = coreFixture();
    const parent = input.assets.find((a) => a.assetId === "gamma")! as unknown as V9AssetFactsV2;
    const grandparent = minimalAsset("delta");
    unresolvedArchetype(parent, "gamma:gap:missing-archetype");
    parent.dependencies = manualSerialDeps("delta", [{ kind: "mint-control", key: "mechanism:delta" }]);
    unresolvedArchetype(grandparent as unknown as V9AssetFactsV2, "delta:gap:missing-archetype");
    input.assets.push(grandparent);
    input.activeAssetIds.push("delta");

    const child = evalInputAsset(input, "alpha");
    expect(child.scoreInput.parent.score).not.toBe(100);
    expect(child.trace.ratingStatus).not.toBe("pipeline-gap");
    expect(child.trace.partialEvidence).toBeNull();
    expect(child.trace.nrReasons.every((r) => r.code !== "missing-parent-score")).toBe(true);
  });

  it.each(["C", "U"] as const)("links opaque oracle topology to its scoped tier gap (%s)", (cause) => {
    const { core, asset } = nativeCore();
    const gap = createV9FactGapV3({
      gapId: "alpha:gap:economic-control:oracle::tier", reasonCode: "missing-oracle-profile", ownerDomain: "control",
      policyRuleId: "control.oracle.tier", observationState: "bounded-unknown",
      path: { kind: "local-component", componentKey: "economic-control:oracle" },
      message: "The reviewed inventory does not establish oracle tier.", responsibility: "unresearched", evidenceRefIds: ["evidence:base"],
    });
    if (cause === "C") certifyGap(asset, gap, cause);
    asset.gaps.push(gap);
    asset.economicControlReview.oracle = {
      status: knownStatus("evidence:base", "control.oracle.review"),
      tier: "opaque-or-unknown", liquidationBranchesApplicable: false, branches: [],
      factorStatuses: { tier: reqStatus("control.oracle.tier", "bounded-unknown", [gap.gapId], gap.evidenceRefIds) },
    };
    const evaluated = evalCore(core);
    expect(evaluated.control.components.find((c) => c.kind === "oracle")).toMatchObject({ score: unknownQuality("control", cause, P.policy.semantic), cause, causeGapIds: [gap.gapId] });
    expect(evaluated.scoreInput.pillars.control.reasons).toContainEqual(expect.objectContaining({
      code: "oracle-topology-undisclosed", cause, causeGapIds: [gap.gapId], responsibility: cause === "C" ? "issuer-undisclosed" : "unresearched",
    }));
    expect(evaluated.trace.boundedUncertaintyAttribution).toContainEqual(expect.objectContaining({ code: "oracle-topology-undisclosed", cause, causeGapIds: [gap.gapId] }));
    expect(evaluated.trace.nrReasons.some((r) => r.field === "boundedUncertaintyAttribution")).toBe(false);

    gap.reasonCode = "oracle-topology-undisclosed";
    const alreadyLinked = evalCore(core);
    expect([alreadyLinked.control.score, alreadyLinked.trace.finalScore, alreadyLinked.trace.finalGrade, alreadyLinked.trace.boundedUncertaintyAttribution])
      .toEqual([evaluated.control.score, evaluated.trace.finalScore, evaluated.trace.finalGrade, evaluated.trace.boundedUncertaintyAttribution]);
  });

  it("attributes a derived oracle reason to the exact reviewed disclosure gap", () => {
    const { core, asset: alpha } = nativeCore();
    const gap = createV9FactGapV3({
      gapId: "alpha:gap:economic-control:oracle", reasonCode: "missing-oracle-profile", ownerDomain: "control",
      policyRuleId: "control.oracle.review", observationState: "bounded-unknown",
      path: { kind: "local-component", componentKey: "economic-control:oracle" },
      message: "The issuer review does not disclose a complete oracle profile.", evidenceRefIds: ["evidence:base"], responsibility: "issuer-undisclosed",
    });
    certifyGap(alpha, gap, "C");
    alpha.gaps.push(gap);
    alpha.economicControlReview.oracle = {
      status: reqStatus("control.oracle.review", "bounded-unknown", [gap.gapId]), tier: null,
      factorStatuses: { tier: reqStatus("control.oracle.review", "bounded-unknown", [gap.gapId], gap.evidenceRefIds) }, branches: [],
    };
    const reasons = evalCore(core).scoreInput.pillars.control.reasons;
    expect(reasons).toContainEqual(expect.objectContaining({
      code: "incomplete-oracle-liquidation-branch", path: "control:oracle:cause:alpha%3Agap%3Aeconomic-control%3Aoracle", responsibility: "issuer-undisclosed",
    }));
    expect(reasons.some((r) => r.code === "incomplete-oracle-liquidation-branch" && r.responsibility === "integration-missing")).toBe(false);
  });

  it("scopes a control-specific reason before considering aggregate control gaps", () => {
    const { core, asset: alpha } = nativeCore();
    const admin = alpha.controls.find((c) => c.controlKey === "control:admin")!;
    admin.controlKind = "governance";
    const controlGap = createV9FactGapV3({
      gapId: "alpha:gap:deployment-control:admin", reasonCode: "unresolved-control-identity", ownerDomain: "control",
      policyRuleId: "control.deployment.review", observationState: "bounded-unknown",
      path: { kind: "local-component", componentKey: "control:control:admin" },
      message: "The issuer has not disclosed the admin control semantics.", evidenceRefIds: ["evidence:base"], responsibility: "issuer-undisclosed",
    });
    const aggregateGap = createV9FactGapV3({
      gapId: "alpha:gap:deployment-controls", reasonCode: "unresolved-control-identity", ownerDomain: "control",
      policyRuleId: "control.inventory.review", observationState: "bounded-unknown",
      path: { kind: "local-component", componentKey: "deployment-controls" },
      message: "The producer cannot reconcile the aggregate control inventory.", evidenceRefIds: ["evidence:base"], responsibility: "producer-failed",
    });
    certifyGap(alpha, controlGap, "C");
    certifyGap(alpha, aggregateGap, "A");
    alpha.gaps.push(controlGap, aggregateGap);
    admin.status = reqStatus("control.deployment.review", "bounded-unknown", [controlGap.gapId]);
    alpha.controlStatus = reqStatus("control.inventory.review", "bounded-unknown", [aggregateGap.gapId]);

    const specific = evalCore(core).scoreInput.pillars.control.reasons.filter(
      (r) => r.code === "unresolved-control-identity" && r.path === "control:control:control:admin:cause:alpha%3Agap%3Adeployment-control%3Aadmin",
    );
    expect(specific).toHaveLength(1);
    expect(specific[0]!.responsibility).toBe("issuer-undisclosed");
  });

  it("keeps mixed upstream backing owners on distinct causal score paths", () => {
    const { core, asset: beta } = nativeCore("beta");
    const issuerGap = createV9FactGapV3({
      gapId: "beta:gap:mechanism-archetype:z-issuer", reasonCode: "missing-archetype", ownerDomain: "backing",
      policyRuleId: "backing.archetype.review", observationState: "missing",
      path: { kind: "local-component", componentKey: "mechanism-archetype:issuer" },
      message: "The issuer has not disclosed the mechanism archetype.", evidenceRefIds: ["evidence:base"], responsibility: "issuer-undisclosed",
    });
    const producerGap = createV9FactGapV3({
      gapId: "beta:gap:mechanism-archetype:a-producer", reasonCode: "missing-archetype", ownerDomain: "backing",
      policyRuleId: "backing.archetype.review", observationState: "missing",
      path: { kind: "local-component", componentKey: "mechanism-archetype:producer" },
      message: "The current producer capture cannot resolve the mechanism archetype.", evidenceRefIds: ["evidence:base"], responsibility: "producer-failed",
    });
    certifyGap(beta, issuerGap, "C");
    certifyGap(beta, producerGap, "A");
    beta.archetype = "unresolved";
    beta.gaps = [issuerGap, producerGap];
    beta.mechanismRiskReview = { status: reqStatus("backing.archetype.review", "missing", [issuerGap.gapId, producerGap.gapId]), review: null };

    const singleRootCore = structuredClone(core);
    const singleRootBeta = singleRootCore.assets.find((a) => a.assetId === "beta")!;
    singleRootBeta.gaps = [issuerGap];
    singleRootBeta.evidence = singleRootBeta.evidence.filter((r) => !producerGap.evidenceRefIds.includes(r.evidenceId));
    singleRootBeta.mechanismRiskReview.status = reqStatus("backing.archetype.review", "missing", [issuerGap.gapId]);

    const singleEval = evalCoreAll(singleRootCore);
    const mixedEval = evalCoreAll(core);
    const findIssuerReason = (res: EvalResult, id: string, code?: string) =>
      assetById(res, id).scoreInput.pillars.backing.reasons.find((r) => r.responsibility === "issuer-undisclosed" && (!code || r.code === code));
    for (const reason of [
      findIssuerReason(singleEval, "alpha"), findIssuerReason(mixedEval, "alpha"),
      findIssuerReason(singleEval, "beta", "missing-archetype"), findIssuerReason(mixedEval, "beta", "missing-archetype"),
    ]) {
      expect(reason).toMatchObject({ cause: "C", responsibility: "issuer-undisclosed" });
      expect(reason?.causeGapIds).toContain(issuerGap.gapId);
    }
    const child = assetById(mixedEval, "alpha");
    expect(child.scoreInput.pillars.backing.limitedEvidenceCauses).toContain("C");
    expect(child.scoreInput.pillars.backing.score).toBe(assetById(singleEval, "alpha").scoreInput.pillars.backing.score);
    expect(child.trace.partialEvidence?.causes).toContain("A");
    expect(child.trace.partialEvidence?.causeGapIds).toContain(producerGap.gapId);
  });

  it("inherits admitted parent claims monotonically but prices parent-denominated strategies independently", () => {
    const run = (quality: "adequate" | "strong", parentWeight = 1, assetClass: "stablecoin" | "protocol-position" = "stablecoin") => {
      const input = coreFixture();
      const child = input.assets[1]! as unknown as V9AssetFactsV2;
      const parent = input.assets[2]! as unknown as V9AssetFactsV2;
      child.assetId = "child";
      parent.assetId = "parent";
      child.variantKind = "savings-passthrough";
      child.reserveStatus = knownStatus("evidence:base", "backing.wrapper-live-parent");
      child.reserveExposures = [{
        exposureKey: "exposure:parent", classificationKey: "stablecoin:parent",
        sourceGenerationId: SOURCE_FINGERPRINTS.liveReserves.generationId, provenance: "live",
        status: knownStatus("evidence:base", "backing.wrapper-live-parent"), name: "Parent stablecoin",
        weight: parentWeight, trackedAssetId: "parent", assetClass, issuerOrObligorKey: "asset:parent",
        riskFactors: ["counterparty"], liquidityHorizon: "immediate", maturityDaysMax: null,
        failureDomains: [{ kind: "reserve-issuer", key: "asset:parent" }],
      }];
      child.dependencies = {
        status: knownStatus("evidence:base", "dependencies.wrapper-parent"),
        sourceGenerationId: SOURCE_FINGERPRINTS.liveReserves.generationId, source: "variant", baseSource: "live-reserve",
        dependencyFromLive: true, mappedLiveReserveWeight: parentWeight, fallbackReason: null,
        edges: [{
          edgeKey: canonicalV9DependencyEdgeKey("wrapper", "parent"), upstreamAssetId: "parent",
          dependencyType: "wrapper", pathKind: "serial-dependency", weight: 1, economicRole: "serial-claim",
          evidenceRefIds: ["evidence:base"], failureDomains: [{ kind: "mint-control", key: "asset:parent" }],
        }],
        diagnostics: { graphState: "valid", issueCodes: [], sccMemberAssetIds: [] },
      };
      const parentReview = parent.mechanismRiskReview.review;
      if (!parentReview || parentReview.archetype !== "algorithmic") throw new Error("Expected algorithmic parent fixture");
      for (const comp of [parentReview.contractionCapacity, parentReview.confidenceAndIncentives, parentReview.oracleAndControlAssumptions, parentReview.emergencyRecovery, parentReview.lossRecovery]) {
        comp.quality = quality;
      }
      input.activeAssetIds = ["child", "parent"];
      input.assets = [child as never, parent as never];
      const evaluated = evalInput(input);
      return { child: assetById(evaluated, "child"), parent: assetById(evaluated, "parent") };
    };

    const adequate = run("adequate");
    const strong = run("strong");
    const belowThreshold = run("strong", 0.98);
    const strategy = run("strong", 1, "protocol-position");
    for (const res of [adequate, strong]) {
      expect(res.child.backing.score).toBeCloseTo(res.parent.backing.score!, 12);
      expect(res.child.backing.contributions).toContainEqual(expect.objectContaining({ componentKey: "reserve:inherited-backing:parent", observationState: "known", provenance: "live" }));
      expect(res.child.backing.contributions.some((e) => e.source === "mechanism")).toBe(false);
      expect(res.child.trace.finalScore).toBeLessThanOrEqual(res.parent.trace.finalScore!);
    }
    expect(strong.child.backing.score!).toBeGreaterThan(adequate.child.backing.score!);
    for (const res of [belowThreshold, strategy]) {
      expect(res.child.backing.contributions.some((e) => e.componentKey.startsWith("reserve:inherited-backing:"))).toBe(false);
      expect(res.child.backing.contributions.some((e) => e.source === "mechanism")).toBe(true);
    }
    expect(strategy.child.backing.score!).toBeLessThan(strategy.parent.backing.score!);
  });

  it("deduplicates transitive physical-resource overlap in the capacity resolver", () => {
    const alpha = coreFixture().assets[0]! as unknown as V9AssetFactsV2;
    const projected = projectV9ExitEvaluationRoute(alpha.exitRoutes.find((r) => r.routeId === "amm-main")!);
    const mk = (routeKey: string, executableUsd: number, physicalResourceKeys: string[]) => ({
      ...projected, routeKey, physicalResourceKeys,
      capacityCurve: projected.capacityCurve.map((p) => {
        const exec = Math.min(executableUsd, p.requestedNotionalUsd);
        return { ...p, executableUsd: exec, completionRatio: exec / p.requestedNotionalUsd };
      }),
    });
    expect(resolveV9DistinctExitCapacity(
      [mk("route:a", 20_000, ["resource:a"]), mk("route:b", 30_000, ["resource:a", "resource:b"]), mk("route:c", 40_000, ["resource:b"])],
      { requestedNotionalUsd: 1_000_000, maxCostBps: 200, comparisonWindowSec: 300, rawSupplyRequestUsd: 1_000_000 }, P,
    ).valuedExecutableUsd).toBe(40_000);
  });

  it("keeps subthreshold DEX capacity low in common-mode materiality", () => {
    const input = coreFixture();
    const alpha = input.assets[0]! as unknown as V9AssetFactsV2;
    const delta = structuredClone(alpha);
    delta.assetId = "delta";
    input.activeAssetIds.push("delta");
    input.assets.push(delta as never);
    for (const asset of [alpha, delta]) {
      const primary = asset.exitRoutes.find((r) => r.routeId === "amm-main")!;
      primary.capacityCurve = primary.capacityCurve.map((p) => ({ ...p, executableUsd: 30_000, completionRatio: 30_000 / p.requestedNotionalUsd }));
    }
    const evaluated = evalInput(input);
    for (const id of ["alpha", "delta"]) expect(depSignal(evaluated, id, "dex-protocol:dex:fixture")).toMatchObject({ kind: "critical-dependency", severity: "low" });
  });

  it("qualifies DEX common-mode groups with score-bearing routes only", () => {
    const run = (alphaEligible: boolean, deltaEligible: boolean) => {
      const input = coreFixture();
      const alpha = input.assets[0]! as unknown as V9AssetFactsV2;
      const delta = structuredClone(alpha);
      delta.assetId = "delta";
      input.activeAssetIds.push("delta");
      input.assets.push(delta as never);
      for (const [asset, eligible] of [[alpha, alphaEligible], [delta, deltaEligible]] as const) {
        if (eligible) continue;
        Object.assign(asset.exitRoutes.find((c) => c.routeId === "amm-main")!, { coverageClass: "diagnostic", scoreEligible: false });
      }
      return evalInput(input);
    };
    for (const evaluated of [run(false, false), run(true, false)]) {
      expect(depSignal(evaluated, "alpha", "dex-protocol:dex:fixture")).toBeUndefined();
      expect(depSignal(evaluated, "delta", "dex-protocol:dex:fixture")).toBeUndefined();
    }
    const twoEligible = run(true, true);
    for (const id of ["alpha", "delta"]) expect(depSignal(twoEligible, id, "dex-protocol:dex:fixture")).toMatchObject({ severity: "high", responsibility: "measured-adverse" });
  });

  it("joins dependency-owned mint-control groups through asset issuer identity", () => {
    const run = (betaIssuer: string | null, gammaIssuer: string | null) => {
      const input = coreFixture();
      for (const [asset, issuer] of [[input.assets[1]! as unknown as V9AssetFactsV2, betaIssuer], [input.assets[2]! as unknown as V9AssetFactsV2, gammaIssuer]] as const) {
        asset.assetIssuerKey = issuer;
        asset.dependencies = manualSerialDeps("alpha", [{ kind: "mint-control", key: "shared:dependency-minter" }]);
      }
      return evalInput(input);
    };
    const same = run("issuer:shared", "issuer:shared");
    const cross = run("issuer:shared", "issuer:other");
    const unresolved = run("issuer:shared", null);
    for (const id of ["beta", "gamma"]) {
      expect(depSignal(same, id, "mint-control:shared:dependency-minter")).toMatchObject({ severity: "low" });
      expect(depSignal(cross, id, "mint-control:shared:dependency-minter")).toMatchObject({ severity: "high", responsibility: "measured-adverse" });
      expect(depSignal(unresolved, id, "mint-control:shared:dependency-minter")).toMatchObject({ severity: "high", responsibility: "integration-missing" });
    }
  });

  it("keeps merged and disjoint split mint-controller domains score-neutral while the diagnostic signal rekeys", () => {
    const run = (mintKey: (assetId: string) => string) => {
      const input = coreFixture();
      const beta = input.assets[1]! as unknown as V9AssetFactsV2;
      const gamma = input.assets[2]! as unknown as V9AssetFactsV2;
      const delta = { ...structuredClone(beta), assetId: "delta" };
      const epsilon = { ...structuredClone(beta), assetId: "epsilon" };
      input.activeAssetIds.push("delta", "epsilon");
      input.assets.push(delta as never, epsilon as never);
      for (const asset of [beta, gamma, delta, epsilon]) {
        asset.assetIssuerKey = "issuer:circle";
        asset.dependencies = manualSerialDeps("alpha", [{ kind: "mint-control", key: mintKey(asset.assetId) }]);
      }
      return evalInput(input);
    };
    const mintSignal = (evaluated: EvalResult, id: string) =>
      assetById(evaluated, id).scoreInput.dependencyStructuralSignals.find((c) => c.failureDomainKeys.some((k) => k.startsWith("mint-control:")));

    const merged = run(() => "shared:mint");
    const split = run((id) => (id === "beta" || id === "gamma" ? "shared:mint-a" : "shared:mint-b"));
    for (const id of ["beta", "gamma", "delta", "epsilon"]) {
      const mergedSig = mintSignal(merged, id);
      const splitSig = mintSignal(split, id);
      const expectedKey = id === "beta" || id === "gamma" ? "mint-control:shared:mint-a" : "mint-control:shared:mint-b";
      expect(mergedSig).toMatchObject({ severity: "low", failureDomainKeys: ["mint-control:shared:mint"] });
      expect(mergedSig?.reason).toContain("same-issuer controller, diagnostic only");
      expect(splitSig).toMatchObject({ severity: "low", failureDomainKeys: [expectedKey] });
      expect(splitSig?.reason).toContain("same-issuer controller, diagnostic only");
      expect(splitSig?.failureDomainKeys).not.toContain("mint-control:shared:mint");
      expect([assetById(merged, id).trace.finalScore, assetById(merged, id).trace.caps, assetById(merged, id).trace.bindingCap])
        .toEqual([assetById(split, id).trace.finalScore, assetById(split, id).trace.caps, assetById(split, id).trace.bindingCap]);
    }
  });

  it("keeps a shared upgrade-control ceiling adverse when one member is bounded-unknown", () => {
    const run = (boundedUnknownAssetId: string | null) => {
      const input = coreFixture();
      const assets = input.assets as unknown as V9AssetFactsV2[];
      const controlTemplate = structuredClone(assets[0]!.controls.find((c) => c.controlKey === "control:admin")!);
      const sharedDomain = { kind: "upgrade-control" as const, key: "platform:fixture" };
      for (const asset of assets) {
        asset.assetIssuerKey = `issuer:${asset.assetId}`;
        const controlKey = `control:shared-upgrade:${asset.assetId}`;
        const deploymentKey = `deployment:${asset.assetId}`;
        const isBounded = asset.assetId === boundedUnknownAssetId;
        const boundedGapId = `${asset.assetId}:gap:shared-upgrade-bounded`;
        const status = isBounded ? reqStatus("control.upgrade.shared", "bounded-unknown", [boundedGapId]) : knownStatus("evidence:base", "control.upgrade.shared");
        if (isBounded) {
          asset.gaps.push(createV9FactGap({
            gapId: boundedGapId, reasonCode: "unknown-upgrade-authority", ownerDomain: "control",
            policyRuleId: "control.upgrade.shared", observationState: "bounded-unknown",
            path: { kind: "deployment-control", deploymentKey, controlKey },
            message: "The shared upgrade authority was re-verified, but its custody is not established.", evidenceRefIds: ["evidence:base"],
          }));
        }
        asset.controls.push({
          ...controlTemplate, controlKey, deploymentKey, status, failureDomains: [sharedDomain],
          ...(isBounded ? {
            authority: { authorityKey: `programdata:${asset.assetId}`, model: "unknown" as const, threshold: null },
            capSemantics: { kind: "unknown" as const, bound: null }, claimImpairment: "unknown" as const,
            economicLossScope: "unknown" as const, keyCustody: "unknown" as const, modulesOrGuards: "unknown" as const,
          } : {}),
        });
        if (asset.assetId !== "alpha") asset.controlStatus = status;
      }
      return evalInput(input);
    };

    const allKnown = run(null);
    const degraded = run("gamma");
    for (const id of ["alpha", "beta"]) {
      const sig = depSignal(degraded, id, "upgrade-control:platform:fixture");
      expect(sig).toMatchObject({ severity: "high", responsibility: "measured-adverse", evidenceConfidence: "high" });
      expect(sig?.reason).toContain("remain");
      expect(sig?.reason).toContain("unresolved");
      expect(assetById(degraded, id).trace.caps).not.toContainEqual(expect.objectContaining({ kind: "signal:critical-dependency:high" }));
      expect(assetById(degraded, id).trace.finalScore).toBeLessThanOrEqual(assetById(allKnown, id).trace.finalScore!);
    }
    expect(depSignal(degraded, "gamma", "upgrade-control:platform:fixture")).toMatchObject({ severity: "high", responsibility: "measured-adverse", evidenceConfidence: "low" });
    expect(assetById(degraded, "gamma").trace.finalScore).toBeLessThanOrEqual(assetById(allKnown, "gamma").trace.finalScore!);
  });

  it("derives bridge share bounds through reviewed control and deployment joins", () => {
    type BridgeJoinVariant =
      | "known" | "aggregate-mismatch" | "contradictory-share" | "missing-capability" | "null-control-share"
      | "same-domain-epsilon-no-row" | "same-domain-invalid" | "same-domain-null-no-row" | "same-domain-zero-no-row"
      | "separate-domain-unjoined" | "supply-mismatch" | "stale-control" | "stale-review" | "unmatched" | "wrong-kind";
    const evalSignals = (targetShare: number, variant: BridgeJoinVariant = "known") => {
      const { input, assets } = commonDomainFixture();
      for (const asset of assets) {
        const targetDomain = { kind: "bridge-route" as const, key: "protocol:fixture-bridge" };
        const nativeDomain = { kind: "bridge-route" as const, key: variant === "separate-domain-unjoined" ? "bridge:native" : `native:${asset.assetId}` };
        const targetControl: V9AssetFactsV2["controls"][number] = {
          ...bridgeControl(asset, "target", targetShare, targetDomain.key),
          controlKind: variant === "wrong-kind" ? "mint" : "bridge",
          capabilities: variant === "missing-capability" ? [] : ["bridge-mint"],
          materialSupplyShare: variant === "null-control-share" ? null : variant === "contradictory-share" ? 1 : targetShare,
        };
        const nativeControl = bridgeControl(asset, "native", 1 - targetShare, nativeDomain.key);
        const sameDomainMissingRow = ["same-domain-epsilon-no-row", "same-domain-invalid", "same-domain-null-no-row", "same-domain-zero-no-row"].includes(variant);
        const invalidSame = sameDomainMissingRow
          ? bridgeControl(asset, "invalid", variant === "same-domain-zero-no-row" ? 0 : variant === "same-domain-null-no-row" ? null : variant === "same-domain-epsilon-no-row" ? Number.EPSILON : targetShare, targetDomain.key)
          : null;
        if (variant === "stale-control") {
          targetControl.status = staleBridgeStatus(asset, "control", { kind: "deployment-control", deploymentKey: targetControl.deploymentKey, controlKey: targetControl.controlKey }, "control.bridge.current");
        }
        asset.controls.push(targetControl, ...(variant === "separate-domain-unjoined" ? [] : [nativeControl]), ...(invalidSame ? [invalidSame] : []));
        asset.economicControlReview.bridge = {
          status: knownStatus("evidence:base", "control.bridge.review"),
          routes: [
            { controlKey: targetControl.controlKey, tier: sameDomainMissingRow || variant === "separate-domain-unjoined" ? "external-validated-network" : "opaque-or-unknown" },
            ...(variant === "separate-domain-unjoined" ? [] : [{ controlKey: nativeControl.controlKey, tier: "single-chain-or-native" as const }]),
            ...(invalidSame ? [{ controlKey: invalidSame.controlKey, tier: "canonical-rollup-bridge" as const }] : []),
          ],
        };
        if (variant === "stale-review") {
          asset.economicControlReview.bridge.status = staleBridgeStatus(asset, "review", { kind: "deployment-control", deploymentKey: targetControl.deploymentKey, controlKey: targetControl.controlKey }, "control.bridge.review.current");
        }
        Object.assign(asset.supply, {
          selectedBridgeRoutes: [
            bridgeSupplyRow(variant === "unmatched" ? "bridge:unmatched" : targetControl.deploymentKey, targetShare, (variant === "supply-mismatch" ? 9_000_000 : 10_000_000) * targetShare),
            bridgeSupplyRow(nativeControl.deploymentKey, 1 - targetShare),
          ],
          selectedRouteSupplyShare: variant === "aggregate-mismatch" ? 0.99 : 1,
          unknownRouteSupplyShare: 0, unreviewedRouteSupplyShare: 0,
        });
        asset.supply.failureDomains.push(targetDomain, nativeDomain);
      }
      return evalInputAsset(input, "alpha").scoreInput.dependencyStructuralSignals;
    };
    const bridgeSig = (share: number, variant: BridgeJoinVariant = "known") =>
      evalSignals(share, variant).find((s) => s.failureDomainKeys.includes("bridge-route:protocol:fixture-bridge"))!;

    for (const [share, variant, severity] of [
      [0.0999, "known", "low"], [0.1, "known", "moderate"], [0.2499, "known", "moderate"],
      [0.0499, "contradictory-share", "high"], [0.0499, "missing-capability", "high"], [0.0499, "null-control-share", "high"],
      [0.0499, "same-domain-zero-no-row", "low"], [0.0499, "same-domain-null-no-row", "high"],
      [0.0499, "same-domain-epsilon-no-row", "high"], [0.0499, "same-domain-invalid", "high"],
      [0.0499, "supply-mismatch", "high"], [0.0499, "unmatched", "high"], [0.0499, "wrong-kind", "high"],
      [0.0499, "stale-control", "high"], [0.0499, "stale-review", "high"],
    ] as const) {
      expect(bridgeSig(share, variant).severity, `${share}/${variant}`).toBe(severity);
    }
    const separate = evalSignals(0.0499, "separate-domain-unjoined");
    expect(separate.find((s) => s.failureDomainKeys.includes("bridge-route:protocol:fixture-bridge"))).toMatchObject({ severity: "low" });
    expect(separate.find((s) => s.failureDomainKeys.includes("bridge-route:bridge:native"))).toMatchObject({ severity: "high" });
    expect(bridgeSig(0.25)).toMatchObject({ severity: "high", responsibility: "measured-adverse" });
    expect(bridgeSig(0.0499, "aggregate-mismatch")).toMatchObject({ severity: "high", responsibility: "integration-missing" });
  });

  it("does not treat a control-only bridge domain as exact supply attribution", () => {
    const { input, assets } = commonDomainFixture();
    for (const asset of assets) {
      const targetDomain = { kind: "bridge-route" as const, key: "protocol:fixture-bridge" };
      const targetControl = bridgeControl(asset, "target", 0.0499, targetDomain.key);
      const decoyControl = bridgeControl(asset, "decoy", 0, "bridge:native");
      asset.controls.push(targetControl, decoyControl);
      asset.economicControlReview.bridge = {
        status: knownStatus("evidence:base", "control.bridge.review"),
        routes: [{ controlKey: targetControl.controlKey, tier: "external-validated-network" }, { controlKey: decoyControl.controlKey, tier: "canonical-rollup-bridge" }],
      };
      Object.assign(asset.supply, {
        selectedBridgeRoutes: [bridgeSupplyRow(targetControl.deploymentKey, 0.0499), bridgeSupplyRow("bridge:native", 0.9501)],
        selectedRouteSupplyShare: 1, unknownRouteSupplyShare: 0, unreviewedRouteSupplyShare: 0,
      });
      asset.supply.failureDomains.push(targetDomain);
    }
    const evaluated = evalInput(input);
    for (const id of ["alpha", "delta"]) expect(depSignal(evaluated, id, "bridge-route:protocol:fixture-bridge")).toMatchObject({ severity: "high" });
  });

  it("rejects bridge reviews that reference a missing control before evaluation", () => {
    const input = coreFixture();
    (input.assets[0]! as unknown as V9AssetFactsV2).economicControlReview.bridge = {
      status: knownStatus("evidence:base", "control.bridge.review"),
      routes: [{ controlKey: "control:missing-bridge", tier: "external-validated-network" }],
    };
    expect(() => compileV9FactSetV2(input)).toThrow(/review references unknown control control:missing-bridge/);
  });

  it("does not turn pillar or diagnostic reasons into a global limited-evidence cap", () => {
    const pillarInput = coreFixture();
    const pillarAsset = pillarInput.assets[0]! as unknown as V9AssetFactsV2;
    const pillarGap = createV9FactGap({
      gapId: "gap:bounded-mechanism", reasonCode: "bounded-mechanism-review", ownerDomain: "backing",
      policyRuleId: "backing.mechanism.bounded", observationState: "bounded-unknown",
      path: { kind: "local-component", componentKey: "assurance-and-reconciliation" },
      message: "The assurance component is conservatively bounded.", evidenceRefIds: ["evidence:base"],
    });
    pillarAsset.gaps.push(pillarGap);
    const pillarReview = pillarAsset.mechanismRiskReview.review!;
    if (pillarReview.archetype !== "fiat-cash") throw new Error("Expected fiat fixture");
    pillarReview.assuranceAndReconciliation = { ...pillarReview.assuranceAndReconciliation, status: reqStatus("backing.mechanism.bounded", "bounded-unknown", [pillarGap.gapId]), quality: null };
    const pillarEvaluated = evalInputAsset(pillarInput);
    expect(pillarEvaluated.scoreInput.pillars.backing).toMatchObject({ evidenceLevel: "strong", limitedEvidenceCauses: [], limitingCauseGapIds: [] });
    expect(pillarEvaluated.scoreInput.pillars.backing.reasons).toContainEqual(expect.objectContaining({ code: "bounded-mechanism-review" }));
    expect(pillarEvaluated.scoreInput.pillars.backing.score).toBeLessThan(evalInputAsset(coreFixture()).scoreInput.pillars.backing.score!);
    expect(pillarEvaluated.trace.caps.map((c) => c.kind)).not.toContain("evidence:limited");

    const diagInput = coreFixture();
    const diagAsset = diagInput.assets[0]! as unknown as V9AssetFactsV2;
    const dexRoute = diagAsset.exitRoutes.find((r) => r.routeId === "amm-main")!;
    diagAsset.exitRoutes.find((r) => r.routeId === "issuer-main")!.failureDomains.push(dexRoute.failureDomains.find((d) => d.kind === "dex-protocol")!);
    const diagEvaluated = evalInputAsset(diagInput);
    expect(diagEvaluated.exit.reasons).toContain("correlated-exit-routes");
    expect(diagEvaluated.trace.caps.map((c) => c.kind)).not.toContain("evidence:limited");
  });

  it.each([
    ["exact-complete", "known"], ["exact-complete", "stale"], ["exact-lower-bound", "known"], ["exact-lower-bound", "stale"],
  ] as const)("retains R1 materiality and completion gates for %s capacity with %s observations", (coverageClass, observationState) => {
    for (const s of [
      { name: "submaterial prefix", supplyUsd: 1_000_000, requestUsd: 1_000_000, materialityRequestUsd: 100_000, executableUsd: 1, material: false },
      { name: "1% asset-relative boundary below stress floor", supplyUsd: 1_000_000, requestUsd: 1_000_000, materialityRequestUsd: 100_000, executableUsd: 1_000, material: true },
      { name: "below both boundaries", supplyUsd: 1_000_000_000, requestUsd: 25_000_000, materialityRequestUsd: 25_000_000, executableUsd: 99_999, material: false },
      { name: "$100k absolute boundary", supplyUsd: 1_000_000_000, requestUsd: 25_000_000, materialityRequestUsd: 25_000_000, executableUsd: 100_000, material: true },
    ]) {
      const input = coreFixture();
      const alpha = input.assets.find((a) => a.assetId === "alpha")! as unknown as V9AssetFactsV2;
      const beta = input.assets.find((a) => a.assetId === "beta")! as unknown as V9AssetFactsV2;
      beta.supply.circulatingUsd = s.supplyUsd;
      for (const chain of beta.supply.chainDistribution!.chains) chain.supplyUsd = s.supplyUsd * chain.supplyShare;
      const routeEvidence = alpha.evidence.find((e) => e.evidenceId === "evidence:route")!;
      const measuredRoute = structuredClone(alpha.exitRoutes.find((r) => r.routeId === "amm-main")!);
      measuredRoute.coverageClass = coverageClass;
      measuredRoute.status = { ...measuredRoute.status, observationState };
      if (observationState === "stale") {
        const staleEvidence = createV9EvidenceReference({
          evidenceId: "evidence:retained-stale-exit", sourceId: routeEvidence.sourceId, sourceGenerationId: routeEvidence.sourceGenerationId,
          disposition: "published", observedAtSec: 600, publishedAtSec: 610, maxAgeSec: 100,
        }, AS_OF_SEC);
        beta.evidence.push(staleEvidence);
        const gap = createV9FactGap({
          gapId: "gap:retained-stale-exit", reasonCode: "missing-runtime-route-evidence", ownerDomain: "exit",
          policyRuleId: "exit.route.freshness", observationState: "stale", path: { kind: "optional-exit", routeKey: measuredRoute.routeKey },
          message: "The route observation retains its original expired evidence clock.", evidenceRefIds: [staleEvidence.evidenceId],
        });
        beta.gaps.push(gap);
        measuredRoute.status = { ...measuredRoute.status, evidenceRefIds: [staleEvidence.evidenceId], gapIds: [gap.gapId] };
      }
      measuredRoute.request = { ...measuredRoute.request!, requestedNotionalUsd: s.requestUsd };
      measuredRoute.capacityCurve = [100_000, 1_000_000, 25_000_000].map((req) => ({
        requestedNotionalUsd: req, maxCostBps: 200, executableUsd: s.executableUsd, completionRatio: s.executableUsd / req, executionCostBps: 200,
      }));
      beta.evidence.push(routeEvidence);
      beta.exitStatus = knownStatus(routeEvidence.evidenceId, "exit.portfolio.reviewed");
      beta.exitRoutes = [measuredRoute];
      const evaluated = evalInputAsset(input, "beta");
      const trace = evaluated.exit.routes.find((r) => r.routeKey === measuredRoute.routeKey)!;
      expect(evaluated.exit.stressRequest, s.name).toMatchObject({ requestedNotionalUsd: s.requestUsd, rawSupplyRequestUsd: s.materialityRequestUsd });
      if (!s.material) {
        expect(trace, s.name).toMatchObject({ included: false, score: coverageClass === "exact-complete" ? 0 : null, exclusionReason: "missing-same-notional-route" });
        expect(trace.capacityPoint!.executableUsd).toBeGreaterThan(0);
        expect(evaluated.exit.primaryRouteKey, s.name).toBeNull();
        expect(evaluated.exit.score, s.name).toBe(0);
      } else {
        expect(trace.included, s.name).toBe(true);
        expect(trace.score, s.name).toBeGreaterThan(0);
        expect(evaluated.exit.primaryRouteKey, s.name).toBe(measuredRoute.routeKey);
        expect(trace.capsApplied, s.name).not.toContain("immaterial-executable-capacity");
        expect(trace.capsApplied, s.name).toContain("insufficient-completion:50");
        expect(trace.score, s.name).toBeCloseTo(50 * trace.confidenceFactor!, 10);
      }
      expect(evaluated.scoreInput.pillars.exit.score).toBe(evaluated.exit.score);
      expect(evaluated.trace.finalScore).not.toBeNull();
      expect(evaluated.trace.nrReasons).toEqual([]);
    }
  });

  it.each(["unknown", "dust-gap", "empty", "issuer-zero", "not-applicable"])("dust preserves public Exit evidence and unknown weight: %s", (scenario) => {
    const input = coreFixture();
    const alpha = input.assets.find((a) => a.assetId === "alpha")! as unknown as V9AssetFactsV2;
    const beta = input.assets.find((a) => a.assetId === "beta")! as unknown as V9AssetFactsV2;
    const evidence = beta.evidence;
    const routeEvidence = alpha.evidence.find((r) => r.evidenceId === "evidence:route")!;
    const dust = structuredClone(alpha.exitRoutes.find((r) => r.lane === "dex")!);
    const issuer = structuredClone(alpha.exitRoutes.find((r) => r.lane === "redemption")!);
    issuer.capacityCurve = issuer.capacityCurve.map((p) => ({ ...p, executableUsd: 0, completionRatio: 0 }));
    if (scenario === "empty") beta.exitStatus = knownStatus(routeEvidence.evidenceId, "exit.portfolio.reviewed");
    if (scenario === "not-applicable") issuer.status.applicability = { state: "not-applicable", policyRuleId: "no-issuer", rationale: "No issuer rail applies.", gapId: null };
    if (scenario === "issuer-zero" || scenario === "not-applicable") beta.exitRoutes = [issuer];
    const evaluate = () => {
      beta.evidence = [...evidence, ...(beta.exitRoutes.length > 0 || scenario === "empty" ? [routeEvidence] : [])];
      const { v9FactSetDigest: _digest, ...core } = CompiledV9FactSetV3Schema.parse(compileNativeV3FactSet(input));
      const target = core.assets.find((a) => a.assetId === "beta")!;
      const measured = target.exitRoutes.find((r) => r.routeKey === dust.routeKey);
      if (scenario === "dust-gap" && measured) exitFactorGap(target, measured, "B");
      const result = evalCore(core, "beta");
      return projectSafetyScoreV9Card({
        ...result, policy: P,
        display: { exitHolderEligibility: Object.fromEntries(beta.exitRoutes.map((r) => [r.routeKey, projectV9ExitEvaluationRoute(r).holderEligibility])) },
      }).card;
    };
    const accounting = (c: ReturnType<typeof evaluate>) => [c.score, c.pillars.exit.score, c.pillars.exit.evidenceLevel, computeV9UnknownPricedWeightShare(c.breakdowns, c.scoreTrace.aggregation)];
    const before = evaluate();
    for (const executableUsd of [0, 1]) {
      dust.capacityCurve = dust.capacityCurve.map((p) => ({ ...p, executableUsd, completionRatio: executableUsd / p.requestedNotionalUsd }));
      beta.exitRoutes.push(dust);
      const after = evaluate();
      expect(accounting(after)).toEqual(accounting(before));
      expect(after.breakdowns!.exit.alternatives.some((r) => r.label.includes("Negligible"))).toBe(true);
      beta.exitRoutes.pop();
    }
  });

  it.each(["exact-complete", "exact-lower-bound"] as const)("does not attribute non-score-eligible %s redemption zero as measured exhaustion", (coverageClass) => {
    const input = coreFixture();
    const alpha = input.assets.find((a) => a.assetId === "alpha")! as unknown as V9AssetFactsV2;
    const beta = input.assets.find((a) => a.assetId === "beta")! as unknown as V9AssetFactsV2;
    const routeEvidence = alpha.evidence.find((e) => e.evidenceId === "evidence:route")!;
    const redemptionRoute = structuredClone(alpha.exitRoutes.find((r) => r.routeId === "issuer-main")!);
    Object.assign(redemptionRoute, {
      routeFamily: "protocol-redemption", scoreEligible: false, evidenceKind: "live-reserve-state",
      coverageClass, settlementModel: "queued", settlementSlaSec: 86_400,
      capacityCurve: redemptionRoute.capacityCurve.map((p) => ({ ...p, executableUsd: 0, completionRatio: 0 })),
    });
    beta.evidence.push(routeEvidence);
    beta.exitStatus = knownStatus(routeEvidence.evidenceId, "exit.portfolio.reviewed");
    beta.exitRoutes = [redemptionRoute];

    const evaluated = evalInputAsset(input, "beta");
    expect(evaluated.exit.score).toBe(P.policy.semantic.unknownQuality.exit.U);
    expect(evaluated.exit.reasons).toContain("missing-same-notional-route");
    expect(evaluated.exit.reasons).not.toContain("no-viable-exit-path");
    expect(evaluated.scoreInput.pillars.exit.adverseAttribution).toEqual([]);
    expect(evaluated.trace.adverseAttribution).not.toContainEqual(expect.objectContaining({ source: "pillar-score", path: expect.stringMatching(/^pillar:exit:/) }));
    expect(evaluated.trace.finalGrade).not.toBe("F");
  });
});
