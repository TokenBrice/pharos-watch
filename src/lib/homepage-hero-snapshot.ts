import { CLIENT_CORE_AGGREGATE_ACTIVE_IDS } from "@shared/lib/stablecoins/aggregate-client-registry";
import { getCirculatingRaw } from "@shared/lib/supply";
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
  cohort: TotalMcapChartRow;
}

interface HomepageHeroMarketRow {
  id: string;
  pegType: string;
  circulatingUsd: number;
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
  let usdt = 0;
  let usdc = 0;
  let sky = 0;

  for (const row of rows) {
    if (!CLIENT_CORE_AGGREGATE_ACTIVE_IDS.has(row.id)) {
      continue;
    }

    const circulatingUsd = Number.isFinite(row.circulatingUsd) ? row.circulatingUsd : 0;
    totalUsd += circulatingUsd;

    if (row.pegType !== "peggedUSD") {
      nonUsdUsd += circulatingUsd;
    }

    switch (COHORT_BUCKET_BY_ID.get(row.id)) {
      case "usdt":
        usdt += circulatingUsd;
        break;
      case "usdc":
        usdc += circulatingUsd;
        break;
      case "sky":
        sky += circulatingUsd;
        break;
    }
  }

  return {
    asOfISO,
    totalUsd,
    nonUsdUsd,
    nonUsdShare: totalUsd > 0 ? nonUsdUsd / totalUsd : null,
    cohort: {
      ts: asOfISO ? Date.parse(asOfISO) : 0,
      usdt,
      usdc,
      sky,
      others: Math.max(0, totalUsd - usdt - usdc - sky),
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
      circulatingUsd: getCirculatingRaw(asset),
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
