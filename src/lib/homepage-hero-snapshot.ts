import { CLIENT_CORE_AGGREGATE_ACTIVE_IDS } from "@shared/lib/stablecoins/aggregate-client-registry";
import { getCirculatingRawOrNull } from "@shared/lib/supply";
import type { StablecoinListResponse } from "@shared/types";
import { HOMEPAGE_COHORT_BUCKET_IDS, type HomepageCohortBucketKey } from "@/lib/homepage-cohort-config";
import type { TotalMcapChartRow } from "@/lib/total-mcap-chart";

// A checked-in build snapshot is only a short outage bridge, never an
// indefinitely current headline.
export const HOMEPAGE_HERO_MAX_FALLBACK_AGE_MS = 72 * 60 * 60 * 1000;

const COHORT_BUCKET_BY_ID = new Map<string, HomepageCohortBucketKey>(
  (Object.entries(HOMEPAGE_COHORT_BUCKET_IDS) as Array<[HomepageCohortBucketKey, readonly string[]]>).flatMap(
    ([bucket, ids]) => ids.map((id) => [id, bucket] as const),
  ),
);

export interface HomepageHeroSnapshot {
  asOfISO: string | null;
  totalUsd: number | null;
  nonUsdUsd: number | null;
  nonUsdShare: number | null;
  /**
   * Core-aggregate rows present in the source whose current supply is unavailable. They are
   * excluded from every sum (never counted as $0), so a nonzero count marks the totals partial.
   */
  supplyUnavailableCount: number;
  supplyObservedCount: number;
  supplyExpectedCount: number;
  supplyMissingCount: number;
  cohort: Omit<TotalMcapChartRow, "total"> & { total: number | null };
}

interface HomepageHeroMarketRow {
  id: string;
  pegType: string;
  /** `null` when the source row carries no observed supply; `0` only for an explicit zero. */
  circulatingUsd: number | null;
}

export type HomepageHeroSelection =
  | {
      status: "available";
      source: "live" | "fallback";
      snapshot: HomepageHeroSnapshot;
    }
  | {
      status: "unavailable";
      source: "unavailable";
      snapshot: null;
    };

export function buildHomepageHeroSnapshot(
  rows: readonly HomepageHeroMarketRow[],
  asOfISO: string | null,
): HomepageHeroSnapshot {
  let totalUsd = 0;
  let nonUsdUsd = 0;
  let nonUsdObservedCount = 0;
  let supplyUnavailableCount = 0;
  const cohortSums: Record<HomepageCohortBucketKey, number> = { usdt: 0, usdc: 0, sky: 0 };
  const observedIds = new Set<string>();
  const presentIds = new Set<string>();

  for (const row of rows) {
    if (!CLIENT_CORE_AGGREGATE_ACTIVE_IDS.has(row.id)) {
      continue;
    }
    if (presentIds.has(row.id)) continue;
    presentIds.add(row.id);

    const circulatingUsd = row.circulatingUsd;
    if (circulatingUsd == null || !Number.isFinite(circulatingUsd) || circulatingUsd < 0) {
      supplyUnavailableCount += 1;
      continue;
    }
    observedIds.add(row.id);
    totalUsd += circulatingUsd;

    if (row.pegType !== "peggedUSD") {
      nonUsdObservedCount += 1;
      nonUsdUsd += circulatingUsd;
    }

    const bucket = COHORT_BUCKET_BY_ID.get(row.id);
    if (bucket) cohortSums[bucket] += circulatingUsd;
  }

  // A cohort is known only when every core-aggregate member reported an observed supply;
  // an absent or unavailable member leaves the cohort unavailable rather than understated.
  const cohortValue = (bucket: HomepageCohortBucketKey): number | null =>
    HOMEPAGE_COHORT_BUCKET_IDS[bucket].every((id) => !CLIENT_CORE_AGGREGATE_ACTIVE_IDS.has(id) || observedIds.has(id))
      ? cohortSums[bucket]
      : null;
  const usdt = cohortValue("usdt");
  const usdc = cohortValue("usdc");
  const sky = cohortValue("sky");
  const supplyExpectedCount = CLIENT_CORE_AGGREGATE_ACTIVE_IDS.size;
  const supplyMissingCount = supplyExpectedCount - presentIds.size;
  const complete = observedIds.size === supplyExpectedCount;
  const knownTotal = observedIds.size > 0 ? totalUsd : null;
  const knownNonUsd = nonUsdObservedCount > 0 ? nonUsdUsd : null;

  return {
    asOfISO,
    totalUsd: knownTotal,
    nonUsdUsd: knownNonUsd,
    nonUsdShare: complete && knownNonUsd !== null && totalUsd > 0 ? nonUsdUsd / totalUsd : null,
    supplyUnavailableCount,
    supplyObservedCount: observedIds.size,
    supplyExpectedCount,
    supplyMissingCount,
    cohort: {
      ts: asOfISO ? Date.parse(asOfISO) : 0,
      usdt,
      usdc,
      sky,
      others: complete && usdt !== null && usdc !== null && sky !== null
        && totalUsd >= usdt + usdc + sky ? totalUsd - usdt - usdc - sky : null,
      nonUsd: knownNonUsd,
      total: knownTotal,
    },
  };
}

export function buildLiveHomepageHeroSnapshot(
  data: StablecoinListResponse,
  updatedAtSeconds?: number,
): HomepageHeroSnapshot {
  const asOfISO = typeof updatedAtSeconds === "number" && Number.isFinite(updatedAtSeconds)
    ? new Date(updatedAtSeconds * 1000).toISOString()
    : null;

  return buildHomepageHeroSnapshot(
    data.peggedAssets.map((asset) => ({
      id: asset.id,
      pegType: asset.pegType,
      circulatingUsd: getCirculatingRawOrNull(asset),
    })),
    asOfISO,
  );
}

export function selectHomepageHeroSnapshot({
  liveSnapshot,
  fallbackSnapshot,
  nowMs,
}: {
  liveSnapshot: HomepageHeroSnapshot | null;
  fallbackSnapshot: HomepageHeroSnapshot;
  nowMs: number;
}): HomepageHeroSelection {
  if (liveSnapshot?.totalUsd != null) {
    return { status: "available", source: "live", snapshot: liveSnapshot };
  }

  const fallbackTimestamp = fallbackSnapshot.asOfISO ? Date.parse(fallbackSnapshot.asOfISO) : Number.NaN;
  const fallbackAgeMs = nowMs - fallbackTimestamp;
  if (
    fallbackSnapshot.totalUsd !== null
    && Number.isFinite(fallbackTimestamp)
    && fallbackAgeMs >= 0
    && fallbackAgeMs <= HOMEPAGE_HERO_MAX_FALLBACK_AGE_MS
  ) {
    return { status: "available", source: "fallback", snapshot: fallbackSnapshot };
  }

  return { status: "unavailable", source: "unavailable", snapshot: null };
}
