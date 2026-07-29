import { describe, expect, it } from "vitest";
import { buildBlacklistEventsPath } from "../blacklist-api";
import { BLACKLIST_STABLECOINS, BlacklistSummaryResponseSchema } from "@shared/types/market";
import type { BlacklistStablecoin, BlacklistSummaryResponse } from "@shared/types";

type QuarterlyEventPoint =
  BlacklistSummaryResponse["stats"]["perCoinQuarterlyEventTypes"][BlacklistStablecoin][number];
type RecentEventCounts = NonNullable<
  BlacklistSummaryResponse["stats"]["perCoinRecentEventTypes"]
>[BlacklistStablecoin];

function makePerCoinRecord<T>(createValue: (symbol: BlacklistStablecoin) => T): Record<BlacklistStablecoin, T> {
  return Object.fromEntries(BLACKLIST_STABLECOINS.map((symbol) => [symbol, createValue(symbol)])) as Record<
    BlacklistStablecoin,
    T
  >;
}

function makeLegacySummaryWithoutCurrentFreshness(): BlacklistSummaryResponse {
  const zeroByCoin = makePerCoinRecord(() => 0);
  const emptyQuarterly = makePerCoinRecord<QuarterlyEventPoint[]>(() => []);

  return {
    stats: {
      usdcBlacklisted: 1,
      usdtBlacklisted: 2,
      goldBlacklisted: 0,
      frozenAddresses: 3,
      destroyedTotal: 1_000,
      activeAddressCount: 3,
      activeFrozenTotal: 10_000,
      activeAmountGapCount: 0,
      trackedAddressCount: 3,
      trackedFrozenTotal: 10_000,
      trackedAmountGapCount: 0,
      recentCount: 4,
      recentCount24h: 1,
      recoverableGapCount: 0,
      perCoinBlacklistCounts: zeroByCoin,
      perCoinTotalEvents: zeroByCoin,
      perCoinFrozenAddressCount: zeroByCoin,
      perCoinFrozenTotal: zeroByCoin,
      perCoinDestroyedTotal: zeroByCoin,
      perCoinQuarterlyEventTypes: emptyQuarterly,
      perCoinRecentEventTypes: makePerCoinRecord<RecentEventCounts>(() => ({
        freezes: 0,
        destroys: 0,
        releases: 0,
      })),
    },
    chart: [],
    chains: [{ id: "ethereum", name: "Ethereum" }],
    freezeLedgerMeta: {
      totalRows: 0,
      scopedRows: 0,
      legacyRows: 0,
      oldestObservedAt: null,
      newestObservedAt: null,
      oldestAgeSec: null,
      newestAgeSec: null,
      statusDistribution: {},
      sourceDistribution: {},
      freshnessDistribution: {
        fresh: 0,
        degraded: 0,
        stale: 0,
      },
      providerFailedCount: 0,
      lastErrorClassDistribution: {},
      sourceCategoryCounts: {
        bootstrap: 0,
        current: 0,
        destroy: 0,
        other: 0,
      },
      gaps: {
        tracked: 0,
        recoverable: 0,
        unrecoverable: 0,
        recentRecoverable: 0,
        neverAttempted: 0,
        repeatedFailures: 0,
        oldestRecoverableAgeSec: null,
        amountStatusDistribution: {},
        amountSourceDistribution: {},
      },
    },
    totalEvents: 5,
  };
}

describe("blacklist-api", () => {
  it("buildBlacklistEventsPath forwards pagination, filter, search, and sort params", () => {
    const path = buildBlacklistEventsPath({
      stablecoin: "USDT",
      chainName: "Ethereum",
      eventType: "blacklist",
      query: "0xabc",
      sortBy: "chain",
      sortDirection: "asc",
      limit: 50,
      offset: 100,
      cursor: "opaque-cursor",
      includeTotal: true,
    });

    expect(path).toContain("/api/blacklist?");
    expect(path).toContain("stablecoin=USDT");
    expect(path).toContain("chain=Ethereum");
    expect(path).toContain("eventType=blacklist");
    expect(path).toContain("q=0xabc");
    expect(path).toContain("sortBy=chain");
    expect(path).toContain("sortDirection=asc");
    expect(path).toContain("limit=50");
    expect(path).not.toContain("offset=100");
    expect(path).toContain("cursor=opaque-cursor");
    expect(path).toContain("includeTotal=true");
  });

  it("parses the current summary payload shape", () => {
    const body: BlacklistSummaryResponse = {
      stats: {
        usdcBlacklisted: 1,
        usdtBlacklisted: 2,
        goldBlacklisted: 0,
        frozenAddresses: 3,
        destroyedTotal: 1_000,
        activeAddressCount: 3,
        activeFrozenTotal: 10_000,
        activeAmountGapCount: 0,
        trackedAddressCount: 3,
        trackedFrozenTotal: 10_000,
        trackedAmountGapCount: 0,
        recentCount: 4,
        recentCount24h: 1,
        recoverableGapCount: 0,
        perCoinBlacklistCounts: makePerCoinRecord(() => 0),
        perCoinTotalEvents: makePerCoinRecord(() => 0),
        perCoinFrozenAddressCount: makePerCoinRecord(() => 0),
        perCoinFrozenTotal: makePerCoinRecord(() => 0),
        perCoinDestroyedTotal: makePerCoinRecord(() => 0),
        perCoinQuarterlyEventTypes: makePerCoinRecord<QuarterlyEventPoint[]>(() => []),
        perCoinRecentEventTypes: makePerCoinRecord<RecentEventCounts>(() => ({
          freezes: 0,
          destroys: 0,
          releases: 0,
        })),
      },
      chart: [],
      chains: [{ id: "ethereum", name: "Ethereum" }],
      coverage: {
        supported: [],
        unsupportedDeferred: [],
        counts: {
          supportedConfigs: 0,
          unsupportedDeferredConfigs: 0,
          bySymbol: {},
          byChain: {},
          byProviderSource: {},
        },
      },
      freezeLedgerMeta: {
        totalRows: 0,
        scopedRows: 0,
        legacyRows: 0,
        oldestObservedAt: null,
        newestObservedAt: null,
        oldestAgeSec: null,
        newestAgeSec: null,
        statusDistribution: {},
        sourceDistribution: {},
        freshnessDistribution: {
          fresh: 0,
          degraded: 0,
          stale: 0,
        },
        currentFreshnessDistribution: {
          fresh: 0,
          degraded: 0,
          stale: 0,
        },
        providerFailedCount: 0,
        lastErrorClassDistribution: {},
        sourceCategoryCounts: {
          bootstrap: 0,
          current: 0,
          destroy: 0,
          other: 0,
        },
        gaps: {
          tracked: 0,
          recoverable: 0,
          unrecoverable: 0,
          recentRecoverable: 0,
          neverAttempted: 0,
          repeatedFailures: 0,
          oldestRecoverableAgeSec: null,
          amountStatusDistribution: {},
          amountSourceDistribution: {},
        },
      },
      dataQuality: {
        status: "ok",
        warnings: [],
        amountGaps: {
          totalEvents: 5,
          recoverable: 0,
          unrecoverable: 0,
          recentRecoverable: 0,
          missingRatio: 0,
          recentWindowSec: 86_400,
        },
        freezeLedger: {
          providerFailedCount: 0,
          staleSnapshotCount: 0,
          trackedGapCount: 0,
          scopedRows: 0,
          legacyRows: 0,
        },
        coverage: {
          supportedConfigs: 0,
          unsupportedDeferredConfigs: 0,
        },
      },
      totalEvents: 5,
    };

    expect(BlacklistSummaryResponseSchema.parse(body)).toEqual(body);
  });

  it("accepts cached summary payloads from before the current-freshness split", () => {
    const result = BlacklistSummaryResponseSchema.parse(makeLegacySummaryWithoutCurrentFreshness());

    expect(result.stats.trackedFrozenTotal).toBe(10_000);
    expect(result.freezeLedgerMeta?.currentFreshnessDistribution).toBeUndefined();
  });
});
