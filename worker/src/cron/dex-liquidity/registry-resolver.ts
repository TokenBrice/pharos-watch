import {
  STAGED_POOL_CONFIDENCE_HORIZON_HOURS,
  STAGED_POOL_FRESH_HOURS,
  type StagedPool,
} from "../dex-discovery/types";
import { STAGED_POOL_PRICE_MAX_AGE_HOURS } from "../../lib/dex-cron-constants";
import { DEX_VOLUME_OBSERVATION_MAX_AGE_SEC } from "@shared/lib/dex-volume-availability";
import { getRegistryPriceObservedAt, getRegistryVolumeObservedAt } from "./registry-writeback-evidence";

export interface RegistryPoolView {
  stablecoinId: string;
  poolId: string;
  metadata: Pick<StagedPool,
    "chain" | "protocol" | "dexId" | "symbol" | "poolType" | "qualityMultiplier"
    | "feeTier" | "isStable" | "baseToken" | "quoteToken" | "quoteSymbol">;
  value: StagedPool;
  price: StagedPool | null;
  priceObservedAt: number | null;
  /**
   * Row supplying the pool's 24h volume reading (DEC-19): the most trusted row
   * with a usable reading inside the staged fresh window (24h), else the most
   * trusted row inside the volume admission window (72h), else the freshest row
   * with any reading (so an aged reading is classified stale, never counted),
   * else null when no source observed volume. Future observations are rejected
   * whole before any field is resolved.
   */
  volume: StagedPool | null;
  volumeObservedAt: number | null;
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
  sundaeswap: 3,
  cg_tickers: 4,
};

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareFreshness(a: StagedPool, b: StagedPool): number {
  return b.refreshedAt - a.refreshedAt || compareText(a.source, b.source);
}

function sourceTier(source: StagedPool["source"]): number {
  // Unknown persisted sources retain the merge's legacy fallback handling,
  // but can never outrank a reviewed source.
  return Object.prototype.hasOwnProperty.call(SOURCE_TIER, source) ? SOURCE_TIER[source] : Infinity;
}

function compareTrust(a: StagedPool, b: StagedPool): number {
  return (sourceTier(a.source) - sourceTier(b.source)) || compareFreshness(a, b);
}

export function resolveRegistryPools(rows: StagedPool[], nowSec: number): RegistryPoolView[] {
  const groups = new Map<string, StagedPool[]>();
  for (const row of rows) {
    if (row.refreshedAt > nowSec) continue;
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
    let price: StagedPool | null = null;
    let priceObservedAt: number | null = null;
    for (const row of group) {
      if (row.priceUsd == null || !Number.isFinite(row.priceUsd) || row.priceUsd <= 0) continue;
      const observedAt = getRegistryPriceObservedAt(row);
      if (observedAt == null || nowSec - observedAt > STAGED_POOL_PRICE_MAX_AGE_HOURS * 3600) continue;
      price = row;
      priceObservedAt = observedAt;
      break;
    }
    const volumeRows = group.flatMap((row) => {
      if (row.volume24h == null || !Number.isFinite(row.volume24h) || row.volume24h < 0) return [];
      const observedAt = getRegistryVolumeObservedAt(row);
      return observedAt == null ? [] : [{ row, observedAt }];
    });
    const compareVolumeFreshness = (a: typeof volumeRows[number], b: typeof volumeRows[number]) =>
      b.observedAt - a.observedAt || compareText(a.row.source, b.row.source);
    volumeRows.sort((a, b) => (sourceTier(a.row.source) - sourceTier(b.row.source)) || compareVolumeFreshness(a, b));
    const volume = volumeRows.find(({ observedAt }) => nowSec - observedAt <= STAGED_POOL_FRESH_HOURS * 3600)
      ?? volumeRows.find(({ observedAt }) => nowSec - observedAt <= DEX_VOLUME_OBSERVATION_MAX_AGE_SEC)
      ?? volumeRows.reduce<typeof volumeRows[number] | null>((best, reading) =>
        best == null || compareVolumeFreshness(reading, best) < 0 ? reading : best, null);
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
      priceObservedAt,
      volume: volume?.row ?? null,
      volumeObservedAt: volume?.observedAt ?? null,
      discoveredAt: group.reduce((earliest, row) => Math.min(earliest, row.discoveredAt), Infinity),
      lastSeenAt: group.reduce((latest, row) => Math.max(latest, row.refreshedAt), -Infinity),
      sources: [...new Set(group.map((row) => row.source))].sort(compareText),
    });
  }
  return views.sort((a, b) => compareText(a.stablecoinId, b.stablecoinId) || compareText(a.poolId, b.poolId));
}
