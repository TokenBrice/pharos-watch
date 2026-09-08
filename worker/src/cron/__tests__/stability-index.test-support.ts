import type { StablecoinData } from "@shared/types/market";

export function makeStabilityAsset(overrides: Partial<StablecoinData> = {}): StablecoinData {
  const nowSec = Math.floor(Date.now() / 1000);
  return {
    id: "usdt-tether", name: "Tether USD", symbol: "USDT", geckoId: "tether",
    pegType: "peggedUSD", pegMechanism: "fiat-backed", price: 1,
    priceSource: "defillama", priceConfidence: "high", priceUpdatedAt: nowSec,
    priceObservedAt: nowSec, priceObservedAtMode: "upstream", priceSyncedAt: nowSec,
    consensusSources: [], agreeSources: [], supplySource: "defillama",
    circulating: { peggedUSD: 100_000_000 }, circulatingPrevDay: { peggedUSD: 99_000_000 },
    circulatingPrevWeek: { peggedUSD: 98_000_000 }, circulatingPrevMonth: { peggedUSD: 97_000_000 },
    chainCirculating: {}, chains: [], ...overrides,
  };
}

export function makeUnpricedFalconAsset(): StablecoinData {
  return makeStabilityAsset({
    id: "usdf-falcon", name: "Falcon USD", symbol: "USDf", geckoId: "falcon-finance",
    pegMechanism: "crypto-backed", price: null, priceConfidence: null,
    priceUpdatedAt: null, priceObservedAt: null, priceObservedAtMode: null, priceSyncedAt: null,
    circulating: { peggedUSD: 93_500_000 }, circulatingPrevDay: { peggedUSD: 92_000_000 },
    circulatingPrevWeek: { peggedUSD: 90_000_000 }, circulatingPrevMonth: { peggedUSD: 88_000_000 },
  });
}
