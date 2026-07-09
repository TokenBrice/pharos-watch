import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchBlacklistEvents, fetchBlacklistSummary } from "../blacklist-api";
import { BLACKLIST_STABLECOINS } from "@shared/types/market";
import type { BlacklistEvent, BlacklistResponse, BlacklistStablecoin, BlacklistSummaryResponse } from "@shared/types";

function makeEvent(id: number): BlacklistEvent {
  const hex = id.toString(16).padStart(64, "0");
  const addressHex = id.toString(16).padStart(40, "0");

  return {
    id: `ethereum-0x${hex}-${id}`,
    stablecoin: "USDT",
    chainId: "ethereum",
    chainName: "Ethereum",
    eventType: "blacklist",
    address: `0x${addressHex}`,
    amountNative: id + 1,
    amountUsdAtEvent: id + 1,
    amountSource: "historical_balance",
    amountStatus: "resolved",
    txHash: `0x${hex}`,
    blockNumber: 20_000_000 - id,
    timestamp: 1_772_838_315 - id,
    methodologyVersion: "3.2",
    contractAddress: "0xdac17f958d2ee523a2206206994597c13d831ec7",
    configKey: "ethereum-0xdac17f958d2ee523a2206206994597c13d831ec7",
    eventSignature: "AddedBlackList(address)",
    eventTopic0: "0x42e160154868087d6bfdc0ca23d96a1c1cfa32f1b72ba9ba27b69b98a0d819dc",
    suppressionReason: null,
    explorerTxUrl: `https://etherscan.io/tx/0x${hex}`,
    explorerAddressUrl: `https://etherscan.io/address/0x${addressHex}`,
  };
}

function jsonResponse(body: BlacklistResponse | BlacklistSummaryResponse): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function makeLegacySummaryWithoutCurrentFreshness(): BlacklistSummaryResponse {
  const zeroByCoin = Object.fromEntries(BLACKLIST_STABLECOINS.map((s) => [s, 0])) as Record<
    BlacklistStablecoin,
    number
  >;
  const emptyQuarterly = Object.fromEntries(BLACKLIST_STABLECOINS.map((s) => [s, []])) as Record<
    BlacklistStablecoin,
    Array<{ quarter: string; blacklist: number; unblacklist: number; destroy: number }>
  >;

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
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("fetchBlacklistEvents forwards pagination, filter, search, and sort params", async () => {
    const body: BlacklistResponse = {
      events: [makeEvent(1)],
      total: 1,
    };
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(jsonResponse(body));

    const result = await fetchBlacklistEvents({
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

    expect(result).toEqual(body);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = String(fetchMock.mock.calls[0]?.[0]);
    expect(url).toContain("/api/blacklist?");
    expect(url).toContain("stablecoin=USDT");
    expect(url).toContain("chain=Ethereum");
    expect(url).toContain("eventType=blacklist");
    expect(url).toContain("q=0xabc");
    expect(url).toContain("sortBy=chain");
    expect(url).toContain("sortDirection=asc");
    expect(url).toContain("limit=50");
    expect(url).not.toContain("offset=100");
    expect(url).toContain("cursor=opaque-cursor");
    expect(url).toContain("includeTotal=true");
  });

  it("fetchBlacklistSummary hits the dedicated summary endpoint", async () => {
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
        perCoinBlacklistCounts: Object.fromEntries(BLACKLIST_STABLECOINS.map((s) => [s, 0])) as Record<
          BlacklistStablecoin,
          number
        >,
        perCoinTotalEvents: Object.fromEntries(BLACKLIST_STABLECOINS.map((s) => [s, 0])) as Record<
          BlacklistStablecoin,
          number
        >,
        perCoinFrozenAddressCount: Object.fromEntries(BLACKLIST_STABLECOINS.map((s) => [s, 0])) as Record<
          BlacklistStablecoin,
          number
        >,
        perCoinFrozenTotal: Object.fromEntries(BLACKLIST_STABLECOINS.map((s) => [s, 0])) as Record<
          BlacklistStablecoin,
          number
        >,
        perCoinDestroyedTotal: Object.fromEntries(BLACKLIST_STABLECOINS.map((s) => [s, 0])) as Record<
          BlacklistStablecoin,
          number
        >,
        perCoinQuarterlyEventTypes: Object.fromEntries(BLACKLIST_STABLECOINS.map((s) => [s, []])) as Record<
          BlacklistStablecoin,
          Array<{ quarter: string; blacklist: number; unblacklist: number; destroy: number }>
        >,
        perCoinRecentEventTypes: Object.fromEntries(
          BLACKLIST_STABLECOINS.map((s) => [s, { freezes: 0, destroys: 0, releases: 0 }]),
        ) as Record<BlacklistStablecoin, { freezes: number; destroys: number; releases: number }>,
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
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(jsonResponse(body));

    const result = await fetchBlacklistSummary();

    expect(result).toEqual(body);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/api/blacklist-summary");
  });

  it("accepts cached summary payloads from before the current-freshness split", async () => {
    const body = makeLegacySummaryWithoutCurrentFreshness();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(jsonResponse(body));

    const result = await fetchBlacklistSummary();

    expect(result.stats.trackedFrozenTotal).toBe(10_000);
    expect(result.freezeLedgerMeta?.currentFreshnessDistribution).toBeUndefined();
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/api/blacklist-summary");
  });
});
