import { describe, expect, it } from "vitest";
import mechanismReviewOverlaysAsset from "@shared/data/safety-score-v9/mechanism-review-overlays-v1.json";
import xdaiMetaSource from "@shared/data/stablecoins/coins/xdai-gnosis.json";
import { V9_CANDIDATE_POLICY_V1 } from "@shared/lib/safety-score-v9/policy";
import type { StablecoinMeta } from "@shared/types/core";
import type { ReportCardsFixedInput } from "../report-cards-fixed-input";
import {
  buildSafetyScoreV9MechanismReview,
  deriveCommodityClaimMechanismExitFacts,
  expandOverlayReview,
  getSafetyScoreV9MechanismReviewGapDisposition,
  getSafetyScoreV9MechanismReviewedUnavailableComponents,
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

  it("compiles Base Dollar's five-branch review after the date-only admission gate", () => {
    const admittedClockSec = Date.parse("2026-08-22T00:00:00Z") / 1_000;
    const review = buildSafetyScoreV9MechanismReview(
      fixedInputStub({}, admittedClockSec),
      { id: "bd-basedollar" } as MechanismMeta,
      "cdp",
    );
    if (review?.archetype !== "cdp") throw new Error("expected the curated Base Dollar CDP overlay");
    expect(review.collateralizationRatio).toBe(2.209);
    expect(review.liquidationCapacityRatio).toBe(0.278);
    expect(review.collateralizationParameters).toMatchObject({
      quality: "adequate",
      status: { observationState: "known" },
    });
    expect(review.liquidationMechanics.quality).toBe("adequate");
    expect(review.backstop.quality).toBe("adequate");
    expect(review.branchIsolation.quality).toBe("adequate");
    expect(review.shutdownAndBadDebt.quality).toBe("limited");
    expect(review.structuralRedemption.quality).toBe("adequate");
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
    expect(
      getSafetyScoreV9MechanismReviewGapDisposition("usdd-tron-dao-reserve", "cdp", sameDaySec),
    ).toMatchObject({
      responsibility: "method-unsupported",
      componentKeys: expect.arrayContaining(["collateralizationParameters", "liquidationMechanics"]),
    });
    const beforeReviewSec = Date.UTC(2026, 6, 15, 23, 59, 59) / 1_000;
    expect(
      getSafetyScoreV9MechanismReviewGapDisposition(
        "usdd-tron-dao-reserve",
        "cdp",
        beforeReviewSec,
      ),
    ).toBeNull();
  });

  it("carries the adjudicated non-disclosure only while the overlay is current", () => {
    // a7a5-old-vector's committed fiat-cash overlay is reviewed 2026-08-08 and
    // adjudicates all three components as reviewed-but-unpublished.
    const currentSec = Date.UTC(2026, 7, 20) / 1_000;
    expect(
      getSafetyScoreV9MechanismReviewedUnavailableComponents("a7a5-old-vector", "fiat-cash", currentSec),
    ).toEqual([
      expect.objectContaining({
        componentKey: "assuranceAndReconciliation",
        sourceUrl: "https://docs.a7a5.io/legal/transparency.md",
        reviewedAt: "2026-08-08",
      }),
      expect.objectContaining({ componentKey: "claimAndSegregation", reviewedAt: "2026-08-08" }),
      expect.objectContaining({ componentKey: "custodyContinuity", reviewedAt: "2026-08-08" }),
    ]);

    // Inside the reviewed UTC day the overlay is not admitted at all, so the
    // clock guard owns the gap and no adjudication is carried.
    const sameDaySec = Date.UTC(2026, 7, 8, 12) / 1_000;
    expect(
      getSafetyScoreV9MechanismReviewedUnavailableComponents("a7a5-old-vector", "fiat-cash", sameDaySec),
    ).toEqual([]);
    expect(
      getSafetyScoreV9MechanismReviewGapDisposition("a7a5-old-vector", "fiat-cash", sameDaySec),
    ).toMatchObject({ responsibility: "method-unsupported" });

    // A resolved archetype that disagrees with the overlay ignores it, exactly
    // as the review build does.
    expect(
      getSafetyScoreV9MechanismReviewedUnavailableComponents("a7a5-old-vector", "tbill", currentSec),
    ).toEqual([]);
  });

  it("expands every curated overlay after its date-only admission gate elapses", () => {
    for (const rawOverlay of mechanismReviewOverlaysAsset.overlays) {
      const overlay = MechanismReviewOverlaySchema.parse(rawOverlay);
      expect(() => expandOverlayReview(overlay), overlay.assetId).not.toThrow();
    }
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

  it("derives xDAI assurance from its onchain proof instead of a duplicate overlay claim", () => {
    const overlay = mechanismReviewOverlaysAsset.overlays.find(
      (candidate) => candidate.assetId === "xdai-gnosis",
    );
    expect(overlay).toBeDefined();
    expect(overlay?.components).not.toHaveProperty(
      "assuranceAndReconciliation",
    );
    const fallback = buildSafetyScoreV9MechanismReview(
      fixedInputStub(
        { "xdai-gnosis": [{}] },
        Date.parse("2026-07-24T00:00:00Z") / 1_000,
      ),
      xdaiMetaSource as unknown as MechanismMeta,
      "fiat-cash",
    );
    const review = expandOverlayReview(
      MechanismReviewOverlaySchema.parse(overlay),
      fallback,
    );
    if (review.archetype !== "fiat-cash") {
      throw new Error("unexpected archetype");
    }
    expect(review.assuranceAndReconciliation).toMatchObject({
      quality: "adequate",
      status: { observationState: "known" },
    });
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

  it("expands partial sdn/rwa overlays with unavailable metrics and rejects CDP unavailability", () => {
    const sourceUrl = "https://example.com/transparency";
    // usdf-falcon-shaped: loss absorption measured, hedge/margin honestly unavailable.
    const sdnOverlay = MechanismReviewOverlaySchema.parse({
      assetId: "sdn-partial",
      archetype: "synthetic-delta-neutral",
      reviewedAt: "2026-07-27",
      sources: [{ label: "Issuer transparency API", url: sourceUrl }],
      notes: "Insurance-fund share is measured; no hedge-position or margin dataset is published.",
      metrics: { hedgeCoverageRatio: null, marginBufferPct: null, lossAbsorptionShare: 0.0079 },
      metricApplicability: {
        hedgeCoverageRatio: {
          state: "unavailable",
          rationale: "No hedge-position or venue-notional dataset is published.",
          sourceUrl,
        },
        marginBufferPct: {
          state: "unavailable",
          rationale: "No margin dataset is published; reserve excess is an analog only.",
          sourceUrl,
        },
      },
      components: {
        venueAndCustody: { quality: "limited" },
        lossAbsorption: { quality: "limited" },
      },
    });
    const sdnReview = expandOverlayReview(sdnOverlay);
    if (sdnReview.archetype !== "synthetic-delta-neutral") throw new Error("unexpected archetype");
    expect(sdnReview.hedgeCoverageRatio).toBeNull();
    expect(sdnReview.lossAbsorptionShare).toBe(0.0079);
    expect(sdnReview.metricApplicability?.hedgeCoverageRatio.state).toBe("unavailable");
    expect(sdnReview.metricApplicability?.lossAbsorptionShare.state).toBe("measured");
    expect(sdnReview.venueAndCustody.quality).toBe("limited");
    // Uncurated components stay bounded rather than being neutralized.
    expect(sdnReview.hedgeReconciliation.status.observationState).toBe("bounded-unknown");

    // apxusd-shaped: valuation cadence measured, WAM honestly unavailable.
    const rwaOverlay = MechanismReviewOverlaySchema.parse({
      assetId: "rwa-partial",
      archetype: "rwa-credit-fund",
      reviewedAt: "2026-07-27",
      sources: [{ label: "Collateral dashboard", url: sourceUrl }],
      notes: "Monthly valuation policy is documented; portfolio tenors are undisclosed.",
      metrics: { weightedAverageMaturityDays: null, valuationCadenceDays: 30 },
      metricApplicability: {
        weightedAverageMaturityDays: {
          state: "unavailable",
          rationale: "Tenors are undisclosed and the dominant holding is perpetual.",
          sourceUrl,
        },
      },
      components: {
        creditQuality: { quality: "weak" },
        maturityAndLiquidity: { quality: "weak" },
      },
    });
    const rwaReview = expandOverlayReview(rwaOverlay);
    if (rwaReview.archetype !== "rwa-credit-fund") throw new Error("unexpected archetype");
    expect(rwaReview.weightedAverageMaturityDays).toBeNull();
    expect(rwaReview.valuationCadenceDays).toBe(30);
    expect(rwaReview.metricApplicability?.weightedAverageMaturityDays.state).toBe("unavailable");

    // CDP has no defined severity for an unavailable ratio.
    expect(() =>
      expandOverlayReview(
        MechanismReviewOverlaySchema.parse({
          assetId: "cdp-unavailable",
          archetype: "cdp",
          reviewedAt: "2026-07-27",
          sources: [{ label: "Protocol design", url: sourceUrl }],
          notes: "CDP metrics cannot be marked unavailable.",
          metrics: { collateralizationRatio: null, liquidationCapacityRatio: 1 },
          metricApplicability: {
            collateralizationRatio: { state: "unavailable", rationale: "Unpublished.", sourceUrl },
          },
          components: { structuralRedemption: { quality: "adequate" } },
        }),
      ),
    ).toThrow(/CDP admits only measured or not-applicable metrics/);

    // Unavailable metric sourceUrl must match an overlay source.
    expect(() =>
      MechanismReviewOverlaySchema.parse({
        ...sdnOverlay,
        metricApplicability: {
          hedgeCoverageRatio: {
            state: "unavailable",
            rationale: "No hedge dataset.",
            sourceUrl: "https://example.com/not-a-source",
          },
        },
        metrics: { hedgeCoverageRatio: null, marginBufferPct: 1, lossAbsorptionShare: 0.0079 },
      }),
    ).toThrow(/sourceUrl must match an overlay source/);
  });

  it("keeps an applicable but undisclosed component bounded with overlay evidence", () => {
    const sourceUrl = "https://example.com/transparency";
    const overlay = MechanismReviewOverlaySchema.parse({
      assetId: "fiat-partial",
      archetype: "fiat-cash",
      reviewedAt: "2026-07-27",
      sources: [{ label: "Issuer transparency page", url: sourceUrl }],
      notes: "The issuer identifies its custodian but publishes no continuity review.",
      metrics: {},
      components: {
        claimAndSegregation: { quality: "adequate" },
        custodyContinuity: {
          applicability: "unavailable",
          rationale: "No custody continuity or fallback arrangement is disclosed.",
          sourceUrl,
        },
      },
    });
    const review = expandOverlayReview(overlay);
    if (review.archetype !== "fiat-cash") throw new Error("unexpected archetype");
    expect(review.custodyContinuity.status.applicability.state).toBe("required");
    expect(review.custodyContinuity.status.observationState).toBe("bounded-unknown");
    expect(review.custodyContinuity.status.evidenceRefIds).toHaveLength(1);
    expect(review.custodyContinuity.quality).toBeNull();

    expect(() =>
      MechanismReviewOverlaySchema.parse({
        ...overlay,
        components: {
          custodyContinuity: {
            applicability: "unavailable",
            rationale: "No continuity arrangement is disclosed.",
            sourceUrl: "https://example.com/not-a-source",
          },
        },
      }),
    ).toThrow(/sourceUrl must match an overlay source/);
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

  describe("commodity-claim (v9.14)", () => {
    const sourceUrl = "https://example.com/bar-list";

    function commodityOverlay(components: Record<string, unknown>): MechanismReviewOverlay {
      return MechanismReviewOverlaySchema.parse({
        assetId: "alpha",
        archetype: "commodity-claim",
        reviewedAt: "2026-07-14",
        sources: [{ label: "Vault attestation and redemption terms", url: sourceUrl }],
        notes: "Curated allocated-metal review under the ratified strict evidence standard.",
        metrics: {},
        components,
      });
    }

    it("bounds the compiler fallback and keeps the proof-of-reserves assurance shortcut", () => {
      expect(buildSafetyScoreV9MechanismReview(fixedInputStub(), BARE_META, "commodity-claim")).toBeNull();

      const review = buildSafetyScoreV9MechanismReview(
        fixedInputStub({ alpha: [{}] }),
        ATTESTED_META,
        "commodity-claim",
      );
      if (review?.archetype !== "commodity-claim") throw new Error("unexpected archetype");
      expect(review.titleAndAllocation.status.observationState).toBe("bounded-unknown");
      expect(review.titleAndAllocation.quality).toBeNull();
      expect(review.custodyContinuity.status.observationState).toBe("bounded-unknown");
      // The bar-list/inventory attestation is the same recorded report class as
      // a cash proof-of-reserves report, so the auto-known shortcut carries over.
      expect(review.assuranceAndReconciliation.status.observationState).toBe("known");
      expect(review.assuranceAndReconciliation.quality).toBe("adequate");
      // Redemption minimums, eligibility, and delivery terms are never derivable
      // from reserve or assurance evidence; the component waits for curation.
      expect(review.physicalRedemption.status.observationState).toBe("missing");
      expect(review.physicalRedemption.quality).toBeNull();
    });

    it("expands curated components, merges the fallback, and rejects foreign keys", () => {
      const fallback = buildSafetyScoreV9MechanismReview(
        fixedInputStub({ alpha: [{}] }),
        ATTESTED_META,
        "commodity-claim",
      );
      const review = expandOverlayReview(
        commodityOverlay({
          titleAndAllocation: { quality: "limited" },
          physicalRedemption: { quality: "limited" },
          custodyContinuity: {
            applicability: "unavailable",
            rationale: "No vault operator, insurance terms, or successor-custody arrangement is disclosed.",
            sourceUrl,
          },
        }),
        fallback,
      );
      if (review.archetype !== "commodity-claim") throw new Error("unexpected archetype");
      expect(review.titleAndAllocation).toMatchObject({ status: { observationState: "known" }, quality: "limited" });
      expect(review.physicalRedemption).toMatchObject({ status: { observationState: "known" }, quality: "limited" });
      expect(review.custodyContinuity.status.observationState).toBe("bounded-unknown");
      // The uncurated assurance component keeps the PoR-derived fallback quality.
      expect(review.assuranceAndReconciliation).toMatchObject({
        status: { observationState: "known" },
        quality: "adequate",
      });

      expect(() =>
        expandOverlayReview(commodityOverlay({ claimAndSegregation: { quality: "adequate" } })),
      ).toThrow(/Unknown commodity-claim mechanism component/);
      expect(() =>
        expandOverlayReview({
          ...commodityOverlay({ titleAndAllocation: { quality: "adequate" } }),
          metrics: { commodityOunces: 1 },
        }),
      ).toThrow(/Unknown commodity-claim mechanism metric/);
    });

    it("refuses a profile-driven commodity-claim overlay so the archetype owns its own facts", () => {
      expect(() =>
        MechanismReviewOverlaySchema.parse({
          assetId: "alpha",
          archetype: "commodity-claim",
          reviewedAt: "2026-07-14",
          sources: [{ label: "Vault attestation", url: sourceUrl }],
          notes: "Profiles project to fiat-cash and must not ride the new archetype.",
          metrics: {},
          components: {},
          profileReview: {
            profile: "allocated-commodity-claim",
            facts: {
              holderTitle: { disposition: "supported", quality: "strong" },
              physicalAllocation: { disposition: "supported", quality: "strong" },
              custodianSegregation: { disposition: "supported", quality: "adequate" },
              bankruptcyRemoteness: { disposition: "supported", quality: "limited" },
              custodyContinuity: { disposition: "issuer-undisclosed" },
              auditCadence: { disposition: "supported", quality: "adequate" },
              reserveReconciliation: { disposition: "supported", quality: "strong" },
              insurance: { disposition: "issuer-undisclosed" },
              physicalRedemption: { disposition: "supported", quality: "limited" },
            },
          },
        }),
      ).toThrow(/incompatible with commodity-claim/);
    });

    it("projects the exit fact from the one curated physical-redemption statement", () => {
      // Measured -> supported at the same quality the backing pillar grades.
      expect(
        deriveCommodityClaimMechanismExitFacts(commodityOverlay({ physicalRedemption: { quality: "limited" } })),
      ).toEqual([{ factKey: "physical-redemption", disposition: "supported", quality: "limited" }]);
      // Sourced nondisclosure -> bounded issuer-undisclosed, never a quality claim.
      expect(
        deriveCommodityClaimMechanismExitFacts(
          commodityOverlay({
            physicalRedemption: {
              applicability: "unavailable",
              rationale: "No redemption minimum, fee schedule, or eligibility rule is published.",
              sourceUrl,
            },
          }),
        ),
      ).toEqual([{ factKey: "physical-redemption", disposition: "issuer-undisclosed", quality: null }]);
      // A structurally absent redemption right is not evidence an exit exists,
      // so it must not buy the bounded missing-runtime-route substitution.
      expect(
        deriveCommodityClaimMechanismExitFacts(
          commodityOverlay({
            physicalRedemption: {
              applicability: "not-applicable",
              rationale: "The product offers no physical delivery channel at all.",
              sourceUrl,
            },
          }),
        ),
      ).toEqual([]);
      // Uncurated projects nothing: the compiler fallback has no statement.
      expect(
        deriveCommodityClaimMechanismExitFacts(commodityOverlay({ titleAndAllocation: { quality: "adequate" } })),
      ).toEqual([]);
    });
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
