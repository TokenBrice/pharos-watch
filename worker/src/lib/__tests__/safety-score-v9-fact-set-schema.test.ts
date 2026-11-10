import { describe, expect, it } from "vitest";
import { stableJsonStringifyV1 } from "@shared/lib/stable-json";
import { createV9PublicationAssetCompactor, createV9PublicationResearchHashRebinder, safeParseV9AssetFactsV3 } from "@shared/lib/safety-score-v9/compile";
import { RejectionSchema, SafetyScoreV9FactSetExtensionV2Schema } from "../safety-score-v9/fact-set-schema";
import { makeV9Extension, makeV9FixedInput, makeV9ThreeAssetFixedInput, makeV9TwoAssetFixedInput, v9Status } from "../../test-helpers/v9-fixed-input";
import { assertSafetyScoreV9ExactExtensionAssets } from "../safety-score-v9/fact-set-boundary";
import { createSafetyScoreV9BaselineExtensionSource, type V9ExtensionRegistryMeta } from "../safety-score-v9/extension";
import {
  compileSafetyScoreV9FactSetFromExtensionSource,
  compileSafetyScoreV9FactSetFromFixedInput,
  compileSafetyScoreV9FactSetWithIsolationFromValidatedExtension,
  materializeSafetyScoreV9FactSetExtension,
} from "../safety-score-v9/fact-set";
import { normalizeSafetyScoreV9CompilerInput } from "../safety-score-v9/native-input";
import { buildV9EvidenceGapQueue } from "@shared/lib/safety-score-v9/evidence-gap-queue";
import { V9_CANDIDATE_POLICY_V1 } from "@shared/lib/safety-score-v9/policy";
import { V9AssetFactsV3Schema, V9EffectiveDependenciesV3Schema, type V9AssetFactsV3 } from "@shared/types/safety-score-v9-facts";

describe("Safety Score V9 fact-set input primitives", () => {
  it("rejects surrounding whitespace instead of normalizing identity-bearing text", () => {
    expect(
      RejectionSchema.safeParse({
        code: " producer-failed ",
        reason: "Canonical evidence reason",
        rejectedAtSec: 1_783_891_200,
      }).success,
    ).toBe(false);
  });

  it("accepts already-canonical identity-bearing text without transformation", () => {
    const value = {
      code: "producer-failed",
      reason: "Canonical evidence reason",
      rejectedAtSec: 1_783_891_200,
    };
    expect(RejectionSchema.parse(value)).toEqual(value);
  });

  it.each([
    ["wrapper", "serial-claim", 1, true],
    ["wrapper", "serial-claim", 0.5, false],
    ["collateral", "serial-claim", 1, false],
    ["mechanism", "basket-exposure", 0.5, false],
    ["collateral", "basket-exposure", 0.5, true],
    ["wrapper", "oracle-nav", 1, false],
    ["mechanism", "oracle-nav", 0.5, true],
  ] as const)("keeps producer/compiled role invariants for %s %s at %s", (dependencyType, economicRole, weight, accepted) => {
    const extension = makeV9Extension();
    const dependencies = {
      source: "manual" as const, baseSource: "manual" as const, dependencyFromLive: false,
      mappedLiveReserveWeight: null, fallbackReason: null,
      diagnostics: { graphState: "valid" as const, issueCodes: [], sccMemberAssetIds: [] },
      edges: [{ upstreamAssetId: "upstream", dependencyType, economicRole, weight,
        failureDomains: [{ kind: "oracle-feed" as const, key: "upstream" }] }],
    };
    extension.assets[0]!.dependencies = dependencies;
    const compiled = { ...dependencies, status: v9Status(), sourceGenerationId: "fixture:g1",
      edges: dependencies.edges.map(edge => ({ ...edge, edgeKey: "edge:upstream", evidenceRefIds: ["evidence"],
        pathKind: economicRole === "serial-claim" ? "serial-dependency"
          : economicRole === "basket-exposure" ? "collateral-exposure" : "local-component" })) };
    expect(SafetyScoreV9FactSetExtensionV2Schema.safeParse(extension).success).toBe(accepted);
    expect(V9EffectiveDependenciesV3Schema.safeParse(compiled).success).toBe(accepted);
    if (economicRole === "oracle-nav" && accepted) {
      expect(V9EffectiveDependenciesV3Schema.safeParse({
        ...compiled, edges: compiled.edges.map(edge => ({ ...edge, evidenceRefIds: [] })),
      }).success).toBe(false);
    }
  });

  it("retains producer role absence and canonical sorting without compiled envelope admission", () => {
    const extension = makeV9Extension();
    const dependencies = extension.assets[0]!.dependencies!;
    dependencies.edges = ["z-upstream", "a-upstream"].map(upstreamAssetId => ({
      upstreamAssetId, dependencyType: "mechanism", weight: 1, failureDomains: [],
    }));
    const parsed = SafetyScoreV9FactSetExtensionV2Schema.parse(extension).assets[0]!.dependencies!;
    expect(parsed.edges.map(edge => edge.upstreamAssetId)).toEqual(["a-upstream", "z-upstream"]);
    expect(parsed.edges.every(edge => !("economicRole" in edge))).toBe(true);
    expect(parsed).not.toHaveProperty("rejectionReasons");
    expect(V9EffectiveDependenciesV3Schema.safeParse({
      ...parsed, status: v9Status(), sourceGenerationId: "fixture:g1",
      edges: parsed.edges.map(edge => ({ ...edge, economicRole: "serial-claim", pathKind: "serial-dependency",
        edgeKey: `serial-claim:mechanism:${edge.upstreamAssetId}`, evidenceRefIds: ["evidence"] })),
    }).success).toBe(false);
  });

  it.each([undefined, "native", "controlled"] as const)("preserves bridge route optional kind %s through producer and compilation", (reviewedRouteKind) => {
    const fixed = makeV9FixedInput();
    const extension = makeV9Extension({ registryFingerprint: fixed.registryFingerprint });
    const row = { deploymentRouteKey: "bridge:fixture", supplyUsd: 1_000_000, supplyShare: 0.1,
      reviewState: "selected-reviewed" as const, ...(reviewedRouteKind === undefined ? {} : { reviewedRouteKind }) };
    const supplyReview = extension.assets[0]!.supplyReview!;
    supplyReview.selectedBridgeRoutes = [row];
    supplyReview.selectedRouteSupplyShare = 0.1;
    supplyReview.unknownRouteSupplyShare = 0.9;
    const producer = SafetyScoreV9FactSetExtensionV2Schema.parse(extension);
    const factSet = compileSafetyScoreV9FactSetFromFixedInput(fixed, producer);
    expect(producer.assets[0]!.supplyReview!.selectedBridgeRoutes).toEqual([row]);
    expect(factSet.assets[0]!.supply.selectedBridgeRoutes).toEqual([row]);
    const invalid = structuredClone(extension);
    invalid.assets[0]!.supplyReview!.selectedBridgeRoutes[0] = {
      ...row, reviewState: "selected-unresolved", reviewedRouteKind: "native",
    };
    expect(SafetyScoreV9FactSetExtensionV2Schema.safeParse(invalid).success).toBe(false);
    const invalidCompiled = structuredClone(factSet.assets[0]!);
    invalidCompiled.supply.selectedBridgeRoutes[0] = invalid.assets[0]!.supplyReview!.selectedBridgeRoutes[0]!;
    expect(V9AssetFactsV3Schema.safeParse(invalidCompiled).success).toBe(false);
  });
});

describe("Safety Score V9 fact-set refinement rejections", () => {
  it("rejects researchEvidence.observedAtSec later than compiledAtSec", () => {
    const extension = makeV9Extension();
    extension.assets[0]!.researchEvidence = [{
      evidenceKey: "future-observation",
      sourceId: "fixture.future-observation",
      observedAtSec: extension.compiledAtSec + 1,
      publishedAtSec: null,
      url: "https://example.com/future-observation",
      contentSha256: "a".repeat(64),
      confidence: "verified",
      maxAgeSec: 86_400,
    }];

    expect(() => SafetyScoreV9FactSetExtensionV2Schema.parse(extension)).toThrow(
      "Research evidence observation cannot be later than the extension clock",
    );
  });
});

describe("v10.01 cause compilation contract", () => {
  it("shares one quarantine A lineage across every synthetic missing status", () => {
    const fixed = makeV9FixedInput();
    const extension = makeV9Extension({ registryFingerprint: fixed.registryFingerprint });
    extension.sources.researchOverlays.observedAtSec = fixed.clockSec - 600;
    const asset = compileSafetyScoreV9FactSetFromFixedInput(fixed, extension).assets[0]!;
    const gap = asset.gaps.find((row) => row.gapId === "alpha:gap:asset-compilation")!;
    expect(gap.causeProof).toMatchObject({ cause: "A", sourceGenerationId: fixed.baseInputGenerationId });
    const statuses = [
      asset.implementation.status, asset.reserveStatus, asset.exitStatus, asset.controlStatus,
      asset.economicControlReview!.mint.status, asset.economicControlReview!.mint.factorStatuses!.reconciliation!,
      asset.economicControlReview!.oracle.status, asset.economicControlReview!.bridge.status,
    ];
    for (const status of statuses) {
      expect(status.gapIds).toEqual([gap.gapId]);
      expect(status.evidenceRefIds).toEqual(gap.causeProof.evidenceRefIds);
    }
    expect(asset.economicControlReview!.mint.reconciliation).toBe("unknown");
    expect(asset.reserveExposures).toEqual([]);
    expect(asset.exitRoutes).toEqual([]);
  });

  it("keeps unreviewed holder access policy-bound without discarding measured capacity", () => {
    const fixed = makeV9FixedInput();
    const extension = makeV9Extension({ registryFingerprint: fixed.registryFingerprint });
    extension.assets[0]!.routeReviews[0]!.holderAccess = "unknown";
    const factSet = compileSafetyScoreV9FactSetFromFixedInput(fixed, extension);
    const asset = factSet.assets[0]!;
    const route = asset.exitRoutes[0]!;
    expect(route.status.observationState).toBe("known");
    const gap = asset.gaps.find((row) => row.gapId === route.factorStatuses.holderEligibility!.gapIds[0])!;
    expect(gap.causeScope).toEqual({ pillar: "exit", componentKey: "exit-route",
      factorKey: "holderEligibility", routeKey: route.routeKey, exposureId: null, requiredDatum: "holderEligibility" });
    expect(gap.causeProof.cause).toBe("U");
    expect(buildV9EvidenceGapQueue({ factSet, policy: V9_CANDIDATE_POLICY_V1 })
      .summary.policyBindingMismatchGapCount).toBe(0);
    expect(route.factorStatuses.capacity!.observationState).toBe("known");
    expect(route.capacityCurve[0]!.completionRatio).toBe(0.8);
  });

  it.each([
    ["2026-07-12", "C"],
    ["2026-07-13", "U"],
    ["2025-07-12", "U"],
    ["2026-07-14", "U"],
  ] as const)("uses typed mechanism review %s only when current and before the capture day", (reviewedAt, cause) => {
    const fixed = makeV9FixedInput({ assetId: "usdc-circle", clockSec: Date.parse("2026-07-13T00:00:00Z") / 1000 });
    const extension = makeV9Extension({ assetId: "usdc-circle", clockSec: fixed.clockSec, registryFingerprint: fixed.registryFingerprint });
    const review = extension.assets[0]!.mechanismRiskReview!;
    if (review.archetype !== "fiat-cash") throw new Error("Expected fiat review");
    review.claimAndSegregation.status = v9Status("missing");
    review.claimAndSegregation.quality = null;
    extension.assets[0]!.mechanismReviewedUnavailable = [{
      componentKey: "claimAndSegregation", reviewedAt,
      rationale: "The primary holder terms omit an enforceable segregation claim.",
      sourceUrl: "https://example.com/holder-terms", searchedSurfaces: ["https://example.com/holder-terms"],
    }];
    const asset = compileSafetyScoreV9FactSetFromFixedInput(fixed, extension).assets[0]!;
    const gap = asset.gaps.find((row) => row.causeScope?.componentKey === "mechanism-review:claimAndSegregation")!;
    expect(gap.causeProof.cause).toBe(cause);
    if (gap.causeProof.cause === "C") {
      expect(gap.causeProof.reviewedAt).toBe(reviewedAt);
      expect(gap.causeProof.proofOrigin).toBe("typed-review");
      expect(gap.causeProof.sources[0]!.observedAt).toBeUndefined();
    }
  });

  it("keeps malformed typed-review conversion local and diagnoses U without quarantining measured facts", () => {
    const fixed = makeV9FixedInput({ assetId: "usdc-circle", clockSec: 100_000 });
    const extension = makeV9Extension({ assetId: "usdc-circle", clockSec: fixed.clockSec, registryFingerprint: fixed.registryFingerprint });
    const review = extension.assets[0]!.mechanismRiskReview!;
    if (review.archetype !== "fiat-cash") throw new Error("Expected fiat review");
    review.claimAndSegregation.status = v9Status("missing");
    review.claimAndSegregation.quality = null;
    extension.assets[0]!.mechanismReviewedUnavailable = [{
      componentKey: "claimAndSegregation", reviewedAt: "1970-01-01",
      rationale: "The scoped claim terms were not disclosed in the reviewed surfaces.",
      sourceUrl: "not-a-primary-url", searchedSurfaces: ["https://example.com/holder-terms"],
    }];
    const asset = compileSafetyScoreV9FactSetFromFixedInput(fixed, extension).assets[0]!;
    const gap = asset.gaps.find((row) => row.causeScope?.componentKey === "mechanism-review:claimAndSegregation")!;
    expect(gap.causeProof.cause).toBe("U");
    expect(asset.causeResolutionDiagnostics).toEqual([expect.objectContaining({
      code: "cause-proof-conversion-failed", scope: gap.causeScope,
    })]);
    expect(asset.gaps.some((row) => row.causeScope?.componentKey === "asset-compilation")).toBe(false);
    expect(asset.implementation.status.observationState).toBe("known");
  });
});
function fixture() {
  const fixedInput = normalizeSafetyScoreV9CompilerInput(makeV9ThreeAssetFixedInput());
  const metaById = new Map<string, V9ExtensionRegistryMeta>(fixedInput.activeAssetIds.map((id) => [id, {
    id, mechanismArchetype: "fiat-cash", launchDate: "1970-01-01",
    dependencies: id === "alpha" ? [{ id: "beta", type: "wrapper", weight: 1 }]
      : id === "beta" ? [{ id: "alpha", type: "wrapper", weight: 1 }] : [],
  }]));
  return { fixedInput, source: createSafetyScoreV9BaselineExtensionSource(fixedInput, { metaById }) };
}

describe("per-asset extension compilation", () => {
  it.each([false, true])("preserves full facts, digests, graph and quarantine on retry=%s", (retry) => {
    const { fixedInput, source } = fixture();
    const failures = retry ? new Map([["gamma", "fixture evaluation failure"]]) : undefined;
    const extension = materializeSafetyScoreV9FactSetExtension(fixedInput, { ...source.extension, assets: [...source.assets()] });
    const full = compileSafetyScoreV9FactSetWithIsolationFromValidatedExtension(fixedInput, extension, failures);
    let traversals = 0;
    const streamed = compileSafetyScoreV9FactSetFromExtensionSource(fixedInput, {
      ...source, *assets() { traversals++; yield* source.assets(); },
    }, failures);
    expect(traversals).toBe(1);
    expect(stableJsonStringifyV1(streamed.factSet)).toBe(stableJsonStringifyV1(full.factSet));
    const finalizedHash = streamed.factSet.sourceFingerprints.researchOverlays!.payloadSha256;
    for (const asset of streamed.factSet.assets) {
      for (const reference of asset.evidence) {
        expect(reference.contentSha256).not.toBe("0".repeat(64));
        if (reference.sourceId === "safety-score-v9-research-overlay" || reference.sourceId === "safety-score-v9-compiler") {
          expect(reference.contentSha256).toBe(finalizedHash);
        }
      }
    }
    expect(streamed.quarantines).toEqual(full.quarantines);
    expect(streamed.bridgeJoinDiagnostics).toEqual(extension.assets.flatMap((asset) => {
      const diagnostics = asset.economicControlReview?.bridge.diagnostics;
      return diagnostics === undefined ? [] : [{ assetId: asset.assetId, ...diagnostics }];
    }));
    expect(source.extension.assets).toEqual([]);
    expect([...source.assets()]).toEqual(extension.assets);
  });

  it("preserves the independent shock-coverage digest and original observation time", () => {
    const fixedInput = normalizeSafetyScoreV9CompilerInput(makeV9FixedInput({ assetId: "lusd-liquity", clockSec: 1_784_225_942 }));
    const source = createSafetyScoreV9BaselineExtensionSource(fixedInput);
    const extension = materializeSafetyScoreV9FactSetExtension(fixedInput, { ...source.extension, assets: [...source.assets()] });
    const full = compileSafetyScoreV9FactSetWithIsolationFromValidatedExtension(fixedInput, extension);
    const streamed = compileSafetyScoreV9FactSetFromExtensionSource(fixedInput, source);
    expect(full.factSet.sourceFingerprints.shockCoverage).toBeDefined();
    expect(stableJsonStringifyV1(streamed.factSet)).toBe(stableJsonStringifyV1(full.factSet));
  });

  it("quarantines malformed asset-local input without changing healthy siblings", () => {
    const { fixedInput, source } = fixture();
    const rows = [...source.assets()];
    rows[0] = { ...rows[0]!, launchedAtSec: -1 };
    const extension = materializeSafetyScoreV9FactSetExtension(fixedInput, { ...source.extension, assets: rows });
    const full = compileSafetyScoreV9FactSetWithIsolationFromValidatedExtension(fixedInput, extension);
    const streamed = compileSafetyScoreV9FactSetFromExtensionSource(fixedInput, { ...source, *assets() { yield* rows; } });
    expect(streamed.quarantines).toEqual(full.quarantines);
    expect(streamed.quarantines).toEqual([expect.objectContaining({ assetId: "alpha", code: "fact-validation-failed" })]);
    expect(stableJsonStringifyV1(streamed.factSet)).toBe(stableJsonStringifyV1(full.factSet));
  });

  it("rejects empty, missing, duplicate or out-of-order cohorts and invalid envelopes", () => {
    const { fixedInput, source } = fixture();
    const rows = [...source.assets()];
    for (const assets of [[], rows.slice(1), [rows[0]!, rows[0]!, rows[2]!], [...rows].reverse()]) {
      expect(() => compileSafetyScoreV9FactSetFromExtensionSource(fixedInput, { ...source, *assets() { yield* assets; } })).toThrow();
    }
    expect(() => compileSafetyScoreV9FactSetFromExtensionSource(fixedInput, {
      ...source, extension: { ...source.extension, compiledAtSec: -1 },
    })).toThrow();
    expect(() => compileSafetyScoreV9FactSetFromExtensionSource(fixedInput, {
      ...source, extension: { ...source.extension, registryFingerprint: "a".repeat(64) },
    })).toThrow(/registry fingerprint/);
  });

  it("rebinds only admitted research evidence while preserving compact getters and other sources", () => {
    const { fixedInput, source } = fixture();
    const extension = materializeSafetyScoreV9FactSetExtension(fixedInput, { ...source.extension, assets: [...source.assets()] });
    const { factSet } = compileSafetyScoreV9FactSetWithIsolationFromValidatedExtension(fixedInput, extension);
    const previousHash = factSet.sourceFingerprints.researchOverlays!.payloadSha256;
    const finalHash = "f".repeat(64);
    const input = JSON.parse(stableJsonStringifyV1(factSet.assets[0])) as V9AssetFactsV3;
    const research = input.evidence.find((reference) => reference.sourceId === "safety-score-v9-research-overlay")!;
    expect(research).toBeDefined();
    input.evidence.push({ ...research, evidenceId: "alpha:unrelated-source", sourceId: "another-source" });
    input.evidence.push({ ...research, evidenceId: "alpha:unrelated-research-evidence" });
    input.evidence.sort((left, right) => left.evidenceId.localeCompare(right.evidenceId));
    const parsed = safeParseV9AssetFactsV3(input);
    if (!parsed.success) throw parsed.error;
    const compact = createV9PublicationAssetCompactor();
    const admitted = compact(parsed.data);
    const before = stableJsonStringifyV1(admitted);
    const rebind = createV9PublicationResearchHashRebinder(previousHash, finalHash);
    const finalized = rebind(admitted);
    expect(Object.getOwnPropertyDescriptor(finalized, "gaps")!.get).toBe(Object.getOwnPropertyDescriptor(admitted, "gaps")!.get);
    expect(finalized.evidence.find((reference) => reference.evidenceId === research.evidenceId)!.contentSha256).toBe(finalHash);
    expect(finalized.evidence.find((reference) => reference.evidenceId === "alpha:unrelated-source")!.contentSha256).toBe(previousHash);
    expect(finalized.evidence.find((reference) => reference.evidenceId === "alpha:unrelated-research-evidence")!.contentSha256).toBe(previousHash);
    expect(Object.isFrozen(finalized)).toBe(true);
    expect(Object.isFrozen(finalized.evidence)).toBe(true);
    expect(safeParseV9AssetFactsV3(finalized).success).toBe(true);
    expect(stableJsonStringifyV1(admitted)).toBe(before);
    expect(() => rebind(input)).toThrow(/admitted immutable asset/);
    expect(() => createV9PublicationResearchHashRebinder(previousHash, "invalid")).toThrow();
    expect(() => createV9PublicationResearchHashRebinder(previousHash, "0".repeat(64))(admitted).evidence).toThrow(/cannot retain a pending research hash/);
    expect(() => createV9PublicationResearchHashRebinder(finalHash, previousHash)(admitted).evidence).toThrow(/pending cohort/);
  });

  it.each([
    { sourceId: "another-source", evidenceId: "alpha:unrelated-source" },
    { sourceId: "safety-score-v9-research-overlay", evidenceId: "alpha:unrelated-research-evidence" },
  ])("rejects a pending hash on unmatched evidence $evidenceId without poisoning the cache", (unmatched) => {
    const { fixedInput, source } = fixture();
    const extension = materializeSafetyScoreV9FactSetExtension(fixedInput, { ...source.extension, assets: [...source.assets()] });
    const { factSet } = compileSafetyScoreV9FactSetWithIsolationFromValidatedExtension(fixedInput, extension);
    const previousHash = factSet.sourceFingerprints.researchOverlays!.payloadSha256;
    const input = JSON.parse(stableJsonStringifyV1(factSet.assets[0])) as V9AssetFactsV3;
    const research = input.evidence.find((reference) => reference.sourceId === "safety-score-v9-research-overlay")!;
    input.evidence.push({ ...research, ...unmatched, contentSha256: "0".repeat(64) });
    const parsed = safeParseV9AssetFactsV3(input);
    if (!parsed.success) throw parsed.error;
    const compact = createV9PublicationAssetCompactor();
    const rebind = createV9PublicationResearchHashRebinder(previousHash, "f".repeat(64));
    const healthy = rebind(compact(factSet.assets[0]!));
    const healthyEvidence = healthy.evidence;
    const rejected = rebind(compact(parsed.data));
    expect(() => rejected.evidence).toThrow(/cannot retain a pending research hash/);
    expect(healthy.evidence).toBe(healthyEvidence);
    expect(() => rejected.evidence).toThrow(/cannot retain a pending research hash/);
  });
});

const exactBoundaryFixed = normalizeSafetyScoreV9CompilerInput(makeV9TwoAssetFixedInput());

function assetSet(ids: readonly string[]) {
  return { assets: ids.map((assetId) => ({ assetId })) };
}

describe("exact extension asset boundary", () => {
  it("admits exactly the captured ordered active set", () => {
    expect(() => assertSafetyScoreV9ExactExtensionAssets(exactBoundaryFixed, assetSet(["alpha", "beta"]))).not.toThrow();
  });

  it.each([
    { ids: ["alpha"], missing: "beta", unexpected: "none" },
    { ids: ["alpha", "beta", "gamma"], missing: "none", unexpected: "gamma" },
    { ids: ["alpha", "gamma"], missing: "beta", unexpected: "gamma" },
    { ids: ["beta", "alpha"], missing: "none", unexpected: "none" },
    { ids: ["alpha", "beta", "beta"], missing: "none", unexpected: "none" },
  ])("rejects missing, unexpected, reordered or duplicate IDs: $ids", ({ ids, missing, unexpected }) => {
    expect(() => assertSafetyScoreV9ExactExtensionAssets(exactBoundaryFixed, assetSet(ids)))
      .toThrow(`Safety Score v9 extension active set mismatch: missing=${missing}; unexpected=${unexpected}`);
  });
});
