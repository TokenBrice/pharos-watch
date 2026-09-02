import type { StablecoinFlags, StablecoinMeta } from "../../../types";

export const CANONICAL_STABLECOIN_FLAGS: StablecoinFlags = {
  pegCurrency: "USD",
  governance: "centralized",
  backing: "rwa-backed",
  yieldBearing: false,
  rwa: true,
  navToken: false,
};

export const NON_RWA_STABLECOIN_FLAGS: StablecoinFlags = {
  ...CANONICAL_STABLECOIN_FLAGS,
  rwa: false,
};

export const YIELD_BEARING_NAV_STABLECOIN_FLAGS: StablecoinFlags = {
  ...NON_RWA_STABLECOIN_FLAGS,
  yieldBearing: true,
  navToken: true,
};

interface CatalogCoinOverrides extends Partial<StablecoinMeta> {
  id: string;
}

export function makeCatalogCoin(overrides: CatalogCoinOverrides): StablecoinMeta {
  return makeStablecoinMeta({
    name: overrides.id,
    symbol: overrides.id.toUpperCase(),
    ...overrides,
  });
}

export function makeRawStablecoinMeta(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: "fixture-usd",
    name: "Fixture USD",
    symbol: "FUSD",
    flags: CANONICAL_STABLECOIN_FLAGS,
    ...overrides,
  };
}

export function makeStablecoinMeta(
  overrides: Partial<StablecoinMeta> = {},
): StablecoinMeta {
  return {
    id: "fixture-usd",
    name: "Fixture USD",
    symbol: "FUSD",
    flags: CANONICAL_STABLECOIN_FLAGS,
    ...overrides,
  } as StablecoinMeta;
}
