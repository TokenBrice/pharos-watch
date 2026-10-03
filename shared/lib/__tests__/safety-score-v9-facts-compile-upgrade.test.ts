import { describe, expect, it } from "vitest";
import {
  AS_OF_SEC,
  SOURCE_FINGERPRINTS,
  assertExactV9ActiveAssetSet,
  canonicalV9DependencyEdgeKey,
  canonicalV9RouteKey,
  compileV9FactSetV2,
  compileV9FactSetV3,
  compileNativeV3FactSet,
  computeV9FactSetDigest,
  createV9EvidenceReference,
  createV9FactGap,
  createV9FactGapV3,
  createV9FactStatus,
  evaluateV9FactSet,
  fullAsset,
  coreFixture,
  knownStatus,
  optionalExitV9Path,
  parseCompiledV9FactSetV2,
  readCompiledV9FactSetForEvaluation,
  requiredV9Applicability,
  stableJsonStringifyV1,
  V9_CANDIDATE_POLICY_V1,
} from "./safety-score-v9-facts.fixture-support";
import type { V9AssetFactsV2 } from "./safety-score-v9-facts.fixture-support";
import { unresolvedArchetype } from "./safety-score-v9-facts.test-support";
import { safeParseV9AssetFactsV3 } from "../safety-score-v9/compile";
import { resolveV9EvidenceCause } from "../safety-score-v9/evidence";
import type { V9EvidenceCauseScope, V9EvidenceGapClassification } from "../../types/safety-score-v9-causes";
import type { CompiledV9FactSetV3, V9FactSetCoreV3, V9EconomicControlReviewV2 } from "../../types/safety-score-v9-facts";


function currentCore(): V9FactSetCoreV3 {
  // Mutable authoring inputs must not retain the compiled graph's interned aliases.
  const { v9FactSetDigest: _digest, ...core } = JSON.parse(stableJsonStringifyV1(compileNativeV3FactSet(coreFixture()))) as CompiledV9FactSetV3;
  return core;
}
function classifiedCore(cause: "B" | "C"): V9FactSetCoreV3 {
  const core = currentCore();
  const asset = core.assets[0]!;
  const exposure = asset.reserveExposures[0]!;
  const scope: V9EvidenceCauseScope = {
    pillar: "backing", componentKey: "liquidity", factorKey: "liquidity", routeKey: null,
    exposureId: exposure.exposureKey, requiredDatum: "reserve liquidity horizon",
  };
  const reviewedAt = new Date(AS_OF_SEC * 1_000).toISOString().replace(".000Z", "Z");
  const common = {
    id: "classification:liquidity", assetId: asset.assetId, scope, reviewedAt, reviewer: "fixture-reviewer",
    sources: [{ url: "https://issuer.example/reserves", observedAt: reviewedAt, datumAsOf: null,
      location: "Liquidity section", excerpt: "Fixture evidence assertion.", assertion: "Fixture required-datum research." }],
  };
  const classification: V9EvidenceGapClassification = cause === "B"
    ? { ...common, cause: "B", assertion: "required-data-public" }
    : { ...common, cause: "C", assertion: "researched-nondisclosure", searchedSurfaces: ["https://issuer.example/reserves"],
      rationale: "The fixture search found no disclosure of this exact required datum." };
  const resolved = resolveV9EvidenceCause({
    assetId: asset.assetId, scope, asOfSec: AS_OF_SEC, sourceGenerationId: SOURCE_FINGERPRINTS.researchOverlays.generationId,
    evidenceReferences: asset.evidence, classification,
  });
  asset.evidence = [...resolved.evidenceReferences];
  const gap = createV9FactGapV3({
    gapId: "classified-liquidity", reasonCode: "material-unknown-reserve-exposure", ownerDomain: "backing",
    policyRuleId: "reserve:liquidity", observationState: "missing", path: { kind: "collateral-exposure", exposureKey: exposure.exposureKey },
    message: "Reserve liquidity is unresolved.", causeScope: scope, causeProof: resolved.causeProof, responsibility: resolved.responsibility,
  });
  asset.gaps.push(gap);
  exposure.liquidityHorizon = "unknown";
  exposure.factorStatuses = { ...exposure.factorStatuses, liquidity: createV9FactStatus({
    observationState: "missing", applicability: requiredV9Applicability("reserve:liquidity"), gapIds: [gap.gapId],
  }) };
  return core;
}

describe("current cause admission", () => {
  it.each(["B", "C"] as const)("binds authored %s research bytes through compile and evaluation admission", (cause) => {
    const compiled = compileV9FactSetV3(classifiedCore(cause));
    const admitted = readCompiledV9FactSetForEvaluation(compiled).factSet.assets[0]!;
    expect(admitted.gaps.find((gap) => gap.gapId === "classified-liquidity")!.causeProof.cause).toBe(cause);
  });

  it.each(["B", "C"] as const)("rejects mutated authored %s assertion bytes even with an otherwise valid reference", (cause) => {
    const core = classifiedCore(cause);
    const asset = core.assets[0]!;
    const proof = asset.gaps.find((gap) => gap.gapId === "classified-liquidity")!.causeProof;
    if (proof.cause !== "B" && proof.cause !== "C") throw new Error("Expected researched fixture proof");
    proof.sources[0]!.excerpt = "Changed assertion bytes.";
    expect(safeParseV9AssetFactsV3(asset).success).toBe(false);
    expect(() => compileV9FactSetV3(core)).toThrow();
  });

  it("rejects wrong research scope before either asset admission or whole-cohort hashing", () => {
    const core = classifiedCore("B");
    const asset = core.assets[0]!;
    asset.gaps.find((gap) => gap.gapId === "classified-liquidity")!.causeScope!.factorKey = "maturity";
    expect(safeParseV9AssetFactsV3(asset).success).toBe(false);
    expect(() => compileV9FactSetV3(core)).toThrow();
  });

  it("never lets an envelope-3 payload enter the current evaluation reader", () => {
    const current = compileV9FactSetV3(currentCore());
    expect(() => readCompiledV9FactSetForEvaluation({ ...current, schemaVersion: 3 })).toThrow();
  });

  it("requires an unknown reserve subfield to have its own status rather than hiding under known whole-row metadata", () => {
    const core = currentCore();
    const asset = core.assets[0]!;
    const exposure = asset.reserveExposures.find((row) => row.maturityDaysMax !== null)!;
    exposure.liquidityHorizon = "unknown";
    expect(safeParseV9AssetFactsV3(asset).success).toBe(false);
  });

  it("requires unknown modeled confidence to carry its own cause-bearing status", () => {
    const core = currentCore();
    const asset = core.assets[0]!;
    asset.exitRoutes.find((route) => route.scoreEligible)!.modelConfidence = "unknown";
    expect(safeParseV9AssetFactsV3(asset).success).toBe(false);
  });

  it.each(["reconciliation", "supervision", "upgrade", "oracle", "bridge-route"] as const)(
    "keeps known parent facts while requiring a linked cause for unknown economic factor %s", (factor) => {
      const core = currentCore();
      const asset = core.assets[0]!;
      let target: Pick<V9EconomicControlReviewV2["mint"], "factorStatuses">;
      let key: string;
      if (factor === "oracle") {
        asset.economicControlReview.oracle.status = knownStatus();
        asset.economicControlReview.oracle.tier = null;
        target = asset.economicControlReview.oracle;
        key = "tier";
      } else if (factor === "bridge-route") {
        asset.economicControlReview.bridge.status = knownStatus();
        asset.economicControlReview.bridge.routes = [{
          controlKey: asset.controls[0]!.controlKey, tier: "opaque-or-unknown",
        }];
        const route = asset.economicControlReview.bridge.routes[0]!;
        target = route;
        key = "tier";
      } else {
        const mint = asset.economicControlReview.mint;
        if (factor === "upgrade") mint.upgrade = { state: "unknown", controlKey: null };
        else mint[factor] = "unknown";
        target = mint;
        key = factor;
      }
      const replacedGapIds = target.factorStatuses?.[key]?.gapIds ?? [];
      asset.gaps = asset.gaps.filter((gap) => !replacedGapIds.includes(gap.gapId));
      target.factorStatuses = { ...target.factorStatuses };
      delete target.factorStatuses[key];
      expect(safeParseV9AssetFactsV3(asset).success).toBe(false);
      const gap = createV9FactGapV3({
        gapId: `economic:${factor}`, reasonCode: "scoped-control-question", ownerDomain: "control",
        policyRuleId: `economic:${factor}`, observationState: "missing", path: { kind: "local-component", componentKey: `economic:${factor}` },
        message: "This economic-control factor has not been researched.", responsibility: "unresearched",
      });
      const status = createV9FactStatus({ observationState: "missing", applicability: requiredV9Applicability(`economic:${factor}`), gapIds: [gap.gapId] });
      target.factorStatuses[key] = status;
      expect(safeParseV9AssetFactsV3(asset).success).toBe(false);
      asset.gaps.push(gap);
      const admitted = compileV9FactSetV3(core).assets[0]!;
      expect(admitted.economicControlReview.mint.status.observationState).toBe("known");
      expect(admitted.controls).toEqual(asset.controls);
      expect(safeParseV9AssetFactsV3(admitted).success).toBe(true);
    },
  );

  it("retains a linked missing operational fact without manufacturing positive eligibility evidence", () => {
    const core = currentCore();
    const asset = core.assets[0]!;
    asset.operationalResilience = null;
    const gap = createV9FactGapV3({
      gapId: "missing-operational", reasonCode: "scoped-control-question", ownerDomain: "control",
      policyRuleId: "operational-eligibility", observationState: "missing",
      path: { kind: "local-component", componentKey: "operational-eligibility" },
      message: "Operational eligibility evidence is unavailable.", responsibility: "unresearched",
    });
    asset.operationalResilienceStatus = createV9FactStatus({
      observationState: "missing", applicability: requiredV9Applicability("operational-eligibility"), gapIds: [gap.gapId],
    });
    expect(safeParseV9AssetFactsV3(asset).success).toBe(false);
    asset.gaps.push(gap);
    const admitted = compileV9FactSetV3(core).assets[0]!;
    expect(admitted.operationalResilience).toBeNull();
    expect(admitted.operationalResilienceStatus!.observationState).toBe("missing");
    const forged = structuredClone(admitted);
    forged.operationalResilienceStatus = knownStatus();
    expect(safeParseV9AssetFactsV3(forged).success).toBe(false);
  });

  it("retains overlapping score-eligible alternatives for portfolio allocation rather than rejecting the whole current cohort", () => {
    const core = currentCore();
    const routes = core.assets[0]!.exitRoutes.filter((route) => route.scoreEligible);
    routes[1]!.physicalResourceKeys = [...routes[0]!.physicalResourceKeys];
    const admitted = compileV9FactSetV3(core).assets[0]!;
    expect(admitted.exitRoutes.filter((route) => route.scoreEligible).map((route) => route.physicalResourceKeys))
      .toEqual([routes[0]!.physicalResourceKeys, routes[0]!.physicalResourceKeys]);
  });

  it("keeps failed optional proof conversion unresearched without quarantining known facts or losing expired publisher history", () => {
    const core = currentCore();
    const asset = core.assets[0]!;
    const exposure = asset.reserveExposures[0]!;
    const scope: V9EvidenceCauseScope = {
      pillar: "backing", componentKey: "liquidity", factorKey: "liquidity", exposureId: exposure.exposureKey,
      routeKey: null, requiredDatum: "reserve liquidity horizon",
    };
    const historical = createV9EvidenceReference({
      evidenceId: "expired-typed-review", sourceId: "issuer-reserve-report", sourceGenerationId: "old-report",
      disposition: "published", observedAtSec: 700, publishedAtSec: 710, maxAgeSec: 200,
    }, AS_OF_SEC);
    asset.evidence.push(historical);
    const result = resolveV9EvidenceCause({
      assetId: asset.assetId, scope, asOfSec: AS_OF_SEC, sourceGenerationId: "typed-review",
      evidenceReferences: asset.evidence,
      typedReview: { id: "unsupported-review", assetId: asset.assetId, scope, cause: "C",
        assertion: "researched-nondisclosure", reviewedAt: "not-a-date",
        sources: ["https://issuer.example/reserves"], rationale: "Authored nondisclosure rationale." },
    });
    const gap = createV9FactGapV3({
      gapId: "failed-optional-review", reasonCode: "material-unknown-reserve-exposure", ownerDomain: "backing",
      policyRuleId: "reserve:liquidity", observationState: "missing", causeScope: scope, causeProof: result.causeProof,
      path: { kind: "collateral-exposure", exposureKey: exposure.exposureKey }, message: "Liquidity remains unresearched.",
      responsibility: result.responsibility, evidenceHistory: { publishedBy: "issuer", references: [historical] },
    });
    asset.gaps.push(gap);
    asset.causeResolutionDiagnostics = [...(result.diagnostics ?? [])];
    exposure.liquidityHorizon = "unknown";
    exposure.factorStatuses = { ...exposure.factorStatuses, liquidity: createV9FactStatus({
      observationState: "missing", applicability: requiredV9Applicability("reserve:liquidity"), gapIds: [gap.gapId],
    }) };
    const admitted = readCompiledV9FactSetForEvaluation(compileV9FactSetV3(core)).factSet.assets[0]!;
    const admittedGap = admitted.gaps.find((candidate) => candidate.gapId === gap.gapId)!;
    expect(admittedGap.causeProof.cause).toBe("U");
    expect(admittedGap.responsibility).toBe("unresearched");
    expect(admittedGap.evidenceRefIds).toEqual([]);
    expect(admittedGap.evidenceHistory!.publishedBy).toBe("issuer");
    const oldSource = admitted.evidence.find((reference) => reference.evidenceId === admittedGap.evidenceHistory!.evidenceRefIds[0])!;
    expect(oldSource).toMatchObject({ observedAtSec: 700, publishedAtSec: 710, freshness: { state: "stale", ageSec: 300 } });
    expect(admitted.causeResolutionDiagnostics).toEqual([expect.objectContaining({ code: "cause-proof-conversion-failed", scope })]);
    expect(admitted.controls).toEqual(asset.controls);
    const dangling = structuredClone(admitted);
    dangling.gaps.find((candidate) => candidate.gapId === gap.gapId)!.evidenceHistory!.evidenceRefIds = ["not-captured"];
    expect(safeParseV9AssetFactsV3(dangling).success).toBe(false);
  });
  it("admits compatible composition strength only with an actual composition and rejects live/static contradictions", () => {
    const core = currentCore();
    const asset = core.assets[0]!;
    asset.reserveCompositionEvidenceClass = "issuer-attested";
    asset.reserveCompositionProvenance = "curated";
    expect(safeParseV9AssetFactsV3(asset).success).toBe(true);
    const contradictory = structuredClone(asset);
    contradictory.reserveCompositionProvenance = "live";
    expect(safeParseV9AssetFactsV3(contradictory).success).toBe(false);
    delete contradictory.reserveCompositionEvidenceClass;
    expect(safeParseV9AssetFactsV3(contradictory).success).toBe(true);
    const incomplete = structuredClone(asset);
    delete incomplete.reserveCompositionEvidenceClass;
    expect(safeParseV9AssetFactsV3(incomplete).success).toBe(false);
    const absent = core.assets.find((candidate) => candidate.reserveExposures.length === 0)!;
    expect(safeParseV9AssetFactsV3(absent).success).toBe(true);
    absent.reserveCompositionProvenance = "live";
    expect(safeParseV9AssetFactsV3(absent).success).toBe(false);
    const uncaptured = structuredClone(asset);
    uncaptured.reserveStatus.evidenceRefIds = ["not-captured"];
    expect(safeParseV9AssetFactsV3(uncaptured).success).toBe(false);
  });

  it("rejects a measured adverse proof on a reserve remainder without rejecting the same admitted proof as a separate adverse fact", () => {
    const core = currentCore();
    const asset = core.assets[0]!;
    const scope: V9EvidenceCauseScope = {
      pillar: "backing", componentKey: "reserve-remainder", factorKey: null,
      routeKey: null, exposureId: null, requiredDatum: "reserve remainder identity",
    };
    const source = createV9EvidenceReference({
      evidenceId: "measured-reserve-loss", sourceId: "reserve-loss-observation", sourceGenerationId: "measured-loss:g1",
      disposition: "observed", observedAtSec: AS_OF_SEC,
      causeBinding: { assetId: asset.assetId, scope, producerState: null, rejectionCode: null, adverseFactId: "reserve-loss" },
    }, AS_OF_SEC);
    asset.evidence.push(source);
    const remainder = createV9FactGapV3({
      gapId: "unclassified-tail", reasonCode: "material-unknown-reserve-exposure", ownerDomain: "backing",
      policyRuleId: "reserve-remainder", observationState: "missing", causeScope: scope,
      path: { kind: "local-component", componentKey: "reserve-remainder" },
      responsibility: "unresearched", message: "The remaining holdings are unidentified.",
    });
    const adverse = createV9FactGapV3({
      ...remainder, gapId: "measured-adverse",
      evidenceHistory: undefined,
      causeProof: { cause: "D", adverseFactId: "reserve-loss", evidenceRefIds: [source.evidenceId] },
      responsibility: "measured-adverse",
    });
    asset.gaps.push(remainder, adverse);
    asset.reserveExposures[0]!.weight -= 0.1;
    const status = createV9FactStatus({
      observationState: "missing", applicability: requiredV9Applicability("reserve-remainder"), gapIds: [remainder.gapId],
    });
    asset.reserveResiduals.push({ residualId: "unclassified-tail", weight: 0.1, status });
    expect(safeParseV9AssetFactsV3(asset).success).toBe(true);
    const forged = structuredClone(asset);
    forged.reserveResiduals[0]!.status.gapIds = [adverse.gapId];
    expect(safeParseV9AssetFactsV3(forged).success).toBe(false);
    expect(() => compileV9FactSetV3({ ...core, assets: [forged, ...core.assets.slice(1)] })).toThrow();
    expect(safeParseV9AssetFactsV3(core.assets[1]!).success).toBe(true);
  });
});

describe("Safety Score v9 fact compilation and upgrades", () => {
  it("keeps admitted assets immutable without bypassing cohort or clone validation", () => {
    const compiled = compileNativeV3FactSet(coreFixture());
    const { v9FactSetDigest: digest, ...core } = structuredClone(compiled);
    const admitted = core.assets.map((asset) => {
      const parsed = safeParseV9AssetFactsV3(asset);
      if (!parsed.success) throw parsed.error;
      return parsed.data;
    });
    const admittedCore = { ...core, assets: admitted };
    core.assets[0]!.supply.circulatingUsd = -1;
    expect(compileV9FactSetV3(admittedCore).v9FactSetDigest).toBe(digest);
    expect(() => { admitted[0]!.supply.circulatingUsd = -1; }).toThrow(TypeError);
    expect(() => compileV9FactSetV3({
      ...admittedCore,
      activeAssetIds: admittedCore.activeAssetIds.slice(1),
    })).toThrow("Assets must match the exact active asset set");
    const cloned = structuredClone(admittedCore);
    cloned.assets[0]!.supply.circulatingUsd = -1;
    expect(() => compileV9FactSetV3(cloned)).toThrow();
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
    for (const result of evaluated.assets) {
      expect(result.trace.ratingStatus).not.toBe("pipeline-gap");
      expect(result.trace.partialEvidence).toBeNull();
      expect(result.scoreInput.parent.score).not.toBe(100);
      expect(result.trace.nrReasons.every((reason) => reason.code !== "implementation-parent-cycle" && reason.code !== "parent-cycle")).toBe(true);
    }
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
    expect(() => readCompiledV9FactSetForEvaluation(retained)).toThrow();
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
    unresolvedArchetype(beta, "gap:missing-archetype");
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
  it("requires native V3 dependency identities to include their economic role", () => {
    const { v9FactSetDigest: _digest, ...core } = structuredClone(compileNativeV3FactSet(coreFixture()));
    const edge = core.assets[0]!.dependencies.edges.find((candidate) => candidate.upstreamAssetId === "beta")!;
    edge.economicRole = "exit-dependency";
    edge.pathKind = "local-component";
    expect(() => compileV9FactSetV3(core)).toThrow("Expected exit-dependency:collateral:beta");
    edge.edgeKey = "exit-dependency:collateral:beta";
    expect(compileV9FactSetV3(core).assets[0]!.dependencies.edges).toContainEqual(
      expect.objectContaining({ edgeKey: "exit-dependency:collateral:beta", economicRole: "exit-dependency" }),
    );
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

describe("Safety Score v9 fact digest canonicalization", () => {
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
  it("canonicalizes the retained Hyperliquid alias and fails closed on an alias collision", () => {
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
    // P1-03: hyperliquid is no longer a mature chain, so the folded 100% alias share grades high.
    expect(severity(alias)).toBe("high");

    const collision = coreFixture();
    configure(collision, [
      { chainId: "ethereum", supplyUsd: 950_200, supplyShare: 0.9502 },
      { chainId: "hyperliquid", supplyUsd: 24_900, supplyShare: 0.0249 },
      { chainId: "hyperliquid-l1", supplyUsd: 24_900, supplyShare: 0.0249 },
    ]);
    // P1-03: with hyperliquid no longer mature, the ambiguous alias pair is visible as the
    // fail-closed "chain inventory unavailable" verdict instead of being masked by maturity.
    expect(severity(collision)).toBe("high");
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
  it("binds native V3 semantics and responsibility while excluding compilation time", () => {
    const first = compileNativeV3FactSet(coreFixture());
    const { v9FactSetDigest: _digest, ...core } = structuredClone(first);
    core.compiledAtSec += 500;
    expect(compileV9FactSetV3(core).v9FactSetDigest).toBe(first.v9FactSetDigest);
    const supply = core.assets[0]!.supply;
    if (supply.circulatingUsd === null) throw new Error("Fixture circulating supply must be known");
    supply.circulatingUsd += 1;
    supply.chainDistribution!.chains[0]!.supplyUsd += 1;
    expect(compileV9FactSetV3(core).v9FactSetDigest).not.toBe(first.v9FactSetDigest);

    const { v9FactSetDigest: _ownerDigest, ...ownerCore } = structuredClone(first);
    const gap = ownerCore.assets[0]!.gaps[0]!;
    expect(gap.responsibility).not.toBe("issuer-undisclosed");
    gap.responsibility = "issuer-undisclosed";
    expect(() => compileV9FactSetV3(ownerCore)).toThrow();
  });
  it("accepts intact native V3 captures and refuses semantic tampering at the evaluation reader", () => {
    const first = compileNativeV3FactSet(coreFixture());
    expect(readCompiledV9FactSetForEvaluation(first)).toEqual({
      sourceSchemaVersion: 4,
      sourceFactSetDigest: first.v9FactSetDigest,
      factSet: first,
    });
    const tampered = structuredClone(first);
    const tamperedSupply = tampered.assets[0]!.supply;
    if (tamperedSupply.circulatingUsd === null) throw new Error("Fixture circulating supply must be known");
    tamperedSupply.circulatingUsd += 1;
    tamperedSupply.chainDistribution!.chains[0]!.supplyUsd += 1;
    expect(() => readCompiledV9FactSetForEvaluation(tampered)).toThrow("does not match");
  });
});
