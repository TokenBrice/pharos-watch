import {
  STAGED_POOL_CONFIDENCE_HORIZON_HOURS,
  STAGED_POOL_FRESH_HOURS,
  STAGED_POOL_PRICE_MAX_AGE_HOURS,
  type StagedPool,
} from "../dex-discovery/types";

export interface RegistryPoolView {
  stablecoinId: string;
  poolId: string;
  metadata: Pick<StagedPool,
    "chain" | "protocol" | "dexId" | "symbol" | "poolType" | "qualityMultiplier"
    | "feeTier" | "isStable" | "baseToken" | "quoteToken" | "quoteSymbol">;
  value: StagedPool;
  price: StagedPool | null;
  discoveredAt: number;
  lastSeenAt: number;
  sources: string[];
}

const SOURCE_TIER: Record<StagedPool["source"], number> = {
  direct_api: 1,
  dl: 1,
  cg_onchain: 2,
  gecko_terminal: 2,
  dexscreener: 3,
  horizon: 3,
  aquarius: 3,
  tezos: 3,
  "icon-balanced": 3,
  "kava-swap": 3,
  "osmosis-sqs": 3,
  "noble-swap": 3,
  cg_tickers: 4,
};

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareFreshness(a: StagedPool, b: StagedPool): number {
  return b.refreshedAt - a.refreshedAt || compareText(a.source, b.source);
}

function compareTrust(a: StagedPool, b: StagedPool): number {
  // Unknown persisted sources retain the merge's legacy fallback handling,
  // but can never outrank a reviewed source.
  const tier = (source: StagedPool["source"]) =>
    Object.prototype.hasOwnProperty.call(SOURCE_TIER, source) ? SOURCE_TIER[source] : Infinity;
  return (tier(a.source) - tier(b.source)) || compareFreshness(a, b);
}

export function resolveRegistryPools(rows: StagedPool[], nowSec: number): RegistryPoolView[] {
  const groups = new Map<string, StagedPool[]>();
  for (const row of rows) {
    const key = `${row.stablecoinId}\u0000${row.poolId}`;
    const group = groups.get(key);
    if (group) group.push(row);
    else groups.set(key, [row]);
  }

  const views: RegistryPoolView[] = [];
  for (const group of groups.values()) {
    group.sort(compareTrust);
    const freshValue = group.find((row) =>
      nowSec - row.refreshedAt <= STAGED_POOL_FRESH_HOURS * 3600 && row.tvlUsd != null);
    const value = freshValue ?? group.reduce((best, row) => compareFreshness(row, best) < 0 ? row : best);
    const price = group.find((row) => row.priceUsd != null && row.priceUsd > 0
      && nowSec - row.refreshedAt <= STAGED_POOL_PRICE_MAX_AGE_HOURS * 3600) ?? null;
    const metadataRows = group.filter((row) =>
      nowSec - row.refreshedAt <= STAGED_POOL_CONFIDENCE_HORIZON_HOURS * 3600);
    const field = <K extends keyof RegistryPoolView["metadata"]>(key: K): StagedPool[K] =>
      metadataRows.find((row) => row[key] != null && row[key] !== "")?.[key] ?? value[key];
    // Tuples stay intact: a fee tier belongs to the pool type it was observed with,
    // and a token pair to the orientation it was observed in.
    const profile = metadataRows.find((row) => row.poolType != null) ?? value;
    const tokens = metadataRows.find((row) => row.baseToken && row.quoteToken) ?? value;
    views.push({
      stablecoinId: value.stablecoinId,
      poolId: value.poolId,
      metadata: {
        chain: field("chain"),
        protocol: field("protocol"),
        dexId: field("dexId"),
        symbol: field("symbol"),
        poolType: profile.poolType,
        qualityMultiplier: profile.qualityMultiplier,
        feeTier: profile.feeTier,
        isStable: profile.isStable,
        baseToken: tokens.baseToken,
        quoteToken: tokens.quoteToken,
        quoteSymbol: tokens.quoteSymbol,
      },
      value,
      price,
      discoveredAt: group.reduce((earliest, row) => Math.min(earliest, row.discoveredAt), Infinity),
      lastSeenAt: group.reduce((latest, row) => Math.max(latest, row.refreshedAt), -Infinity),
      sources: [...new Set(group.map((row) => row.source))].sort(compareText),
    });
  }
  return views.sort((a, b) => compareText(a.stablecoinId, b.stablecoinId) || compareText(a.poolId, b.poolId));
}
