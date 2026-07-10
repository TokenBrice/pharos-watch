import { describe, expect, it } from "vitest";
import { buildPublicDecisionLedger, deriveYieldSourceRole } from "../decision-public";
import type { EvaluatedYieldSource } from "../evaluation-types";
import type { YieldSourceRisk } from "@shared/types/yield";

/**
 * Audit Q-299: deriveRejectionReasonCode / deriveSelectedReasonCode produce the
 * bounded, enum-coded decision evidence on the public /api/yield-rankings
 * payload, and the module is deliberately kept independent from the frontend σ3
 * ladder. These tests pin the threshold constants (THINNER_RATIO 5, STALE_RATIO
 * 2, REWARDS_ONLY_SHARE 0.5, SMALLER_TVL_RATIO 5) and the selected-reason
 * precedence ladder so the wire-format contract cannot drift undetected.
 *
 * Both internal derivations are reached through the only public export,
 * buildPublicDecisionLedger: the selected reason via `selectedReasonCode` and
 * the rejection reason via the per-alternative `rejectionReasonCode`.
 */

function makeSourceRisk(overrides: Partial<YieldSourceRisk> = {}): YieldSourceRisk {
  return { sourceAgeSeconds: null, ...overrides } as YieldSourceRisk;
}

function makeSource(overrides: Partial<EvaluatedYieldSource> = {}): EvaluatedYieldSource {
  const base: EvaluatedYieldSource = {
    id: "coin",
    symbol: "COIN",
    sourceKey: "source-key",
    yieldSource: "Source",
    yieldType: "lending-opportunity",
    currentApy: 5,
    apyBase: 5,
    apyReward: 0,
    sourcePool: null,
    sourceTvlUsd: 1_000_000,
    sourceRisk: makeSourceRisk(),
    sourceRiskPenalty: 1,
    sourceRiskPenaltyReason: "provided",
    sourceRiskPenaltyProvided: false,
    sourceRiskAdjustedUtility: 0,
    dataSource: "defillama",
    exchangeRate: null,
    sourceObservedAt: null,
    comparisonAnchorObservedAt: null,
    apy7d: 5,
    apy30d: 5,
    apyVarianceScore: 0,
    stdDev30d: null,
    apyMin30d: null,
    apyMax30d: null,
    yieldStability: null,
    safetyScore: 80,
    safetyGrade: "A",
    safetyProvenance: "cached-publish",
    safetyReason: null,
    yieldToRisk: null,
    excessYield: 0,
    benchmarkKey: "USD",
    benchmarkLabel: "T-Bill 3M",
    benchmarkCurrency: "USD",
    benchmarkRate: 4,
    benchmarkRecordDate: null,
    benchmarkIsFallback: false,
    benchmarkFallbackMode: null,
    benchmarkSelectionMode: "native",
    benchmarkIsProxy: false,
    benchmarkMeta: {} as EvaluatedYieldSource["benchmarkMeta"],
    pharosYieldScore: 0,
    pysNullReason: null,
    sourceFreshness: "fresh",
    benchmarkFreshness: "healthy",
    scoreQualified: true,
    prevExchangeRate: null,
    prevTvlUsd: null,
    sourceDepthRatio: null,
    observationCount30d: null,
    sourceSwitchCount30d: null,
    anomalies: [],
    warnings: [],
    confidenceTier: "curated",
    rejected: false,
    usedLegacyHistory: false,
    usedDefaultSafety: false,
    previousBestSourceKey: null,
  };
  return { ...base, ...overrides };
}

function ledgerFor(selected: EvaluatedYieldSource, candidates: EvaluatedYieldSource[], rejectedCount = 0) {
  return buildPublicDecisionLedger({
    selected,
    candidates: [selected, ...candidates],
    rejectedCount,
    previousBestSourceKey: null,
    sourceSwitch: false,
    apy30dDeltaFromPrevious: null,
  });
}

describe("deriveRejectionReasonCode (via buildPublicDecisionLedger alternatives)", () => {
  const selected = makeSource({ sourceKey: "selected", confidenceTier: "curated" });

  it("codes 'thinner' when selected depth >= candidate depth * THINNER_RATIO (5)", () => {
    const candidate = makeSource({
      sourceKey: "alt",
      sourceDepthRatio: 1,
    });
    const sel = makeSource({ sourceKey: "selected", sourceDepthRatio: 5 });
    const ledger = ledgerFor(sel, [candidate]);
    expect(ledger.alternatives[0]?.rejectionReasonCode).toBe("thinner");
  });

  it("does not code 'thinner' just below the THINNER_RATIO threshold", () => {
    const candidate = makeSource({ sourceKey: "alt", sourceDepthRatio: 1 });
    const sel = makeSource({ sourceKey: "selected", sourceDepthRatio: 4.99 });
    const ledger = ledgerFor(sel, [candidate]);
    expect(ledger.alternatives[0]?.rejectionReasonCode).not.toBe("thinner");
  });

  it("codes 'stale' when candidate age >= selected age * STALE_RATIO (2)", () => {
    const candidate = makeSource({
      sourceKey: "alt",
      sourceRisk: makeSourceRisk({ sourceAgeSeconds: 200 }),
    });
    const sel = makeSource({
      sourceKey: "selected",
      sourceRisk: makeSourceRisk({ sourceAgeSeconds: 100 }),
    });
    const ledger = ledgerFor(sel, [candidate]);
    expect(ledger.alternatives[0]?.rejectionReasonCode).toBe("stale");
  });

  it("codes 'lower-confidence' when candidate confidence tier is below selected", () => {
    const candidate = makeSource({ sourceKey: "alt", confidenceTier: "fallback" });
    const ledger = ledgerFor(selected, [candidate]);
    expect(ledger.alternatives[0]?.rejectionReasonCode).toBe("lower-confidence");
  });

  it("codes 'rewards-only' when reward share exceeds REWARDS_ONLY_SHARE (0.5)", () => {
    const candidate = makeSource({
      sourceKey: "alt",
      currentApy: 10,
      apyReward: 6,
    });
    const ledger = ledgerFor(selected, [candidate]);
    expect(ledger.alternatives[0]?.rejectionReasonCode).toBe("rewards-only");
  });

  it("codes 'smaller' when selected TVL >= candidate TVL * SMALLER_TVL_RATIO (5)", () => {
    const candidate = makeSource({ sourceKey: "alt", sourceTvlUsd: 100_000 });
    const sel = makeSource({ sourceKey: "selected", sourceTvlUsd: 500_000 });
    const ledger = ledgerFor(sel, [candidate]);
    expect(ledger.alternatives[0]?.rejectionReasonCode).toBe("smaller");
  });

  it("codes 'unspecified' when no rejection heuristic applies", () => {
    const candidate = makeSource({ sourceKey: "alt" });
    const ledger = ledgerFor(selected, [candidate]);
    expect(ledger.alternatives[0]?.rejectionReasonCode).toBe("unspecified");
  });

  it("orders alternatives by absolute apy30d delta and caps at 2", () => {
    const sel = makeSource({ sourceKey: "selected", apy30d: 5 });
    const near = makeSource({ sourceKey: "near", yieldType: "lending-vault", apy30d: 6 });
    const far = makeSource({ sourceKey: "far", yieldType: "lending-vault", apy30d: 20 });
    const mid = makeSource({ sourceKey: "mid", yieldType: "lending-vault", apy30d: 10 });
    const ledger = ledgerFor(sel, [near, far, mid]);
    expect(ledger.alternatives).toHaveLength(2);
    expect(ledger.alternatives.map((a) => a.sourceKey)).toEqual(["far", "mid"]);
    expect(ledger.alternatives[0]).toMatchObject({
      confidenceTier: "curated",
      sourceRole: "audit-alternate",
      selectionRank: 3,
    });
  });
});

describe("deriveYieldSourceRole", () => {
  it("labels selected holder sources, retained holder alternates, fallback proxies, external opportunities, and degraded canonicals", () => {
    expect(deriveYieldSourceRole(makeSource({ yieldType: "lending-vault" }), { isSelected: true })).toBe(
      "canonical-holder",
    );
    expect(deriveYieldSourceRole(makeSource({ yieldType: "lending-vault" }), { isSelected: false })).toBe(
      "audit-alternate",
    );
    expect(
      deriveYieldSourceRole(
        makeSource({ dataSource: "price-derived", confidenceTier: "fallback" }),
        { isSelected: true },
      ),
    ).toBe("fallback-proxy");
    expect(deriveYieldSourceRole(makeSource({ yieldType: "fixed-yield" }), { isSelected: false })).toBe(
      "external-opportunity",
    );
    expect(
      deriveYieldSourceRole(
        makeSource({ yieldType: "lending-vault", anomalies: ["canonical-zero-vs-positive"] }),
        { isSelected: true },
      ),
    ).toBe("degraded-canonical");
  });
});

describe("deriveSelectedReasonCode precedence (via buildPublicDecisionLedger)", () => {
  it("codes 'no-alternatives' when there are no competitors", () => {
    const selected = makeSource({ sourceKey: "selected" });
    const ledger = ledgerFor(selected, []);
    expect(ledger.selectedReasonCode).toBe("no-alternatives");
  });

  it("codes 'deterministic-preferred' and outranks every other reason", () => {
    const selected = makeSource({ sourceKey: "selected", confidenceTier: "deterministic" });
    // Candidate is also discovered + lower confidence + tvl-only; deterministic wins.
    const candidate = makeSource({ sourceKey: "alt", confidenceTier: "discovered" });
    const ledger = ledgerFor(selected, [candidate], 1);
    expect(ledger.selectedReasonCode).toBe("deterministic-preferred");
  });

  it("codes 'curated-over-discovered' when curated selection has a discovered alternative", () => {
    const selected = makeSource({ sourceKey: "selected", confidenceTier: "curated" });
    const candidate = makeSource({ sourceKey: "alt", confidenceTier: "discovered" });
    const ledger = ledgerFor(selected, [candidate]);
    expect(ledger.selectedReasonCode).toBe("curated-over-discovered");
  });

  it("codes 'tier-preference' when a lower-confidence alternative exists but the curated-over-discovered rule does not match", () => {
    // Selected is discovered (not curated), alternative is fallback (lower).
    const selected = makeSource({ sourceKey: "selected", confidenceTier: "discovered" });
    const candidate = makeSource({ sourceKey: "alt", confidenceTier: "fallback" });
    const ledger = ledgerFor(selected, [candidate]);
    expect(ledger.selectedReasonCode).toBe("tier-preference");
  });

  it("codes 'tvl-floor' when an equal-tier alternative ties on apy30d but has lower TVL", () => {
    const selected = makeSource({
      sourceKey: "selected",
      confidenceTier: "curated",
      apy30d: 5,
      sourceTvlUsd: 1_000_000,
    });
    const candidate = makeSource({
      sourceKey: "alt",
      confidenceTier: "curated",
      apy30d: 5,
      sourceTvlUsd: 500_000,
    });
    const ledger = ledgerFor(selected, [candidate], 1);
    expect(ledger.selectedReasonCode).toBe("tvl-floor");
  });

  it("codes 'freshness-tiebreaker' when selection is fresher than an equal-tier alternative", () => {
    const selected = makeSource({
      sourceKey: "selected",
      confidenceTier: "curated",
      apy30d: 5,
      sourceTvlUsd: 1_000_000,
      sourceRisk: makeSourceRisk({ sourceAgeSeconds: 100 }),
    });
    const candidate = makeSource({
      sourceKey: "alt",
      confidenceTier: "curated",
      apy30d: 6, // differs, so the tvl-floor rule does not apply
      sourceTvlUsd: 1_000_000,
      sourceRisk: makeSourceRisk({ sourceAgeSeconds: 200 }),
    });
    const ledger = ledgerFor(selected, [candidate], 1);
    expect(ledger.selectedReasonCode).toBe("freshness-tiebreaker");
  });

  it("codes 'fallback' when a fallback selection has only equal-tier alternatives", () => {
    const selected = makeSource({ sourceKey: "selected", confidenceTier: "fallback" });
    const candidate = makeSource({ sourceKey: "alt", confidenceTier: "fallback" });
    const ledger = ledgerFor(selected, [candidate]);
    expect(ledger.selectedReasonCode).toBe("fallback");
  });

  it("codes 'best-by-confidence-and-apy' as the terminal fallthrough", () => {
    const selected = makeSource({ sourceKey: "selected", confidenceTier: "curated" });
    const candidate = makeSource({ sourceKey: "alt", confidenceTier: "curated" });
    const ledger = ledgerFor(selected, [candidate]);
    expect(ledger.selectedReasonCode).toBe("best-by-confidence-and-apy");
  });
});
