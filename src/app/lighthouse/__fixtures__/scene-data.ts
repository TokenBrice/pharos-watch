import type { ChainsResponse, ChainSummary } from "@shared/types/chains";
import type { StablecoinListResponse } from "@shared/types/market";
import type { StabilityIndexResponse } from "@shared/types/stability";
import type { StressSignalsAllResponse } from "@shared/types/market";

const ETH_CHAIN: ChainSummary = {
  id: "ethereum",
  name: "Ethereum",
  logoPath: "/logos/ethereum.svg",
  type: "evm",
  totalUsd: 600_000_000,
  change24h: 0,
  change24hPct: 0,
  change7d: 9_000_000,
  change7dPct: 1.5,
  change30d: 0,
  change30dPct: 0,
  stablecoinCount: 12,
  dominantStablecoin: { id: "usdt", symbol: "USDT", share: 0.42 },
  topStablecoins: [
    { id: "usdt", symbol: "USDT", supplyUsd: 250_000_000, share: 0.42 },
    { id: "usdc", symbol: "USDC", supplyUsd: 200_000_000, share: 0.33 },
    { id: "dai", symbol: "DAI", supplyUsd: 80_000_000, share: 0.13 },
  ],
  dominanceShare: 0.42,
  healthScore: 72,
  healthBand: "healthy",
  healthFactors: {
    concentration: 0.42,
    quality: 0.7,
    pegStability: 0.85,
    backingDiversity: 0.6,
    chainEnvironment: 0.7,
  },
};

const TRON_CHAIN: ChainSummary = {
  id: "tron",
  name: "Tron",
  logoPath: "/logos/tron.svg",
  type: "tron",
  totalUsd: 300_000_000,
  change24h: 0,
  change24hPct: 0,
  change7d: -1_200_000,
  change7dPct: -0.4,
  change30d: 0,
  change30dPct: 0,
  stablecoinCount: 4,
  dominantStablecoin: { id: "usdt", symbol: "USDT", share: 0.93 },
  topStablecoins: [
    { id: "usdt", symbol: "USDT", supplyUsd: 280_000_000, share: 0.93 },
  ],
  dominanceShare: 0.93,
  healthScore: 40,
  healthBand: "concentrated",
  healthFactors: {
    concentration: 0.93,
    quality: 0.5,
    pegStability: 0.8,
    backingDiversity: 0.2,
    chainEnvironment: 0.5,
  },
};

export const fixtureChains: ChainsResponse = {
  chains: [ETH_CHAIN, TRON_CHAIN],
  globalTotalUsd: 1_000_000_000,
  chainAttributedTotalUsd: 900_000_000,
  unattributedTotalUsd: 100_000_000,
  globalChange24hPct: 0,
  globalChange7dPct: 1.0,
  globalChange30dPct: 0,
  updatedAt: 1_710_000_000,
  healthMethodologyVersion: "v1",
};

export const fixtureStability: StabilityIndexResponse = {
  current: {
    score: 72,
    band: "STEADY",
    components: { severity: 10, breadth: 5, stressBreadth: 2, trend: 0 },
    computedAt: 1_710_000_000,
    methodologyVersion: "v1",
  },
  history: [],
  methodology: {} as StabilityIndexResponse["methodology"],
};

export const fixtureStress: StressSignalsAllResponse = {
  signals: {
    usdt: {
      score: 35,
      band: "WATCH",
      signals: {},
      computedAt: 1_710_000_000,
      methodologyVersion: "v1",
    },
    usdc: {
      score: 5,
      band: "CALM",
      signals: {},
      computedAt: 1_710_000_000,
      methodologyVersion: "v1",
    },
    dai: {
      score: 60,
      band: "ALERT",
      signals: {},
      computedAt: 1_710_000_000,
      methodologyVersion: "v1",
    },
  },
  updatedAt: 1_710_000_000,
  methodology: {} as StressSignalsAllResponse["methodology"],
};

// The adapter looks up `flags` via a permissive cast on each stablecoin record
// because StablecoinData doesn't carry classification flags directly. The
// fixture extends the runtime shape with the flags the adapter reads, so the
// cast in the adapter resolves to the values the tests assert against.
export const fixtureStablecoins = {
  peggedAssets: [
    {
      id: "usdt",
      name: "Tether",
      symbol: "USDT",
      geckoId: null,
      pegType: "peggedUSD",
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
      circulating: { peggedUSD: 250_000_000 },
      circulatingPrevDay: {},
      circulatingPrevWeek: {},
      circulatingPrevMonth: {},
      chainCirculating: {},
      chains: ["ethereum"],
      flags: { governance: "centralized", backing: "rwa-backed" },
    },
    {
      id: "usdc",
      name: "USD Coin",
      symbol: "USDC",
      geckoId: null,
      pegType: "peggedUSD",
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
      circulating: { peggedUSD: 200_000_000 },
      circulatingPrevDay: {},
      circulatingPrevWeek: {},
      circulatingPrevMonth: {},
      chainCirculating: {},
      chains: ["ethereum"],
      flags: { governance: "centralized", backing: "rwa-backed" },
    },
    {
      id: "dai",
      name: "Dai",
      symbol: "DAI",
      geckoId: null,
      pegType: "peggedUSD",
      pegMechanism: "crypto-backed",
      price: 1,
      priceSource: "test",
      priceConfidence: null,
      priceUpdatedAt: null,
      priceObservedAt: null,
      priceObservedAtMode: null,
      priceSyncedAt: null,
      consensusSources: [],
      agreeSources: [],
      circulating: { peggedUSD: 80_000_000 },
      circulatingPrevDay: {},
      circulatingPrevWeek: {},
      circulatingPrevMonth: {},
      chainCirculating: {},
      chains: ["ethereum"],
      flags: { governance: "decentralized", backing: "crypto-backed" },
    },
  ],
} as unknown as StablecoinListResponse;
