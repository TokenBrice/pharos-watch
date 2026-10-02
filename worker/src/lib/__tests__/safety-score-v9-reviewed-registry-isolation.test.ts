import { afterEach, describe, expect, it, vi } from "vitest";
import { stableJsonStringifyV1 } from "@shared/lib/stable-json";
import { makeV9CohortFixedInput, V9_EVALUATION_TEST_TIMEOUT_MS } from "../../test-helpers/v9-fixed-input";
import { alphaMeta } from "./safety-score-v9-fact-set.test-support";
import { assessV9Publication } from "../safety-score-v9/publication-assessment";

const extraIds = Array.from({ length: 18 }, (_, index) => `gamma-${String(index + 1).padStart(2, "0")}`);
const fixedInput = makeV9CohortFixedInput(extraIds);
const mechanismPath = "@shared/data/safety-score-v9/mechanism-review-overlays-v1.json";
const transferPath = "@shared/data/safety-score-v9/transfer-review-overlays-v1.json";

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

async function runCandidate(path: string, rows: unknown[]) {
  vi.resetModules();
  vi.doMock(path, () => ({ default: { schemaVersion: 1, note: "Fixture registry", [path === mechanismPath ? "overlays" : "reviews"]: rows } }));
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
});
