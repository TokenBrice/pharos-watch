import { logWorkerEventArgs } from "./structured-log";
import { normalizeLegacyPegType } from "@shared/lib/peg-price-bounds";
import { pegTypeFromCurrency as canonicalPegTypeFromCurrency } from "@shared/lib/peg-taxonomy";
import { CORE_AGGREGATE_ACTIVE_STABLECOINS } from "@shared/lib/stablecoins/aggregate-registry";
import { findAsOfSnapshot, MAX_SUPPLY_SNAPSHOT_DISTANCE_SEC } from "@shared/lib/rate-series";
import type { StablecoinChartPoint } from "@shared/types";

interface StructuralSupplementalChartConfig {
  id: string;
  pegType: string;
}

export interface SupplyHistoryChartRow {
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
  return canonicalPegTypeFromCurrency(pegCurrency) ?? null;
}

export const STRUCTURAL_SUPPLEMENTAL_CHART_CONFIGS: StructuralSupplementalChartConfig[] =
  CORE_AGGREGATE_ACTIVE_STABLECOINS
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
        logWorkerEventArgs("lib", "warn",
          `[stablecoin-charts] skipping ${meta.id}: unsupported peg currency ${meta.flags.pegCurrency}`,
        );
        return [];
      }
      return [{ id: meta.id, pegType }];
    });

function addBucketValue(target: Record<string, number | null>, pegType: string, value: number): void {
  if (!Number.isFinite(value) || value < 0) return;
  const normalized = normalizeLegacyPegType(pegType);
  if (target[normalized] === null) return;
  target[normalized] = (target[normalized] ?? 0) + value;
}

export function mergeStructuralSupplementalHistoryIntoCharts(
  basePoints: StablecoinChartPoint[],
  rows: SupplyHistoryChartRow[],
  configs: readonly StructuralSupplementalChartConfig[] = STRUCTURAL_SUPPLEMENTAL_CHART_CONFIGS,
): StablecoinChartPoint[] {
  if (basePoints.length === 0 || configs.length === 0) {
    return basePoints;
  }

  const configById = new Map(configs.map((config) => [config.id, config]));
  const rowsById = new Map<string, Array<{ date: number; circulatingUsd: number }>>();

  for (const row of rows) {
    const config = configById.get(row.stablecoin_id);
    if (
      !config ||
      !Number.isFinite(row.snapshot_date) ||
      row.snapshot_date <= 0 ||
      !Number.isFinite(row.circulating_usd) ||
      row.circulating_usd < 0
    ) continue;
    const series = rowsById.get(row.stablecoin_id) ?? [];
    series.push({ date: row.snapshot_date, circulatingUsd: row.circulating_usd });
    rowsById.set(row.stablecoin_id, series);
  }

  const state = configs.map((config) => ({
    pegType: config.pegType,
    series: (rowsById.get(config.id) ?? []).sort((left, right) => left.date - right.date),
  }));

  const orderedBase = [...basePoints].sort((left, right) => left.date - right.date);
  return orderedBase.map((point) => {
    const totals = { ...point.totalCirculatingUSD };

    for (const overlay of state) {
      const snapshot = findAsOfSnapshot(
        overlay.series,
        point.date,
        (row) => row.date,
        MAX_SUPPLY_SNAPSHOT_DISTANCE_SEC,
      );
      // Supplemental archives extend the observed provider universe; an absent
      // overlay is not evidence that the provider's own bucket is unavailable.
      if (snapshot) addBucketValue(totals, overlay.pegType, snapshot.circulatingUsd);
    }

    return {
      ...point,
      totalCirculatingUSD: totals,
    };
  });
}

