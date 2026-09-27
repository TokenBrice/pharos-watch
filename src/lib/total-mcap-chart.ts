import type { StablecoinChartPoint, SupplyHistoryPoint } from "@shared/types";

export interface TotalMcapChartRow {
  ts: number;
  usdt: number | null;
  usdc: number | null;
  sky: number | null;
  others: number | null;
  nonUsd: number | null;
  total: number;
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
  const aligned: (number | null)[] = [];
  let historyIndex = 0;
  let lastValue: number | null = null;

  for (const point of chartPoints) {
    const chartDate = Number(point.date);
    while (historyIndex < sortedHistory.length && sortedHistory[historyIndex]!.date <= chartDate) {
      lastValue = sortedHistory[historyIndex]!.circulatingUsd;
      historyIndex += 1;
    }
    aligned.push(lastValue);
  }

  return aligned;
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

  return chartPoints.map((point, index) => {
    const total = Object.values(point.totalCirculatingUSD).reduce((sum, value) => sum + (value ?? 0), 0);
    const nonUsd = Object.entries(point.totalCirculatingUSD).reduce(
      (sum, [bucket, value]) => (bucket === "peggedUSD" ? sum : sum + (value ?? 0)),
      0,
    );
    const usdt = usdtSeries[index] ?? null;
    const usdc = usdcSeries[index] ?? null;
    const usds = usdsSeries[index] ?? null;
    const dai = daiSeries[index] ?? null;
    const sky = usds !== null && dai !== null ? usds + dai : null;
    const residual = usdt !== null && usdc !== null && sky !== null ? total - usdt - usdc - sky : null;
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
