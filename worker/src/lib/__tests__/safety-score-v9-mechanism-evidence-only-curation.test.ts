import { describe, expect, it } from "vitest";
import { unknownQuality, V9_CANDIDATE_POLICY_V1 } from "@shared/lib/safety-score-v9/policy";
import { evaluateV9FactSet } from "@shared/lib/safety-score-v9/evaluate-set";
import {
  expandOverlayReview,
  MechanismReviewOverlaySchema,
  type MechanismReviewOverlay,
} from "../safety-score-v9/extension-mechanism";
import { buildSafetyScoreV9BaselineExtension } from "../safety-score-v9/extension";
import { compileSafetyScoreV9FactSetFromFixedInput } from "../safety-score-v9/fact-set";
import { makeV9FixedInput } from "../../test-helpers/v9-fixed-input";
import { pinnedUusdMeta } from "./safety-score-v9-fact-set.test-support";

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

  it("prices reviewed issuer nondisclosure below an unresearched applicable mechanism", () => {
    // The same exact-publication input differs only in the reviewed cause:
    // issuer nondisclosure is C, while withdrawing the review leaves U.
    // AM1 prices the unknown subfactors, not the known reserve book.
    const clockSec = Date.parse("2026-08-09T00:00:00Z") / 1_000;
    const fixed = makeV9FixedInput({ assetId: "uusd-anything-labs", clockSec });
    const metaById = pinnedUusdMeta();

    const curatedExtension = buildSafetyScoreV9BaselineExtension(fixed, { metaById });
    const curatedCompiled = compileSafetyScoreV9FactSetFromFixedInput(fixed, curatedExtension);

    const unreviewedExtension = structuredClone(curatedExtension);
    unreviewedExtension.assets[0]!.mechanismRiskReview = null;
    const unreviewedCompiled = compileSafetyScoreV9FactSetFromFixedInput(fixed, unreviewedExtension);

    const curated = evaluateV9FactSet(curatedCompiled, V9_CANDIDATE_POLICY_V1).assets[0]!;
    const unreviewed = evaluateV9FactSet(unreviewedCompiled, V9_CANDIDATE_POLICY_V1).assets[0]!;

    expect(curated.trace.finalScore!).toBeLessThan(unreviewed.trace.finalScore!);
    expect(curated.trace.finalGrade).not.toBe("NR");
    expect(unreviewed.trace.finalGrade).not.toBe("NR");
    for (const [result, cause] of [[curated, "C"], [unreviewed, "U"]] as const) {
      const mechanismRows = result.backing.contributions.filter(row => row.source === "mechanism");
      expect(mechanismRows.length).toBeGreaterThan(0);
      for (const row of mechanismRows) expect(row).toMatchObject({
        score: unknownQuality("backing", cause), cause, scoringDisposition: "bounded-uncertainty",
      });
    }
    expect(curated.backing.contributions.filter(row => row.source !== "mechanism"))
      .toEqual(unreviewed.backing.contributions.filter(row => row.source !== "mechanism"));

    // The reviewed and withdrawn evidence states must genuinely differ.
    expect(curatedCompiled.assets[0]!.mechanismRiskReview.review).not.toBeNull();
    expect(unreviewedCompiled.assets[0]!.mechanismRiskReview.review).toBeNull();
    expect(curatedCompiled.assets[0]!.mechanismRiskReview.status.observationState).toBe("bounded-unknown");
    expect(unreviewedCompiled.assets[0]!.mechanismRiskReview.status.observationState).toBe("missing");
    expect(
      curatedCompiled.assets[0]!.gaps.some(
        (gap) => gap.responsibility === "issuer-undisclosed" && "componentKey" in gap.path && gap.path.componentKey.startsWith("mechanism-review:"),
      ),
    ).toBe(true);
  });
});
