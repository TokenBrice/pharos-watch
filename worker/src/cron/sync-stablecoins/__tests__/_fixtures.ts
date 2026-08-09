/**
 * Shared fixture builders for the `sync-stablecoins` test family.
 *
 * Seven suites had each re-authored a local `makeAsset` over the same
 * `PeggedAsset` shape, and two had re-authored `makePrimaryPriceResult`. The
 * bases below carry only the fields every variant agreed on; a suite keeps its
 * own defaults by wrapping these with the deltas it actually asserts on.
 */
import type { PeggedAsset, PrimaryPriceResult } from "../enrich-prices";

/** The identity fields every `PeggedAsset` fixture in this family sets. */
export function makePeggedAsset(overrides: Partial<PeggedAsset> = {}): PeggedAsset {
  return {
    id: "usdt-tether",
    name: "Tether",
    symbol: "USDT",
    pegType: "peggedUSD",
    ...overrides,
  };
}

/** A single-source primary-price result; every field is overridable. */
export function makePrimaryPriceResultFixture(
  overrides: Partial<PrimaryPriceResult> = {},
): PrimaryPriceResult {
  return {
    price: 1,
    source: "coingecko",
    selectedSource: "coingecko",
    confidence: "single-source",
    dlPrice: null,
    cgPrice: 1,
    candidateSources: ["coingecko"],
    agreeSources: ["coingecko"],
    allPrices: { coingecko: 1 },
    observedAt: 1_700_000_000,
    observedAtMode: "upstream",
    ...overrides,
  };
}
