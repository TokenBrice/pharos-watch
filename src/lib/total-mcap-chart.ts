import type { StablecoinChartPoint, SupplyHistoryPoint } from "@shared/types";
import { findAsOfSnapshot, MAX_SUPPLY_SNAPSHOT_DISTANCE_SEC } from "@shared/lib/rate-series";
import { admitSupplyBuckets } from "@shared/lib/supply";
import { CLIENT_TRACKED_META_BY_ID } from "@shared/lib/stablecoins/client-registry";

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
  stablecoinId: string,
): (number | null)[] {
  const sortedHistory = history ? [...history].sort((a, b) => a.date - b.date) : [];
  const launchDate = CLIENT_TRACKED_META_BY_ID.get(stablecoinId)?.launchDate;
  const launchSec = launchDate ? Date.parse(`${launchDate}T00:00:00Z`) / 1000 : null;
  return chartPoints.map((point) => {
    const date = Number(point.date);
    const snapshot = findAsOfSnapshot(sortedHistory, date, (snapshot) => snapshot.date, MAX_SUPPLY_SNAPSHOT_DISTANCE_SEC);
    if (snapshot) return snapshot.circulatingUsd;
    // Authored launch evidence establishes nonexistence, not an archive's first
    // row. Missing/empty reads and gaps after launch still remain unavailable.
    return sortedHistory.length > 0 && launchSec !== null && date < launchSec && date < sortedHistory[0]!.date
      ? 0 : null;
  });
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

  const usdtSeries = alignHistoryAtOrBeforeDate(chartPoints, usdtHistory, TOTAL_MCAP_COHORT_IDS.usdt);
  const usdcSeries = alignHistoryAtOrBeforeDate(chartPoints, usdcHistory, TOTAL_MCAP_COHORT_IDS.usdc);
  const usdsSeries = alignHistoryAtOrBeforeDate(chartPoints, usdsHistory, TOTAL_MCAP_COHORT_IDS.usds);
  const daiSeries = alignHistoryAtOrBeforeDate(chartPoints, daiHistory, TOTAL_MCAP_COHORT_IDS.dai);

  return chartPoints.map((point, index) => {
    const aggregate = admitSupplyBuckets(point.totalCirculatingUSD);
    const total = aggregate.status === "observed" ? aggregate.total : null;
    const nonUsdBuckets = Object.fromEntries(
      Object.entries(point.totalCirculatingUSD).filter(([bucket]) => bucket !== "peggedUSD"),
    );
    const nonUsdAdmission = admitSupplyBuckets(nonUsdBuckets);
    const nonUsd = nonUsdAdmission.status === "observed" ? nonUsdAdmission.total
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
