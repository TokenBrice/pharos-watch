import { afterEach, describe, expect, it, vi } from "vitest";
import { stableJsonStringifyV1 } from "@shared/lib/stable-json";
import { makeV9CohortFixedInput, V9_EVALUATION_TEST_TIMEOUT_MS } from "../../test-helpers/v9-fixed-input";
import { alphaMeta } from "./safety-score-v9-fact-set.test-support";
import { assessV9Publication } from "../safety-score-v9/publication-assessment";
import supplyRegistry from "@shared/data/safety-score-v9/supply-attribution-reviews-v1.json";

const extraIds = Array.from({ length: 18 }, (_, index) => `gamma-${String(index + 1).padStart(2, "0")}`);
const fixedInput = makeV9CohortFixedInput(extraIds);
const mechanismPath = "@shared/data/safety-score-v9/mechanism-review-overlays-v1.json";
const transferPath = "@shared/data/safety-score-v9/transfer-review-overlays-v1.json";
const supplyPath = "@shared/data/safety-score-v9/supply-attribution-reviews-v1.json";
const deploymentKey = `ethereum:0x${"1".repeat(40)}`;
const economicPlan = {
  assetId: "alpha", reviewer: "Fixture reviewer", reviewedAtSec: 1, expiresAtSec: 86401,
  evidenceUrls: ["https://example.com/accounting"], economicScope: "All holder claims",
  sourceId: "reference", accountingFamily: "independent-liability", commonClaimUnit: "claim",
  exhaustive: true, inFlightTreatment: "observed-reconciled",
  deployments: [{
    deploymentKey, chainId: "ethereum", address: deploymentKey.split(":")[1],
    holdingKind: "contract", amountBasis: "fixed-token-units", decimals: 6, routeId: deploymentKey,
    read: { kind: "evm-total-supply", safeBlockLag: 2 }, claimUnit: "claim", conversionSourceId: null,
  }],
  excludedRegistryDeploymentKeys: [], exclusions: [], conversionSources: [], escrows: [],
  referencePriceSource: null, liabilityInFlightSource: null,
};
const exclusionReview = { ...supplyRegistry.providerRowExclusionReviews[0]!, assetId: "alpha" };

const mechanismReview = {
  assetId: "alpha", archetype: "fiat-cash", reviewedAt: "1970-01-01",
  sources: [{ label: "Primary evidence", url: "https://example.com/review" }],
  notes: "Fixture review", metrics: {}, components: {},
};
const transferReview = {
  assetId: "alpha", reviewedAt: "1970-01-01", reviewer: "Fixture reviewer",
  deployments: [{ chainId: "ethereum", contractOrTokenId: "0x1234", scope: "canonical", posture: "permissionless",
    evidence: "Fixture evidence", sources: [{ label: "Primary evidence", url: "https://example.com/review" }] }],
};

async function runCandidate(path: string, rows: unknown[], exclusions: unknown[] = []) {
  vi.resetModules();
  vi.doMock(path, () => ({ default: path === supplyPath
    ? { ...supplyRegistry, reviews: rows, providerRowExclusionReviews: exclusions }
    : { schemaVersion: 1, note: "Fixture registry", [path === mechanismPath ? "overlays" : "reviews"]: rows } }));
  // Re-import after each JSON replacement to exercise the module-load envelope boundary.
  const { buildSafetyScoreV9Candidate } = await import("../safety-score-v9/candidate");
  return buildSafetyScoreV9Candidate({
    fixedInput, publishedAtSec: fixedInput.clockSec,
    registry: {
      registryFingerprint: fixedInput.registryFingerprint,
      metaById: new Map(fixedInput.activeAssetIds.map((id) => [id, alphaMeta({
        id,
        reserves: [{ name: "Custodied cash", pct: 100, risk: "very-low", assetClass: "cash",
          issuerOrObligor: `issuer:${id}`, riskFactors: ["custody", "counterparty"], liquidityHorizon: "immediate", maturityDaysMax: 0 }],
        reserveReview: { reviewedAt: "1970-01-01", reviewer: "Fixture reviewer", confidence: "verified",
          sources: [{ label: "Reserve report", url: "https://example.com/reserves" }], rationale: "Fixture review",
          compositionBasis: "Fixture report", compositionAsOf: "1970-01-01", scope: "full-composition",
          knownUnknownExposure: "None", knownUnknownExposurePct: 0 },
      })])),
    },
  });
}

afterEach(() => {
  vi.doUnmock(mechanismPath);
  vi.doUnmock(transferPath);
  vi.doUnmock(supplyPath);
  vi.resetModules();
});

describe("reviewed registry asset isolation", { timeout: V9_EVALUATION_TEST_TIMEOUT_MS }, () => {
  it.each([
    { name: "mechanism", path: mechanismPath, review: mechanismReview, bad: { ...mechanismReview, reviewedAt: "not-a-date" }, field: "mechanismReviews.overlays.0.reviewedAt" },
    { name: "transfer", path: transferPath, review: transferReview, bad: { ...transferReview, deployments: [{ ...transferReview.deployments[0], posture: "invalid-posture" }] }, field: "transferReviews.reviews.0.deployments.0.posture" },
  ])("publishes healthy B while malformed $name evidence quarantines A with its exact path", async ({ path, review, bad, field }) => {
    const healthyB = { ...structuredClone(review), assetId: "beta" };
    const clean = await runCandidate(path, [review, healthyB]);
    expect(clean.quarantines).toEqual([]);
    const isolated = await runCandidate(path, [bad, healthyB]);
    expect(isolated.extension.assets.find((asset) => asset.assetId === "alpha")?.admissionQuarantine).toMatchObject({ code: "fact-build-failed", path: field });
    expect(isolated.quarantines).toEqual([{ assetId: "alpha", code: "fact-build-failed", message: expect.stringContaining(field) }]);
    expect(isolated.candidate.cards.find((card) => card.id === "alpha")).toMatchObject({ grade: "NR", score: null });
    const healthyCard = isolated.candidate.cards.find((card) => card.id === "beta")!;
    expect(healthyCard.grade).not.toBe("NR");
    expect(stableJsonStringifyV1(healthyCard)).toBe(stableJsonStringifyV1(clean.candidate.cards.find((card) => card.id === "beta")));
    expect(assessV9Publication({
      inputHealth: {
        dex: { state: "current", generationId: fixedInput.dexGenerationId, updatedAtSec: fixedInput.clockSec },
        redemption: { state: "not-applicable", generationId: null, updatedAtSec: null },
        liveReserves: { state: "available", coverageRatio: 1 },
      }, candidate: isolated.candidate, acceptedPublication: null, coverageFloors: [],
      quarantinedAssetIds: ["alpha"], quarantineAffectedAssetIds: isolated.quarantineAffectedAssetIds,
    })).toEqual({ decision: "publish", reasons: [], affectedAssetIds: ["alpha"] });
  });

  it("quarantines only the owner of duplicate asset reviews", async () => {
    const result = await runCandidate(transferPath, [transferReview, structuredClone(transferReview), { ...structuredClone(transferReview), assetId: "beta" }]);
    expect(result.quarantines).toEqual([{ assetId: "alpha", code: "fact-build-failed", message: expect.stringContaining("Duplicate reviewed registry key: alpha") }]);
    expect(result.extension.assets.find((asset) => asset.assetId === "alpha")?.admissionQuarantine?.path).toBe("transferReviews.reviews.1.assetId");
    expect(result.candidate.cards.find((card) => card.id === "beta")?.grade).not.toBe("NR");
  });

  it.each([
    {
      name: "malformed economic plan",
      plans: [{ ...economicPlan, reviewedAtSec: "not-a-time" }],
      exclusions: [],
      field: "supplyAttribution.reviews.0.reviewedAtSec",
    },
    {
      name: "duplicate provider exclusion",
      plans: [economicPlan],
      exclusions: [exclusionReview, structuredClone(exclusionReview), { ...exclusionReview, assetId: "beta" }],
      field: "supplyAttribution.providerRowExclusionReviews.1.providerChainLabel",
    },
    {
      name: "malformed provider exclusion",
      plans: [economicPlan],
      exclusions: [{ ...exclusionReview, reviewedAtSec: "not-a-time" }, { ...exclusionReview, assetId: "beta" }],
      field: "supplyAttribution.providerRowExclusionReviews.0.reviewedAtSec",
    },
  ])("cold-imports $name and publishes the healthy asset unchanged", async ({ plans, exclusions, field }) => {
    const healthyPlans = [economicPlan];
    const healthyExclusions = [exclusionReview, { ...exclusionReview, assetId: "beta" }];
    const clean = await runCandidate(supplyPath, healthyPlans, healthyExclusions);
    expect(clean.quarantines).toEqual([]);
    const isolated = await runCandidate(supplyPath, plans, exclusions);
    expect(isolated.extension.assets.find(asset => asset.assetId === "alpha")?.admissionQuarantine).toMatchObject({
      code: "fact-build-failed", path: field,
    });
    expect(isolated.quarantines).toEqual([{
      assetId: "alpha", code: "fact-build-failed", message: expect.any(String),
    }]);
    expect(isolated.candidate.cards.find(card => card.id === "alpha")).toMatchObject({ grade: "NR", score: null });
    const healthyCard = isolated.candidate.cards.find(card => card.id === "beta")!;
    expect(healthyCard.grade).not.toBe("NR");
    expect(stableJsonStringifyV1(healthyCard)).toBe(stableJsonStringifyV1(clean.candidate.cards.find(card => card.id === "beta")));
    expect(assessV9Publication({
      inputHealth: {
        dex: { state: "current", generationId: fixedInput.dexGenerationId, updatedAtSec: fixedInput.clockSec },
        redemption: { state: "not-applicable", generationId: null, updatedAtSec: null },
        liveReserves: { state: "available", coverageRatio: 1 },
      }, candidate: isolated.candidate, acceptedPublication: null, coverageFloors: [],
      quarantinedAssetIds: ["alpha"], quarantineAffectedAssetIds: isolated.quarantineAffectedAssetIds,
    })).toEqual({ decision: "publish", reasons: [], affectedAssetIds: ["alpha"] });
  });
});
