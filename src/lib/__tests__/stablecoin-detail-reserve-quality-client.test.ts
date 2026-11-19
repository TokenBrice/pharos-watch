import { describe, expect, it } from "vitest";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import type { ReserveReview } from "@shared/types/stablecoin-meta-primitives";
import type { ReserveSlice } from "@shared/types/reserves";
import type { StablecoinMeta } from "@shared/types/stablecoin-meta-schemas";
import {
  formatReserveQualityPct,
  projectReserveQualityClientSummary,
} from "../stablecoin-detail-reserve-quality-client";
import { projectReserveAdmissionClientSummary } from "../stablecoin-detail-reserve-admission-client";
import { describeReserveScoreAdmission } from "../reserve-score-admission";

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

describe("projectReserveQualityClientSummary", () => {
  it.each([
    [90, 0, "Highly liquid", "state-positive"],
    [89.96, 0, "Mostly liquid", ""],
    [60, 0, "Mostly liquid", "blue"],
    [60, 40, "Mostly liquid", ""],
    [59.96, 0, "Mixed liquidity", ""],
    [0, 39.96, "Mixed liquidity", ""],
  ])("classifies raw liquidity %s and unknown share %s before display rounding", (liquid, unknown, chip, tone) => {
    const summary = projectReserveQualityClientSummary(coinWith([
      { ...USDC_LIKE_SLICES[1], pct: liquid },
      { name: "Unknown", pct: unknown, risk: "high", assetClass: "other", liquidityHorizon: "unknown" },
      { name: "Locked", pct: 100 - liquid - unknown, risk: "medium", assetClass: "other", liquidityHorizon: "over-seven-days" },
    ]))!;
    expect(summary.chipLabel).toBe(chip);
    expect(summary.chipToneClass).toContain(tone);
    expect(summary.liquidWithinOneDayPct).toBe(liquid);
    expect(summary.unknownHorizonPct).toBe(unknown);
  });

  it("retains tiny known liquidity without asserting complete nondisclosure", () => {
    const summary = projectReserveQualityClientSummary(coinWith([
      { ...USDC_LIKE_SLICES[1], pct: 0.04 },
      { name: "Unknown", pct: 99.96, risk: "high", assetClass: "other", liquidityHorizon: "unknown" },
    ]))!;
    expect(summary.ladder[0].pct).toBe(0.04);
    expect(formatReserveQualityPct(summary.ladder[0].pct)).toBe("<0.1%");
    expect(summary.lede).toContain("at least <0.1%");
    expect(summary.lede).not.toContain("for any of the basket");
  });
  it.each(["selected-slices", "classification-only", "dependency-relationships"] as const)(
    "preserves contextual 100-total slices without whole-basket quality claims (%s)",
    (scope) => {
      const summary = projectReserveQualityClientSummary(coinWith(USDC_LIKE_SLICES, { ...USDC_LIKE_REVIEW, scope }))!;
      expect(summary.evidenceBasis).toBe("contextual");
      expect(summary.slices).toHaveLength(2);
      expect(summary.liquidWithinOneDayPct).toBeNull();
      expect(summary.unknownHorizonPct).toBeNull();
      expect(summary.unidentifiedObligorsPct).toBeNull();
      expect(summary.ladder).toEqual([]);
      expect(summary.lede).not.toContain("100% convertible");
      expect(summary.chipLabel).not.toBe("Highly liquid");
      expect(summary.compositionBasis).toBe(USDC_LIKE_REVIEW.compositionBasis);
    },
  );
  it("retains the legacy reviewless curated-book quality contract", () => {
    expect(projectReserveQualityClientSummary(coinWith(USDC_LIKE_SLICES))).toMatchObject({
      evidenceBasis: "legacy-curated", populationId: "test-coin", liquidWithinOneDayPct: 100, chipLabel: "Highly liquid",
    });
  });
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

  it("keeps a near-whole share short of 100% at display precision", () => {
    expect(formatReserveQualityPct(99.99757415980419)).toBe(">99.9%");
    expect(formatReserveQualityPct(99.96)).toBe(">99.9%");
    expect(formatReserveQualityPct(100)).toBe("100%");
  });

  it.each([
    [99.99999962097924, 3.790207601143955e-7],
    [0.0067, 99.9933],
    [0.005757310118, 99.994242689881],
    [3.651e-8, 99.99999996349],
    [9.352639691815362e-15, 99.99999999999999],
  ])("bounds a rounded-to-whole share beside a positive opposite share (%s / %s)", (liquid, unknown) => {
    const summary = projectReserveQualityClientSummary(
      coinWith([
        { name: "Liquid", pct: liquid, risk: "very-low", assetClass: "cash", liquidityHorizon: "immediate" },
        { name: "Untimed", pct: unknown, risk: "high", assetClass: "other", liquidityHorizon: "unknown" },
        { name: "Rest", pct: 100 - liquid - unknown, risk: "medium", assetClass: "other", liquidityHorizon: "over-seven-days" },
      ]),
    )!;
    expect(summary.lede).not.toContain("100%");
    expect(summary.lede).not.toContain("at least >");
    expect(summary.lede).not.toContain("≥ >");
  });

  it("ignores float-summation dust at the full-basket boundary", () => {
    const wholeLiquid = projectReserveQualityClientSummary(coinWith([
      { name: "Cash", pct: 24.3, risk: "very-low", assetClass: "cash", liquidityHorizon: "immediate" },
      { name: "T-bills", pct: 64.6, risk: "very-low", assetClass: "treasury-bill", liquidityHorizon: "one-day" },
      { name: "Deposits", pct: 11.1, risk: "low", assetClass: "bank-deposit", liquidityHorizon: "one-day" },
    ]))!;
    expect(wholeLiquid.liquidWithinOneDayPct).toBe(100);
    expect(wholeLiquid.lede).toBe("3 reviewed reserve slices — 100% convertible within one day.");
    expect(wholeLiquid.chipLabel).toBe("Highly liquid");

    const wholeUnknown = projectReserveQualityClientSummary(coinWith([
      { name: "Cash", pct: 24.3, risk: "very-low", assetClass: "cash", liquidityHorizon: "unknown" },
      { name: "T-bills", pct: 64.6, risk: "very-low", assetClass: "treasury-bill", liquidityHorizon: "unknown" },
      { name: "Deposits", pct: 11.1, risk: "low", assetClass: "bank-deposit", liquidityHorizon: "unknown" },
    ]))!;
    expect(wholeUnknown.unknownHorizonPct).toBe(100);
    expect(wholeUnknown.lede).toBe("3 reviewed reserve slices — no published exit timeline for any of the basket.");
  });



  it("projects only review provenance when a full-composition review misses one quality dimension", () => {
    const summary = projectReserveQualityClientSummary(
      coinWith([{ name: "Cash", pct: 100, risk: "very-low", assetClass: "cash" }], USDC_LIKE_REVIEW),
    )!;
    expect(summary.evidenceBasis).toBe("provenance-only");
    expect(summary.chipLabel).toBeNull();
    expect(summary.lede).toBeNull();
    expect(summary.ladder).toEqual([]);
    expect(summary.liquidWithinOneDayPct).toBeNull();
    expect(summary.unknownHorizonPct).toBeNull();
    expect(summary.unidentifiedObligorsPct).toBeNull();
    expect(summary.slices).toEqual([]);
    expect(summary.reviewedAt).toBe("2026-07-18");
    expect(summary.asOf).toBe("2026-06-30");
    expect(summary.confidenceLabel).toBe("Verified");
    expect(summary.compositionBasis).toBe("Monthly attestation composition table.");
    expect(summary.knownUnknownExposureNote).toBe("No undisclosed obligors in the attested basket.");
    expect(summary.sources).toEqual([{ label: "Circle reserve report", url: "https://example.com/reserves" }]);
  });

  it.each([
    ["usde-ethena", "Verified"],
    ["usdon-ondo", "Probable"],
  ])(
    "projects provenance only for the reviewed full-composition book %s",
    (id, confidenceLabel) => {
      const coin = TRACKED_META_BY_ID.get(id)!;
      const review = coin.reserveReview!;
      const summary = projectReserveQualityClientSummary(coin)!;
      expect(summary.evidenceBasis).toBe("provenance-only");
      expect(summary.chipLabel).toBeNull();
      expect(summary.lede).toBeNull();
      expect(summary.ladder).toEqual([]);
      expect(summary.sliceCount).toBe(coin.reserves!.length);
      expect(summary.reviewedAt).toBe(review.reviewedAt);
      expect(summary.asOf).toBe(review.compositionAsOf ?? null);
      expect(summary.confidenceLabel).toBe(confidenceLabel);
      expect(summary.compositionBasis).toBe(review.compositionBasis);
      expect(summary.knownUnknownExposureNote).toBe(review.knownUnknownExposure);
      expect(summary.sources).toEqual(review.sources);
    },
  );

  it.each([undefined, [], [{ name: "Cash", pct: 100, risk: "very-low", liquidityHorizon: "immediate" }], [{ name: "Cash", pct: 100, risk: "very-low", assetClass: "cash" }]])(
    "returns null without reserves or with one quality dimension uncurated (%#)",
    (reserves) => expect(projectReserveQualityClientSummary(coinWith(reserves))).toBeNull(),
  );


  it("projects the ladder, review aggregates, and slice detail", () => {
    const summary = projectReserveQualityClientSummary(coinWith(USDC_LIKE_SLICES, USDC_LIKE_REVIEW));
    expect(summary).not.toBeNull();
    expect(summary!.evidenceBasis).toBe("full-composition");
    expect(summary!.populationId).toBe("test-coin");
    expect(summary!.chipLabel).toBe("Highly liquid");
    expect(summary!.chipToneClass).toContain("state-positive");
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



  it.each([[40, "Opaque exit"], [39.9, "Mixed liquidity"]] as const)("classifies %s percent unknown at the opacity boundary", (unknown, label) => {
    const summary = projectReserveQualityClientSummary(
      coinWith([
        { name: "Cash", pct: 59, risk: "very-low", assetClass: "cash", liquidityHorizon: "immediate" },
        { name: "Undisclosed holdings", pct: unknown, risk: "high", assetClass: "other", liquidityHorizon: "unknown" },
        { name: "Private credit", pct: 41 - unknown, risk: "high", assetClass: "private-credit", liquidityHorizon: "over-seven-days" },
      ]),
    );
    expect(summary!.chipLabel).toBe(label);
    expect(summary!.chipToneClass).toContain("state-warn");
  });


  it.each([
    [[{ name: "Credit", pct: 20, risk: "medium", assetClass: "private-credit", liquidityHorizon: "over-seven-days" }, ...Array.from({ length: 5 }, (_, index) => ({ name: `Cash ${index}`, pct: 16, risk: "very-low", assetClass: "cash", liquidityHorizon: "immediate" }))], "Credit", 20],
    [[{ name: "Hedged basis book", pct: 62.44, risk: "high", assetClass: "hedged-crypto", liquidityHorizon: "seven-days" }, { name: "Cash", pct: 37.56, risk: "very-low", assetClass: "cash", liquidityHorizon: "immediate" }], "Hedged basis book", 62.4],
  ])("surfaces a medium-or-worse top slice at or above the concentration floor (%#)", (reserves, topPositionName, topPositionPct) => {
    expect(projectReserveQualityClientSummary(coinWith(reserves))).toMatchObject({ topPositionName, topPositionPct });
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
    expect(summary!.selfExposurePct).toBe(8.75);
    expect(summary!.unidentifiedObligorsPct).toBe(12.56);
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



  it("does not surface a top position below the 20% floor, with low risk or alone", () => {
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
    expect(projectReserveQualityClientSummary(coinWith(USDC_LIKE_SLICES))).toMatchObject({ topPositionName: null, topPositionPct: null });
    expect(projectReserveQualityClientSummary(coinWith([{ name: "Book", pct: 100, risk: "high", assetClass: "hedged-crypto", liquidityHorizon: "seven-days" }])))
      .toMatchObject({ topPositionName: null, topPositionPct: null, lede: expect.stringContaining("1 reviewed reserve slice —") });
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
});

describe("reserve score admission", () => {
  it("names what an unadmitted review misses, at the card clock", () => {
    const at = Date.parse("2026-06-30") / 1_000, day = 86_400;
    const card = (key: string) => ({ breakdowns: { backing: { components: [{ key }] } } }) as never, out = card("reserve:unclassified-residual");
    const review = (patch: object) => projectReserveAdmissionClientSummary(coinWith(USDC_LIKE_SLICES, { ...USDC_LIKE_REVIEW, ...patch }));
    expect(review({})).toMatchObject({ blockers: [], compositionAtSec: at, maxAgeSec: 38 * day });
    expect(describeReserveScoreAdmission(review({}), card("reserve:reserve:x"), at + 90 * day)).toBeNull();
    expect(describeReserveScoreAdmission(review({}), out, at + 38 * day)).toMatch(/did not pass its reserve admission checks\.$/);
    expect(describeReserveScoreAdmission(review({}), out, at + 51 * day)).toMatch(/within 38 days; this one is dated 2026-06-30, 51 days before scoring\.$/);
    expect(describeReserveScoreAdmission(review({ scope: "selected-slices", confidence: "manual-review", compositionAsOf: undefined }), out, at))
      .toMatch(/this one covers selected slices only, has manual review confidence and has no composition date\.$/);
  });
});
