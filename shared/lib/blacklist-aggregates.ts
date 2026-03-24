import {
  buildBlacklistAddressCountKey,
  isBlacklistAmountGapStatus,
  isGoldBlacklistStablecoin,
  type BlacklistAddressCountMode,
} from "./blacklist";
import { BLACKLIST_STABLECOINS } from "../types/market";
import type { BlacklistEvent, BlacklistStablecoin } from "../types/market";

export interface BlacklistSummaryStats {
  usdcBlacklisted: number;
  usdtBlacklisted: number;
  goldBlacklisted: number;
  frozenAddresses: number;
  destroyedTotal: number;
  recentCount: number;
  recoverableGapCount: number;
}

export type BlacklistChartPoint = { quarter: string; total: number } & Record<BlacklistStablecoin, number>;

function quarterToSortKey(timestamp: number): number {
  const d = new Date(timestamp * 1000);
  return d.getUTCFullYear() * 4 + Math.floor(d.getUTCMonth() / 3);
}

function sortKeyToLabel(sortKey: number): string {
  const year = Math.floor(sortKey / 4);
  const q = (sortKey % 4) + 1;
  return `Q${q} '${(year % 100).toString().padStart(2, "0")}`;
}

export function computeBlacklistSummaryStats(
  events: BlacklistEvent[],
  nowSeconds = Math.floor(Date.now() / 1000),
  countMode: BlacklistAddressCountMode = "address-chain-stablecoin",
): BlacklistSummaryStats {
  const thirtyDaysAgo = nowSeconds - 30 * 24 * 60 * 60;
  const usdcAddresses = new Map<string, number>();
  const usdtAddresses = new Map<string, number>();
  const goldAddresses = new Map<string, number>();
  const otherAddresses = new Map<string, number>();
  const allAddresses = new Map<string, number>();
  let destroyedTotal = 0;
  let recentCount = 0;
  let recoverableGapCount = 0;

  for (const evt of events) {
    const isGold = isGoldBlacklistStablecoin(evt.stablecoin);
    const scopedKey = buildBlacklistAddressCountKey(evt.stablecoin, evt.chainId, evt.address, countMode);
    const map = isGold ? goldAddresses
      : evt.stablecoin === "USDC" ? usdcAddresses
      : evt.stablecoin === "USDT" ? usdtAddresses
      : otherAddresses;

    if (evt.eventType === "blacklist") {
      map.set(scopedKey, (map.get(scopedKey) ?? 0) + 1);
      allAddresses.set(scopedKey, (allAddresses.get(scopedKey) ?? 0) + 1);
    } else if (evt.eventType === "unblacklist") {
      map.set(scopedKey, (map.get(scopedKey) ?? 0) - 1);
      allAddresses.set(scopedKey, (allAddresses.get(scopedKey) ?? 0) - 1);
    } else if (evt.eventType === "destroy" && evt.amountUsdAtEvent != null) {
      destroyedTotal += evt.amountUsdAtEvent;
    }

    if (evt.timestamp >= thirtyDaysAgo) recentCount++;
    if (isBlacklistAmountGapStatus(evt.amountStatus)) {
      recoverableGapCount++;
    }
  }

  return {
    usdcBlacklisted: Array.from(usdcAddresses.values()).filter((value) => value > 0).length,
    usdtBlacklisted: Array.from(usdtAddresses.values()).filter((value) => value > 0).length,
    goldBlacklisted: Array.from(goldAddresses.values()).filter((value) => value > 0).length,
    frozenAddresses: Array.from(allAddresses.values()).filter((value) => value > 0).length,
    destroyedTotal,
    recentCount,
    recoverableGapCount,
  };
}

export function buildBlacklistChartData(events: BlacklistEvent[]): BlacklistChartPoint[] {
  const emptyBucket = (): Record<BlacklistStablecoin, number> =>
    Object.fromEntries(BLACKLIST_STABLECOINS.map((s) => [s, 0])) as Record<BlacklistStablecoin, number>;

  const buckets = new Map<number, Record<BlacklistStablecoin, number>>();

  for (const evt of events) {
    if (evt.eventType !== "blacklist" || evt.amountUsdAtEvent == null || evt.amountUsdAtEvent <= 0) continue;
    const sortKey = quarterToSortKey(evt.timestamp);
    const bucket = buckets.get(sortKey) ?? emptyBucket();
    bucket[evt.stablecoin] = (bucket[evt.stablecoin] ?? 0) + evt.amountUsdAtEvent;
    buckets.set(sortKey, bucket);
  }

  if (buckets.size === 0) return [];
  const sortKeys = [...buckets.keys()].sort((a, b) => a - b);
  const result: BlacklistChartPoint[] = [];
  for (let sortKey = sortKeys[0]; sortKey <= sortKeys[sortKeys.length - 1]; sortKey++) {
    const bucket = buckets.get(sortKey);
    const total = BLACKLIST_STABLECOINS.reduce((sum, s) => sum + (bucket?.[s] ?? 0), 0);
    const point = Object.fromEntries(BLACKLIST_STABLECOINS.map((s) => [s, bucket?.[s] ?? 0])) as Record<BlacklistStablecoin, number>;
    result.push({ quarter: sortKeyToLabel(sortKey), ...point, total });
  }
  return result;
}
