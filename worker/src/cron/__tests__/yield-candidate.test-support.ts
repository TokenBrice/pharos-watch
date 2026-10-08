import type { ResolvedYieldCandidate } from "../yield-sync/types";

export function supplementalCandidate(
  sourceKey: string,
  observedAt: number,
  overrides: Partial<ResolvedYieldCandidate["yield"]> = {},
): ResolvedYieldCandidate {
  return {
    stablecoinId: "100",
    symbol: "sDAI",
    chain: "ethereum",
    address: null,
    yield: {
      currentApy: 6.1,
      apyBase: 6.1,
      apyReward: null,
      sourcePool: "fixture-pool",
      sourceTvlUsd: 50_000_000,
      dataSource: "protocol-api",
      exchangeRate: null,
      sourceKey,
      yieldSource: "Fixture supplemental source",
      yieldType: "lending-vault",
      sourceObservedAt: observedAt,
      comparisonAnchorObservedAt: null,
      ...overrides,
    },
  };
}

export function morphoCandidate(observedAt: number): ResolvedYieldCandidate {
  return supplementalCandidate("protocol-api:morpho-vault:ethereum:0xvault", observedAt, {
    sourcePool: "vault-sdai-morpho",
    yieldSource: "Morpho: sDAI Vault",
  });
}
