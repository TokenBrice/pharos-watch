import type { StablecoinFlags, StablecoinMeta } from "../../../types";

export const CANONICAL_STABLECOIN_FLAGS: StablecoinFlags = {
  pegCurrency: "USD",
  governance: "centralized",
  backing: "rwa-backed",
  yieldBearing: false,
  rwa: true,
  navToken: false,
};

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
