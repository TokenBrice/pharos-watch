import { logWorkerEventArgs } from "./structured-log";
import { normalizeLegacyPegType } from "@shared/lib/peg-price-bounds";
import { pegTypeFromCurrency as canonicalPegTypeFromCurrency } from "@shared/lib/peg-taxonomy";
import { CORE_AGGREGATE_ACTIVE_STABLECOINS } from "@shared/lib/stablecoins/aggregate-registry";
import { CORE_STABLECOIN_AGGREGATE_V2_CUTOVER_SEC } from "@shared/lib/stablecoins/aggregate-universe";
import { CORE_AGGREGATE_V1_MEMBER_IDS } from "@shared/lib/stablecoins/aggregate-universe-v1";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { findAsOfSnapshot, MAX_SUPPLY_SNAPSHOT_DISTANCE_SEC } from "@shared/lib/rate-series";
import type { StablecoinMeta } from "@shared/types/stablecoin-meta-schemas";
import type { StablecoinChartPoint } from "@shared/types/supply";

export interface StructuralSupplementalChartConfig {
  id: string;
  pegType: string;
  activeFrom?: number;
  inactiveFrom?: number;
}

export interface SupplyHistoryChartRow {
  stablecoin_id: string;
  snapshot_date: number;
  circulating_usd: number;
}

const DEFILLAMA_CHART_ABSENT_LEGACY_IDS = new Set(["brz-transfero"]);
// DefiLlama charts these assets under its own stablecoin ids even though the
// registry entry carries no `llamaId`; an overlay would add them to DefiLlama's
// already-populated bucket twice. Reviewed exclusions, not inferred identities.
const DEFILLAMA_CHART_PRESENT_WITHOUT_LLAMA_ID = new Set([
  // DefiLlama stablecoin id 430, peggedUSD chart rows.
  "sofid-sofi",
]);


function pegTypeFromCurrency(pegCurrency: string): string | null {
  // VAR/OTHER have no canonical peg-type key; the shared helper returns
  // undefined for them, so fall back to `pegged${currency}` to preserve the
  // historical bucketing behavior here.
  if (pegCurrency === "VAR" || pegCurrency === "OTHER") {
    return `pegged${pegCurrency}`;
  }
  return canonicalPegTypeFromCurrency(pegCurrency) ?? null;
}

function isStructuralSupplementalCandidate(meta: StablecoinMeta): boolean {
  return Boolean(
    meta.detailProvider
    && meta.detailProvider !== "defillama"
    && (!meta.llamaId || DEFILLAMA_CHART_ABSENT_LEGACY_IDS.has(meta.id))
    && !DEFILLAMA_CHART_PRESENT_WITHOUT_LLAMA_ID.has(meta.id),
  );
}

function toStructuralSupplementalConfig(meta: StablecoinMeta): StructuralSupplementalChartConfig | null {
  if (!isStructuralSupplementalCandidate(meta)) return null;
  const pegType = pegTypeFromCurrency(meta.flags.pegCurrency);
  if (!pegType) {
    // Skip rather than throw so a new peg currency can roll out without a
    // simultaneous worker code change crashing the Worker on startup.
    logWorkerEventArgs("lib", "warn",
      `[stablecoin-charts] skipping ${meta.id}: unsupported peg currency ${meta.flags.pegCurrency}`,
    );
    return null;
  }
  return { id: meta.id, pegType };
}

/**
 * Date-fenced structural supplemental chart overlays across the listing-policy v2
 * cutover: pre-cutover chart dates retain frozen v1 overlays so past history is not
 * restated, while cutover-and-later dates use current v2 core aggregate membership.
 */
export function buildDateFencedSupplementalChartConfigs(
  v1ActiveIds: ReadonlySet<string> = CORE_AGGREGATE_V1_MEMBER_IDS,
  v2ActiveCoins: readonly StablecoinMeta[] = CORE_AGGREGATE_ACTIVE_STABLECOINS,
  trackedMetaById: ReadonlyMap<string, StablecoinMeta> = TRACKED_META_BY_ID,
  cutoverSec: number = CORE_STABLECOIN_AGGREGATE_V2_CUTOVER_SEC,
): StructuralSupplementalChartConfig[] {
  const v2Ids = new Set(v2ActiveCoins.map((meta) => meta.id));
  const configs: StructuralSupplementalChartConfig[] = [];
  const seen = new Set<string>();

  for (const meta of v2ActiveCoins) {
    const base = toStructuralSupplementalConfig(meta);
    if (!base) continue;
    seen.add(meta.id);
    configs.push(v1ActiveIds.has(meta.id) ? base : { ...base, activeFrom: cutoverSec });
  }

  for (const id of v1ActiveIds) {
    if (seen.has(id) || v2Ids.has(id)) continue;
    const meta = trackedMetaById.get(id);
    if (!meta) continue;
    const base = toStructuralSupplementalConfig(meta);
    if (!base) continue;
    seen.add(id);
    configs.push({ ...base, inactiveFrom: cutoverSec });
  }

  return configs;
}

export const STRUCTURAL_SUPPLEMENTAL_CHART_OVERLAYS: StructuralSupplementalChartConfig[] =
  buildDateFencedSupplementalChartConfigs();

function addBucketValue(target: Record<string, number | null>, pegType: string, value: number): void {
  if (!Number.isFinite(value) || value < 0) return;
  const normalized = normalizeLegacyPegType(pegType);
  if (target[normalized] === null) return;
  target[normalized] = (target[normalized] ?? 0) + value;
}

export function mergeStructuralSupplementalHistoryIntoCharts(
  basePoints: StablecoinChartPoint[],
  rows: SupplyHistoryChartRow[],
  configs: readonly StructuralSupplementalChartConfig[] = STRUCTURAL_SUPPLEMENTAL_CHART_OVERLAYS,
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
    activeFrom: config.activeFrom,
    inactiveFrom: config.inactiveFrom,
    series: (rowsById.get(config.id) ?? []).sort((left, right) => left.date - right.date),
  }));

  const orderedBase = [...basePoints].sort((left, right) => left.date - right.date);
  return orderedBase.map((point) => {
    const totals = { ...point.totalCirculatingUSD };

    for (const overlay of state) {
      if (overlay.activeFrom != null && point.date < overlay.activeFrom) continue;
      if (overlay.inactiveFrom != null && point.date >= overlay.inactiveFrom) continue;
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

