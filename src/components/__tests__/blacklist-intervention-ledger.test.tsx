// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  BlacklistInterventionLedger,
  buildBlacklistInterventionLedgerModel,
} from "@/components/blacklist-intervention-ledger";
import { BLACKLIST_STABLECOINS, type BlacklistStablecoin, type BlacklistSummaryResponse } from "@shared/types";
import type { BlacklistStatusBucket } from "@/lib/blacklist-status-buckets";

afterEach(() => {
  cleanup();
});

function makePerCoinRecord(defaultValue: number): Record<BlacklistStablecoin, number> {
  return Object.fromEntries(BLACKLIST_STABLECOINS.map((symbol) => [symbol, defaultValue])) as Record<
    BlacklistStablecoin,
    number
  >;
}

function makeStats(): BlacklistSummaryResponse["stats"] {
  return {
    usdcBlacklisted: 50,
    usdtBlacklisted: 120,
    goldBlacklisted: 0,
    frozenAddresses: 170,
    destroyedTotal: 419_752,
    activeAddressCount: 170,
    activeFrozenTotal: 1_333_332,
    activeAmountGapCount: 0,
    trackedAddressCount: 170,
    trackedFrozenTotal: 1_333_332,
    trackedAmountGapCount: 0,
    recentCount: 8,
    recentCount24h: 1,
    recoverableGapCount: 0,
    perCoinBlacklistCounts: makePerCoinRecord(0),
    perCoinTotalEvents: {
      ...makePerCoinRecord(0),
      USDT: 120,
      USDC: 50,
      BUIDL: 8,
    },
    perCoinFrozenAddressCount: makePerCoinRecord(0),
    perCoinFrozenTotal: {
      ...makePerCoinRecord(0),
      USDT: 1_234_567,
      USDC: 98_765,
    },
    perCoinDestroyedTotal: {
      ...makePerCoinRecord(0),
      USDT: 333_333,
      BUIDL: 86_419,
    },
    perCoinQuarterlyEventTypes: Object.fromEntries(
      BLACKLIST_STABLECOINS.map((symbol) => [symbol, []]),
    ) as BlacklistSummaryResponse["stats"]["perCoinQuarterlyEventTypes"],
  };
}

function makeChartPoint(
  quarter: string,
  total: number,
  overrides: Partial<Record<BlacklistStablecoin, number>> = {},
): BlacklistSummaryResponse["chart"][number] {
  return {
    quarter,
    ...makePerCoinRecord(0),
    ...overrides,
    total,
  };
}

const BUCKETS: BlacklistStatusBucket[] = [
  { status: "Yes", key: "yes", count: 12, marketCap: 210_000_000_000 },
  { status: "Possible", key: "possible", count: 7, marketCap: 10_000_000_000 },
  { status: "Upstream", key: "upstream", count: 5, marketCap: 8_500_000_000 },
  { status: "No", key: "no", count: 20, marketCap: 40_000_000_000 },
];

const CHART: BlacklistSummaryResponse["chart"] = [
  makeChartPoint("Q1 '25", 150_000, { USDT: 150_000 }),
  makeChartPoint("Q2 '25", 3_500_000, { USDT: 3_000_000, USDC: 500_000 }),
  makeChartPoint("Q3 '25", 1_750_000, { USDT: 1_750_000 }),
];

describe("BlacklistInterventionLedger", () => {
  it("keeps exposure status copy separate from observed event history", () => {
    render(
      <BlacklistInterventionLedger
        buckets={BUCKETS}
        stats={makeStats()}
        chart={CHART}
        isLoading={false}
      />,
    );

    expect(screen.getByText("Resolved blacklist/freeze exposure buckets")).toBeTruthy();
    expect(screen.getByText("Stablecoin symbols with observed supported events")).toBeTruthy();
    expect(screen.getByText("Direct possible token/vault control.")).toBeTruthy();
    expect(screen.getByText("Reserve/custody/parent exposure.")).toBeTruthy();
    expect(screen.getByText("No resolved exposure in current model.")).toBeTruthy();
    expect(screen.getByText(/Event count is observed supported tracker history, not policy probability/u)).toBeTruthy();
    expect(screen.queryByText(/contract/i)).toBeNull();
  });

  it("renders exact count and USD values outside hover-only surfaces", () => {
    render(
      <BlacklistInterventionLedger
        buckets={BUCKETS}
        stats={makeStats()}
        chart={CHART}
        isLoading={false}
      />,
    );

    expect(screen.getByText("12 stablecoins · $210,000,000,000")).toBeTruthy();
    expect(screen.getByText("120")).toBeTruthy();
    expect(screen.getByText("$1,234,567")).toBeTruthy();
    expect(screen.getByText("$333,333")).toBeTruthy();
    expect(screen.getByText("Q2 '25")).toBeTruthy();
    expect(screen.getByText("$3,500,000")).toBeTruthy();
    expect(screen.getByText("$419,752")).toBeTruthy();
  });

  it("sorts observed supported event leaders by symbol-level event count", () => {
    const model = buildBlacklistInterventionLedgerModel({
      buckets: BUCKETS,
      stats: makeStats(),
      chart: CHART,
    });

    expect(model.eventRows.map((row) => row.symbol)).toEqual(["USDT", "USDC", "BUIDL"]);
    expect(model.contextRows.find((row) => row.key === "destroyed")?.amountUsd).toBe(419_752);
  });
});
