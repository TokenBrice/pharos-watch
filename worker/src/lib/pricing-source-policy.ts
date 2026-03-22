import { splitCompositePriceSource } from "@shared/lib/pricing-sources";

const POOL_CHALLENGE_EXEMPT_SOURCES = new Set([
  "pyth",
  "binance",
  "kraken",
  "bitstamp",
  "coinbase",
  "curve-onchain",
  "curve-oracle",
  "redstone",
  "protocol-redeem",
]);

const GT_PROBE_ELIGIBLE_SINGLE_SOURCES = new Set([
  "coingecko",
  "defillama-list",
]);

const NON_REPLAYABLE_PRICE_SOURCES = new Set([
  "coinmarketcap",
  "dexscreener",
  "jupiter",
  "cached",
]);

export const FIXED_PEG_SEVERE_DOWNSIDE_RATIO = 0.5;

export function isPoolChallengeEligibleConsensus(sources: string[]): boolean {
  return sources.length > 0 && sources.every((source) => !POOL_CHALLENGE_EXEMPT_SOURCES.has(source));
}

export function isGtProbeEligibleSingleSource(source: string): boolean {
  return GT_PROBE_ELIGIBLE_SINGLE_SOURCES.has(source);
}

export function isReplaySafePriceSource(source: string | null | undefined): boolean {
  if (!source) return false;
  return splitCompositePriceSource(source).every((part) => !NON_REPLAYABLE_PRICE_SOURCES.has(part));
}
