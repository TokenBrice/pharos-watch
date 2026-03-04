import { TRACKED_STABLECOINS } from "../../../../src/lib/stablecoins";
import { isReasonablePrice } from "../enrich-prices";

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
export function isPlausibleDexObservationPrice(stablecoinId: string, price: number): boolean {
  const meta = metaById.get(stablecoinId);
  if (!meta) {
    return Number.isFinite(price) && price > 0 && price < 100_000;
  }

  return isReasonablePrice(
    price,
    pegTypeFromCurrency(meta.flags.pegCurrency),
    undefined,
    { navToken: !!meta.flags.navToken },
  );
}
