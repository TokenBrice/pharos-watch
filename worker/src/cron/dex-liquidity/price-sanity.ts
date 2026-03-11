import { TRACKED_STABLECOINS } from "@shared/lib/stablecoins";
import { buildPriceReasonablenessOptions, isReasonablePrice } from "../enrich-prices";
import {
  buildPriceValidationContext,
  validatePriceCandidate,
  type PriceValidationReferences,
} from "../../lib/price-validation";

const metaById = new Map(TRACKED_STABLECOINS.map((meta) => [meta.id, meta]));

export interface DexPriceValidationShadowStats {
  comparedObs: number;
  acceptedOld: number;
  acceptedNew: number;
  deltaAccepted: number;
  sampleRejectedByNew: Array<{
    stablecoinId: string;
    symbol: string;
    price: number;
    reasonCode: string;
    referenceType: string;
  }>;
}

const EMPTY_SHADOW_STATS = (): DexPriceValidationShadowStats => ({
  comparedObs: 0,
  acceptedOld: 0,
  acceptedNew: 0,
  deltaAccepted: 0,
  sampleRejectedByNew: [],
});

let shadowStats: DexPriceValidationShadowStats = EMPTY_SHADOW_STATS();

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

export function resetDexPriceValidationShadowStats(): void {
  shadowStats = EMPTY_SHADOW_STATS();
}

export function getDexPriceValidationShadowStats(): DexPriceValidationShadowStats {
  return {
    ...shadowStats,
    deltaAccepted: shadowStats.acceptedNew - shadowStats.acceptedOld,
    sampleRejectedByNew: [...shadowStats.sampleRejectedByNew],
  };
}

/** Peg-aware sanity gate for DEX price observations across all tracked stablecoin types. */
export function isPlausibleDexObservationPrice(
  stablecoinId: string,
  price: number,
  references?: PriceValidationReferences,
): boolean {
  const meta = metaById.get(stablecoinId);
  const legacyAccepted = meta
    ? isReasonablePrice(
        price,
        pegTypeFromCurrency(meta.flags.pegCurrency),
        undefined,
        buildPriceReasonablenessOptions({
          navToken: meta.flags.navToken,
          commodityOunces: meta.commodityOunces,
        }),
      )
    : Number.isFinite(price) && price > 0 && price < 100_000;

  const context = buildPriceValidationContext({
    stablecoinId,
    pegCurrency: meta?.flags.pegCurrency,
    pegType: pegTypeFromCurrency(meta?.flags.pegCurrency),
    navToken: meta?.flags.navToken,
    commodityOunces: meta?.commodityOunces,
  });
  const decision = validatePriceCandidate(price, context, "dex_observation", references);

  shadowStats.comparedObs += 1;
  if (legacyAccepted) shadowStats.acceptedOld += 1;
  if (decision.accepted) shadowStats.acceptedNew += 1;
  if (
    legacyAccepted &&
    !decision.accepted &&
    shadowStats.sampleRejectedByNew.length < 10
  ) {
    shadowStats.sampleRejectedByNew.push({
      stablecoinId,
      symbol: meta?.symbol ?? stablecoinId,
      price,
      reasonCode: decision.reasonCode,
      referenceType: decision.referenceType,
    });
  }

  return decision.accepted;
}
