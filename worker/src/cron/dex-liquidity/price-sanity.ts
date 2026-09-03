import { pegTypeFromCurrency } from "@shared/lib/peg-taxonomy";
import { WORKER_TRACKED_META_BY_ID } from "@shared/lib/stablecoins/worker-runtime-registry";
import {
  buildPriceValidationContext,
  validatePriceCandidate,
  type PriceValidationReferences,
} from "../../lib/price-validation";

/** Peg-aware sanity gate for DEX price observations across all tracked stablecoin types. */
export function isPlausibleDexObservationPrice(
  stablecoinId: string,
  price: number,
  references?: PriceValidationReferences,
): boolean {
  const meta = WORKER_TRACKED_META_BY_ID.get(stablecoinId);

  const context = buildPriceValidationContext({
    stablecoinId,
    pegCurrency: meta?.pegCurrency,
    pegType: pegTypeFromCurrency(meta?.pegCurrency),
    navToken: meta?.navToken,
    commodityOunces: meta?.commodityOunces,
  });
  const decision = validatePriceCandidate(price, context, "dex_observation", references);

  return decision.accepted;
}
