import { TRACKED_STABLECOINS } from "@shared/lib/stablecoins";
import {
  buildPriceValidationContext,
  validatePriceCandidate,
  type PriceValidationReferences,
} from "../../lib/price-validation";

const metaById = new Map(TRACKED_STABLECOINS.map((meta) => [meta.id, meta]));

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
  const meta = metaById.get(stablecoinId);

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
