import { afterEach, describe, expect, it, vi } from "vitest";
import { ACTIVE_META_BY_ID } from "@shared/lib/stablecoins/registry";
import {
  SAFETY_SCORE_V9_ACTIVE_META_BY_ID, SAFETY_SCORE_V9_REGISTRY_FINGERPRINT,
} from "@shared/lib/stablecoins/safety-score-v9-registry";
import { stableJsonStringifyV1 } from "@shared/lib/stable-json";
import {
  SAFETY_SCORE_V9_SCORING_FIELDS,
  type SafetyScoreV9ScoringMeta,
} from "@shared/types/safety-score-v9-scoring-catalog";
import { buildSafetyScoreV9Candidate } from "../safety-score-v9/candidate";
import { buildSafetyScoreV9BaselineExtension } from "../safety-score-v9/extension";
import { serializeSafetyScoreV9Publication } from "../safety-score-v9/publication-codec";
import { createNativeSafetyScoreV9FullRegistryInput } from "./fixtures/safety-score-v9-full-registry-input";
import { makeV9TwoAssetFixedInput } from "../../test-helpers/v9-fixed-input";
import { alphaMeta } from "./safety-score-v9-fact-set.test-support";

// Release identity legitimately rotates for this cutover. Compare scoring bytes
// at one explicit build identity instead of normalizing away output differences.
vi.mock("@shared/data/safety-score-v9/evaluation-build-manifest-v1", () => ({
  SAFETY_SCORE_V9_EVALUATION_BUILD_DIGEST: "7".repeat(64),
}));

afterEach(() => vi.restoreAllMocks());

describe("Safety Score V9 scoring-only catalog cutover", { timeout: 240_000 }, () => {
  it("preserves full extension, facts, evaluation, public JSON and stored envelope on the all-asset fixture", async () => {
    const fixedInput = createNativeSafetyScoreV9FullRegistryInput();
    // Override every default metadata read, including supply/XAUT/exit helpers,
    // rather than testing only the explicitly injected extension metadata map.
    const fullDefaults = vi.spyOn(SAFETY_SCORE_V9_ACTIVE_META_BY_ID, "get")
      .mockImplementation((id) => ACTIVE_META_BY_ID.get(id));
    const full = buildSafetyScoreV9Candidate({ fixedInput, publishedAtSec: fixedInput.clockSec,
      registry: { metaById: ACTIVE_META_BY_ID, registryFingerprint: SAFETY_SCORE_V9_REGISTRY_FINGERPRINT } });
    fullDefaults.mockRestore();
    const projected = buildSafetyScoreV9Candidate({ fixedInput, publishedAtSec: fixedInput.clockSec });

    expect(projected.extension.assets).toHaveLength(fixedInput.activeAssetIds.length);
    expect(projected.compiledFacts.assets).toHaveLength(fixedInput.activeAssetIds.length);
    expect(projected.candidate.cards.map(card => card.id)).toEqual(fixedInput.activeAssetIds);
    expect(stableJsonStringifyV1(projected.extension)).toBe(stableJsonStringifyV1(full.extension));
    expect(stableJsonStringifyV1(projected.compiledFacts)).toBe(stableJsonStringifyV1(full.compiledFacts));
    expect(stableJsonStringifyV1(projected.evaluatedSet)).toBe(stableJsonStringifyV1(full.evaluatedSet));
    expect(stableJsonStringifyV1(projected.candidate)).toBe(stableJsonStringifyV1(full.candidate));
    expect(projected.candidateIdentity).toEqual(full.candidateIdentity);
    expect(projected.quarantines).toEqual(full.quarantines);
    expect(await serializeSafetyScoreV9Publication(projected.candidate))
      .toBe(await serializeSafetyScoreV9Publication(full.candidate));
  });

  it("preserves invalid-review quarantine and serial-dependent closure for projected injected metadata", () => {
    const fixedInput = makeV9TwoAssetFixedInput();
    const reviewedAt = new Date((fixedInput.clockSec + 2 * 86400) * 1000).toISOString().slice(0, 10);
    const rows = [alphaMeta({ blacklistabilityReview: {
      reviewedStatus: true, sourceFreeRationale: "Fixture-only review.", evidence: "Future review.",
      reviewer: "Fixture reviewer", reviewedAt,
    } }), alphaMeta({ id: "beta", dependencies: [{ id: "alpha", type: "mechanism", weight: 1 }],
      dependencyReview: { reviewedAt: new Date(fixedInput.clockSec * 1000).toISOString().slice(0, 10),
        reviewer: "Fixture reviewer", confidence: "verified", rationale: "Reviewed serial claim on alpha.",
        sources: [{ label: "Issuer evidence", url: "https://example.com/issuer" }],
        relationships: [{ id: "alpha", type: "mechanism", weight: 1, economicRole: "serial-claim",
          reason: "Beta is a serial claim on alpha." }],
      } })];
    const reference = new Map(rows.map(row => [row.id, row]));
    const projected = new Map(rows.map(row => [row.id, Object.fromEntries(
      SAFETY_SCORE_V9_SCORING_FIELDS.filter(field => Object.prototype.hasOwnProperty.call(row, field))
        .map(field => [field, row[field]]),
    ) as SafetyScoreV9ScoringMeta]));
    const build = (metaById: ReadonlyMap<string, SafetyScoreV9ScoringMeta>) => buildSafetyScoreV9Candidate({
      fixedInput, publishedAtSec: fixedInput.clockSec,
      registry: { metaById, registryFingerprint: fixedInput.registryFingerprint },
    });
    const full = build(reference);
    const narrow = build(projected);
    expect(narrow.quarantines).toEqual([{ assetId: "alpha", code: "fact-build-failed",
      message: expect.stringMatching(/^accessReview: .*later than the scoring clock/) }]);
    expect(narrow.quarantineAffectedAssetIds).toEqual(["alpha", "beta"]);
    expect(narrow.candidate.cards).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "alpha", ratingStatus: "pipeline-gap", score: null }),
      expect.objectContaining({ id: "beta", ratingStatus: "pipeline-gap", score: null }),
    ]));
    expect(stableJsonStringifyV1(narrow)).toBe(stableJsonStringifyV1(full));
  });

  it("retains exact fingerprint failure, replay-only mismatch adoption and missing active-ID failure", () => {
    const fixedInput = makeV9TwoAssetFixedInput();
    const metaById = new Map([alphaMeta(), alphaMeta({ id: "beta" })].map(row => [row.id, row]));
    const mismatch = fixedInput.registryFingerprint === "f".repeat(64) ? "e".repeat(64) : "f".repeat(64);
    expect(() => buildSafetyScoreV9BaselineExtension(fixedInput, { metaById, registryFingerprint: mismatch }))
      .toThrow(/registry fingerprint .* does not match fixed input/);
    expect(buildSafetyScoreV9BaselineExtension(fixedInput, {
      metaById, registryFingerprint: mismatch, allowRegistryMismatch: true,
    }).registryFingerprint).toBe(fixedInput.registryFingerprint);
    metaById.delete("beta");
    expect(() => buildSafetyScoreV9BaselineExtension(fixedInput, {
      metaById, registryFingerprint: fixedInput.registryFingerprint,
    })).toThrow("Safety Score v9 baseline extension has no registry metadata for beta");
  });
});
