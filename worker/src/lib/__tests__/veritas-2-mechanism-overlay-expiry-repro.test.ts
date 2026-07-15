import { describe, expect, it } from "vitest";
import type { StablecoinMeta } from "@shared/types/core";
import type { ReportCardsFixedInput } from "../report-cards-fixed-input";
import { buildSafetyScoreV9MechanismReview } from "../safety-score-v9-extension-mechanism";

type MechanismMeta = Pick<StablecoinMeta, "id" | "reserves" | "reserveReview" | "custodyProfile" | "proofOfReserves">;

describe.skip("VERITAS-II finding: mechanism overlays do not expire after twelve months", () => {
  it("re-bounds USDC components after its 2026-07-15 review expires", () => {
    const fixedInput = {
      clockSec: Date.UTC(2027, 6, 16) / 1_000,
      liveReserveMap: { "usdc-circle": [{ pct: 100 }] },
    } as unknown as ReportCardsFixedInput;
    const meta = { id: "usdc-circle" } as MechanismMeta;

    const review = buildSafetyScoreV9MechanismReview(fixedInput, meta, "fiat-cash");
    if (review?.archetype !== "fiat-cash") throw new Error("expected the USDC fiat-cash review");

    expect(review.claimAndSegregation.status.observationState).toBe("bounded-unknown");
    expect(review.claimAndSegregation.quality).toBeNull();
    expect(review.custodyContinuity.status.observationState).toBe("bounded-unknown");
    expect(review.custodyContinuity.quality).toBeNull();
  });
});
