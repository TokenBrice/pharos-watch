import { describe, expect, it } from "vitest";
import type { ReserveSlice } from "@shared/types/reserves";
import {
  buildReviewedReserveClassifications,
  buildSafetyScoreV9ReviewedCuratedFallbackReserveRows,
  buildSafetyScoreV9ReviewedStandaloneReserveRows,
  type V9ExtensionRegistryMeta,
} from "../safety-score-v9-extension";
import { buildSafetyScoreV9ReserveClassifications } from "../safety-score-v9-extension-reserves";

const CLOCK_SEC = Date.UTC(2026, 6, 14) / 1_000;

function reviewedMeta(
  reserves: ReserveSlice[],
  overrides: Partial<NonNullable<V9ExtensionRegistryMeta["reserveReview"]>> = {},
): V9ExtensionRegistryMeta {
  return {
    id: "alpha",
    reserves,
    reserveReview: {
      reviewedAt: "2026-07-13",
      reviewer: "fixture",
      confidence: "verified",
      sources: [{ label: "Reserve report", url: "https://example.com/reserves" }],
      rationale: "Fixture review",
      compositionBasis: "Fixture report",
      compositionAsOf: "2026-06-30",
      scope: "full-composition",
      knownUnknownExposure: "None",
      knownUnknownExposurePct: 0,
      ...overrides,
    },
  };
}

describe("reviewed curated reserve admission", () => {
  const opaqueRows: ReserveSlice[] = [
    { name: "Opaque basket", pct: 40, risk: "medium" },
    { name: "Treasury bills", pct: 60, risk: "very-low" },
  ];
  const unresolvedReview = {
    knownUnknownExposure: "Opaque basket constituents are not fully split.",
    knownUnknownExposurePct: 40,
    nonLinkDispositions: [
      {
        reserveIndex: 0,
        reserveName: "Opaque basket",
        pct: 40,
        disposition: "basket-needs-split" as const,
        rationale: "The basket weights are unresolved.",
      },
    ],
  };

  it("rejects unresolved known-unknown exposure on live fallback and standalone paths", () => {
    const fallbackMeta = reviewedMeta(opaqueRows, unresolvedReview);
    fallbackMeta.liveReservesConfig = {
      adapter: "curated-validated",
      version: 1,
      semantics: "collateral-mix",
      inputs: { primary: { kind: "onchain-solana" } },
    };

    expect(buildSafetyScoreV9ReviewedCuratedFallbackReserveRows(fallbackMeta, CLOCK_SEC)).toBeNull();
    expect(
      buildSafetyScoreV9ReviewedStandaloneReserveRows(reviewedMeta(opaqueRows, unresolvedReview), CLOCK_SEC),
    ).toBeNull();
  });

  it("admits complete current verified fallback and standalone reserve evidence", () => {
    const rows = [{ name: "Treasury bills", pct: 100, risk: "very-low" as const }];
    const fallbackMeta = reviewedMeta(rows);
    fallbackMeta.liveReservesConfig = {
      adapter: "curated-validated",
      version: 1,
      semantics: "collateral-mix",
      inputs: { primary: { kind: "onchain-solana" } },
    };

    expect(buildSafetyScoreV9ReviewedCuratedFallbackReserveRows(fallbackMeta, CLOCK_SEC)).toMatchObject({
      evidenceClass: "static-validated",
      provenance: "curated-fallback",
      rows,
    });
    expect(buildSafetyScoreV9ReviewedStandaloneReserveRows(reviewedMeta(rows), CLOCK_SEC)).toMatchObject({
      evidenceClass: "static-validated",
      provenance: "curated",
      rows,
    });
  });
});

describe("buildReviewedReserveClassifications", () => {
  it("classifies exact tracked-asset slices without guessing from vague labels", () => {
    const classifications = buildSafetyScoreV9ReserveClassifications([
      { name: "Parent shares", pct: 80, risk: "low", coinId: "parent-stablecoin", depType: "wrapper" },
      { name: "Solana", pct: 20, risk: "medium" },
    ]);

    expect(classifications).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          assetClass: "stablecoin",
          issuerOrObligorKey: "asset:parent-stablecoin",
          failureDomains: [{ kind: "reserve-issuer", key: "asset:parent-stablecoin" }],
        }),
        expect.objectContaining({
          assetClass: null,
          issuerOrObligorKey: null,
          failureDomains: [],
        }),
      ]),
    );
  });

  it("fills missing live classification fields from one normalized name and rounded weight match", () => {
    const classifications = buildReviewedReserveClassifications(
      [{ name: "U.S. Treasury Bills", pct: 61.2, risk: "very-low" }],
      reviewedMeta([
        {
          name: "US Treasury bills",
          pct: 61.03,
          risk: "very-low",
          assetClass: "treasury-bill",
          issuerOrObligor: "United States Treasury",
          riskFactors: ["duration", "liquidity", "custody"],
          liquidityHorizon: "one-day",
          maturityDaysMax: 90,
        },
      ]),
      CLOCK_SEC,
    );

    expect(classifications).toHaveLength(1);
    expect(classifications[0]).toMatchObject({
      assetClass: "treasury-bill",
      issuerOrObligorKey: "United States Treasury",
      riskFactors: ["custody", "duration", "liquidity"],
      liquidityHorizon: "one-day",
      maturityDaysMax: 90,
      failureDomains: [{ kind: "reserve-issuer", key: "United States Treasury" }],
    });
    expect(classifications[0]!.classificationKey).toMatch(/^registry-reviewed:reserve:/);
  });

  it("leaves mismatched, ambiguous, and unreviewed live rows source-native", () => {
    const live = [{ name: "Cash", pct: 15, risk: "very-low" as const }];
    // 22 vs 15 sits beyond the 5pp drift tolerance, so the weight mismatch
    // is gross rather than normal rebalancing and the join must fail.
    const structuredCash: ReserveSlice = {
      name: "Cash",
      pct: 22,
      risk: "very-low",
      assetClass: "bank-deposit",
      issuerOrObligor: "Reserve bank",
      riskFactors: ["counterparty", "custody"],
      liquidityHorizon: "immediate",
    };
    expect(buildReviewedReserveClassifications(live, reviewedMeta([structuredCash]), CLOCK_SEC)[0]).toMatchObject({
      classificationKey: expect.stringMatching(/^source-native:/),
      assetClass: null,
      issuerOrObligorKey: null,
    });

    const ambiguous = reviewedMeta([
      { ...structuredCash, pct: 14.8 },
      { ...structuredCash, pct: 15.2 },
    ]);
    expect(buildReviewedReserveClassifications(live, ambiguous, CLOCK_SEC)[0]).toMatchObject({
      classificationKey: expect.stringMatching(/^source-native:/),
      assetClass: null,
    });

    const unknownReview = reviewedMeta([{ ...structuredCash, pct: 15 }], { confidence: "unknown" });
    expect(buildReviewedReserveClassifications(live, unknownReview, CLOCK_SEC)[0]).toMatchObject({
      classificationKey: expect.stringMatching(/^source-native:/),
      assetClass: null,
    });

    const futureReview = reviewedMeta([{ ...structuredCash, pct: 15 }], { reviewedAt: "2026-07-15" });
    expect(buildReviewedReserveClassifications(live, futureReview, CLOCK_SEC)[0]).toMatchObject({
      classificationKey: expect.stringMatching(/^source-native:/),
      assetClass: null,
    });

    const futureComposition = reviewedMeta([{ ...structuredCash, pct: 15 }], { compositionAsOf: "2026-07-15" });
    expect(buildReviewedReserveClassifications(live, futureComposition, CLOCK_SEC)[0]).toMatchObject({
      classificationKey: expect.stringMatching(/^source-native:/),
      assetClass: null,
    });
  });

  it("matches only the exact Bitcoin identity in the current USDT live/reviewed shapes", () => {
    const live: ReserveSlice[] = [
      { name: "Direct & indirect U.S. Treasury Bills", pct: 73.5, risk: "very-low" },
      {
        name: "Other reserves (cash & equivalents, secured loans, corporate bonds, other investments)",
        pct: 12.4,
        risk: "medium",
      },
      { name: "Physical gold bars", pct: 10.4, risk: "very-low" },
      { name: "Bitcoin", pct: 3.7, risk: "medium" },
    ];
    const reviewed: ReserveSlice[] = [
      {
        name: "U.S. Treasury bills",
        pct: 61.03,
        risk: "very-low",
        assetClass: "treasury-bill",
        issuerOrObligor: "United States Treasury",
        riskFactors: ["duration", "liquidity", "custody"],
        liquidityHorizon: "one-day",
      },
      {
        name: "Precious metals",
        pct: 10.34,
        risk: "medium",
        assetClass: "other",
        issuerOrObligor: "Physical gold inventory",
        riskFactors: ["market", "custody", "liquidity"],
        liquidityHorizon: "seven-days",
      },
      {
        name: "Bitcoin",
        pct: 3.45,
        risk: "high",
        assetClass: "cryptoasset",
        riskFactors: ["market", "custody", "liquidity"],
        liquidityHorizon: "seven-days",
      },
    ];

    const classifications = buildReviewedReserveClassifications(live, reviewedMeta(reviewed), CLOCK_SEC);
    expect(classifications.filter((row) => row.classificationKey.startsWith("registry-reviewed:"))).toHaveLength(1);
    expect(classifications.find((row) => row.assetClass === "cryptoasset")).toMatchObject({
      issuerOrObligorKey: null,
      riskFactors: ["custody", "liquidity", "market"],
      liquidityHorizon: "seven-days",
    });
  });

  it("keeps reviewed classifications joined across normal live composition drift", () => {
    // 2026-07-18 regression: Circle's T-bill share moved 2.0pp in two days,
    // which severed every USDC classification under the old 0.5pp bound and
    // collapsed backing. Identity is the bijective name match; weight drift
    // within 5pp must not destroy the slice's class.
    const reviewed = reviewedMeta([
      {
        name: "<3-Month U.S. Treasuries",
        pct: 73.7,
        risk: "very-low",
        assetClass: "treasury-bill",
        issuerOrObligor: "United States Treasury",
      },
      {
        name: "Other Bank Deposits",
        pct: 14.8,
        risk: "very-low",
        assetClass: "bank-deposit",
        issuerOrObligor: "Other regulated financial institutions",
      },
    ]);
    const drifted = buildReviewedReserveClassifications(
      [
        { name: "<3-Month U.S. Treasuries", pct: 71.7, risk: "very-low" },
        { name: "Other Bank Deposits", pct: 15.9, risk: "very-low" },
      ],
      reviewed,
      CLOCK_SEC,
    );
    expect(drifted.every((row) => !row.classificationKey.startsWith("source-native:"))).toBe(true);

    const grosslyDifferent = buildReviewedReserveClassifications(
      [{ name: "<3-Month U.S. Treasuries", pct: 62, risk: "very-low" }],
      reviewed,
      CLOCK_SEC,
    );
    expect(grosslyDifferent.every((row) => row.classificationKey.startsWith("source-native:"))).toBe(true);
  });

  it("rejects the current USDC repartition and USD1 aggregate basket as non-identical", () => {
    const usdc = buildReviewedReserveClassifications(
      [
        { name: "<3-Month U.S. Treasuries", pct: 73.7, risk: "very-low" },
        { name: "Other Bank Deposits", pct: 14.8, risk: "very-low" },
        { name: "Deposits at Systemically Important Institutions", pct: 10.2, risk: "very-low" },
        { name: "Overnight Reverse Treasury Repo", pct: 1.3, risk: "very-low" },
      ],
      reviewedMeta([
        {
          name: "U.S. Treasury securities",
          pct: 29.04,
          risk: "very-low",
          assetClass: "treasury-bill",
          issuerOrObligor: "United States Treasury",
        },
        {
          name: "Overnight U.S. Treasury repurchase agreements",
          pct: 59.46,
          risk: "very-low",
          assetClass: "repo",
          issuerOrObligor: "Global financial institutions",
        },
        {
          name: "Cash and net settlement balances",
          pct: 11.5,
          risk: "very-low",
          assetClass: "bank-deposit",
          issuerOrObligor: "Regulated financial institutions",
        },
      ]),
      CLOCK_SEC,
    );
    expect(usdc.every((row) => row.classificationKey.startsWith("source-native:"))).toBe(true);

    const usd1 = buildReviewedReserveClassifications(
      [{ name: "U.S. Treasury Bills, Money Market Funds & Cash", pct: 100, risk: "very-low" }],
      reviewedMeta([
        {
          name: "Fidelity Government Portfolio (FRGXX)",
          pct: 85,
          risk: "low",
          assetClass: "money-market-fund",
          issuerOrObligor: "Fidelity Investments Money Market Government Portfolio",
        },
        {
          name: "Cash and cash equivalents in demand deposit accounts",
          pct: 15,
          risk: "very-low",
          assetClass: "bank-deposit",
          issuerOrObligor: "U.S. commercial banks",
        },
      ]),
      CLOCK_SEC,
    );
    expect(usd1[0]).toMatchObject({
      classificationKey: expect.stringMatching(/^source-native:/),
      assetClass: null,
      issuerOrObligorKey: null,
    });
  });
});
