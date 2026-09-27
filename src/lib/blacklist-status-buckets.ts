import { getResolvedBlacklistStatus } from "@/lib/blacklist-status";
import { getCirculatingRawOrNull } from "@shared/lib/supply";
import {
  CLIENT_ACTIVE_STABLECOINS as ACTIVE_STABLECOINS,
  CLIENT_TRACKED_META_BY_ID as TRACKED_META_BY_ID,
} from "@shared/lib/stablecoins/client-registry";
import type { StablecoinData } from "@shared/types";

export type BlacklistStatusBucketKey = "yes" | "upstream" | "possible" | "no";

export interface BlacklistStatusBucket {
  status: string;
  key: BlacklistStatusBucketKey;
  /** Reviewed active registry members in this bucket, independent of runtime supply availability. */
  count: number;
  /** Sum of observed current supply for members whose supply is available; never includes unavailable members as zero. */
  marketCap: number;
  /** Members whose runtime supply is missing, empty or wholly invalid; excluded from `marketCap`. */
  supplyUnavailableCount: number;
}

export const BLACKLIST_STATUS_BUCKET_ORDER: readonly BlacklistStatusBucketKey[] = [
  "yes",
  "upstream",
  "possible",
  "no",
];

export const BLACKLIST_STATUS_BUCKET_COLORS: Record<BlacklistStatusBucketKey, string> = {
  yes: "#ef4444",
  upstream: "#f97316",
  possible: "#f59e0b",
  no: "#22c55e",
};

export const BLACKLIST_STATUS_BUCKET_LABELS: Record<BlacklistStatusBucketKey, string> = {
  yes: "Yes",
  upstream: "Upstream",
  possible: "Possible",
  no: "No",
};

export const BLACKLIST_STATUS_BUCKET_DESCRIPTIONS: Record<BlacklistStatusBucketKey, string> = {
  yes: "Direct token, vault, or issuer controls can freeze, block, seize, or destroy user balances.",
  upstream: "No direct control is resolved; exposure comes from freezable upstream collateral or parent assets.",
  possible:
    "Mutable or pause-capable admin surfaces indicate possible controls, but active address-level freezing is not confirmed.",
  no: "No direct, upstream, or possible freeze exposure is resolved in the current model.",
};

export function resolveBlacklistStatusBucket(
  value: boolean | "possible" | "inherited",
): BlacklistStatusBucketKey {
  if (value === true) return "yes";
  if (value === "possible") return "possible";
  if (value === "inherited") return "upstream";
  return "no";
}

export function getBlacklistStatusBucketForStablecoin(
  stablecoinId: string,
): BlacklistStatusBucketKey | null {
  const resolved = getResolvedBlacklistStatus(stablecoinId);
  return resolved === null ? null : resolveBlacklistStatusBucket(resolved);
}

export function buildBlacklistStatusBuckets(
  stablecoins: StablecoinData[] | undefined,
): BlacklistStatusBucket[] {
  const supplyById = new Map((stablecoins ?? []).map((coin) => [coin.id, getCirculatingRawOrNull(coin)]));
  const counts: Record<BlacklistStatusBucketKey, { count: number; marketCap: number; supplyUnavailableCount: number }> = {
    yes: { count: 0, marketCap: 0, supplyUnavailableCount: 0 },
    upstream: { count: 0, marketCap: 0, supplyUnavailableCount: 0 },
    possible: { count: 0, marketCap: 0, supplyUnavailableCount: 0 },
    no: { count: 0, marketCap: 0, supplyUnavailableCount: 0 },
  };

  for (const coin of ACTIVE_STABLECOINS) {
    if (!TRACKED_META_BY_ID.has(coin.id)) continue;
    const bucket = getBlacklistStatusBucketForStablecoin(coin.id);
    if (bucket === null) continue;
    counts[bucket].count += 1;
    const supply = supplyById.get(coin.id) ?? null;
    if (supply === null) {
      counts[bucket].supplyUnavailableCount += 1;
    } else {
      counts[bucket].marketCap += supply;
    }
  }

  return BLACKLIST_STATUS_BUCKET_ORDER.map((key) => ({
    status: BLACKLIST_STATUS_BUCKET_LABELS[key],
    key,
    count: counts[key].count,
    marketCap: counts[key].marketCap,
    supplyUnavailableCount: counts[key].supplyUnavailableCount,
  }));
}

export function filterStablecoinsByBlacklistStatus(
  stablecoins: StablecoinData[] | undefined,
  status: BlacklistStatusBucketKey,
): StablecoinData[] {
  if (!stablecoins) return [];

  return stablecoins.filter((coin) => {
    if (!TRACKED_META_BY_ID.has(coin.id)) return false;
    return getBlacklistStatusBucketForStablecoin(coin.id) === status;
  });
}
