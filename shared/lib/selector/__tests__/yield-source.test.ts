import { describe, expect, it } from "vitest";
import { selectYieldSource } from "../yield-source";
import type { MergedRow, YieldSourceCandidate } from "../types";
import { buildFixtureData, makeInput } from "./fixture";

/**
 * `selector-v2.0` deleted the weighted venue formula that used to rank rails
 * (venue 0.35 / risk 0.25 / depth 0.20 / freshness 0.15 / excess APY 0.05).
 * Selection is now a lexicographic ordering over the user's venue answer and
 * the yield domain's published readings, so these tests pin the precedence
 * rather than a blended number.
 *
 * This supersedes the audit Q-072 regression, which existed to keep the
 * deleted formula's APY term measured against the per-coin benchmark. The
 * Selector no longer prices APY at all — the Pharos Yield Score does.
 */
describe("selectYieldSource ordering", () => {
  const base = buildFixtureData().rows.get("usds-sky")!;

  const candidate = (
    sourceKey: string,
    overrides: Partial<YieldSourceCandidate> = {},
  ): YieldSourceCandidate => ({
    sourceKey,
    protocol: sourceKey,
    chain: "Ethereum",
    yieldType: "lending-vault",
    apy30d: 5,
    pharosYieldScore: 80,
    sourceTvlUsd: 100_000_000,
    dataSource: "test",
    sourceRiskScore: 20,
    venueRiskTier: "low",
    deploymentPlace: "lending",
    sourceDepthRatio: 0.8,
    sourceSwitchCount30d: 0,
    observationCount30d: 30,
    freshness: { capturedAt: 1_700_000_000, ageSeconds: 120 },
    ...overrides,
  }) as YieldSourceCandidate;

  const makeRow = (sources: YieldSourceCandidate[]): MergedRow => ({
    ...base,
    yieldSources: sources,
  });

  const lendInput = makeInput({ profile: "yield", venuePreferences: ["lend"] });

  it("published source risk decides between rails, not APY", () => {
    const selected = selectYieldSource(
      makeRow([
        candidate("safer-low-apy", { apy30d: 2.5, sourceRiskScore: 15 }),
        candidate("riskier-high-apy", { apy30d: 40, sourceRiskScore: 20 }),
      ]),
      lendInput,
    );
    expect(selected?.sourceKey).toBe("safer-low-apy");
  });

  it("the user's venue answer outranks every published reading", () => {
    const selected = selectYieldSource(
      makeRow([
        candidate("dex-rail", {
          yieldType: "lp-receipt",
          deploymentPlace: "lp",
          sourceRiskScore: 1,
          sourceDepthRatio: 1,
        }),
        candidate("lending-rail", { sourceRiskScore: 60, sourceDepthRatio: 0.1 }),
      ]),
      lendInput,
    );
    expect(selected?.sourceKey).toBe("lending-rail");
    expect(selected?.selectionReason).toBe("venue-preference");
  });

  it("falls through risk to depth, then freshness, then source key", () => {
    const byDepth = selectYieldSource(
      makeRow([
        candidate("thin", { sourceDepthRatio: 0.2 }),
        candidate("deep", { sourceDepthRatio: 0.9 }),
      ]),
      lendInput,
    );
    expect(byDepth?.sourceKey).toBe("deep");

    const byFreshness = selectYieldSource(
      makeRow([
        candidate("stale", { freshness: { capturedAt: 1, ageSeconds: 100_000 } }),
        candidate("fresh", { freshness: { capturedAt: 1, ageSeconds: 60 } }),
      ]),
      lendInput,
    );
    expect(byFreshness?.sourceKey).toBe("fresh");

    const byKey = selectYieldSource(
      makeRow([candidate("bbb"), candidate("aaa")]),
      lendInput,
    );
    expect(byKey?.sourceKey).toBe("aaa");
  });

  it("falls back to the published venue risk tier when no source-risk score exists", () => {
    const selected = selectYieldSource(
      makeRow([
        candidate("high-tier", { sourceRiskScore: null, venueRiskTier: "high" }),
        candidate("low-tier", { sourceRiskScore: null, venueRiskTier: "low" }),
      ]),
      lendInput,
    );
    expect(selected?.sourceKey).toBe("low-tier");
  });
});
