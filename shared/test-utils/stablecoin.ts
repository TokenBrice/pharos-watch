import type { StablecoinData, SupplyChainGuardProvenance, SupplyGapFillProvenance } from "@shared/types/supply";
import type { StablecoinMeta } from "@shared/types/stablecoin-meta-schemas";
import { CHAIN_META } from "@shared/types/chain-identity";

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

/** Chain-dropout guard builders: one provider chain row, one persisted pair, a gap-fill and a chain chart read. */
export function makeChainLeg(current: number, circulatingPrevDay = current) {
  return { current, circulatingPrevDay };
}

export function makeChainBaseline(chainId: string, baselineUsd: number, baselineObservedAt: number, quarantinedSince: number | null = null) {
  return { chainId, chainLabel: CHAIN_META[chainId].name, baselineUsd, baselineObservedAt, quarantinedSince };
}

export function makeGapFill(missingChainId: string, canonicalCurrentUsd: number, supplementalCurrentUsd: number, observedAt: number, maxRatio = 1.5): SupplyGapFillProvenance {
  return { method: "coingecko-single-missing-chain", admission: "entered", missingChainId, canonicalSource: "defillama",
    canonicalCurrentUsd, supplementalSource: "coingecko", supplementalCurrentUsd,
    ratio: supplementalCurrentUsd / canonicalCurrentUsd, maxRatio, observedAt };
}

/** USDG with X Layer, Ink and Hyperliquid L1 collapsed to zero against their previous-day stock. */
export function makeDropoutUsdg() {
  return {
    id: "usdg-paxos", name: "Global Dollar", symbol: "USDG", pegType: "peggedUSD", pegMechanism: "fiat-backed",
    supplySource: "defillama", price: 1, priceSource: "defillama",
    circulating: { peggedUSD: 321_300_000 + 696_500_000 + 627_500_000 },
    circulatingPrevDay: { peggedUSD: 3_134_000_000 }, circulatingPrevWeek: { peggedUSD: 3_000_000_000 }, circulatingPrevMonth: { peggedUSD: 2_900_000_000 },
    chains: ["X Layer", "Ink", "Hyperliquid L1", "Ethereum", "Robinhood", "Solana"],
    chainCirculating: {
      "X Layer": makeChainLeg(0, 1_427_900_000),
      Ink: makeChainLeg(0, 63_600_000),
      "Hyperliquid L1": makeChainLeg(0, 1_200_000),
      Ethereum: makeChainLeg(321_300_000),
      Robinhood: makeChainLeg(696_500_000),
      Solana: makeChainLeg(627_500_000),
    },
  };
}

export function makeChartPoint(value: number, date: number) {
  return { response: { ok: true }, body: JSON.stringify([{ date, totalCirculatingUSD: { peggedUSD: value } }]) };
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
