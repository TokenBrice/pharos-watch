import type { StablecoinMeta } from "@shared/types/core";
import type { adaptChainlinkPorResponse } from "../chainlink-por";

type Supply = NonNullable<Parameters<typeof adaptChainlinkPorResponse>[2]>;

export function makePorSupply(overrides: Partial<Supply> = {}): Supply {
  return {
    contributions: [{
      chain: "ethereum",
      tokenAddress: "0x0000000000000000000000000000000000000001",
      raw: 1000_000000000000000000n,
      decimals: 18,
    }],
    omittedNonEvmChains: [],
    omittedReadFailureChains: [],
    ...overrides,
  };
}

export function makePorCoin(overrides: Partial<StablecoinMeta> = {}): StablecoinMeta {
  return {
    id: "tusd-test",
    name: "TUSD Test",
    symbol: "TUSDT",
    flags: {
      backing: "rwa-backed",
      pegCurrency: "USD",
      governance: "centralized",
      yieldBearing: false,
      rwa: false,
      navToken: false,
    },
    ...overrides,
  };
}
