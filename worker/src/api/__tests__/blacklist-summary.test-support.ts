import { BLACKLIST_STABLECOINS, type BlacklistStablecoin, type BlacklistSummaryResponse } from "@shared/types/market";

type BalanceRow = {
  id: string;
  stablecoin: BlacklistStablecoin;
  chain_id: string;
  address: string;
  amount_native: number | null;
  amount_usd: number | null;
  source: string;
  status: string;
  observed_at: number;
  attempt_count: number;
  last_attempted_at: number | null;
  last_error_class: string | null;
  config_key?: string;
  contract_address?: string;
  last_successful_observed_at?: number;
  consecutive_failures?: number;
};

export function balanceRow(
  stablecoin: BlacklistStablecoin, chain: string, address: string, amount: number | null,
  observedAt: number, overrides: Partial<BalanceRow> = {},
): BalanceRow {
  return {
    id: `${stablecoin}:${chain}:${address}`, stablecoin, chain_id: chain, address,
    amount_native: amount, amount_usd: amount, source: "current_balance", status: "resolved",
    observed_at: observedAt, attempt_count: 1, last_attempted_at: observedAt, last_error_class: null,
    ...overrides,
  };
}

const perCoin = <T>(value: () => T) => Object.fromEntries(BLACKLIST_STABLECOINS.map((coin) => [coin, value()])) as Record<BlacklistStablecoin, T>;

const validSummary: Required<BlacklistSummaryResponse> = {
  stats: {
    usdcBlacklisted: 0, usdtBlacklisted: 0, goldBlacklisted: 0, frozenAddresses: 0, destroyedTotal: 0,
    activeAddressCount: 0, activeFrozenTotal: 0, activeAmountGapCount: 0,
    trackedAddressCount: 0, trackedFrozenTotal: 0, trackedAmountGapCount: 0,
    recentCount: 0, recentCount24h: 0, recoverableGapCount: 0,
    perCoinBlacklistCounts: perCoin(() => 0), perCoinTotalEvents: perCoin(() => 0),
    perCoinFrozenAddressCount: perCoin(() => 0), perCoinFrozenTotal: perCoin(() => 0),
    perCoinDestroyedTotal: perCoin(() => 0), perCoinQuarterlyEventTypes: perCoin(() => []),
    perCoinRecentEventTypes: perCoin(() => ({ freezes: 0, destroys: 0, releases: 0 })),
  },
  chart: [], chains: [], totalEvents: 0,
  coverage: { supported: [], unsupportedDeferred: [], counts: {
    supportedConfigs: 0, unsupportedDeferredConfigs: 0, bySymbol: {}, byChain: {}, byProviderSource: {},
  } },
  freezeLedgerMeta: {
    totalRows: 0, scopedRows: 0, legacyRows: 0, oldestObservedAt: null, newestObservedAt: null,
    oldestAgeSec: null, newestAgeSec: null, statusDistribution: {}, sourceDistribution: {},
    freshnessDistribution: { fresh: 0, degraded: 0, stale: 0 }, providerFailedCount: 0,
    lastErrorClassDistribution: {}, sourceCategoryCounts: { bootstrap: 0, current: 0, destroy: 0, other: 0 },
    gaps: { tracked: 0, recoverable: 0, unrecoverable: 0, recentRecoverable: 0, neverAttempted: 0,
      repeatedFailures: 0, oldestRecoverableAgeSec: null, amountStatusDistribution: {}, amountSourceDistribution: {} },
  },
  dataQuality: {
    status: "ok", warnings: [],
    amountGaps: { totalEvents: 0, recoverable: 0, unrecoverable: 0, recentRecoverable: 0, missingRatio: 0, recentWindowSec: 86400 },
    freezeLedger: { providerFailedCount: 0, staleSnapshotCount: 0, trackedGapCount: 0, scopedRows: 0, legacyRows: 0 },
    coverage: { supportedConfigs: 0, unsupportedDeferredConfigs: 0 },
  },
  methodology: { version: "3.1", versionLabel: "v3.1", currentVersion: "3.1", currentVersionLabel: "v3.1",
    changelogPath: "/methodology/blacklist-tracker-changelog/", asOf: 0, isCurrent: true },
};

export function makeValidSummaryPayload(): Record<string, unknown> {
  return structuredClone(validSummary);
}
