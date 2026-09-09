import { describe, expect, it } from "vitest";
import { ACTIVE_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { V9_CANDIDATE_POLICY_V1 } from "@shared/lib/safety-score-v9/policy";
import { evaluateV9FactSet } from "@shared/lib/safety-score-v9/evaluate-set";
import mechanismReviewOverlaysAsset from "@shared/data/safety-score-v9/mechanism-review-overlays-v1.json";
import {
  expandOverlayReview,
  MechanismReviewOverlaySchema,
  type MechanismReviewOverlay,
} from "../safety-score-v9/extension-mechanism";
import { buildSafetyScoreV9BaselineExtension } from "../safety-score-v9/extension";
import { compileSafetyScoreV9FactSetFromFixedInput } from "../safety-score-v9/fact-set";
import { makeV9FixedInput } from "../../test-helpers/v9-fixed-input";

function expectNonScoring(overlay: MechanismReviewOverlay, keys: string[]) {
  const expanded = expandOverlayReview(overlay) as unknown as Record<
    string,
    { quality: string | null; status: { observationState: string; gapIds: string[] } }
  >;
  for (const key of keys) {
    expect(expanded[key], `${overlay.assetId}:${key}`).toMatchObject({
      quality: null,
      status: { observationState: "bounded-unknown" },
    });
    expect(expanded[key].status.gapIds).not.toHaveLength(0);
  }
}

describe("Safety Score V9 evidence-only mechanism curation", () => {
  it("keeps an authored unavailable component non-scoring", () => {
    const overlay = MechanismReviewOverlaySchema.parse({
      assetId: "fixture-fiat",
      archetype: "fiat-cash",
      reviewedAt: "2026-08-08",
      notes: "Reviewed issuer nondisclosure; no positive quality claim.",
      metrics: {},
      sources: [{ label: "Issuer disclosure", url: "https://example.com/disclosure" }],
      components: {
        custodyContinuity: {
          applicability: "unavailable",
          rationale: "The issuer has not published custody continuity evidence.",
          sourceUrl: "https://example.com/disclosure",
        },
      },
    });
    expectNonScoring(overlay, ["custodyContinuity"]);
  });

  it("keeps all currently authored unavailable components non-scoring", () => {
    for (const value of mechanismReviewOverlaysAsset.overlays) {
      const overlay = MechanismReviewOverlaySchema.parse(value);
      const keys = Object.entries(overlay.components)
        .filter(([, component]) => "applicability" in component && component.applicability === "unavailable")
        .map(([key]) => key);
      expectNonScoring(overlay, keys);
    }
  });

  it("leaves score and grade unchanged when mechanism evidence becomes unavailable", () => {
    // One real fiat-cash asset, scored twice on the same exact-publication
    // input: once with its curated all-unavailable mechanism overlay, and once
    // with the same overlay withdrawn so the mechanism review stays unreviewed.
    // The overlay only adjudicates the gap; it must not move the score or grade.
    const clockSec = Date.parse("2026-08-09T00:00:00Z") / 1_000;
    const fixed = makeV9FixedInput({ assetId: "uusd-anything-labs", clockSec });
    const meta = structuredClone(ACTIVE_META_BY_ID.get("uusd-anything-labs")!);
    meta.mintAuthority!.review.reviewedAt = "2026-08-08";
    const metaById = new Map([["uusd-anything-labs", meta]]);

    const curatedExtension = buildSafetyScoreV9BaselineExtension(fixed, { metaById });
    const curatedCompiled = compileSafetyScoreV9FactSetFromFixedInput(fixed, curatedExtension);

    const unreviewedExtension = structuredClone(curatedExtension);
    unreviewedExtension.assets[0]!.mechanismRiskReview = null;
    const unreviewedCompiled = compileSafetyScoreV9FactSetFromFixedInput(fixed, unreviewedExtension);

    const curated = evaluateV9FactSet(curatedCompiled, V9_CANDIDATE_POLICY_V1).assets[0]!;
    const unreviewed = evaluateV9FactSet(unreviewedCompiled, V9_CANDIDATE_POLICY_V1).assets[0]!;

    expect(curated.trace.finalScore).toBe(unreviewed.trace.finalScore);
    expect(curated.trace.finalGrade).toBe(unreviewed.trace.finalGrade);
    expect(curated.trace.finalGrade).not.toBe("NR");

    // The evidence-availability field really differs, so the equality above
    // cannot pass vacuously: the curated overlay keeps a reviewed (bounded)
    // review whose gaps carry the issuer-undisclosed disposition, while the
    // withdrawn overlay leaves the mechanism review absent.
    expect(curatedCompiled.assets[0]!.mechanismRiskReview.review).not.toBeNull();
    expect(unreviewedCompiled.assets[0]!.mechanismRiskReview.review).toBeNull();
    expect(curatedCompiled.assets[0]!.mechanismRiskReview.status.observationState).toBe("bounded-unknown");
    expect(unreviewedCompiled.assets[0]!.mechanismRiskReview.status.observationState).toBe("missing");
    expect(
      curatedCompiled.assets[0]!.gaps.some(
        (gap) => gap.responsibility === "issuer-undisclosed" && gap.path.componentKey?.startsWith("mechanism-review:"),
      ),
    ).toBe(true);
  });
});
