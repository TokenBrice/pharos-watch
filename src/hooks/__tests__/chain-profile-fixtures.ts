import type { ChainSummary } from "@shared/types/chains";
import { RatioSchema } from "@shared/types/ratio";
import type { ChainStablecoin } from "../use-chains";

export function makeChain(overrides: Partial<ChainSummary> = {}): ChainSummary {
  return {
    id: "ethereum",
    name: "Ethereum",
    logoPath: "/chains/ethereum.png",
    type: "evm",
    totalUsd: 1_500_000_000,
    change24h: 15_000_000,
    change24hPct: RatioSchema.parse(0.01),
    change7d: 30_000_000,
    change7dPct: RatioSchema.parse(0.02),
    change30d: 45_000_000,
    change30dPct: RatioSchema.parse(0.03),
    stablecoinCount: 2,
    dominantStablecoin: {
      id: "usdc-circle",
      symbol: "USDC",
      share: 0.5,
    },
    topStablecoins: [
      { id: "usdc-circle", symbol: "USDC", share: 0.5, supplyUsd: 750_000_000 },
      { id: "usdt-tether", symbol: "USDT", share: 0.5, supplyUsd: 750_000_000 },
    ],
    dominanceShare: 0.32,
    healthScore: 84,
    healthBand: "robust",
    healthFactors: {
      quality: 82,
      chainEnvironment: 80,
      concentration: 78,
      pegStability: 88,
      backingDiversity: 76,
    },
    chainEnvironmentEvidence: {
      source: "pharos-chain-tier",
      score: 80,
      resilienceTier: 2,
    },
    ...overrides,
  };
}

export function makeCoin(overrides: Partial<ChainStablecoin> = {}): ChainStablecoin {
  return {
    id: "usdc-circle",
    name: "USD Coin",
    symbol: "USDC",
    price: 1,
    pegType: "peggedUSD",
    supplyOnChain: 500_000_000,
    chainShare: 0.5,
    change24h: 1_000_000,
    change24hPct: 0.01,
    change7d: 2_000_000,
    change7dPct: 0.02,
    change30d: 3_000_000,
    change30dPct: 0.03,
    backing: "rwa-backed",
    ...overrides,
  };
}
