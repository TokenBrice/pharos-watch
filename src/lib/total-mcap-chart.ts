import type { StablecoinChartPoint, SupplyHistoryPoint } from "@shared/types";
import { findAsOfSnapshot, MAX_SUPPLY_SNAPSHOT_DISTANCE_SEC } from "@shared/lib/rate-series";
import { admitSupplyBuckets } from "@shared/lib/supply";

export interface TotalMcapChartRow {
  ts: number;
  usdt: number | null;
  usdc: number | null;
  sky: number | null;
  others: number | null;
  nonUsd: number | null;
  total: number | null;
}

export const TOTAL_MCAP_MAJOR_COHORT_HISTORY_DAYS = 5000;

/**
 * Stablecoin IDs whose individual supply history drives the hero cohort chart.
 * Single source of truth shared with the per-coin `useSupplyHistory` fetches in
 * home-alt-hero-live-chart.tsx; keep in sync with the cohort math below.
 */
export const TOTAL_MCAP_COHORT_IDS = {
  usdt: "usdt-tether",
  usdc: "usdc-circle",
  usds: "usds-sky",
  dai: "dai-makerdao",
} as const;

function alignHistoryAtOrBeforeDate(
  chartPoints: StablecoinChartPoint[],
  history: SupplyHistoryPoint[] | null,
): (number | null)[] {
  const sortedHistory = history ? [...history].sort((a, b) => a.date - b.date) : [];
  return chartPoints.map((point) => findAsOfSnapshot(
    sortedHistory,
    Number(point.date),
    (snapshot) => snapshot.date,
    MAX_SUPPLY_SNAPSHOT_DISTANCE_SEC,
  )?.circulatingUsd ?? null);
}

export function buildTotalMcapChartRows(
  chartPoints: StablecoinChartPoint[],
  {
    usdtHistory,
    usdcHistory,
    usdsHistory,
    daiHistory,
  }: {
    usdtHistory: SupplyHistoryPoint[] | null;
    usdcHistory: SupplyHistoryPoint[] | null;
    usdsHistory: SupplyHistoryPoint[] | null;
    daiHistory: SupplyHistoryPoint[] | null;
  },
): TotalMcapChartRow[] {
  if (chartPoints.length === 0) return [];

  const usdtSeries = alignHistoryAtOrBeforeDate(chartPoints, usdtHistory);
  const usdcSeries = alignHistoryAtOrBeforeDate(chartPoints, usdcHistory);
  const usdsSeries = alignHistoryAtOrBeforeDate(chartPoints, usdsHistory);
  const daiSeries = alignHistoryAtOrBeforeDate(chartPoints, daiHistory);
  // Older cached feeds may omit a bucket instead of publishing the newer null marker.
  const pegTypes = [...new Set(chartPoints.flatMap((point) => Object.keys(point.totalCirculatingUSD)))];

  return chartPoints.map((point, index) => {
    const aggregate = admitSupplyBuckets(point.totalCirculatingUSD);
    const total = aggregate.status === "observed" && pegTypes.every((bucket) => point.totalCirculatingUSD[bucket] != null)
      ? aggregate.total : null;
    const nonUsdBuckets = Object.fromEntries(
      Object.entries(point.totalCirculatingUSD).filter(([bucket]) => bucket !== "peggedUSD"),
    );
    const nonUsdAdmission = admitSupplyBuckets(nonUsdBuckets);
    const missingNonUsd = pegTypes.some((bucket) => bucket !== "peggedUSD" && point.totalCirculatingUSD[bucket] == null);
    const nonUsd = missingNonUsd ? null : nonUsdAdmission.status === "observed" ? nonUsdAdmission.total
      : nonUsdAdmission.status === "absent" && total !== null ? 0 : null;
    const usdt = usdtSeries[index] ?? null;
    const usdc = usdcSeries[index] ?? null;
    const usds = usdsSeries[index] ?? null;
    const dai = daiSeries[index] ?? null;
    const sky = usds !== null && dai !== null ? usds + dai : null;
    const residual = total !== null && usdt !== null && usdc !== null && sky !== null ? total - usdt - usdc - sky : null;
    const others = residual !== null && residual >= 0 ? residual : null;

    return {
      ts: Number(point.date) * 1000,
      usdt,
      usdc,
      sky,
      others,
      nonUsd,
      total,
    };
  });
}
