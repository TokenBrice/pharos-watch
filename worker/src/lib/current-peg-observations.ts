export { deriveCurrentPegObservationMap, hasUsableCurrentPrice } from "@shared/lib/current-peg-observations";
export type { CurrentPegObservation } from "@shared/lib/current-peg-observations";
import { isAffirmativeDexPriceRow, isTrustedDexPriceRow, readDexAggregateObservedAt } from "./depeg-trust-policy";
import type { CurrentPegDexPrice } from "@shared/lib/current-peg-observations";

export interface CurrentPegDexRow extends CurrentPegDexPrice {
  stablecoin_id: string;
  updated_at: number;
  price_sources_json: string | null;
}

/** Successful reads still need original aggregate-clock admission before an affirmative verdict. */
export function selectCurrentPegDexPrices(rows: CurrentPegDexRow[], now: number): Map<string, CurrentPegDexPrice> {
  return new Map(rows.filter((row) => isTrustedDexPriceRow(row, now, "ui") && isAffirmativeDexPriceRow({
    ...row, aggregateObservedAt: readDexAggregateObservedAt(row.price_sources_json, now),
  }, now, "ui")).map((row) => [row.stablecoin_id, row]));
}
