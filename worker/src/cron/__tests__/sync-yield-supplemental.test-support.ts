import type { VaultsFyiSourceResult, fetchBeefySources, OptionalRpcFamilyTelemetry } from "../yield-sync/sources";
import { emptyTelemetry } from "../yield-sync/vaults-fyi";

export function emptyVaultsFyiResult(
  overrides: Partial<VaultsFyiSourceResult["telemetry"]> = {},
): VaultsFyiSourceResult {
  return {
    candidates: [],
    telemetry: {
      ...emptyTelemetry(overrides),
      consumptionMode: overrides.consumptionMode ?? "disabled",
      consumptionReason: overrides.consumptionReason ?? "source-disabled",
    },
  };
}

export function emptyRpcTelemetry(): OptionalRpcFamilyTelemetry {
  return {
  targetCount: 0,
  attemptedCount: 0,
  resolvedTargetCount: 0,
  emittedCount: 0,
  missingTargetCount: 0,
  missingByChain: {},
  missingReasonCounts: {},
  missingTargets: [],
  missingTargetsTruncated: false,
  budgetExhausted: false,
  endpointStrategy: "alternating-fallback-primary" as const,
  };
}

type BeefyCandidate = Awaited<ReturnType<typeof fetchBeefySources>>[number];

export function beefyCandidate(
  overrides: Partial<Omit<BeefyCandidate, "yield">> = {},
  yieldOverrides: Partial<BeefyCandidate["yield"]> = {},
): BeefyCandidate {
  return {
        symbol: "USDC",
        chain: "ethereum",
        address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
        yield: {
          currentApy: 4.1,
          apyBase: 4.1,
          apyReward: null,
          sourcePool: "vault-a",
          sourceTvlUsd: 1_500_000,
          dataSource: "protocol-api",
          exchangeRate: null,
          sourceKey: "protocol-api:beefy:ethereum:vault-a",
          yieldSource: "Beefy: vault-a",
          yieldType: "lending-opportunity",
          sourceObservedAt: 1_774_526_400,
          comparisonAnchorObservedAt: null,
          ...yieldOverrides,
        },
        ...overrides,
  };
}
