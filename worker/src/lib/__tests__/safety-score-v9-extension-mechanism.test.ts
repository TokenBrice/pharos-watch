import { describe, expect, it } from "vitest";
import type { StablecoinMeta } from "@shared/types/core";
import type { ReportCardsFixedInput } from "../report-cards-fixed-input";
import {
  buildSafetyScoreV9MechanismReview,
  expandOverlayReview,
  type MechanismReviewOverlay,
} from "../safety-score-v9-extension-mechanism";

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

  it("expands a curated overlay with sourced metrics, bounded-unknown defaults, and archetype guarding", () => {
    const boldMeta = { id: "bold-liquity" } as MechanismMeta;
    const review = buildSafetyScoreV9MechanismReview(fixedInputStub(), boldMeta, "cdp");
    if (review?.archetype !== "cdp") throw new Error("expected the curated bold-liquity CDP overlay");
    expect(review.collateralizationRatio).toBeCloseTo(2.455, 3);
    expect(review.liquidationCapacityRatio).toBeCloseTo(0.658, 3);
    expect(review.collateralizationParameters.status.observationState).toBe("known");
    expect(review.collateralizationParameters.quality).toBe("adequate");
    expect(review.backstop.status.observationState).toBe("bounded-unknown");
    expect(review.backstop.quality).toBeNull();
    // The overlay is ignored when the resolved archetype disagrees.
    expect(buildSafetyScoreV9MechanismReview(fixedInputStub(), boldMeta, "fiat-cash")).toBeNull();
  });

  it("merges a gated fiat-cash overlay over the built review without degrading derived assurance", () => {
    const overlay: MechanismReviewOverlay = {
      assetId: "alpha",
      archetype: "fiat-cash",
      reviewedAt: "2026-07-14",
      sources: [{ label: "Issuer trust and segregation disclosures", url: "https://example.com/terms" }],
      notes: "Curated segregation review under the owner-approved evidence standard.",
      metrics: {},
      components: { claimAndSegregation: { quality: "adequate" } },
    };
    const fallback = buildSafetyScoreV9MechanismReview(fixedInputStub({ alpha: [{}] }), ATTESTED_META, "fiat-cash");
    const review = expandOverlayReview(overlay, fallback);
    if (review.archetype !== "fiat-cash") throw new Error("unexpected archetype");
    // The curated component claims quality...
    expect(review.claimAndSegregation.status.observationState).toBe("known");
    expect(review.claimAndSegregation.quality).toBe("adequate");
    // ...uncurated custody stays bounded-unknown...
    expect(review.custodyContinuity.status.observationState).toBe("bounded-unknown");
    // ...and the PoR-derived assurance quality survives instead of degrading to bounded.
    expect(review.assuranceAndReconciliation.status.observationState).toBe("known");
    expect(review.assuranceAndReconciliation.quality).toBe("adequate");
  });

  it("rejects unknown components and metrics on gated fiat-cash and tbill overlays", () => {
    const overlay: MechanismReviewOverlay = {
      assetId: "alpha",
      archetype: "tbill",
      reviewedAt: "2026-07-14",
      sources: [{ label: "Fund prospectus", url: "https://example.com/prospectus" }],
      notes: "Curated NAV review.",
      metrics: {},
      components: { navValuation: { quality: "strong" } },
    };
    const expanded = expandOverlayReview(overlay);
    if (expanded.archetype !== "tbill") throw new Error("unexpected archetype");
    expect(expanded.navValuation.quality).toBe("strong");
    expect(() =>
      expandOverlayReview({ ...overlay, components: { collateralizationParameters: { quality: "strong" } } }),
    ).toThrow(/Unknown tbill mechanism component/);
    expect(() => expandOverlayReview({ ...overlay, metrics: { navDeviationBps: 5 } })).toThrow(
      /Unknown tbill mechanism metric/,
    );
  });
});
