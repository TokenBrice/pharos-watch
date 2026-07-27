import type { StablecoinData } from "@shared/types";

type TestStablecoinOverrides = Partial<StablecoinData>;

export function makeStablecoin(overrides: TestStablecoinOverrides = {}): StablecoinData {
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
