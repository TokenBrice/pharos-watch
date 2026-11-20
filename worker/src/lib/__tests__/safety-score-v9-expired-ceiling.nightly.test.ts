// Nightly tier: PR coverage retained by worker/src/lib/__tests__/safety-score-v9-fact-set-backing.test.ts
// Registry-wide v10.48 counterfactual: every real age-only expired review, compiled expired and with its review
// dated inside the age budget at the same clock. Its PR-tier cases in that file guard the same behavior: the
// fresh-vs-expired ceiling table (strong, weak, own-liability and named-firm books), the owed-exclusion report
// scope, the tracked-asset book and the compile-exception fallback.
import { describe, expect, it } from "vitest";
import { ACTIVE_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { compileCeilingCard as compile, reviewDatedOn } from "./safety-score-v9-reserve-admission.test-support";

describe("v10.48 expired-review ceiling over the registry", () => {
  it("caps every real age-only expired review at its own admission", () => {
    const sec = 1_795_169_853, day = "2026-11-18"; // capture clock
    let capped = 0;
    for (const meta of ACTIVE_META_BY_ID.values()) {
      const review = meta.reserveReview;
      if (review?.scope !== "full-composition" || review.confidence !== "verified" || !review.compositionAsOf) continue;
      const expired = compile(meta, sec);
      if (expired.card.reserveCompositionAdmission?.reasons.join() !== "beyond-age-budget") continue;
      const ceiling = expired.facts.expiredReviewedAdmittedReserveScore;
      if (ceiling === undefined) { // v10.48 does not apply: tracked-asset row, observation-dated composition or report coverage
        expect([expired.facts.gaps.some((gap) => gap.reasonCode === "missing-reserve-composition"),
          meta.reserves!.some((row) => row.coinId) || Boolean(review.observations?.length) ||
          meta.proofOfReserves?.latestReport?.coverage != null], meta.id).toEqual([true, true]);
        continue;
      }
      const admitted = compile(reviewDatedOn(meta, day), sec);
      expect(ceiling, meta.id).toBeCloseTo(admitted.reserves, 6);
      expect(expired.reserves, meta.id).toBeLessThanOrEqual(admitted.reserves + 1e-6);
      capped++;
    }
    expect(capped).toBeGreaterThanOrEqual(20);
  });
});
