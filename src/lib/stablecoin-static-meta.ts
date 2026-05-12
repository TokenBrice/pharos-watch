import type { StablecoinMeta } from "@shared/types";

export type StablecoinStaticMeta = Pick<StablecoinMeta, "id" | "name" | "symbol" | "flags"> & {
  hasCollateralUsage: boolean;
};

export function buildStablecoinStaticMeta(
  coin: StablecoinMeta,
  options: { hasCollateralUsage?: boolean } = {},
): StablecoinStaticMeta {
  return {
    id: coin.id,
    name: coin.name,
    symbol: coin.symbol,
    flags: coin.flags,
    hasCollateralUsage: options.hasCollateralUsage ?? false,
  };
}
