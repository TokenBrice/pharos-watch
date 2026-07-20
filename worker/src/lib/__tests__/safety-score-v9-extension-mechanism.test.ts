import { describe, expect, it } from "vitest";
import { V9_CANDIDATE_POLICY_V1 } from "@shared/lib/safety-score-v9/policy";
import type { StablecoinMeta } from "@shared/types/core";
import type { ReportCardsFixedInput } from "../report-cards-fixed-input";
import {
  buildSafetyScoreV9MechanismReview,
  expandOverlayReview,
  getSafetyScoreV9MechanismOverlayEvidence,
  MechanismReviewOverlaySchema,
  SAFETY_SCORE_V9_MECHANISM_REVIEW_OVERLAYS_DIGEST,
  type MechanismReviewOverlay,
} from "../safety-score-v9-extension-mechanism";

type MechanismMeta = Pick<StablecoinMeta, "id" | "reserves" | "reserveReview" | "custodyProfile" | "proofOfReserves">;

// Curated overlays now re-bound after twelve months (VER2-004), so the stub
// carries a clock within a year of the fixture overlay review dates
// (2026-07-13..16) to keep them current.
const STUB_CLOCK_SEC = Date.UTC(2026, 6, 21) / 1_000;

function fixedInputStub(
  liveReserves: Record<string, unknown[]> = {},
  clockSec = STUB_CLOCK_SEC,
): ReportCardsFixedInput {
  return { clockSec, liveReserveMap: liveReserves } as unknown as ReportCardsFixedInput;
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

  it("expands a curated overlay with sourced metrics, component facts, and archetype guarding", () => {
    const boldMeta = { id: "bold-liquity" } as MechanismMeta;
    const review = buildSafetyScoreV9MechanismReview(fixedInputStub(), boldMeta, "cdp");
    if (review?.archetype !== "cdp") throw new Error("expected the curated bold-liquity CDP overlay");
    expect(review.collateralizationRatio).toBeCloseTo(2.455, 3);
    expect(review.liquidationCapacityRatio).toBeCloseTo(0.658, 3);
    expect(review.metricApplicability.collateralizationRatio.state).toBe("measured");
    expect(review.collateralizationParameters.status.observationState).toBe("known");
    expect(review.collateralizationParameters.quality).toBe("adequate");
    expect(review.backstop.status.observationState).toBe("known");
    expect(review.backstop.quality).toBe("adequate");
    expect(review.branchIsolation.quality).toBe("adequate");
    expect(review.shutdownAndBadDebt.quality).toBe("limited");
    expect(review.structuralRedemption.quality).toBe("adequate");
    // The overlay is ignored when the resolved archetype disagrees.
    expect(buildSafetyScoreV9MechanismReview(fixedInputStub(), boldMeta, "fiat-cash")).toBeNull();
  });

  it("keeps LUSD's measured liquidation capacity and unsafe-backing ceiling outside control changes", () => {
    const review = buildSafetyScoreV9MechanismReview(fixedInputStub(), { id: "lusd-liquity" } as MechanismMeta, "cdp");
    if (review?.archetype !== "cdp") throw new Error("expected the curated LUSD CDP overlay");
    expect(review.liquidationCapacityRatio).toBe(0.278);
    expect(V9_CANDIDATE_POLICY_V1.policy.semantic.backing.structural.cdp.liquidationSignal).toEqual({
      kind: "unsafe-backing",
      severity: "high",
    });
    expect(V9_CANDIDATE_POLICY_V1.policy.semantic.structural.signalLimits["unsafe-backing"].high).toBe(59);
  });

  it("compiles USDD's collateral surplus without erasing its market-funded and shared-deficit constraints", () => {
    const review = buildSafetyScoreV9MechanismReview(
      fixedInputStub(),
      { id: "usdd-tron-dao-reserve" } as MechanismMeta,
      "cdp",
    );
    if (review?.archetype !== "cdp") throw new Error("expected the curated USDD CDP overlay");

    expect(review.collateralizationRatio).toBe(1.551936);
    expect(review.metricApplicability.collateralizationRatio.state).toBe("measured");
    expect(review.liquidationCapacityRatio).toBeNull();
    expect(review.metricApplicability.liquidationCapacityRatio.state).toBe("not-applicable");
    expect(review.collateralizationParameters.quality).toBe("adequate");
    expect(review.liquidationMechanics.quality).toBe("adequate");
    expect(review.backstop.quality).toBe("weak");
    expect(review.branchIsolation.quality).toBe("limited");
    expect(review.shutdownAndBadDebt.quality).toBe("limited");
    expect(review.structuralRedemption.quality).toBe("limited");
  });

  it("binds curated overlays to their content and rejects date-only reviews until the next UTC day", () => {
    expect(SAFETY_SCORE_V9_MECHANISM_REVIEW_OVERLAYS_DIGEST).toMatch(/^[a-f0-9]{64}$/);
    expect(getSafetyScoreV9MechanismOverlayEvidence("usdd-tron-dao-reserve", "cdp", STUB_CLOCK_SEC)).toEqual(
      expect.objectContaining({ reviewedAt: "2026-07-16", maxAgeSec: 31_536_000 }),
    );

    const sameDaySec = Date.UTC(2026, 6, 16, 12) / 1_000;
    expect(
      buildSafetyScoreV9MechanismReview(
        fixedInputStub({}, sameDaySec),
        { id: "usdd-tron-dao-reserve" } as MechanismMeta,
        "cdp",
      ),
    ).toBeNull();
    expect(getSafetyScoreV9MechanismOverlayEvidence("usdd-tron-dao-reserve", "cdp", sameDaySec)).toBeNull();
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

  it("expands sourced structural CDP N/A without turning analogous capacity into liquidation capacity", () => {
    const sourceUrl = "https://example.com/protocol-design";
    const overlay = MechanismReviewOverlaySchema.parse({
      assetId: "conversion-token",
      archetype: "cdp",
      reviewedAt: "2026-07-15",
      sources: [{ label: "Protocol design", url: sourceUrl }],
      notes: "The token has a conversion route but no independent vault or liquidation pool.",
      metrics: { collateralizationRatio: null, liquidationCapacityRatio: null },
      metricApplicability: {
        collateralizationRatio: {
          state: "not-applicable",
          rationale: "No independent per-token vault system exists.",
          sourceUrl,
        },
        liquidationCapacityRatio: {
          state: "not-applicable",
          rationale: "Conversion inventory is not committed liquidation capital.",
          sourceUrl,
        },
      },
      analogousMetrics: { conversionCapacityCounterUnits: 123 },
      components: {
        collateralizationParameters: {
          applicability: "not-applicable",
          rationale: "No independent per-token vault system exists.",
          sourceUrl,
        },
        liquidationMechanics: {
          applicability: "not-applicable",
          rationale: "The conversion pool is not a liquidation pool.",
          sourceUrl,
        },
        structuralRedemption: { quality: "adequate" },
      },
    });
    const review = expandOverlayReview(overlay);
    if (review.archetype !== "cdp") throw new Error("unexpected archetype");
    expect(review.collateralizationRatio).toBeNull();
    expect(review.liquidationCapacityRatio).toBeNull();
    expect(review.metricApplicability.liquidationCapacityRatio.state).toBe("not-applicable");
    expect(review.liquidationMechanics.status.applicability.state).toBe("not-applicable");
  });

  it("publishes complete unhealthy USDQ evidence as failed health rather than missing coverage", () => {
    const review = buildSafetyScoreV9MechanismReview(fixedInputStub(), { id: "usdq-quill" } as MechanismMeta, "cdp");
    if (review?.archetype !== "cdp") throw new Error("expected the curated USDQ CDP overlay");
    expect(review.collateralizationRatio).toBe(0.676425);
    expect(review.liquidationCapacityRatio).toBe(0.00383);
    expect(review.metricApplicability.collateralizationRatio.state).toBe("measured");
    expect(review.shutdownAndBadDebt.status.observationState).toBe("known");
    expect(review.shutdownAndBadDebt.quality).toBe("failed");
  });

  it("publishes Mento conversion inventory only as a structural analogue", () => {
    const review = buildSafetyScoreV9MechanismReview(fixedInputStub(), { id: "audm-mento" } as MechanismMeta, "cdp");
    if (review?.archetype !== "cdp") throw new Error("expected the curated Mento CDP overlay");
    expect(review.collateralizationRatio).toBeNull();
    expect(review.liquidationCapacityRatio).toBeNull();
    expect(review.metricApplicability.collateralizationRatio.state).toBe("not-applicable");
    expect(review.metricApplicability.liquidationCapacityRatio.state).toBe("not-applicable");
    expect(review.liquidationMechanics.status.applicability.state).toBe("not-applicable");
    expect(review.structuralRedemption.quality).toBe("adequate");
  });

  it("rejects measured-null and unsourced structural N/A overlay claims", () => {
    const base = {
      assetId: "invalid",
      archetype: "cdp" as const,
      reviewedAt: "2026-07-15",
      sources: [{ label: "Protocol design", url: "https://example.com/source" }],
      notes: "Invalid fixture.",
      metrics: { collateralizationRatio: null, liquidationCapacityRatio: 0.5 },
      components: {},
    };
    const measuredNull = MechanismReviewOverlaySchema.parse(base);
    expect(() => expandOverlayReview(measuredNull)).toThrow(/measured collateralizationRatio/);
    expect(() =>
      MechanismReviewOverlaySchema.parse({
        ...base,
        metricApplicability: {
          collateralizationRatio: {
            state: "not-applicable",
            rationale: "No vault system.",
            sourceUrl: "https://example.com/not-in-sources",
          },
        },
      }),
    ).toThrow(/sourceUrl must match/);
  });
});
