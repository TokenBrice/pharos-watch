import type { StablecoinData, SupplyChainGuardProvenance } from "@shared/types/supply";
import type { StablecoinMeta } from "@shared/types/stablecoin-meta-schemas";

export const TEST_STABLECOIN_TIMESTAMP_SEC = 1_700_000_000;

/**
 * A chain-dropout guard with one unavailable chain. `true` publishes a partial remainder; omitted, the gap is
 * below the guard's materiality bound and removes nothing from the published aggregate.
 */
export function makeChainGapGuard(partialCoverage?: true): SupplyChainGuardProvenance {
  return {
    reason: "supply-chain-dropout", status: "chains-unavailable", partialCoverage,
    chains: [{
      chainId: "hyperevm", chainLabel: "HyperEVM", listCurrentUsd: 0, baselineUsd: 3_000,
      baselineObservedAt: 1_792_700_000, baselineSource: "state", resolution: "unavailable",
    }],
  };
}

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

export function makeAltPegCoin(id: string, marketCap: number): StablecoinData {
  return makeStablecoin({
    id,
    name: id,
    symbol: id.toUpperCase(),
    pegMechanism: "",
    supplySource: "test",
    circulating: { usd: marketCap },
  });
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
