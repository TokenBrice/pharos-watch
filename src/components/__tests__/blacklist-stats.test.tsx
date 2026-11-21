// @vitest-environment jsdom

import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { BlacklistStablecoin, BlacklistSummaryResponse } from "@shared/types/blacklist";
import { BLACKLIST_STABLECOINS } from "@shared/types/blacklist";
import { BlacklistStats } from "@/components/freezewatch/blacklist-stats";
import { BlacklistDetailStats } from "@/components/stablecoin-detail/blacklist-detail-stats";

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
    recentFreezeCount24h: 1,
    recentFreezeCount7d: 4,
    recentFreezeAmount24hUsd: 500,
    recentFreezeAmount7dUsd: 2_000,
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
  it.each([
    { amount: null, known: 0, unavailable: 1, detail: "Unavailable", headline: "Unavailable" },
    { amount: 100, known: 1, unavailable: 1, detail: "$100.00 (partial)", headline: "$100.00" },
    { amount: 100, known: 1, unavailable: 0, detail: "$100.00", headline: "$100.00" },
    { amount: 0, known: 1, unavailable: 0, detail: "$0.00", headline: "$0.00" },
  ])("qualifies detail destroyed valuations but not the FreezeWatch headline (known=$known unavailable=$unavailable)", ({ amount, known, unavailable, detail, headline }) => {
    const stats = makeStats();
    const coverage = { knownCount: known, unavailableCount: unavailable };
    stats.destroyedTotal = amount;
    stats.valuationCoverage = {
      destroyed: coverage, recent24h: coverage, recent7d: coverage, perCoinFrozen: {}, perCoinDestroyed: {},
    };
    stats.perCoinFrozenTotal.USDC = amount;
    stats.perCoinDestroyedTotal.USDC = amount;
    stats.valuationCoverage.perCoinFrozen.USDC = coverage;
    stats.valuationCoverage.perCoinDestroyed.USDC = coverage;
    const headlineView = render(<BlacklistStats summary={{ ...makeSummary(), stats }} isLoading={false} />);
    const detailView = render(<BlacklistDetailStats symbol="USDC" stats={stats} isLoading={false} />);
    expect(within(headlineView.container).getAllByText(headline)).toHaveLength(1);
    // The dossier strip hides a zero or unavailable figure ("$0.00 destroyed" is not a finding).
    expect(within(detailView.container).queryAllByText(detail)).toHaveLength(amount != null && Number.isFinite(amount) && amount !== 0 ? 2 : 0);
  });

  it("shows the tracked frozen subtotal without a partial marker when snapshots lack a USD value", () => {
    const stats = makeStats();
    stats.trackedFrozenTotal = 1_000;
    stats.trackedAddressCount = 10;
    stats.trackedAmountGapCount = 4;
    render(<BlacklistStats summary={{ ...makeSummary(), stats }} isLoading={false} />);
    expect(screen.getByText("$1.00K")).toBeTruthy();
    expect(screen.queryByText(/partial/)).toBeNull();
  });

  it("renders only observed enforcement totals and omits the duplicate Unfreezable market share card", () => {
    render(<BlacklistStats summary={{ ...makeSummary(), stats: makeStats() }} isLoading={false} />);

    expect(screen.getByText("Tracked frozen total")).toBeTruthy();
    expect(screen.getByText("last-known freeze snapshots")).toBeTruthy();
    expect(screen.getByText("Total wiped value")).toBeTruthy();
    expect(screen.queryByText(/Unfreezable market share/i)).toBeNull();
    expect(screen.queryByText("Snapshot Basis")).toBeNull();
    expect(screen.queryByText("Freeze Ledger")).toBeNull();
    expect(screen.queryByText("USDT Blacklisted")).toBeNull();
    expect(screen.queryByText("unique events")).toBeNull();
  });

  it.each(["degraded", "stale"] as const)("shows the data-quality notice only for stale coverage (%s)", (status) => {
    render(
      <BlacklistStats
        summary={{
          ...makeSummary(),
          dataQuality: {
            status,
            warnings: [],
            ambiguousOrderCount: 3,
            ambiguousOrderReason: "tron-cross-transaction-order",
            amountGaps: { totalEvents: 100, recoverable: 0, unrecoverable: 0, recentRecoverable: 0, missingRatio: 0, recentWindowSec: 86_400 },
            freezeLedger: { providerFailedCount: 0, trackedGapCount: 0, scopedRows: 10, legacyRows: 0 },
            coverage: { supportedConfigs: 8, unsupportedDeferredConfigs: 0 },
          },
        }}
        isLoading={false}
      />,
    );

    if (status === "degraded") {
      expect(screen.queryByText("Data quality")).toBeNull();
      return;
    }
    expect(screen.getByText("Freeze ledger coverage is stale")).toBeTruthy();
    expect(screen.getByText(/3 events have an ambiguous order/)).toBeTruthy();
    expect(screen.getByText(/Tron transfers in separate transactions/)).toBeTruthy();
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
              trackedGapCount: 2,
              scopedRows: 10,
              legacyRows: 0,
            },
            coverage: { supportedConfigs: 8, unsupportedDeferredConfigs: 1 },
          },
        }}
        isLoading={false}
      />,
    );

    expect(screen.getByText("Data quality")).toBeTruthy();
    expect(screen.getByText("Freeze ledger coverage is stale")).toBeTruthy();
    expect(screen.getByText("4 current-balance provider failures")).toBeTruthy();
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
              trackedGapCount: 1,
              scopedRows: 10,
              legacyRows: 0,
            },
            coverage: { supportedConfigs: 8, unsupportedDeferredConfigs: 1 },
          },
        }}
        isLoading={false}
      />,
    );

    expect(screen.queryByText("Data quality")).toBeNull();
  });

  it("renders an unavailable notice instead of zeroed totals when the summary query fails", () => {
    render(
      <BlacklistStats
        summary={undefined}
        isLoading={false}
        error={new Error("summary unavailable")}
      />,
    );

    expect(screen.getByRole("alert").textContent).toContain(
      "Freeze ledger data is temporarily unavailable. No status claim is being made.",
    );
    expect(screen.getAllByText("—")).toHaveLength(2);
    expect(screen.queryByText("$0")).toBeNull();
  });
});
