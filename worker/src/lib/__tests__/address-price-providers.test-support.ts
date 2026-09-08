import type { AddressPriceTarget } from "../address-price-providers/types";

export function makeTarget(overrides: Partial<AddressPriceTarget> = {}): AddressPriceTarget {
  return {
    stablecoinId: "fixture-usd",
    symbol: "FUSD",
    chain: "base",
    providerChainId: "base",
    address: "0x0000000000000000000000000000000000000001",
    origin: "contracts",
    previousSourceDepth: 1,
    previousMissingGenerations: 0,
    alertEligibleMissingPrice: false,
    recentlyMissingPrice: false,
    missingPrice: false,
    expiresBeforeNextGeneration: false,
    circulatingUsd: 1_000_000,
    ...overrides,
  };
}

export function coingeckoResponse(address: string, price: string, liquidity: string, volume?: string) {
  return Response.json({ data: [{ attributes: {
    address,
    price_usd: price,
    total_reserve_in_usd: liquidity,
    ...(volume === undefined ? {} : { volume_usd: { h24: volume } }),
  } }] });
}
