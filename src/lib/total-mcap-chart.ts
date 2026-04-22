import { getCirculatingRaw } from "@shared/lib/supply";
import type { StablecoinChartPoint, StablecoinListResponse, SupplyHistoryPoint } from "@shared/types";

export interface TotalMcapChartRow {
  ts: number;
  usdt: number;
  usdc: number;
  sky: number;
  others: number;
  total: number;
}

function alignHistoryAtOrBeforeDate(
  chartPoints: StablecoinChartPoint[],
  history: SupplyHistoryPoint[],
): number[] {
  const sortedHistory = [...history].sort((a, b) => a.date - b.date);
  const aligned: number[] = [];
  let historyIndex = 0;
  let lastValue = 0;

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

export function buildCurrentTotalMcapRow(
  stablecoinsData: StablecoinListResponse | undefined,
  timestampMs: number,
): TotalMcapChartRow | null {
  const assets = stablecoinsData?.peggedAssets;
  if (!assets?.length) return null;

  let total = 0;
  let usdt = 0;
  let usdc = 0;
  let sky = 0;

  for (const asset of assets) {
    const mcap = getCirculatingRaw(asset);
    total += mcap;

    if (asset.id === "usdt-tether") {
      usdt += mcap;
    } else if (asset.id === "usdc-circle") {
      usdc += mcap;
    } else if (asset.id === "usds-sky" || asset.id === "dai-makerdao") {
      sky += mcap;
    }
  }

  if (total <= 0) return null;

  return {
    ts: timestampMs,
    usdt,
    usdc,
    sky,
    others: Math.max(0, total - usdt - usdc - sky),
    total,
  };
}

export function buildTotalMcapChartRows(
  chartPoints: StablecoinChartPoint[],
  {
    usdtHistory,
    usdcHistory,
    usdsHistory,
    daiHistory,
  }: {
    usdtHistory: SupplyHistoryPoint[];
    usdcHistory: SupplyHistoryPoint[];
    usdsHistory: SupplyHistoryPoint[];
    daiHistory: SupplyHistoryPoint[];
  },
  currentSnapshot?: TotalMcapChartRow | null,
): TotalMcapChartRow[] {
  if (chartPoints.length === 0) return [];

  const usdtSeries = alignHistoryAtOrBeforeDate(chartPoints, usdtHistory);
  const usdcSeries = alignHistoryAtOrBeforeDate(chartPoints, usdcHistory);
  const usdsSeries = alignHistoryAtOrBeforeDate(chartPoints, usdsHistory);
  const daiSeries = alignHistoryAtOrBeforeDate(chartPoints, daiHistory);

  const rows = chartPoints.map((point, index) => {
    const total = Object.values(point.totalCirculatingUSD).reduce((sum, value) => sum + (value ?? 0), 0);
    const usdt = usdtSeries[index] ?? 0;
    const usdc = usdcSeries[index] ?? 0;
    const sky = (usdsSeries[index] ?? 0) + (daiSeries[index] ?? 0);
    const others = Math.max(0, total - usdt - usdc - sky);

    return {
      ts: Number(point.date) * 1000,
      usdt,
      usdc,
      sky,
      others,
      total,
    };
  });

  if (!currentSnapshot) return rows;

  const lastRow = rows[rows.length - 1];
  if (!lastRow) return [currentSnapshot];

  if (currentSnapshot.ts <= lastRow.ts) {
    rows[rows.length - 1] = { ...currentSnapshot, ts: lastRow.ts };
    return rows;
  }

  rows.push(currentSnapshot);
  return rows;
}
