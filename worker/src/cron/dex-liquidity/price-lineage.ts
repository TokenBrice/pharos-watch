import { isCanonicalPricePoolKey } from "@shared/lib/pricing-source-pool-provenance";
import { getPricingSourceRegistryEntry, PRICING_SOURCE_REGISTRY } from "@shared/lib/pricing-source-registry";
import {
  BINANCE_MARKETS,
  BITSTAMP_MARKETS,
  COINBASE_PRODUCTS,
  KRAKEN_MARKETS,
  coinbaseProductMatchesAsset,
  krakenMarketMatchesAsset,
} from "@shared/lib/pricing-provider-config";
import { CURVE_POOL_CONFIGS, type CurvePoolConfig } from "@shared/lib/curve-pool-configs";
import { WORKER_TRACKED_META_BY_ID } from "@shared/lib/stablecoins/worker-runtime-registry";
import { canonicalTronAddress } from "@shared/lib/tron-address";
import { canonicalExitRouteScopedKey } from "@shared/types/exit-route-identity";
import type { DexPriceObs } from "./types";

export interface DexPriceLineage {
  pricePoolKeys?: readonly string[];
  upstreamKeys?: readonly string[];
}

type ChallengerLineage = DexPriceLineage & {
  observedAt?: number | null;
  priceObservedAt?: number | null;
  tvlUsd?: number;
  tvl?: number;
};

/** A connected set of price-forming pools or venues can provide one vote. */
export function selectIndependentChallengerPools<T extends ChallengerLineage>(
  pools: readonly T[],
  observedAt: (pool: T) => number = (pool) => pool.priceObservedAt ?? pool.observedAt ?? 0,
): T[] {
  const ranked = [...pools].sort((a, b) => observedAt(b) - observedAt(a) ||
    (b.tvlUsd ?? b.tvl ?? 0) - (a.tvlUsd ?? a.tvl ?? 0));
  const byIdentity = new Map<string, { pool: T; rank: number; identities: Set<string> }>();
  const selected = new Set<T>();
  for (const [rank, pool] of ranked.entries()) {
    const identities = new Set([...(pool.pricePoolKeys ?? []), ...(pool.upstreamKeys ?? [])]);
    let best = { pool, rank };
    // Keep every link in the group even when a different pool supplies its vote.
    for (const key of identities) {
      const other = byIdentity.get(key);
      if (!other || !selected.delete(other.pool)) continue;
      for (const linked of other.identities) identities.add(linked);
      if (other.rank < best.rank) best = other;
    }
    selected.add(best.pool);
    const group = { ...best, identities };
    for (const key of identities) byIdentity.set(key, group);
  }
  return pools.filter((pool) => selected.delete(pool));
}

export function readDexPriceLineage(value: unknown): DexPriceLineage {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const keys = (input: unknown, validate: (key: unknown) => boolean): string[] =>
    Array.isArray(input) && input.every(validate) ? [...new Set<string>(input)] : [];
  const pools = "pricePoolKeys" in value ? keys(value.pricePoolKeys, isCanonicalPricePoolKey) : undefined;
  const upstream = "upstreamKeys" in value ? keys(value.upstreamKeys, (key) =>
    isCanonicalPricePoolKey(key) || (typeof key === "string" && key.startsWith("venue:") &&
      getPricingSourceRegistryEntry(key.slice(6))?.trustTier === "hard_market")) : undefined;
  if (pools && upstream) {
    const upstreamPools = upstream.filter(isCanonicalPricePoolKey);
    if (pools.length !== upstreamPools.length || !pools.every((key) => upstreamPools.includes(key))) {
      return { pricePoolKeys: [], upstreamKeys: [] };
    }
  }
  return { ...(pools ? { pricePoolKeys: pools } : {}), ...(upstream ? { upstreamKeys: upstream } : {}) };
}

export interface DexObservationLineage {
  upstreamKeys: string[];
  providerFamily: string | null;
  venueFamily: string | null;
}

export const CURVE_USDC_USD_VENUE_KEY = "venue:bitstamp";

const curveConfigsById = new Map<string, CurvePoolConfig[]>();
for (const config of CURVE_POOL_CONFIGS) {
  const existing = curveConfigsById.get(config.stablecoinId) ?? [];
  existing.push(config);
  curveConfigsById.set(config.stablecoinId, existing);
}
const hardMarkets = PRICING_SOURCE_REGISTRY.filter((source) => source.trustTier === "hard_market");

export function configuredPrimaryUpstreamKeys(stablecoinId: string): Set<string> {
  const symbol = WORKER_TRACKED_META_BY_ID.get(stablecoinId)?.symbol.toUpperCase();
  const keys = new Set(hardMarkets.flatMap(({ key }) => directUsdVenueKeys(key, symbol, stablecoinId) ?? []));
  const visited = new Set<string>();
  const queue = [stablecoinId];
  while (queue.length > 0) {
    const currentId = queue.shift()!;
    if (visited.has(currentId)) continue;
    visited.add(currentId);
    const configs = curveConfigsById.get(currentId);
    if (!configs || configs.length === 0) continue;
    keys.add(CURVE_USDC_USD_VENUE_KEY);
    for (const config of configs) {
      keys.add(canonicalExitRouteScopedKey(config.chain, config.poolAddress));
      if (config.hop && !visited.has(config.hop.viaStablecoinId)) {
        queue.push(config.hop.viaStablecoinId);
      }
    }
  }
  return keys;
}

/** Main ignores the receipt, so only legacy-omitted or proven disjoint rows can vote there. */
export function admitsRollbackDexVote(upstreamKeys: readonly string[] | undefined, claimedKeys: ReadonlySet<string>): boolean {
  return upstreamKeys === undefined || (upstreamKeys.length > 0 && !upstreamKeys.some((key) => claimedKeys.has(key)));
}

/** Coinbase stablecoin-quoted books also depend on the Bitstamp USD conversion. */
export function directUsdVenueKeys(source: string, symbol: string | undefined, stablecoinId?: string): string[] | undefined {
  const normalizedSymbol = symbol?.trim().toUpperCase();
  if (!normalizedSymbol) return;
  if (source === "binance" && BINANCE_MARKETS.some((row) => row.symbol === normalizedSymbol && row.pair === normalizedSymbol + "USD")) {
    return ["venue:binance"];
  }
  if (
    source === "kraken" &&
    KRAKEN_MARKETS.some(
      (row) => krakenMarketMatchesAsset(row, normalizedSymbol, stablecoinId) && row.requestPair === normalizedSymbol + "USD",
    )
  ) {
    return ["venue:kraken"];
  }
  if (source === "bitstamp" && BITSTAMP_MARKETS.some((row) => row.symbol === normalizedSymbol && row.pair === normalizedSymbol + "/USD")) {
    return ["venue:bitstamp"];
  }
  if (source !== "coinbase") return;
  const product = COINBASE_PRODUCTS.find((row) => coinbaseProductMatchesAsset(row, normalizedSymbol, stablecoinId));
  if (product?.quoteAsset === "USD") return ["venue:coinbase"];
  if (product?.quoteAsset === "USDC") return ["venue:coinbase", "venue:bitstamp"];
}

/** The physical pool of a provider's token-USD mark need not have formed that mark. */
export function getDexObservationLineage(row: DexPriceObs): DexObservationLineage | null {
  if (row.mergedLineage !== undefined) {
    const merged = row.mergedLineage;
    return merged && readDexPriceLineage(merged).upstreamKeys?.length ? merged : null;
  }
  const mark = row.counterpartyPrice;
  if (row.identityConfidence !== "exact" || row.sourceFamily !== "direct_api" || !mark ||
    !Number.isSafeInteger(row.observedAt) || !Number.isSafeInteger(mark.observedAtSec) ||
    row.observedAt! <= 0 || row.observedAt! > mark.observedAtSec || !Number.isFinite(mark.priceUsd) || mark.priceUsd <= 0) return null;
  const prefix = row.poolKey?.split(":")[0];
  if (prefix !== row.chain.toLowerCase()) return null;
  const key = prefix === "tron"
    ? `tron:${canonicalTronAddress(row.poolKey!.slice(5)) ?? ""}`
    : row.poolKey;
  if (!isCanonicalPricePoolKey(key)) return null;
  const published = readDexPriceLineage(mark);
  if (typeof mark.source !== "string" || !mark.source.trim()) return null;
  const symbol = WORKER_TRACKED_META_BY_ID.get(mark.stablecoinId)?.symbol;
  const venueKeys = mark.source.split("+").map((source) => directUsdVenueKeys(source, symbol, mark.stablecoinId));
  if (published.upstreamKeys?.length === 0 || (published.pricePoolKeys?.length === 0 && !published.upstreamKeys)) return null;
  if (!published.upstreamKeys?.length && venueKeys.some((keys) => keys == null)) return null;
  const inferredVenues = venueKeys.flatMap((keys) => keys ?? []);
  const upstreamKeys = [...new Set([key, ...(published.upstreamKeys ?? []), ...(published.pricePoolKeys ?? []), ...inferredVenues])];
  // DEWS has room for one provider and one venue per counted input. Do not
  // hide a conversion pool or an additional conversion venue from that reader.
  const providerFamily = upstreamKeys.length === 2 && upstreamKeys[1]?.startsWith("venue:")
    ? upstreamKeys[1].slice(6) : null;
  return { upstreamKeys, providerFamily, venueFamily: getPricingSourceRegistryEntry(`${row.protocol}-dex`)?.depegSourceFamily ?? null };
}

export function getDexGroupLineage(rows: readonly DexPriceObs[]) {
  const inputs: DexObservationLineage[] = [];
  for (const row of rows) {
    const lineage = getDexObservationLineage(row);
    if (lineage) inputs.push(lineage);
  }
  if (!inputs.length && !rows.some((row) => row.mergedLineage != null || row.counterpartyPrice != null)) return null;
  // An explicitly incomplete receipt also survives duplicate-pool collapse.
  if (inputs.length !== rows.length) return { upstreamKeys: [], pricePoolKeys: [], aggregateContributors: undefined };
  const upstreamKeys = [...new Set(inputs.flatMap((input) => input.upstreamKeys))].sort();
  return {
    upstreamKeys,
    pricePoolKeys: upstreamKeys.filter(isCanonicalPricePoolKey),
    aggregateContributors: inputs.every((input) => input.providerFamily && input.venueFamily)
      ? inputs.map(({ providerFamily, venueFamily }) => ({ providerFamily, venueFamily })) : undefined,
  };
}
