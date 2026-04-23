// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AltPegsClient } from "@/app/alt-pegs/client";

const refetchMock = vi.fn();

const {
  useStablecoinsMock,
  useNonUsdShareMock,
} = vi.hoisted(() => ({
  useStablecoinsMock: vi.fn(),
  useNonUsdShareMock: vi.fn(),
}));

vi.mock("@/hooks/use-stablecoins", () => ({
  useStablecoins: useStablecoinsMock,
}));

vi.mock("@/hooks/api-hooks", () => ({
  useNonUsdShare: useNonUsdShareMock,
}));

vi.mock("@/components/non-usd-share-chart", () => ({
  NonUsdShareChart: () => <div data-testid="non-usd-share-chart">non-usd-share-chart</div>,
}));

vi.mock("@/app/alt-pegs/alt-peg-cohort-history-chart", () => ({
  AltPegCohortHistoryChart: () => <div data-testid="alt-peg-cohort-chart">alt-peg-cohort-chart</div>,
}));

function makeCoin(id: string, marketCap: number) {
  return {
    id,
    name: id,
    symbol: id.toUpperCase(),
    geckoId: null,
    pegType: "peggedUSD",
    pegMechanism: "",
    price: 1,
    priceSource: "test",
    priceConfidence: null,
    priceUpdatedAt: null,
    priceObservedAt: null,
    priceObservedAtMode: null,
    priceSyncedAt: null,
    consensusSources: [],
    agreeSources: [],
    supplySource: "test",
    circulating: { usd: marketCap },
    circulatingPrevDay: {},
    circulatingPrevWeek: {},
    circulatingPrevMonth: {},
    chainCirculating: {},
    chains: [],
  };
}

describe("AltPegsClient", () => {
  beforeEach(() => {
    refetchMock.mockReset();
    useStablecoinsMock.mockReturnValue({
      data: {
        peggedAssets: [
          makeCoin("eurc-circle", 60_000_000),
          makeCoin("paxg-paxos", 20_000_000),
          makeCoin("usdc-circle", 100_000_000),
        ],
      },
      isLoading: false,
      isError: false,
      error: null,
      dataUpdatedAt: 1,
      refetch: refetchMock,
      meta: null,
    });
    useNonUsdShareMock.mockReturnValue({
      data: [
        {
          date: 1_700_000_000,
          commodityShare: 1,
          fiatNonUsdShare: 1,
          commodity: 10,
          fiatNonUsd: 10,
          total: 1000,
        },
        {
          date: 1_700_000_000 + 366 * 86400,
          commodityShare: 1.4,
          fiatNonUsdShare: 1.2,
          commodity: 18,
          fiatNonUsd: 15,
          total: 1200,
        },
      ],
      isLoading: false,
      isError: false,
      error: null,
      dataUpdatedAt: 2,
    });
  });

  it("renders the core current-state sections and history block", () => {
    render(<AltPegsClient />);

    expect(screen.getByRole("heading", { name: "Which Non-USD Pegs Matter Now" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "How Fast Is The Non-USD Share Growing?" })).toBeTruthy();
    expect(screen.getByTestId("non-usd-share-chart")).toBeTruthy();
    expect(screen.getByTestId("alt-peg-cohort-chart")).toBeTruthy();
  });

  it("renders peg drill-down links from the distribution card", () => {
    render(<AltPegsClient />);

    expect(
      screen.getAllByRole("link", { name: "Euro" }).some((link) => link.getAttribute("href") === "/stablecoins/eur"),
    ).toBe(true);
    expect(
      screen.getAllByRole("link", { name: "Gold" }).some((link) => link.getAttribute("href") === "/stablecoins/gold"),
    ).toBe(true);
  });
});
