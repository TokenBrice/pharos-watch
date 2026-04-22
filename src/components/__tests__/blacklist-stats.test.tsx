// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BLACKLIST_STABLECOINS, type BlacklistSummaryResponse } from "@shared/types";
import { BlacklistStats } from "@/components/blacklist-stats";

const { buildBlacklistStatusBucketsMock } = vi.hoisted(() => ({
  buildBlacklistStatusBucketsMock: vi.fn(),
}));

afterEach(() => {
  cleanup();
});

vi.mock("@/hooks/use-stablecoins", () => ({
  useStablecoins: () => ({
    data: { peggedAssets: [] },
    isLoading: false,
  }),
}));

vi.mock("@/hooks/api-hooks", () => ({
  useReportCards: () => ({
    data: { cards: [] },
    isLoading: false,
  }),
}));

vi.mock("@/lib/stablecoin-lookups", () => ({
  buildReportCardMap: () => undefined,
}));

vi.mock("@/lib/blacklist-status-buckets", () => ({
  BLACKLIST_STATUS_BUCKET_COLORS: {
    yes: "#ef4444",
    possible: "#f59e0b",
    upstream: "#f97316",
    no: "#22c55e",
  },
  buildBlacklistStatusBuckets: buildBlacklistStatusBucketsMock,
}));

function makePerCoinRecord(defaultValue: number) {
  return Object.fromEntries(BLACKLIST_STABLECOINS.map((symbol) => [symbol, defaultValue]));
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
      ...makePerCoinRecord(0),
      USDT: 9_692,
      USDC: 2_325,
      USDO: 340,
      PAXG: 285,
      USDG: 237,
    },
    perCoinTotalEvents: makePerCoinRecord(0),
    perCoinFrozenAddressCount: makePerCoinRecord(0),
    perCoinFrozenTotal: makePerCoinRecord(0),
    perCoinDestroyedTotal: makePerCoinRecord(0),
    perCoinQuarterlyEventTypes: Object.fromEntries(BLACKLIST_STABLECOINS.map((symbol) => [symbol, []])),
  };
}

describe("BlacklistStats", () => {
  it("renders the unfreezable market-share stat from the blacklist-status no bucket", () => {
    buildBlacklistStatusBucketsMock.mockReturnValue([
      { status: "Yes", key: "yes", count: 10, marketCap: 150_000_000_000 },
      { status: "Possible", key: "possible", count: 5, marketCap: 40_000_000_000 },
      { status: "Upstream", key: "upstream", count: 3, marketCap: 20_000_000_000 },
      { status: "No", key: "no", count: 2, marketCap: 30_000_000_000 },
    ]);

    render(<BlacklistStats stats={makeStats()} isLoading={false} />);

    expect(screen.getByText("Unfreezable Market Share")).toBeTruthy();
    expect(screen.getByText("12.5%")).toBeTruthy();
    expect(screen.getByText("$30.00B of $240.00B total")).toBeTruthy();
  });

  it("keeps extra precision for sub-0.1% market-share values", () => {
    buildBlacklistStatusBucketsMock.mockReturnValue([
      { status: "Yes", key: "yes", count: 10, marketCap: 150_000_000_000 },
      { status: "Possible", key: "possible", count: 5, marketCap: 40_000_000_000 },
      { status: "Upstream", key: "upstream", count: 3, marketCap: 20_000_000_000 },
      { status: "No", key: "no", count: 2, marketCap: 184_790_000 },
    ]);

    render(<BlacklistStats stats={makeStats()} isLoading={false} />);

    expect(screen.getByText("0.088%")).toBeTruthy();
  });
});
