import { isKinesisWrapperSupplyId } from "@shared/lib/onchain-supply-probe";
import { CACHE_FRESHNESS_LANES } from "@shared/lib/api-freshness";
import { DAY_SECONDS } from "@shared/lib/time-constants";
import { classifySupplyCoverage, parseSupplyObservationProvenance } from "@shared/lib/supply-provenance";
import { isAmbiguousSupplyPerimeterDay, isEarlierSupplyPerimeter } from "@shared/lib/supply-perimeter-changes";

export interface NativeSupplyHistoryRow {
  stablecoin_id: string;
  snapshot_date: number;
  circulating_native?: number | null;
  supply_provenance?: string | null;
}

export const SUPPLY_SNAPSHOT_MAX_AGE_SEC = 2 * CACHE_FRESHNESS_LANES.stablecoins.producerIntervalSec;

export function isDailyStockObservation(id: string, day: number, observedAt: number, through: number): boolean {
  return Number.isSafeInteger(observedAt) && observedAt > 0 && observedAt <= through &&
    observedAt >= day - SUPPLY_SNAPSHOT_MAX_AGE_SEC && observedAt < day + DAY_SECONDS &&
    !isAmbiguousSupplyPerimeterDay(id, day) && isEarlierSupplyPerimeter(id, observedAt) === isEarlierSupplyPerimeter(id, day);
}

/** A missing count or clock selects legacy history. Malformed reported evidence still requires admission. */
export function hasNativeSupplyEvidence(row: NativeSupplyHistoryRow | undefined): boolean {
  if (row?.circulating_native == null) return false;
  const { provenance, invalid } = parseSupplyObservationProvenance(row.supply_provenance);
  return invalid || provenance?.supplyObservedAt != null;
}

export function readNativeSupplyCheckpoint(row: NativeSupplyHistoryRow, through: number) {
  const quantity = row.circulating_native;
  const { provenance } = parseSupplyObservationProvenance(row.supply_provenance);
  const observedAt = provenance?.supplyObservedAt;
  if (quantity == null || !Number.isFinite(quantity) || quantity < 0 ||
    observedAt == null || !isDailyStockObservation(row.stablecoin_id, row.snapshot_date, observedAt, through) ||
    classifySupplyCoverage(provenance) !== "complete" || !isComparableNativeSupplySource(row.stablecoin_id, provenance?.supplySource)) return null;
  return { quantity, observedAt };
}

export function isComparableNativeSupplySource(id: string, source: string | null | undefined): boolean {
  if (id === "xaut-tether") return source === "onchain-circulating-supply";
  if (isKinesisWrapperSupplyId(id)) return source === "onchain-total-supply";
  return true;
}

export function hasComparableSupplyPerimeter(stablecoinId: string, current: number, baseline: number): boolean {
  return baseline < current &&
    !isAmbiguousSupplyPerimeterDay(stablecoinId, current) && !isAmbiguousSupplyPerimeterDay(stablecoinId, baseline) &&
    isEarlierSupplyPerimeter(stablecoinId, baseline) === isEarlierSupplyPerimeter(stablecoinId, current);
}

export function isMissingNativeSupplyColumn(error: unknown): boolean {
  return error instanceof Error &&
    /no such column: (?:h\.|supply_history\.)?(circulating_native|valuation_price_usd|valuation_observed_at_sec)\b/i.test(error.message);
}
