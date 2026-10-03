import { describe, expect, it } from "vitest";
import { stableJsonStringifyV1 } from "@shared/lib/stable-json";
import type { SafetyScoreV9Card } from "@shared/types/safety-score-v9-public";
import {
  buildSafetyScoreV9Candidate,
  type SafetyScoreV9CandidatePipelineResult,
} from "../safety-score-v9/candidate";
import type { V9ExtensionRegistryMeta } from "../safety-score-v9/extension";
import type { SafetyScoreV9FactSetExtensionV2 } from "../safety-score-v9/fact-set";
import {
  assessV9Publication,
  type V9PublicationInputHealth,
} from "../safety-score-v9/publication-assessment";
import {
  V9_EVALUATION_TEST_TIMEOUT_MS,
  makeV9CohortFixedInput,
  makeV9RoleExtension,
} from "../../test-helpers/v9-fixed-input";
import { alphaMeta } from "./safety-score-v9-fact-set.test-support";

// Twenty assets: one quarantined asset plus its one dependent is exactly the 10%
// the unchanged 9/10 healthy-asset publication gate allows.
const EXTRA_ASSET_IDS = Array.from({ length: 18 }, (_, index) => `gamma-${String(index + 1).padStart(2, "0")}`);
const fixedInput = makeV9CohortFixedInput(EXTRA_ASSET_IDS);
const INPUT_HEALTH: V9PublicationInputHealth = {
  dex: { state: "current", generationId: fixedInput.dexGenerationId, updatedAtSec: fixedInput.clockSec },
  redemption: { state: "not-applicable", generationId: null, updatedAtSec: null },
  liveReserves: { state: "available", coverageRatio: 1 },
};
const FUTURE_BLACKLISTABILITY_REVIEW = {
  reviewedStatus: true,
  sourceFreeRationale: "Fixture-only review.",
  evidence: "Future review.",
  reviewer: "Fixture reviewer",
  reviewedAt: "2026-07-14",
};

/** Beta holds a serial claim on alpha, so alpha's quarantine must reach beta. */
function reviewedExtension(): SafetyScoreV9FactSetExtensionV2 {
  return makeV9RoleExtension(fixedInput, {
    beta: [{ upstreamAssetId: "alpha", dependencyType: "mechanism", weight: 1, failureDomains: [] }],
  });
}

function withMalformedArchetype(extension: SafetyScoreV9FactSetExtensionV2, assetId: string) {
  const asset = extension.assets.find((candidate) => candidate.assetId === assetId)!;
  Reflect.set(asset.mechanismRiskReview!, "archetype", "invalid-local-archetype");
  return extension;
}

function candidateFor(extension: unknown) {
  return buildSafetyScoreV9Candidate({ fixedInput, extension, publishedAtSec: fixedInput.clockSec });
}

function registryCandidate(alpha: V9ExtensionRegistryMeta, registryFingerprint = fixedInput.registryFingerprint) {
  return buildSafetyScoreV9Candidate({
    fixedInput,
    publishedAtSec: fixedInput.clockSec,
    registry: {
      registryFingerprint,
      metaById: new Map(
        [alpha, alphaMeta({ id: "beta" }), ...EXTRA_ASSET_IDS.map((id) => alphaMeta({ id }))].map((meta) => [
          meta.id,
          meta,
        ]),
      ),
    },
  });
}

function assess(result: Readonly<SafetyScoreV9CandidatePipelineResult>) {
  return assessV9Publication({
    inputHealth: INPUT_HEALTH,
    candidate: result.candidate,
    acceptedPublication: null,
    coverageFloors: [],
    quarantinedAssetIds: result.quarantines.map((quarantine) => quarantine.assetId),
    quarantineAffectedAssetIds: result.quarantineAffectedAssetIds,
  });
}

// Attribution copy counts cohort members; it is not asset-local financial state.
function cardFinancialState(card: SafetyScoreV9Card) {
  return {
    ...card,
    scoreTrace: {
      ...card.scoreTrace,
      adverseAttribution: {
        ...card.scoreTrace.adverseAttribution,
        items: card.scoreTrace.adverseAttribution.items.map(({ message: _message, ...item }) => item),
      },
    },
  };
}

function expectUnaffectedCardsIdentical(
  clean: Readonly<SafetyScoreV9CandidatePipelineResult>,
  isolated: Readonly<SafetyScoreV9CandidatePipelineResult>,
  affectedAssetIds: readonly string[],
) {
  const cleanById = new Map(clean.candidate.cards.map((card) => [card.id, stableJsonStringifyV1(cardFinancialState(card))]));
  expect(isolated.candidate.cards.map((card) => card.id)).toEqual(fixedInput.activeAssetIds);
  for (const card of isolated.candidate.cards) {
    if (affectedAssetIds.includes(card.id)) {
      expect(card).toMatchObject({ ratingStatus: "pipeline-gap", grade: null, score: null });
      continue;
    }
    expect(stableJsonStringifyV1(cardFinancialState(card))).toBe(cleanById.get(card.id));
  }
}

describe("Safety Score v9 extension admission quarantine", { timeout: V9_EVALUATION_TEST_TIMEOUT_MS }, () => {
  it("quarantines one malformed local archetype and publishes the rest through the unchanged gate", () => {
    const clean = candidateFor(reviewedExtension());
    expect(clean.quarantines).toEqual([]);
    expect(assess(clean)).toEqual({ decision: "publish", reasons: [], affectedAssetIds: [] });

    const isolated = candidateFor(withMalformedArchetype(reviewedExtension(), "alpha"));

    expect(isolated.quarantines).toEqual([
      {
        assetId: "alpha",
        code: "fact-validation-failed",
        message: expect.stringMatching(/^mechanismRiskReview\.archetype: /),
      },
    ]);
    expect(isolated.quarantineAffectedAssetIds).toEqual(["alpha", "beta"]);
    expectUnaffectedCardsIdentical(clean, isolated, ["alpha", "beta"]);
    expect(
      isolated.compiledFacts.assets.find((asset) => asset.assetId === "beta")!.dependencies.edges,
    ).toContainEqual(expect.objectContaining({ upstreamAssetId: "alpha" }));
    expect(assess(isolated)).toEqual({ decision: "publish", reasons: [], affectedAssetIds: ["alpha", "beta"] });

    // The admitted extension is a replay input: it carries the quarantine and
    // reproduces the same publication instead of silently rating alpha.
    expect(isolated.extension.assets.find((asset) => asset.assetId === "alpha")).toMatchObject({
      mechanismRiskReview: null,
      admissionQuarantine: { code: "fact-validation-failed", path: "mechanismRiskReview.archetype" },
    });
    const replayed = candidateFor(isolated.extension);
    expect(replayed.quarantines).toEqual(isolated.quarantines);
    expect(stableJsonStringifyV1(replayed.candidate.cards)).toBe(stableJsonStringifyV1(isolated.candidate.cards));
  });

  it("holds when a second quarantine pushes affected assets past the unchanged 10% allowance", () => {
    const isolated = candidateFor(withMalformedArchetype(withMalformedArchetype(reviewedExtension(), "alpha"), "gamma-01"));

    expect(isolated.quarantines.map((quarantine) => quarantine.assetId)).toEqual(["alpha", "gamma-01"]);
    expect(isolated.quarantineAffectedAssetIds).toEqual(["alpha", "beta", "gamma-01"]);
    const assessment = assess(isolated);
    expect(assessment.decision).toBe("hold");
    expect(assessment.affectedAssetIds).toEqual(["alpha", "beta", "gamma-01"]);
    expect(assessment.reasons).toEqual(
      expect.arrayContaining(
        ["alpha", "beta", "gamma-01"].map((assetId) =>
          expect.objectContaining({ code: "producer-failed-pipeline-gap", assetId, effect: "pipeline-gap" }),
        ),
      ),
    );
  });

  it("converts a future-dated registry review into one asset-local quarantine at extension build", () => {
    const clean = registryCandidate(alphaMeta());
    expect(clean.quarantines).toEqual([]);

    const isolated = registryCandidate(alphaMeta({ blacklistabilityReview: FUTURE_BLACKLISTABILITY_REVIEW }));

    expect(isolated.quarantines).toEqual([
      {
        assetId: "alpha",
        code: "fact-build-failed",
        message: expect.stringMatching(/^accessReview: .*later than the scoring clock/),
      },
    ]);
    expect(isolated.quarantineAffectedAssetIds).toEqual(["alpha"]);
    expectUnaffectedCardsIdentical(clean, isolated, ["alpha"]);
    expect(assess(isolated)).toEqual({ decision: "publish", reasons: [], affectedAssetIds: ["alpha"] });
  });

  it("still fails the whole cohort on global registry, envelope, or asset-identity invalidity", () => {
    expect(() => candidateFor({ ...reviewedExtension(), registryFingerprint: "f".repeat(64) })).toThrow(
      /registry fingerprint/,
    );
    expect(() => registryCandidate(alphaMeta(), "f".repeat(64))).toThrow(/registry fingerprint/);

    const missing = reviewedExtension();
    missing.assets = missing.assets.filter((asset) => asset.assetId !== "gamma-18");
    expect(() => candidateFor(missing)).toThrow(/active set mismatch/);

    const duplicated = reviewedExtension();
    duplicated.assets = [...duplicated.assets, structuredClone(duplicated.assets[0]!)];
    expect(() => candidateFor(duplicated)).toThrow(/Duplicate canonical key: alpha/);

    const anonymous = reviewedExtension();
    Reflect.set(anonymous.assets[0]!, "assetId", " alpha ");
    expect(() => candidateFor(anonymous)).toThrow(/no canonical assetId/);

    expect(() => candidateFor({ ...reviewedExtension(), routeFreshness: { dexMaxAgeSec: -1 } })).toThrow(/routeFreshness/);
  });
});
