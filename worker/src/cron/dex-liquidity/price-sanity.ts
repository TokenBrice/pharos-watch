import { pegTypeFromCurrency } from "@shared/lib/peg-taxonomy";
import { WORKER_TRACKED_META_BY_ID } from "@shared/lib/stablecoins/worker-runtime-registry";
import {
  buildPriceValidationContext,
  validatePriceCandidate,
  FIAT_UPPER_BAND_REQUIRES_CORROBORATION,
  type PriceValidationReferences,
} from "../../lib/price-validation";

export function classifyDexObservationPrice(
  stablecoinId: string,
  price: number,
  references?: PriceValidationReferences,
) {
  const meta = WORKER_TRACKED_META_BY_ID.get(stablecoinId);

  const context = buildPriceValidationContext({
    stablecoinId,
    pegCurrency: meta?.pegCurrency,
    pegType: pegTypeFromCurrency(meta?.pegCurrency),
    navToken: meta?.navToken,
    commodityOunces: meta?.commodityOunces,
  });
  const decision = validatePriceCandidate(price, context, "dex_observation", references);

  if (decision.accepted) return "accepted";
  return decision.reasonCode === FIAT_UPPER_BAND_REQUIRES_CORROBORATION ? "provisional" : "rejected";
}

const provisionalIntake = Symbol("provisional-dex-intake");

// Only the private exact-observation collection pass may retain an unconfirmed premium.
export function forDexPriceCandidateCollection(references: PriceValidationReferences) {
  return { ...references, [provisionalIntake]: true as const };
}

export function isPlausibleDexObservationPrice(
  stablecoinId: string,
  price: number,
  references?: PriceValidationReferences,
): boolean {
  const status = classifyDexObservationPrice(stablecoinId, price, references);
  return status === "accepted" || (status === "provisional" && references != null &&
    provisionalIntake in references && references[provisionalIntake] === true);
}
