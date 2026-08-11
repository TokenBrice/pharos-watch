// src/lib/__tests__/stablecoin-detail-reserve-quality-client.test.ts
import { describe, expect, it } from "vitest";
import type { ReserveReview, ReserveSlice, StablecoinMeta } from "@shared/types";
import {
  formatReserveQualityPct,
  projectReserveQualityClientSummary,
} from "../stablecoin-detail-reserve-quality-client";

function coinWith(reserves: unknown, reserveReview?: unknown): StablecoinMeta {
  return { id: "test-coin", reserves, reserveReview } as unknown as StablecoinMeta;
}

const USDC_LIKE_SLICES: ReserveSlice[] = [
  {
    name: "U.S. Treasury bills",
    pct: 80,
    risk: "very-low",
    assetClass: "treasury-bill",
    liquidityHorizon: "one-day",
    issuerOrObligor: "U.S. Treasury",
    riskFactors: ["duration", "liquidity"],
  },
  { name: "Bank deposits", pct: 20, risk: "low", assetClass: "bank-deposit", liquidityHorizon: "immediate" },
];

const USDC_LIKE_REVIEW: ReserveReview = {
  reviewedAt: "2026-07-18",
  reviewer: "Kimi RESERVE shard-3",
  confidence: "verified",
  sources: [{ label: "Circle reserve report", url: "https://example.com/reserves" }],
  rationale: "Server-only rationale.",
  compositionBasis: "Monthly attestation composition table.",
  compositionAsOf: "2026-06-30",
  scope: "full-composition",
  knownUnknownExposure: "No undisclosed obligors in the attested basket.",
  knownUnknownExposurePct: 0,
};

describe("formatReserveQualityPct", () => {
  it("rounds to at most 1 decimal and trims trailing zeros", () => {
    expect(formatReserveQualityPct(12.56)).toBe("12.6%");
    expect(formatReserveQualityPct(71)).toBe("71%");
    expect(formatReserveQualityPct(33.3333)).toBe("33.3%");
    expect(formatReserveQualityPct(0)).toBe("0%");
  });
});

describe("projectReserveQualityClientSummary", () => {
  it("returns null without reserves", () => {
    expect(projectReserveQualityClientSummary(coinWith(undefined))).toBeNull();
    expect(projectReserveQualityClientSummary(coinWith([]))).toBeNull();
  });

  it("returns null for reserve slices carrying no quality attributes", () => {
    expect(
      projectReserveQualityClientSummary(coinWith([{ name: "Cash", pct: 100, risk: "very-low" }])),
    ).toBeNull();
  });

  it("returns null when asset classes are curated but no liquidity horizon is", () => {
    expect(
      projectReserveQualityClientSummary(
        coinWith([{ name: "Cash", pct: 100, risk: "very-low", assetClass: "cash" }]),
      ),
    ).toBeNull();
  });

  it("returns null when liquidity horizons are curated but no asset class is", () => {
    expect(
      projectReserveQualityClientSummary(
        coinWith([{ name: "Cash", pct: 100, risk: "very-low", liquidityHorizon: "immediate" }]),
      ),
    ).toBeNull();
  });

  it("projects the mix, ladder, review aggregates, and slice detail", () => {
    const summary = projectReserveQualityClientSummary(coinWith(USDC_LIKE_SLICES, USDC_LIKE_REVIEW));
    expect(summary).not.toBeNull();
    expect(summary!.chipLabel).toBe("Highly liquid");
    expect(summary!.chipToneClass).toContain("emerald");
    expect(summary!.lede).toBe("2 reviewed reserve slices — 100% convertible within one day.");
    expect(summary!.mix).toEqual([
      { key: "treasury-bill", label: "Treasury bills", pct: 80, barClass: "bg-blue-500" },
      { key: "bank-deposit", label: "Bank deposits", pct: 20, barClass: "bg-cyan-500" },
    ]);
    expect(summary!.ladder).toEqual([
      { key: "immediate", tone: "ok", label: "Immediate", pct: 20 },
      { key: "one-day", tone: "info", label: "≤ 1 day", pct: 80 },
    ]);
    expect(summary!.liquidWithinOneDayPct).toBe(100);
    expect(summary!.unknownHorizonPct).toBe(0);
    expect(summary!.unidentifiedObligorsPct).toBe(0);
    expect(summary!.selfExposurePct).toBeNull();
    expect(summary!.asOf).toBe("2026-06-30");
    expect(summary!.sliceCount).toBe(2);
    expect(summary!.confidenceLabel).toBe("Verified");
    expect(summary!.reviewedAt).toBe("2026-07-18");
    expect(summary!.compositionBasis).toBe("Monthly attestation composition table.");
    expect(summary!.knownUnknownExposureNote).toBe("No undisclosed obligors in the attested basket.");
    expect(summary!.slices[0]).toEqual({
      key: "U.S. Treasury bills:0",
      name: "U.S. Treasury bills",
      pct: 80,
      assetClassLabel: "Treasury bills",
      horizonLabel: "≤ 1 day",
      riskLabel: "Very low",
      obligor: "U.S. Treasury",
      riskFactorLabels: ["duration", "liquidity"],
    });
    expect(summary!.slices[1]!.obligor).toBeNull();
    expect(summary!.slices[1]!.riskFactorLabels).toEqual([]);
    expect(summary!.sources).toEqual([{ label: "Circle reserve report", url: "https://example.com/reserves" }]);
  });

  it("counts a missing liquidity horizon as unknown and orders the ladder", () => {
    const summary = projectReserveQualityClientSummary(
      coinWith([
        { name: "Private credit fund", pct: 45, risk: "high", assetClass: "private-credit" },
        { name: "Cash", pct: 25, risk: "very-low", assetClass: "cash", liquidityHorizon: "immediate" },
        { name: "Tokenized notes", pct: 30, risk: "medium", assetClass: "tokenized-security", liquidityHorizon: "over-seven-days" },
      ]),
    );
    expect(summary!.ladder).toEqual([
      { key: "immediate", tone: "ok", label: "Immediate", pct: 25 },
      { key: "over-seven-days", tone: "alert", label: "> 7 days", pct: 30 },
      { key: "unknown", tone: "neutral", label: "Unknown", pct: 45 },
    ]);
    expect(summary!.unknownHorizonPct).toBe(45);
    expect(summary!.liquidWithinOneDayPct).toBe(25);
    expect(summary!.lede).toContain("25% convertible within one day, 45% with no established exit timeline.");
  });

  it("aggregates repeated asset classes and rounds shares", () => {
    const summary = projectReserveQualityClientSummary(
      coinWith([
        { name: "T-bill ladder A", pct: 40.02, risk: "very-low", assetClass: "treasury-bill", liquidityHorizon: "one-day" },
        { name: "T-bill ladder B", pct: 30.04, risk: "very-low", assetClass: "treasury-bill", liquidityHorizon: "one-day" },
        { name: "Cash", pct: 29.94, risk: "very-low", assetClass: "cash", liquidityHorizon: "immediate" },
      ]),
    );
    expect(summary!.mix).toEqual([
      { key: "treasury-bill", label: "Treasury bills", pct: 70.1, barClass: "bg-blue-500" },
      { key: "cash", label: "Cash", pct: 29.9, barClass: "bg-cyan-500" },
    ]);
  });

  it("labels slices without an asset class as unclassified", () => {
    const summary = projectReserveQualityClientSummary(
      coinWith([
        { name: "Cash", pct: 60, risk: "very-low", assetClass: "cash", liquidityHorizon: "immediate" },
        { name: "Undisclosed holdings", pct: 40, risk: "medium", liquidityHorizon: "unknown" },
      ]),
    );
    expect(summary!.mix[1]).toEqual({
      key: "unclassified",
      label: "Unclassified",
      pct: 40,
      barClass: "bg-cyan-500",
    });
  });

  it("folds a single tail class beyond the fifth segment under its own label", () => {
    const summary = projectReserveQualityClientSummary(
      coinWith([
        { name: "Cash", pct: 30, risk: "very-low", assetClass: "cash", liquidityHorizon: "immediate" },
        { name: "T-bills", pct: 25, risk: "very-low", assetClass: "treasury-bill", liquidityHorizon: "one-day" },
        { name: "Repo", pct: 20, risk: "low", assetClass: "repo", liquidityHorizon: "one-day" },
        { name: "MMF", pct: 12, risk: "low", assetClass: "money-market-fund", liquidityHorizon: "one-day" },
        { name: "Bank deposits", pct: 10, risk: "low", assetClass: "bank-deposit", liquidityHorizon: "immediate" },
        { name: "Gold", pct: 3, risk: "medium", assetClass: "commodity-allocated", liquidityHorizon: "seven-days" },
      ]),
    );
    expect(summary!.mix).toHaveLength(6);
    expect(summary!.mix[5]).toEqual({
      key: "mix-tail",
      label: "Allocated commodities",
      pct: 3,
      barClass: "bg-muted-foreground/40",
    });
  });

  it("folds several tail classes into one counted segment", () => {
    const summary = projectReserveQualityClientSummary(
      coinWith([
        { name: "Cash", pct: 30, risk: "very-low", assetClass: "cash", liquidityHorizon: "immediate" },
        { name: "T-bills", pct: 25, risk: "very-low", assetClass: "treasury-bill", liquidityHorizon: "one-day" },
        { name: "Repo", pct: 20, risk: "low", assetClass: "repo", liquidityHorizon: "one-day" },
        { name: "MMF", pct: 12, risk: "low", assetClass: "money-market-fund", liquidityHorizon: "one-day" },
        { name: "Bank deposits", pct: 8, risk: "low", assetClass: "bank-deposit", liquidityHorizon: "immediate" },
        { name: "Gold", pct: 3, risk: "medium", assetClass: "commodity-allocated", liquidityHorizon: "seven-days" },
        { name: "Fund shares", pct: 2, risk: "medium", assetClass: "fund-share", liquidityHorizon: "seven-days" },
      ]),
    );
    expect(summary!.mix).toHaveLength(6);
    expect(summary!.mix.map((row) => row.barClass)).toEqual([
      "bg-blue-500",
      "bg-cyan-500",
      "bg-violet-500",
      "bg-amber-500",
      "bg-teal-500",
      "bg-muted-foreground/40",
    ]);
    expect(summary!.mix[5]).toMatchObject({ key: "mix-tail", label: "2 smaller classes", pct: 5 });
  });

  it("calls a basket highly liquid exactly at the 90% one-day boundary", () => {
    const summary = projectReserveQualityClientSummary(
      coinWith([
        { name: "Cash", pct: 90, risk: "very-low", assetClass: "cash", liquidityHorizon: "immediate" },
        { name: "Private credit", pct: 10, risk: "high", assetClass: "private-credit", liquidityHorizon: "over-seven-days" },
      ]),
    );
    expect(summary!.chipLabel).toBe("Highly liquid");
    expect(summary!.chipToneClass).toContain("emerald");
  });

  it("calls a basket mostly liquid exactly at the 60% one-day boundary", () => {
    const summary = projectReserveQualityClientSummary(
      coinWith([
        { name: "Cash", pct: 60, risk: "very-low", assetClass: "cash", liquidityHorizon: "immediate" },
        { name: "Private credit", pct: 40, risk: "high", assetClass: "private-credit", liquidityHorizon: "over-seven-days" },
      ]),
    );
    expect(summary!.chipLabel).toBe("Mostly liquid");
    expect(summary!.chipToneClass).toContain("blue");
  });

  it("calls the exit opaque when the unknown share reaches 40%", () => {
    const summary = projectReserveQualityClientSummary(
      coinWith([
        { name: "Cash", pct: 59, risk: "very-low", assetClass: "cash", liquidityHorizon: "immediate" },
        { name: "Undisclosed holdings", pct: 41, risk: "high", assetClass: "other", liquidityHorizon: "unknown" },
      ]),
    );
    expect(summary!.chipLabel).toBe("Opaque exit");
    expect(summary!.chipToneClass).toContain("amber");
  });

  it("falls back to mixed liquidity below both liquidity and opacity thresholds", () => {
    const summary = projectReserveQualityClientSummary(
      coinWith([
        { name: "Cash", pct: 50, risk: "very-low", assetClass: "cash", liquidityHorizon: "immediate" },
        { name: "Private credit", pct: 30, risk: "high", assetClass: "private-credit", liquidityHorizon: "over-seven-days" },
        { name: "Undisclosed holdings", pct: 20, risk: "high", assetClass: "other", liquidityHorizon: "unknown" },
      ]),
    );
    expect(summary!.chipLabel).toBe("Mixed liquidity");
    expect(summary!.chipToneClass).toContain("amber");
  });

  it("sums self-reserve dispositions into the self-exposure share", () => {
    const summary = projectReserveQualityClientSummary(
      coinWith(USDC_LIKE_SLICES, {
        ...USDC_LIKE_REVIEW,
        knownUnknownExposurePct: 12.56,
        nonLinkDispositions: [
          { reserveIndex: 0, reserveName: "Governance token", pct: 6.5, disposition: "self-reserve", rationale: "Issuer's own token." },
          { reserveIndex: 1, reserveName: "Protocol LP", pct: 2.25, disposition: "self-reserve", rationale: "Issuer-owned position." },
          { reserveIndex: 2, reserveName: "Exogenous asset", pct: 40, disposition: "untracked-exogenous-asset", rationale: "Untracked." },
        ],
      }),
    );
    expect(summary!.selfExposurePct).toBe(8.8);
    expect(summary!.unidentifiedObligorsPct).toBe(12.6);
    expect(summary!.lede).toContain("12.6% of the basket has no identified obligor.");
    expect(summary!.lede).toContain("8.8% is issuer self-exposure rather than independent collateral.");
  });

  it("leaves self-exposure null when the review records no self-reserve disposition", () => {
    const summary = projectReserveQualityClientSummary(
      coinWith(USDC_LIKE_SLICES, {
        ...USDC_LIKE_REVIEW,
        nonLinkDispositions: [
          { reserveIndex: 0, reserveName: "Exogenous asset", pct: 40, disposition: "untracked-exogenous-asset", rationale: "Untracked." },
        ],
      }),
    );
    expect(summary!.selfExposurePct).toBeNull();
  });

  it("surfaces a concentrated position only when the top slice carries medium-or-worse risk", () => {
    const summary = projectReserveQualityClientSummary(
      coinWith([
        { name: "Hedged basis book", pct: 62.44, risk: "high", assetClass: "hedged-crypto", liquidityHorizon: "seven-days" },
        { name: "Cash", pct: 37.56, risk: "very-low", assetClass: "cash", liquidityHorizon: "immediate" },
      ]),
    );
    expect(summary!.topPositionName).toBe("Hedged basis book");
    expect(summary!.topPositionPct).toBe(62.4);
  });

  it("does not surface a low-risk top position", () => {
    const summary = projectReserveQualityClientSummary(coinWith(USDC_LIKE_SLICES));
    expect(summary!.topPositionName).toBeNull();
    expect(summary!.topPositionPct).toBeNull();
  });

  it("does not surface a top position below the 20% concentration floor", () => {
    const summary = projectReserveQualityClientSummary(
      coinWith([
        { name: "Cash", pct: 19, risk: "high", assetClass: "cash", liquidityHorizon: "immediate" },
        { name: "T-bills A", pct: 18, risk: "very-low", assetClass: "treasury-bill", liquidityHorizon: "one-day" },
        { name: "T-bills B", pct: 18, risk: "very-low", assetClass: "treasury-bill", liquidityHorizon: "one-day" },
        { name: "T-bills C", pct: 18, risk: "very-low", assetClass: "treasury-bill", liquidityHorizon: "one-day" },
        { name: "T-bills D", pct: 18, risk: "very-low", assetClass: "treasury-bill", liquidityHorizon: "one-day" },
        { name: "T-bills E", pct: 9, risk: "very-low", assetClass: "treasury-bill", liquidityHorizon: "one-day" },
      ]),
    );
    expect(summary!.topPositionName).toBeNull();
  });

  it("does not treat a single-slice basket as a concentrated position", () => {
    const summary = projectReserveQualityClientSummary(
      coinWith([
        { name: "Hedged basis book", pct: 100, risk: "high", assetClass: "hedged-crypto", liquidityHorizon: "seven-days" },
      ]),
    );
    expect(summary!.topPositionName).toBeNull();
    expect(summary!.topPositionPct).toBeNull();
    expect(summary!.lede).toContain("1 reviewed reserve slice —");
  });

  it("keeps review-derived fields null without a reserve review", () => {
    const summary = projectReserveQualityClientSummary(coinWith(USDC_LIKE_SLICES));
    expect(summary!.unidentifiedObligorsPct).toBeNull();
    expect(summary!.selfExposurePct).toBeNull();
    expect(summary!.asOf).toBeNull();
    expect(summary!.confidenceLabel).toBeNull();
    expect(summary!.reviewedAt).toBeNull();
    expect(summary!.compositionBasis).toBeNull();
    expect(summary!.knownUnknownExposureNote).toBeNull();
    expect(summary!.sources).toEqual([]);
  });

  it("passes an unmapped review confidence through unchanged", () => {
    const summary = projectReserveQualityClientSummary(
      coinWith(USDC_LIKE_SLICES, { ...USDC_LIKE_REVIEW, confidence: "speculative" }),
    );
    expect(summary!.confidenceLabel).toBe("speculative");
  });
});
