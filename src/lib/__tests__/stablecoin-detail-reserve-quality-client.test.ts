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
  it("preserves a positive sub-display-precision asset instead of publishing zero exposure", () => {
    const summary = projectReserveQualityClientSummary(coinWith([
      { ...USDC_LIKE_SLICES[0], pct: 99.99536 },
      { name: "Corporate bonds", pct: 0.00464, risk: "high", assetClass: "public-credit", liquidityHorizon: "unknown" },
    ], USDC_LIKE_REVIEW));
    const bonds = summary?.slices.find((slice) => slice.name === "Corporate bonds");
    expect(bonds?.pct).toBe(0.00464);
    expect(formatReserveQualityPct(bonds!.pct)).toBe("<0.1%");
    expect(formatReserveQualityPct(0)).toBe("0%");
    expect(summary?.asOf).toBe("2026-06-30");
  });

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

  it("projects the ladder, review aggregates, and slice detail", () => {
    const summary = projectReserveQualityClientSummary(coinWith(USDC_LIKE_SLICES, USDC_LIKE_REVIEW));
    expect(summary).not.toBeNull();
    expect(summary!.chipLabel).toBe("Highly liquid");
    expect(summary!.chipToneClass).toContain("emerald");
    expect(summary!.lede).toBe("2 reviewed reserve slices — 100% convertible within one day.");
    expect(summary!.ladder).toEqual([
      { key: "immediate", label: "Immediate", pct: 20 },
      { key: "one-day", label: "≤ 1 day", pct: 80 },
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
      risk: "very-low",
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
      { key: "immediate", label: "Immediate", pct: 25 },
      { key: "over-seven-days", label: "> 7 days", pct: 30 },
      { key: "unknown", label: "Unknown", pct: 45 },
    ]);
    expect(summary!.unknownHorizonPct).toBe(45);
    expect(summary!.liquidWithinOneDayPct).toBe(25);
    expect(summary!.lede).toContain("at least 25% convertible within one day; 45% has no published exit timeline.");
  });

  it("leads with the disclosure gap, not a 0% figure, when no horizon is published at all", () => {
    const summary = projectReserveQualityClientSummary(
      coinWith(
        [{ name: "Undisclosed reserve basket", pct: 100, risk: "high", assetClass: "other", liquidityHorizon: "unknown" }],
        { knownUnknownExposurePct: 100 },
      ),
    );
    expect(summary!.unknownHorizonPct).toBe(100);
    expect(summary!.liquidWithinOneDayPct).toBe(0);
    expect(summary!.lede).not.toContain("0% convertible");
  });

  it("states a known-negative convertibility only for the disclosed part of a partly opaque basket", () => {
    const summary = projectReserveQualityClientSummary(
      coinWith([
        { name: "Private credit fund", pct: 40, risk: "high", assetClass: "private-credit" },
        { name: "Tokenized notes", pct: 60, risk: "medium", assetClass: "tokenized-security", liquidityHorizon: "over-seven-days" },
      ]),
    );
    expect(summary!.lede).toBe(
      "2 reviewed reserve slices — none of the disclosed basket converts within one day; 40% has no published exit timeline.",
    );
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

  it.each([[40, "Opaque exit"], [39.9, "Mixed liquidity"]] as const)("classifies %s percent unknown at the opacity boundary", (unknown, label) => {
    const summary = projectReserveQualityClientSummary(
      coinWith([
        { name: "Cash", pct: 59, risk: "very-low", assetClass: "cash", liquidityHorizon: "immediate" },
        { name: "Undisclosed holdings", pct: unknown, risk: "high", assetClass: "other", liquidityHorizon: "unknown" },
        { name: "Private credit", pct: 41 - unknown, risk: "high", assetClass: "private-credit", liquidityHorizon: "over-seven-days" },
      ]),
    );
    expect(summary!.chipLabel).toBe(label);
    expect(summary!.chipToneClass).toContain("amber");
  });

  it("prefers liquid coverage when both liquidity and opacity thresholds are met", () => {
    const summary = projectReserveQualityClientSummary(coinWith([
      { name: "Cash", pct: 60, risk: "very-low", assetClass: "cash", liquidityHorizon: "immediate" },
      { name: "Unknown", pct: 40, risk: "high", assetClass: "other", liquidityHorizon: "unknown" },
    ]));
    expect(summary!.chipLabel).toBe("Mostly liquid");
  });

  it("surfaces a medium-risk top slice exactly at the concentration floor", () => {
    const summary = projectReserveQualityClientSummary(coinWith([
      { name: "Credit", pct: 20, risk: "medium", assetClass: "private-credit", liquidityHorizon: "over-seven-days" },
      ...Array.from({ length: 5 }, (_, index) => ({ name: `Cash ${index}`, pct: 16, risk: "very-low", assetClass: "cash", liquidityHorizon: "immediate" })),
    ]));
    expect(summary).toMatchObject({ topPositionName: "Credit", topPositionPct: 20 });
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
