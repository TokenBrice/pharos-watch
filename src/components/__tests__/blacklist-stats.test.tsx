// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { BlacklistStablecoin, BlacklistSummaryResponse } from "@shared/types";
import { BLACKLIST_STABLECOINS } from "@shared/types/market";
import { BlacklistStats } from "@/components/blacklist-stats";

afterEach(() => {
  cleanup();
});

function makePerCoinRecord<T>(createValue: (symbol: BlacklistStablecoin) => T): Record<BlacklistStablecoin, T> {
  return Object.fromEntries(BLACKLIST_STABLECOINS.map((symbol) => [symbol, createValue(symbol)])) as Record<
    BlacklistStablecoin,
    T
  >;
}

function makeSummary(): BlacklistSummaryResponse {
  return {
    stats: makeStats(),
    chart: [],
    chains: [],
    totalEvents: 0,
  };
}

function makeStats(): BlacklistSummaryResponse["stats"] {
  return {
    usdcBlacklisted: 9_692,
    usdtBlacklisted: 2_325,
    goldBlacklisted: 400,
    frozenAddresses: 11_844,
    destroyedTotal: 862_660_000,
    activeAddressCount: 11_844,
    activeFrozenTotal: 3_400_000_000,
    activeAmountGapCount: 0,
    trackedAddressCount: 11_844,
    trackedFrozenTotal: 3_400_000_000,
    trackedAmountGapCount: 0,
    recentCount: 12,
    recentCount24h: 1,
    recoverableGapCount: 0,
    perCoinBlacklistCounts: {
      ...makePerCoinRecord(() => 0),
      USDT: 9_692,
      USDC: 2_325,
      USDO: 340,
      PAXG: 285,
      USDG: 237,
    },
    perCoinTotalEvents: makePerCoinRecord(() => 0),
    perCoinFrozenAddressCount: makePerCoinRecord(() => 0),
    perCoinFrozenTotal: makePerCoinRecord(() => 0),
    perCoinDestroyedTotal: makePerCoinRecord(() => 0),
    perCoinQuarterlyEventTypes: makePerCoinRecord<
      BlacklistSummaryResponse["stats"]["perCoinQuarterlyEventTypes"][BlacklistStablecoin]
    >(() => []),
    perCoinRecentEventTypes: makePerCoinRecord(() => ({
      freezes: 0,
      destroys: 0,
      releases: 0,
    })),
  };
}

describe("BlacklistStats", () => {
  it("renders the unfreezable market-share stat from the blacklist-status no bucket", () => {
    render(
      <BlacklistStats
        summary={{ ...makeSummary(), stats: makeStats() }}
        isLoading={false}
        blacklistStatusBuckets={[
          { status: "Yes", key: "yes", count: 10, marketCap: 150_000_000_000 },
          { status: "Possible", key: "possible", count: 5, marketCap: 40_000_000_000 },
          { status: "Upstream", key: "upstream", count: 3, marketCap: 20_000_000_000 },
          { status: "No", key: "no", count: 2, marketCap: 30_000_000_000 },
        ]}
        supportDataLoading={false}
      />,
    );

    expect(screen.getByText("Unfreezable Market Share")).toBeTruthy();
    expect(screen.getByText("12.5%")).toBeTruthy();
    expect(screen.getByText("2 stablecoins · $30.00B of $240.00B total")).toBeTruthy();
    expect(screen.getByText("Tracked Frozen Total")).toBeTruthy();
    expect(screen.getByText("last-known freeze snapshots")).toBeTruthy();
    expect(screen.getByText("Total Wiped Value")).toBeTruthy();
    expect(screen.queryByText("Snapshot Basis")).toBeNull();
    expect(screen.queryByText("Freeze Ledger")).toBeNull();
    expect(screen.queryByText("USDT Blacklisted")).toBeNull();
    expect(screen.queryByText("unique events")).toBeNull();
  });

  it("surfaces freeze-ledger data-quality warnings", () => {
    render(
      <BlacklistStats
        summary={{
          ...makeSummary(),
          dataQuality: {
            status: "stale",
            warnings: ["current-balance-provider-failures", "stale-current-balance-snapshots"],
            amountGaps: {
              totalEvents: 100,
              recoverable: 2,
              unrecoverable: 1,
              recentRecoverable: 1,
              missingRatio: 0.03,
              recentWindowSec: 86_400,
            },
            freezeLedger: {
              providerFailedCount: 4,
              staleSnapshotCount: 3,
              trackedGapCount: 2,
              scopedRows: 10,
              legacyRows: 0,
            },
            coverage: { supportedConfigs: 8, unsupportedDeferredConfigs: 1 },
          },
        }}
        isLoading={false}
        blacklistStatusBuckets={null}
        supportDataLoading={false}
      />,
    );

    expect(screen.getByText("Data Quality")).toBeTruthy();
    expect(screen.getByText("Freeze ledger coverage is stale")).toBeTruthy();
    expect(screen.getByText("4 current-balance provider failures")).toBeTruthy();
    expect(screen.getByText("3 stale current-balance snapshots")).toBeTruthy();
    expect(screen.getByText("2 tracked ledger gaps")).toBeTruthy();
    expect(screen.getByText(/2 recoverable amount gaps across/)).toBeTruthy();
    expect(screen.queryByText(/deferred coverage configs/)).toBeNull();
  });

  it("does not open the warning for permanent gaps or deferred coverage alone", () => {
    render(
      <BlacklistStats
        summary={{
          ...makeSummary(),
          dataQuality: {
            status: "ok",
            warnings: [],
            amountGaps: {
              totalEvents: 100,
              recoverable: 0,
              unrecoverable: 10,
              recentRecoverable: 0,
              missingRatio: 0,
              recentWindowSec: 86_400,
            },
            freezeLedger: {
              providerFailedCount: 0,
              staleSnapshotCount: 0,
              trackedGapCount: 1,
              scopedRows: 10,
              legacyRows: 0,
            },
            coverage: { supportedConfigs: 8, unsupportedDeferredConfigs: 1 },
          },
        }}
        isLoading={false}
        blacklistStatusBuckets={null}
        supportDataLoading={false}
      />,
    );

    expect(screen.queryByText("Data Quality")).toBeNull();
  });

  it("keeps extra precision for sub-0.1% market-share values", () => {
    render(
      <BlacklistStats
        summary={{ ...makeSummary(), stats: makeStats() }}
        isLoading={false}
        blacklistStatusBuckets={[
          { status: "Yes", key: "yes", count: 10, marketCap: 150_000_000_000 },
          { status: "Possible", key: "possible", count: 5, marketCap: 40_000_000_000 },
          { status: "Upstream", key: "upstream", count: 3, marketCap: 20_000_000_000 },
          { status: "No", key: "no", count: 2, marketCap: 184_790_000 },
        ]}
        supportDataLoading={false}
      />,
    );

    expect(screen.getByText("0.088%")).toBeTruthy();
  });

  it("shows an unresolved unfreezable share while support data is still loading", () => {
    render(
      <BlacklistStats
        summary={{ ...makeSummary(), stats: makeStats() }}
        isLoading={false}
        blacklistStatusBuckets={[
          { status: "Yes", key: "yes", count: 10, marketCap: 150_000_000_000 },
          { status: "Possible", key: "possible", count: 5, marketCap: 40_000_000_000 },
          { status: "Upstream", key: "upstream", count: 3, marketCap: 20_000_000_000 },
          { status: "No", key: "no", count: 2, marketCap: 30_000_000_000 },
        ]}
        supportDataLoading
      />,
    );

    expect(screen.getByText("—")).toBeTruthy();
  });
});
