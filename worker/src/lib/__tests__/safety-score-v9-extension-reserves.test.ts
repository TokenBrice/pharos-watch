import { describe, expect, it } from "vitest";
import type { ReserveSlice } from "@shared/types/reserves";
import { evaluateV9FactSet } from "@shared/lib/safety-score-v9/evaluate-set";
import { V9_CANDIDATE_POLICY_V1 } from "@shared/lib/safety-score-v9/policy";
import {
  buildSafetyScoreV9BaselineExtension,
  buildReviewedReserveClassifications,
  buildSafetyScoreV9ReviewedCuratedFallbackReserveRows,
  buildSafetyScoreV9ReviewedStandaloneReserveRows,
  type V9ExtensionRegistryMeta,
} from "../safety-score-v9-extension";
import { compileSafetyScoreV9FactSetFromFixedInput } from "../safety-score-v9-fact-set";
import {
  buildSafetyScoreV9ReserveClassifications,
  dependencyReserveSlices,
} from "../safety-score-v9-extension-reserves";
import { makeV9TwoAssetFixedInput } from "../../test-helpers/v9-fixed-input";

const CLOCK_SEC = Date.UTC(2026, 6, 14) / 1_000;
const DEPENDENCY_CLOCK_SEC = Date.UTC(2026, 7, 20) / 1_000;

const LIVE_RESERVES_CONFIG: NonNullable<V9ExtensionRegistryMeta["liveReservesConfig"]> = {
  adapter: "curated-validated",
  version: 1,
  semantics: "collateral-mix",
  inputs: { primary: { kind: "onchain-solana" } },
};

const LINKED_RESERVES: ReserveSlice[] = [
  {
    name: "Beta stablecoin",
    pct: 50,
    risk: "low",
    coinId: "beta",
    depType: "collateral",
    assetClass: "stablecoin",
    issuerOrObligor: "asset:beta",
    riskFactors: ["counterparty"],
    liquidityHorizon: "immediate",
  },
  {
    name: "Custodied cash",
    pct: 50,
    risk: "very-low",
    assetClass: "cash",
    issuerOrObligor: "issuer:alpha",
    riskFactors: ["custody", "counterparty"],
    liquidityHorizon: "immediate",
    maturityDaysMax: 0,
  },
];

function dependencyMeta(reviewedAt: string): V9ExtensionRegistryMeta {
  return {
    id: "alpha",
    mechanismArchetype: "fiat-cash",
    launchDate: "2020-01-01",
    reserves: LINKED_RESERVES,
    liveReservesConfig: LIVE_RESERVES_CONFIG,
    reserveReview: {
      reviewedAt,
      reviewer: "fixture",
      confidence: "verified",
      sources: [{ label: "Reserve report", url: "https://example.com/reserves" }],
      rationale: "Fixture review",
      compositionBasis: "Fixture report",
      compositionAsOf: reviewedAt,
      scope: "full-composition",
      knownUnknownExposure: "None",
      knownUnknownExposurePct: 0,
    },
  };
}

function dependencyMetaById(reviewedAt: string): Map<string, V9ExtensionRegistryMeta> {
  return new Map([
    ["alpha", dependencyMeta(reviewedAt)],
    [
      "beta",
      {
        id: "beta",
        mechanismArchetype: "fiat-cash",
        launchDate: "2020-01-01",
      },
    ],
  ]);
}

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

describe("curated reserve dependency admission", () => {
  it("drops curated basket edges when the reserve review is expired", () => {
    const fixed = makeV9TwoAssetFixedInput({
      omitAlphaReserve: true,
      liveToFallbackCoins: ["alpha"],
      clockSec: DEPENDENCY_CLOCK_SEC,
    });
    const extension = buildSafetyScoreV9BaselineExtension(fixed, {
      metaById: dependencyMetaById("2026-01-01"),
    });
    const alpha = extension.assets.find((asset) => asset.assetId === "alpha")!;
    expect(alpha.dependencies).toMatchObject({
      source: "curated-reserve",
      diagnostics: { graphState: "valid", issueCodes: [] },
      edges: [],
    });

    const compiled = compileSafetyScoreV9FactSetFromFixedInput(fixed, extension);
    const compiledAlpha = compiled.assets.find((asset) => asset.assetId === "alpha")!;
    expect(compiledAlpha.reserveStatus.observationState).toBe("missing");
    expect(compiledAlpha.gaps).toContainEqual(
      expect.objectContaining({ reasonCode: "missing-reserve-composition" }),
    );
    expect(
      evaluateV9FactSet(compiled, V9_CANDIDATE_POLICY_V1)
        .assets.find((asset) => asset.assetId === "alpha")!
        .scoreInput.dependencyReasons.map((reason) => reason.code),
    ).not.toContain("unreviewed-dependency-relationships");
  });

  it("keeps curated basket edges when the review is admissible", () => {
    const fixed = makeV9TwoAssetFixedInput({
      omitAlphaReserve: true,
      liveToFallbackCoins: ["alpha"],
      clockSec: DEPENDENCY_CLOCK_SEC,
    });
    const extension = buildSafetyScoreV9BaselineExtension(fixed, {
      metaById: dependencyMetaById("2026-08-19"),
    });
    const alpha = extension.assets.find((asset) => asset.assetId === "alpha")!;
    expect(alpha.dependencies).toMatchObject({
      source: "curated-reserve",
      diagnostics: { graphState: "valid", issueCodes: [] },
      edges: [{ upstreamAssetId: "beta", dependencyType: "collateral", weight: 0.5 }],
    });

    const compiled = compileSafetyScoreV9FactSetFromFixedInput(fixed, extension);
    expect(
      evaluateV9FactSet(compiled, V9_CANDIDATE_POLICY_V1)
        .assets.find((asset) => asset.assetId === "alpha")!
        .scoreInput.dependencyReasons.map((reason) => reason.code),
    ).not.toContain("unreviewed-dependency-relationships");
  });

  it("leaves live-derived edges unchanged even when the curated review is expired", () => {
    const fixed = makeV9TwoAssetFixedInput({
      mapAlphaCollateral: true,
      clockSec: DEPENDENCY_CLOCK_SEC,
    });
    const extension = buildSafetyScoreV9BaselineExtension(fixed, {
      metaById: dependencyMetaById("2026-01-01"),
    });
    const alpha = extension.assets.find((asset) => asset.assetId === "alpha")!;
    expect(alpha.dependencies).toMatchObject({
      source: "live-reserve",
      diagnostics: { graphState: "valid", issueCodes: [] },
      edges: [{ upstreamAssetId: "beta", dependencyType: "collateral", weight: 0.5 }],
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

  it("matches legacy rows by unique name regardless of weight and rejects ambiguity or invalid review state", () => {
    const live = [{ name: "Cash", pct: 15, risk: "very-low" as const }];
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
      classificationKey: expect.stringMatching(/^registry-reviewed:/),
      assetClass: "bank-deposit",
      issuerOrObligorKey: "Reserve bank",
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

  it("keeps reviewed classifications joined across arbitrary live composition drift", () => {
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
    expect(grosslyDifferent.every((row) => row.classificationKey.startsWith("registry-reviewed:"))).toBe(true);
  });

  it("uses explicit source keys across label and weight changes and fails closed on key mismatch", () => {
    const reviewed = reviewedMeta([{
      sourceKey: "circle:usdc:treasuries-under-3m",
      name: "<3-Month U.S. Treasuries",
      pct: 71.9,
      risk: "very-low",
      assetClass: "treasury-bill",
      issuerOrObligor: "United States Treasury",
      coinId: "treasury-proxy",
    }]);
    const matchedLive: ReserveSlice[] = [{
      sourceKey: "circle:usdc:treasuries-under-3m",
      name: "Treasury securities under 93 days",
      pct: 12,
      risk: "very-low",
    }];

    expect(buildReviewedReserveClassifications(matchedLive, reviewed, CLOCK_SEC)[0]).toMatchObject({
      classificationKey: expect.stringMatching(/^registry-reviewed:/),
      assetClass: "treasury-bill",
      issuerOrObligorKey: "United States Treasury",
    });
    expect(dependencyReserveSlices(matchedLive, reviewed, CLOCK_SEC)[0]).toMatchObject({
      coinId: "treasury-proxy",
    });

    const mismatchedLive = [{
      ...matchedLive[0]!,
      sourceKey: "circle:usdc:different-slice",
      name: "<3-Month U.S. Treasuries",
    }];
    expect(buildReviewedReserveClassifications(mismatchedLive, reviewed, CLOCK_SEC)[0]).toMatchObject({
      classificationKey: expect.stringMatching(/^source-native:/),
      assetClass: null,
    });
    expect(dependencyReserveSlices(mismatchedLive, reviewed, CLOCK_SEC)[0]!.coinId).toBeUndefined();
  });

  it("rejects duplicate explicit source keys on either side", () => {
    const sourceKey = "fixture:alpha:cash";
    const reviewed = reviewedMeta([{
      sourceKey,
      name: "Cash",
      pct: 100,
      risk: "very-low",
      assetClass: "bank-deposit",
    }]);
    const duplicateLive = [
      { sourceKey, name: "Cash A", pct: 50, risk: "very-low" as const },
      { sourceKey, name: "Cash B", pct: 50, risk: "very-low" as const },
    ];
    expect(buildReviewedReserveClassifications(duplicateLive, reviewed, CLOCK_SEC)
      .every((row) => row.classificationKey.startsWith("source-native:"))).toBe(true);

    const duplicateReviewed = reviewedMeta([
      ...reviewed.reserves!,
      { ...reviewed.reserves![0]!, name: "Duplicate cash" },
    ]);
    expect(buildReviewedReserveClassifications([duplicateLive[0]!], duplicateReviewed, CLOCK_SEC)[0]).toMatchObject({
      classificationKey: expect.stringMatching(/^source-native:/),
    });
  });

  it("keeps the current USDC reserve repartition classified by stable source key", () => {
    const live: ReserveSlice[] = [
      { sourceKey: "circle:usdc:treasuries-under-3m", name: "<3-Month U.S. Treasuries", pct: 65.7, risk: "very-low" },
      { sourceKey: "circle:usdc:sifi-deposits", name: "Deposits at Systemically Important Institutions", pct: 18.6, risk: "very-low" },
      { sourceKey: "circle:usdc:other-bank-deposits", name: "Other Bank Deposits", pct: 14.1, risk: "very-low" },
      { sourceKey: "circle:usdc:overnight-reverse-treasury-repo", name: "Overnight Reverse Treasury Repo", pct: 1.6, risk: "very-low" },
    ];
    const reviewed = reviewedMeta([
      { ...live[0]!, pct: 71.93275, assetClass: "treasury-bill", issuerOrObligor: "United States Treasury" },
      { ...live[1]!, pct: 12.491316, assetClass: "bank-deposit", issuerOrObligor: "Systemically important financial institutions" },
      { ...live[2]!, pct: 13.852994, assetClass: "bank-deposit", issuerOrObligor: "Other regulated financial institutions" },
      { ...live[3]!, pct: 1.72294, assetClass: "repo", issuerOrObligor: "Leading global banks" },
    ]);

    expect(buildReviewedReserveClassifications(live, reviewed, CLOCK_SEC)
      .every((row) => row.classificationKey.startsWith("registry-reviewed:"))).toBe(true);
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
