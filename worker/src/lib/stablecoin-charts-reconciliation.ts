import { normalizeLegacyPegType, normalizePegTypeFromCurrency } from "@shared/lib/peg-price-bounds";
import { ACTIVE_STABLECOINS } from "@shared/lib/stablecoins/registry";
import type { StablecoinChartPoint, StablecoinData } from "@shared/types";

interface StructuralSupplementalChartConfig {
  id: string;
  pegType: string;
}

interface SupplyHistoryChartRow {
  stablecoin_id: string;
  snapshot_date: number;
  circulating_usd: number;
}

const DEFILLAMA_CHART_ABSENT_LEGACY_IDS = new Set(["brz-transfero"]);


function pegTypeFromCurrency(pegCurrency: string): string | null {
  // VAR/OTHER have no canonical peg-type key; the shared helper returns
  // undefined for them, so fall back to `pegged${currency}` to preserve the
  // historical bucketing behavior here.
  if (pegCurrency === "VAR" || pegCurrency === "OTHER") {
    return `pegged${pegCurrency}`;
  }
  return normalizePegTypeFromCurrency(pegCurrency) ?? null;
}

export const STRUCTURAL_SUPPLEMENTAL_CHART_CONFIGS: StructuralSupplementalChartConfig[] =
  ACTIVE_STABLECOINS
    .filter((meta) =>
      meta.detailProvider
      && meta.detailProvider !== "defillama"
      && (!meta.llamaId || DEFILLAMA_CHART_ABSENT_LEGACY_IDS.has(meta.id))
    )
    .flatMap((meta) => {
      const pegType = pegTypeFromCurrency(meta.flags.pegCurrency);
      if (!pegType) {
        // Skip rather than throw so a new peg currency can roll out without a
        // simultaneous worker code change crashing the Worker on startup.
        console.warn(
          `[stablecoin-charts] skipping ${meta.id}: unsupported peg currency ${meta.flags.pegCurrency}`,
        );
        return [];
      }
      return [{ id: meta.id, pegType }];
    });

function addBucketValue(target: Record<string, number>, pegType: string, value: number): void {
  if (!Number.isFinite(value) || value === 0) return;
  const normalized = normalizeLegacyPegType(pegType);
  target[normalized] = (target[normalized] ?? 0) + value;
}

export function mergeStructuralSupplementalHistoryIntoCharts(
  basePoints: StablecoinChartPoint[],
  rows: SupplyHistoryChartRow[],
  configs: readonly StructuralSupplementalChartConfig[] = STRUCTURAL_SUPPLEMENTAL_CHART_CONFIGS,
): StablecoinChartPoint[] {
  if (basePoints.length === 0 || rows.length === 0 || configs.length === 0) {
    return basePoints;
  }

  const configById = new Map(configs.map((config) => [config.id, config]));
  const rowsById = new Map<string, Array<{ date: number; circulatingUsd: number }>>();

  for (const row of rows) {
    const config = configById.get(row.stablecoin_id);
    if (!config || !Number.isFinite(row.circulating_usd) || row.circulating_usd <= 0) continue;
    const series = rowsById.get(row.stablecoin_id) ?? [];
    series.push({ date: row.snapshot_date, circulatingUsd: row.circulating_usd });
    rowsById.set(row.stablecoin_id, series);
  }

  const state = configs
    .map((config) => {
      const series = rowsById.get(config.id);
      if (!series || series.length === 0) return null;
      series.sort((left, right) => left.date - right.date);
      return {
        pegType: config.pegType,
        series,
        index: 0,
        lastValue: 0,
      };
    })
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null);

  if (state.length === 0) return basePoints;

  const orderedBase = [...basePoints].sort((left, right) => left.date - right.date);
  return orderedBase.map((point) => {
    const totals = { ...point.totalCirculatingUSD };

    for (const overlay of state) {
      while (
        overlay.index < overlay.series.length &&
        overlay.series[overlay.index]!.date <= point.date
      ) {
        overlay.lastValue = overlay.series[overlay.index]!.circulatingUsd;
        overlay.index += 1;
      }
      addBucketValue(totals, overlay.pegType, overlay.lastValue);
    }

    return {
      ...point,
      totalCirculatingUSD: totals,
    };
  });
}

export function buildCurrentStablecoinChartsPoint(
  assets: StablecoinData[],
  updatedAtSec: number,
): StablecoinChartPoint | null {
  const totals: Record<string, number> = {};

  for (const asset of assets) {
    const circulating = asset.circulating;
    if (!circulating || typeof circulating !== "object") continue;

    for (const [pegType, rawValue] of Object.entries(circulating)) {
      const value = typeof rawValue === "number" && Number.isFinite(rawValue) ? rawValue : 0;
      addBucketValue(totals, pegType, value);
    }
  }

  if (Object.keys(totals).length === 0) return null;

  return {
    date: updatedAtSec,
    totalCirculatingUSD: totals,
  };
}

export function appendOrReplaceCurrentStablecoinChartsPoint(
  points: StablecoinChartPoint[],
  currentPoint: StablecoinChartPoint | null,
): StablecoinChartPoint[] {
  if (!currentPoint) return points;
  if (points.length === 0) return [currentPoint];

  const next = [...points].sort((left, right) => left.date - right.date);
  const lastPoint = next[next.length - 1];
  if (!lastPoint) return [currentPoint];

  if (currentPoint.date === lastPoint.date) {
    next[next.length - 1] = {
      ...currentPoint,
      date: lastPoint.date,
    };
    return next;
  }

  if (currentPoint.date < lastPoint.date) {
    return next;
  }

  next.push(currentPoint);
  return next;
}
