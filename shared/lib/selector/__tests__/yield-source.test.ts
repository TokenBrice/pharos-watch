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
        candidate("safer-low-apy", {
          apy30d: 2.5, sourceRiskScore: 15, sourceDepthRatio: 0.1,
          freshness: { capturedAt: 1, ageSeconds: 172_800 },
        }),
        candidate("riskier-high-apy", {
          apy30d: 40, sourceRiskScore: 20, sourceDepthRatio: 1,
          freshness: { capturedAt: 1, ageSeconds: 0 },
        }),
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
        candidate("thin", { sourceDepthRatio: 0.2, freshness: { capturedAt: 1, ageSeconds: 0 } }),
        candidate("deep", { sourceDepthRatio: 0.9, freshness: { capturedAt: 1, ageSeconds: 172_800 } }),
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

  it("uses the complete row fallback only when all required fields exist", () => {
    const row = {
      ...makeRow([]), yieldProtocolSlug: "fallback", yieldVenueChain: "Ethereum",
      apy30d: 4, pharosYieldScore: 70, effectiveTvlUsd: 123_000,
      venueRiskTier: "low" as const, deploymentPlace: "lending" as const,
      yieldFreshness: { capturedAt: 123, ageSeconds: 45 },
    };
    const expected = {
      sourceKey: "fallback:Ethereum", protocol: "fallback", chain: "Ethereum",
      yieldType: null, apy30d: 4, pharosYieldScore: 70, sourceTvlUsd: 123_000,
      sourceRiskTier: "low", freshness: { capturedAt: 123, ageSeconds: 45 },
      selectionReason: "venue-preference",
    };
    expect(selectYieldSource(row, lendInput)).toEqual(expected);
    expect(selectYieldSource({ ...row, yieldSources: undefined }, lendInput)).toEqual(expected);
    for (const field of ["yieldProtocolSlug", "yieldVenueChain", "apy30d", "pharosYieldScore"] as const) {
      expect(selectYieldSource({ ...row, [field]: null }, lendInput)).toBeNull();
    }
  });

  it("fails closed when the winning rail has no chain rather than substituting a runner-up", () => {
    const row = makeRow([
      candidate("winner", { chain: null, sourceRiskScore: 1 }),
      candidate("runner-up", { sourceRiskScore: 50 }),
    ]);
    expect(selectYieldSource(row, lendInput)).toBeNull();
    expect(selectYieldSource(makeRow([
      candidate("winner", { sourceRiskScore: 1 }),
      candidate("runner-up", { sourceRiskScore: 50 }),
    ]), lendInput)?.sourceKey).toBe("winner");
  });

  it("prefers wrapper rails only for wrap, not all or unsupported venue answers", () => {
    const row = makeRow([
      candidate("lending", { sourceRiskScore: 1 }),
      candidate("wrapper", {
        yieldType: "nav-appreciation", deploymentPlace: "native-wrapper", sourceRiskScore: 50,
      }),
    ]);
    expect(selectYieldSource(row, makeInput({ profile: "yield", venuePreferences: ["wrap"] }))?.sourceKey)
      .toBe("wrapper");
    for (const venuePreferences of [["all"], ["cex"]] as const) {
      expect(selectYieldSource(row, makeInput({
        profile: "yield", venuePreferences: [...venuePreferences],
      }))?.sourceKey).toBe("lending");
    }
  });

  it("uses TVL without depth ratios and ranks unknown freshness above known stale data", () => {
    expect(selectYieldSource(makeRow([
      candidate("small", { sourceDepthRatio: null, sourceTvlUsd: 1_000 }),
      candidate("large", { sourceDepthRatio: null, sourceTvlUsd: 100_000_000 }),
    ]), lendInput)?.sourceKey).toBe("large");
    expect(selectYieldSource(makeRow([
      candidate("stale", { freshness: { capturedAt: 1, ageSeconds: 172_800 } }),
      candidate("unknown", { freshness: null }),
    ]), lendInput)?.sourceKey).toBe("unknown");
  });

  it("publishes unknown rail freshness as null instead of a fabricated 0s capture", () => {
    const selected = selectYieldSource(makeRow([
      candidate("stale", { freshness: { capturedAt: 1, ageSeconds: 172_800 } }),
      candidate("unknown", { freshness: null }),
    ]), lendInput);
    expect(selected?.sourceKey).toBe("unknown");
    // The engine still ranks unknown above stale (neutral 50 > 0), but the
    // returned reading must stay unknown: `{ capturedAt: 0, ageSeconds: 0 }`
    // rendered as "0s old" — the freshest possible claim from no data.
    expect(selected?.freshness).toBeNull();
  });

  it("ranks future-dated and nonfinite freshness below every valid reading", () => {
    for (const ageSeconds of [-1, -172_800, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(selectYieldSource(makeRow([
        candidate("unusable", { freshness: { capturedAt: 1, ageSeconds } }),
        candidate("fresh", { freshness: { capturedAt: 1, ageSeconds: 60 } }),
      ]), lendInput)?.sourceKey, `fresh vs ${ageSeconds}`).toBe("fresh");
      expect(selectYieldSource(makeRow([
        candidate("unusable", { freshness: { capturedAt: 1, ageSeconds } }),
        candidate("stale", { freshness: { capturedAt: 1, ageSeconds: 100_000 } }),
      ]), lendInput)?.sourceKey, `stale vs ${ageSeconds}`).toBe("stale");
    }
  });
});
