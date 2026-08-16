import type { StablecoinData, StablecoinMeta } from "@shared/types";

export const TEST_STABLECOIN_TIMESTAMP_SEC = 1_700_000_000;

export function makeStablecoin(overrides: Partial<StablecoinData> = {}): StablecoinData {
  const pegType = overrides.pegType ?? "peggedUSD";
  return {
    id: "usdc-circle",
    name: "USD Coin",
    symbol: "USDC",
    geckoId: null,
    pegType,
    pegMechanism: "fiat-backed",
    price: 1,
    priceSource: "test",
    priceConfidence: null,
    priceUpdatedAt: null,
    priceObservedAt: null,
    priceObservedAtMode: null,
    priceSyncedAt: null,
    consensusSources: [],
    agreeSources: [],
    supplySource: undefined,
    circulating: { [pegType]: 1_000_000 },
    circulatingPrevDay: {},
    circulatingPrevWeek: {},
    circulatingPrevMonth: {},
    chainCirculating: {},
    chains: [],
    ...overrides,
  } as StablecoinData;
}

export function makeStablecoinMeta(overrides: Partial<StablecoinMeta> = {}): StablecoinMeta {
  return {
    id: "test-coin",
    name: "Test Coin",
    symbol: "TEST",
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
