import type { StablecoinMeta } from "@shared/types";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";

export type StablecoinStaticMeta = Pick<StablecoinMeta, "id" | "name" | "symbol" | "flags"> & {
  /** Registry symbol of the NAV reference asset, when the coin declares one. */
  pegReferenceSymbol?: string;
};

export function buildStablecoinStaticMeta(
  coin: StablecoinMeta,
): StablecoinStaticMeta {
  return {
    id: coin.id,
    name: coin.name,
    symbol: coin.symbol,
    flags: coin.flags,
    pegReferenceSymbol: coin.pegReferenceId
      ? TRACKED_META_BY_ID.get(coin.pegReferenceId)?.symbol
      : undefined,
  };
}
