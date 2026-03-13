import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins";
import {
  buildPriceValidationContext,
  validatePriceCandidate,
  type PriceValidationReferences,
} from "../../lib/price-validation";

function pegTypeFromCurrency(pegCurrency: string | undefined): string | undefined {
  if (!pegCurrency || pegCurrency === "VAR" || pegCurrency === "OTHER") {
    return undefined;
  }
  // DefiLlama uses peggedREAL for BRL-pegged assets.
  if (pegCurrency === "BRL") {
    return "peggedREAL";
  }
  return `pegged${pegCurrency}`;
}

/** Peg-aware sanity gate for DEX price observations across all tracked stablecoin types. */
export function isPlausibleDexObservationPrice(
  stablecoinId: string,
  price: number,
  references?: PriceValidationReferences,
): boolean {
  const meta = TRACKED_META_BY_ID.get(stablecoinId);

  const context = buildPriceValidationContext({
    stablecoinId,
    pegCurrency: meta?.flags.pegCurrency,
    pegType: pegTypeFromCurrency(meta?.flags.pegCurrency),
    navToken: meta?.flags.navToken,
    commodityOunces: meta?.commodityOunces,
  });
  const decision = validatePriceCandidate(price, context, "dex_observation", references);

  return decision.accepted;
}
