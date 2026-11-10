export { deriveCurrentPegObservationMap, hasUsableCurrentPrice } from "@shared/lib/current-peg-observations";
export type { CurrentPegObservation } from "@shared/lib/current-peg-observations";
import { getDexTrustPolicy, isAffirmativeDexPriceRow, isTrustedDexPriceRow, readDexAggregateObservedAt } from "./depeg-trust-policy";
import type { CurrentPegDexPrice } from "@shared/lib/current-peg-observations";

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
      ...row, expiresAt: Math.min(row.updated_at, aggregateObservedAt) + getDexTrustPolicy("ui").maxAgeSec,
    });
  }
  return prices;
}
