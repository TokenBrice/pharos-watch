import { describe, expect, it } from "vitest";
import { RejectionSchema, SafetyScoreV9FactSetExtensionV2Schema } from "../safety-score-v9/fact-set-schema";
import { makeV9Extension, makeV9FixedInput, v9Status } from "../../test-helpers/v9-fixed-input";
import { compileSafetyScoreV9FactSetFromFixedInput } from "../safety-score-v9/fact-set";
import { buildV9EvidenceGapQueue } from "@shared/lib/safety-score-v9/evidence-gap-queue";
import { V9_CANDIDATE_POLICY_V1 } from "@shared/lib/safety-score-v9/policy";
import { V9AssetFactsV3Schema, V9EffectiveDependenciesV3Schema } from "@shared/types/safety-score-v9-facts";

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
