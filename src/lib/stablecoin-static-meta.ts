import type { StablecoinMeta } from "@shared/types";

export type StablecoinStaticMeta = Pick<StablecoinMeta, "id" | "name" | "symbol" | "flags">;

export function buildStablecoinStaticMeta(
  coin: StablecoinMeta,
): StablecoinStaticMeta {
  return {
    id: coin.id,
    name: coin.name,
    symbol: coin.symbol,
    flags: coin.flags,
  };
}
