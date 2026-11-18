import { hasComparablePegQuote } from "@shared/lib/current-peg-projection";
import { deriveCurrentPegObservationMap } from "@shared/lib/current-peg-observations";
import { hasPublishedDeviation } from "@shared/lib/depeg-signals";
import type { StablecoinData } from "@shared/types/supply";
export { deriveCurrentPegObservationMap, hasUsableCurrentPrice } from "@shared/lib/current-peg-observations";
export type { CurrentPegObservation } from "@shared/lib/current-peg-observations";
import { getDexTrustPolicy, isAffirmativeDexPriceRow, isTrustedDexPriceRow, readDexAggregateObservedAt } from "./depeg-trust-policy";
import type { CurrentPegDexPrice } from "@shared/lib/current-peg-observations";

/** Older cache generations can precede the per-asset block. Derive their cohort just once. */
export function createCurrentPegReader(options: Parameters<typeof deriveCurrentPegObservationMap>[0]) {
  let observations: ReturnType<typeof deriveCurrentPegObservationMap> | undefined;
  return (asset: StablecoinData) => {
    const peg = asset.currentPeg;
    if (peg && (hasPublishedDeviation(peg) || options.fxReferenceObservations === undefined)) {
      if (!hasComparablePegQuote(asset)) {
        return { ...peg, currentDeviationBps: null, pegReference: null, pegReferenceUnavailable: true };
      }
      return peg;
    }
    observations ??= deriveCurrentPegObservationMap(options);
    return observations.get(asset.id);
  };
}

export interface CurrentPegDexRow extends Omit<CurrentPegDexPrice, "expiresAt"> {
  stablecoin_id: string;
  updated_at: number;
  price_sources_json: string | null;
}

/** Successful reads still need original aggregate-clock admission before an affirmative verdict. */
export function selectCurrentPegDexPrices(rows: CurrentPegDexRow[], now: number): Map<string, CurrentPegDexPrice> {
  const prices = new Map<string, CurrentPegDexPrice>();
  for (const row of rows) {
    if (!isTrustedDexPriceRow(row, now, "ui")) continue;
    const aggregateObservedAt = readDexAggregateObservedAt(row.price_sources_json, now);
    if (aggregateObservedAt == null || !isAffirmativeDexPriceRow({ ...row, aggregateObservedAt }, now, "ui")) continue;
    prices.set(row.stablecoin_id, {
      ...row, observedAtSec: aggregateObservedAt, expiresAt: Math.min(row.updated_at, aggregateObservedAt) + getDexTrustPolicy("ui").maxAgeSec,
    });
  }
  return prices;
}
