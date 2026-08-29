import type { ChainSummary } from "@shared/types/chains";
import { ZERO_RATIO } from "@shared/types/ratio";

export function makeChain(overrides: Partial<ChainSummary>): ChainSummary {
  return {
    id: overrides.id ?? "ethereum",
    name: overrides.name ?? "Ethereum",
    logoPath: overrides.logoPath ?? "/logos/chains/ethereum.svg",
    type: overrides.type ?? "evm",
    totalUsd: overrides.totalUsd ?? 100,
    change24h: overrides.change24h ?? 0,
    change24hPct: overrides.change24hPct ?? ZERO_RATIO,
    change7d: overrides.change7d ?? 0,
    change7dPct: overrides.change7dPct ?? ZERO_RATIO,
    change30d: overrides.change30d ?? 0,
    change30dPct: overrides.change30dPct ?? ZERO_RATIO,
    stablecoinCount: overrides.stablecoinCount ?? 3,
    dominantStablecoin: overrides.dominantStablecoin ?? {
      id: "usdc-circle",
      symbol: "USDC",
      share: 0.6,
    },
    topStablecoins: overrides.topStablecoins ?? [
      { id: "usdc-circle", symbol: "USDC", share: 0.6, supplyUsd: 60 },
      { id: "usdt-tether", symbol: "USDT", share: 0.25, supplyUsd: 25 },
      { id: "dai-makerdao", symbol: "DAI", share: 0.15, supplyUsd: 15 },
    ],
    dominanceShare: overrides.dominanceShare ?? 0.5,
    healthScore: overrides.healthScore === undefined ? 82 : overrides.healthScore,
    healthBand: overrides.healthBand === undefined ? "healthy" : overrides.healthBand,
    healthFactors: overrides.healthFactors ?? {
      concentration: 80,
      quality: 85,
      pegStability: 90,
      backingDiversity: 70,
      chainEnvironment: 80,
    },
    chainEnvironmentEvidence: overrides.chainEnvironmentEvidence ?? {
      source: "pharos-chain-tier",
      score: 80,
      resilienceTier: 2,
    },
  };
}
