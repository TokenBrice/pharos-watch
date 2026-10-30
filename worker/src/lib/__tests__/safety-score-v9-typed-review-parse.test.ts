import { describe, expect, it } from "vitest";
import overlaysAsset from "@shared/data/safety-score-v9/mechanism-review-overlays-v1.json";
import { V9TypedReviewGapClassificationSchema, type V9EvidenceCauseScope } from "@shared/types/safety-score-v9-causes";
import { compileSafetyScoreV9FactSetFromFixedInput } from "../safety-score-v9/fact-set";
import { v9TypedMechanismReview } from "../safety-score-v9/fact-set-context";
import { getSafetyScoreV9MechanismReviewedUnavailableComponents } from "../safety-score-v9/extension-mechanism";
import { makeV9Extension, makeV9FixedInput, v9Status } from "../../test-helpers/v9-fixed-input";

function mechanismScope(componentKey: string): V9EvidenceCauseScope {
  const full = `mechanism-review:${componentKey}`;
  return { pillar: "backing", componentKey: full, factorKey: null, routeKey: null, exposureId: null, requiredDatum: full };
}

describe("typed mechanism reviews", () => {
  it("diagnoses the failing field of a reviewed-but-unpublished row instead of a silent U", () => {
    const fixed = makeV9FixedInput({ assetId: "usdc-circle", clockSec: Date.parse("2026-07-13T00:00:00Z") / 1000 });
    const extension = makeV9Extension({ assetId: "usdc-circle", clockSec: fixed.clockSec, registryFingerprint: fixed.registryFingerprint });
    const review = extension.assets[0]!.mechanismRiskReview!;
    if (review.archetype !== "fiat-cash") throw new Error("Expected fiat review");
    review.claimAndSegregation.status = v9Status("missing");
    review.claimAndSegregation.quality = null;
    extension.assets[0]!.mechanismReviewedUnavailable = [{
      // The typed-review schema admits a calendar date only; a curated UTC
      // instant is exactly the shape that used to revert this scope to U.
      componentKey: "claimAndSegregation", reviewedAt: "2026-07-12T00:00:00Z",
      rationale: "The primary holder terms omit an enforceable segregation claim.",
      sourceUrl: "https://example.com/holder-terms", searchedSurfaces: ["https://example.com/holder-terms"],
    }];
    const asset = compileSafetyScoreV9FactSetFromFixedInput(fixed, extension).assets[0]!;
    const gap = asset.gaps.find((row) => row.causeScope?.componentKey === "mechanism-review:claimAndSegregation")!;
    expect(gap.causeProof.cause).toBe("U");
    const mechanismDiagnostics = asset.causeResolutionDiagnostics?.filter(
      (diagnostic) => diagnostic.scope.componentKey.startsWith("mechanism-review:"),
    );
    expect(mechanismDiagnostics).toEqual([{
      code: "cause-proof-conversion-failed", scope: gap.causeScope,
      message: "mechanism-review:usdc-circle:claimAndSegregation:2026-07-12T00:00:00Z: reviewedAt: Expected YYYY-MM-DD",
    }]);
  });

  it("admits every curated reviewed-but-unpublished component as a typed review", () => {
    // Publication clock of capture 20261030T1033Z.
    const clockSec = Date.parse("2026-10-30T10:17:46Z") / 1000;
    const failures: string[] = [];
    for (const overlay of overlaysAsset.overlays) {
      const rows = getSafetyScoreV9MechanismReviewedUnavailableComponents(overlay.assetId, overlay.archetype, clockSec);
      for (const row of rows) {
        const review = v9TypedMechanismReview(
          { assetId: overlay.assetId, mechanismReviewedUnavailable: [row] },
          mechanismScope(row.componentKey),
        )!;
        const parsed = V9TypedReviewGapClassificationSchema.safeParse(review);
        if (!parsed.success) {
          failures.push(`${overlay.assetId}:${row.componentKey}: ${parsed.error.issues
            .map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`);
        }
      }
    }
    expect(failures).toEqual([]);
  });

  it("keeps the xo-exodus assurance review on its own date", () => {
    const rows = getSafetyScoreV9MechanismReviewedUnavailableComponents(
      "xo-exodus", "fiat-cash", Date.parse("2026-10-30T10:17:46Z") / 1000,
    );
    // The October 20 component review was published at 22:19:27Z; the typed
    // review carries only its calendar day and must never be re-dated.
    expect(rows.find((row) => row.componentKey === "assuranceAndReconciliation")?.reviewedAt).toBe("2026-10-20");
  });
});
