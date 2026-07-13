import { describe, expect, it } from "vitest";
import type { StablecoinMeta } from "@shared/types/core";
import type { ReportCardsFixedInput } from "../report-cards-fixed-input";
import { buildSafetyScoreV9MechanismReview } from "../safety-score-v9-extension-mechanism";

type MechanismMeta = Pick<StablecoinMeta, "id" | "reserves" | "reserveReview" | "custodyProfile" | "proofOfReserves">;

function fixedInputStub(liveReserves: Record<string, unknown[]> = {}): ReportCardsFixedInput {
  return { liveReserveMap: liveReserves } as unknown as ReportCardsFixedInput;
}

const BARE_META: MechanismMeta = { id: "alpha" } as MechanismMeta;

const ATTESTED_META = {
  id: "alpha",
  proofOfReserves: {
    latestReport: {
      assuranceMethod: "attestation",
      scope: "assets-and-liabilities",
      confidence: "high",
    },
  },
} as unknown as MechanismMeta;

describe("buildSafetyScoreV9MechanismReview", () => {
  it("returns no review without any reserve, custody, or assurance evidence", () => {
    expect(buildSafetyScoreV9MechanismReview(fixedInputStub(), BARE_META, "fiat-cash")).toBeNull();
    expect(buildSafetyScoreV9MechanismReview(fixedInputStub(), BARE_META, "tbill")).toBeNull();
  });

  it("bounds fiat-cash components as unknown and restates only the recorded assurance quality", () => {
    const review = buildSafetyScoreV9MechanismReview(fixedInputStub({ alpha: [{}] }), ATTESTED_META, "fiat-cash");
    expect(review?.archetype).toBe("fiat-cash");
    if (review?.archetype !== "fiat-cash") throw new Error("unexpected archetype");
    expect(review.claimAndSegregation.status.observationState).toBe("bounded-unknown");
    expect(review.claimAndSegregation.quality).toBeNull();
    expect(review.custodyContinuity.status.observationState).toBe("bounded-unknown");
    expect(review.assuranceAndReconciliation.status.observationState).toBe("known");
    expect(review.assuranceAndReconciliation.quality).toBe("adequate");
  });

  it("marks tbill duration evidence bounded only when maturity data exists", () => {
    const withoutMaturity = buildSafetyScoreV9MechanismReview(
      fixedInputStub({ alpha: [{ pct: 100 }] }),
      ATTESTED_META,
      "tbill",
    );
    if (withoutMaturity?.archetype !== "tbill") throw new Error("unexpected archetype");
    // Reserve evidence exists, so duration is bounded-unknown rather than missing.
    expect(withoutMaturity.durationAndLiquidity.status.observationState).toBe("bounded-unknown");
    const bare = buildSafetyScoreV9MechanismReview(fixedInputStub(), ATTESTED_META, "tbill");
    if (bare?.archetype !== "tbill") throw new Error("unexpected archetype");
    expect(bare.durationAndLiquidity.status.observationState).toBe("missing");
    expect(bare.durationAndLiquidity.quality).toBeNull();
  });

  it("returns no derived review for measured-ratio archetypes without a curated overlay", () => {
    expect(buildSafetyScoreV9MechanismReview(fixedInputStub({ alpha: [{}] }), ATTESTED_META, "cdp")).toBeNull();
    expect(
      buildSafetyScoreV9MechanismReview(fixedInputStub({ alpha: [{}] }), ATTESTED_META, "synthetic-delta-neutral"),
    ).toBeNull();
  });
});
