import { buildBlacklistAddressCountKey } from "./blacklist";
import type { BlacklistCurrentBalanceSnapshot } from "./blacklist-active-records";
import { BLACKLIST_STABLECOINS } from "../types/market";
import type { BlacklistEvent, BlacklistStablecoin } from "../types/market";

export type BlacklistChartPoint = { quarter: string; total: number } & Record<BlacklistStablecoin, number>;

function quarterToSortKey(timestamp: number): number {
  const d = new Date(timestamp * 1000);
  return d.getUTCFullYear() * 4 + Math.floor(d.getUTCMonth() / 3);
}

export function sortKeyToLabel(sortKey: number): string {
  const year = Math.floor(sortKey / 4);
  const q = (sortKey % 4) + 1;
  return `Q${q} '${(year % 100).toString().padStart(2, "0")}`;
}

export function buildBlacklistQuarterlyChartFromSnapshots(
  currentBalances: ReadonlyMap<string, BlacklistCurrentBalanceSnapshot>,
  latestByAddr: BlacklistEvent[],
): BlacklistChartPoint[] {
  const latestBlacklistTsByKey = new Map<string, number>();
  for (const row of latestByAddr) {
    if (row.eventType !== "blacklist") continue;
    const key = buildBlacklistAddressCountKey(row.stablecoin, row.chainId, row.address);
    const prev = latestBlacklistTsByKey.get(key);
    if (prev == null || row.timestamp > prev) latestBlacklistTsByKey.set(key, row.timestamp);
  }
  const emptyBucket = (): Record<BlacklistStablecoin, number> =>
    Object.fromEntries(BLACKLIST_STABLECOINS.map((s) => [s, 0])) as Record<BlacklistStablecoin, number>;
  const buckets = new Map<number, Record<BlacklistStablecoin, number>>();
  for (const snapshot of currentBalances.values()) {
    if (snapshot.amountUsd == null || snapshot.amountUsd <= 0) continue;
    const key = buildBlacklistAddressCountKey(snapshot.stablecoin, snapshot.chainId, snapshot.address);
    const ts = latestBlacklistTsByKey.get(key) ?? snapshot.observedAt;
    const sortKey = quarterToSortKey(ts);
    const bucket = buckets.get(sortKey) ?? emptyBucket();
    bucket[snapshot.stablecoin] = (bucket[snapshot.stablecoin] ?? 0) + snapshot.amountUsd;
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
