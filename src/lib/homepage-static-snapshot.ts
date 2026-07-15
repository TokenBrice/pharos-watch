import topStablecoinsDataset from "../../public/datasets/top-stablecoins/latest.json";
import { CORE_AGGREGATE_ACTIVE_IDS } from "@shared/lib/stablecoins/aggregate-registry";
import { HOMEPAGE_COHORT_BUCKET_IDS, type HomepageCohortBucketKey } from "@/lib/homepage-cohort-config";
import type { TotalMcapChartRow } from "@/lib/total-mcap-chart";
import { numberValue } from "@shared/lib/type-guards";

const COHORT_BUCKET_BY_ID = new Map<string, HomepageCohortBucketKey>(
  (Object.entries(HOMEPAGE_COHORT_BUCKET_IDS) as Array<[HomepageCohortBucketKey, readonly string[]]>).flatMap(
    ([bucket, ids]) => ids.map((id) => [id, bucket] as const),
  ),
);

interface TopStablecoinsDatasetRow {
  id?: unknown;
  pegType?: unknown;
  circulatingUsd?: unknown;
}

interface TopStablecoinsDataset {
  _meta?: {
    asOfISO?: unknown;
  };
  rows?: TopStablecoinsDatasetRow[];
}

export interface HomepageHeroSnapshot {
  asOfISO: string | null;
  totalUsd: number;
  nonUsdUsd: number;
  nonUsdShare: number | null;
  cohort: TotalMcapChartRow;
}

const TOP_STABLECOINS_DATASET = topStablecoinsDataset as TopStablecoinsDataset;

function asOfISO(): string | null {
  const value = TOP_STABLECOINS_DATASET._meta?.asOfISO;
  return typeof value === "string" && value ? value : null;
}

export function getHomepageHeroSnapshot(): HomepageHeroSnapshot {
  const rows = Array.isArray(TOP_STABLECOINS_DATASET.rows) ? TOP_STABLECOINS_DATASET.rows : [];
  let totalUsd = 0;
  let nonUsdUsd = 0;
  let usdt = 0;
  let usdc = 0;
  let sky = 0;

  for (const row of rows) {
    if (typeof row.id !== "string" || !CORE_AGGREGATE_ACTIVE_IDS.has(row.id)) {
      continue;
    }

    const circulatingUsd = numberValue(row.circulatingUsd) ?? 0;
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

  const nonUsdShare = totalUsd > 0 ? nonUsdUsd / totalUsd : null;
  const others = Math.max(0, totalUsd - usdt - usdc - sky);
  const timestamp = asOfISO();

  return {
    asOfISO: timestamp,
    totalUsd,
    nonUsdUsd,
    nonUsdShare,
    cohort: {
      ts: timestamp ? Date.parse(timestamp) : Date.now(),
      usdt,
      usdc,
      sky,
      others,
      nonUsd: nonUsdUsd,
      total: totalUsd,
    },
  };
}
