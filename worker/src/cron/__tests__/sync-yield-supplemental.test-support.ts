import type { VaultsFyiSourceResult, fetchBeefySources, OptionalRpcFamilyTelemetry } from "../yield-sync/sources";

export function emptyVaultsFyiResult(
  overrides: Partial<VaultsFyiSourceResult["telemetry"]> = {},
): VaultsFyiSourceResult {
  return {
    candidates: [],
    telemetry: {
      enabled: false,
      hasKey: false,
      status: "skipped",
      skipReason: "disabled",
      requestCount: 0,
      pageCount: 0,
      pageCapReached: false,
      creditsEstimated: 0,
      creditsCap: 13,
      creditCapReached: false,
      monthlyCreditsEstimated: null,
      monthlyCreditsReserved: null,
      monthlyCreditsCap: 2500,
      monthlyCreditsForecast: null,
      monthlyUnthrottledForecast: null,
      monthlyBudgetUtilization: null,
      monthlyBudgetWarning: false,
      monthlyRunsRemaining: null,
      monthlyLedgerState: "unavailable",
      coverageBudgetState: "unavailable",
      rawVaultCount: 0,
      rankableCandidateCount: 0,
      auditOnlyCount: 0,
      malformedDropCount: 0,
      unsupportedChainCount: 0,
      identityMissCount: 0,
      sizeGateDropCount: 0,
      warningDropCount: 0,
      durationMs: 0,
      budgetMs: 20_000,
      budgetExhausted: false,
      dropExamples: [],
      ...overrides,
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
