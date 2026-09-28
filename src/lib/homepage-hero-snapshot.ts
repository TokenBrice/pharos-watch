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
  totalUsd: number;
  nonUsdUsd: number;
  nonUsdShare: number | null;
  /**
   * Core-aggregate rows present in the source whose current supply is unavailable. They are
   * excluded from every sum (never counted as $0), so a nonzero count marks the totals partial.
   */
  supplyUnavailableCount: number;
  cohort: TotalMcapChartRow;
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
  let supplyUnavailableCount = 0;
  const cohortSums: Record<HomepageCohortBucketKey, number> = { usdt: 0, usdc: 0, sky: 0 };
  const observedIds = new Set<string>();

  for (const row of rows) {
    if (!CLIENT_CORE_AGGREGATE_ACTIVE_IDS.has(row.id)) {
      continue;
    }

    const circulatingUsd = row.circulatingUsd;
    if (circulatingUsd == null || !Number.isFinite(circulatingUsd)) {
      supplyUnavailableCount += 1;
      continue;
    }
    observedIds.add(row.id);
    totalUsd += circulatingUsd;

    if (row.pegType !== "peggedUSD") {
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

  return {
    asOfISO,
    totalUsd,
    nonUsdUsd,
    nonUsdShare: totalUsd > 0 ? nonUsdUsd / totalUsd : null,
    supplyUnavailableCount,
    cohort: {
      ts: asOfISO ? Date.parse(asOfISO) : 0,
      usdt,
      usdc,
      sky,
      others: supplyUnavailableCount === 0 && usdt !== null && usdc !== null && sky !== null
        && totalUsd >= usdt + usdc + sky ? totalUsd - usdt - usdc - sky : null,
      nonUsd: nonUsdUsd,
      total: totalUsd,
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
  if (liveSnapshot) {
    return { status: "available", source: "live", snapshot: liveSnapshot };
  }

  const fallbackTimestamp = fallbackSnapshot.asOfISO ? Date.parse(fallbackSnapshot.asOfISO) : Number.NaN;
  const fallbackAgeMs = nowMs - fallbackTimestamp;
  if (
    Number.isFinite(fallbackTimestamp)
    && fallbackAgeMs >= 0
    && fallbackAgeMs <= HOMEPAGE_HERO_MAX_FALLBACK_AGE_MS
  ) {
    return { status: "available", source: "fallback", snapshot: fallbackSnapshot };
  }

  return { status: "unavailable", source: "unavailable", snapshot: null };
}
