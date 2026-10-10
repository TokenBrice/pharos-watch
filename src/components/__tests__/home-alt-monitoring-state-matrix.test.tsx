// @vitest-environment jsdom

import type { ComponentType } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { HomeAltRankingsSection } from "@/components/home-alt-rankings-section";
import { ActiveDepegsCard } from "@/components/home-alt-mini-cards/active-depegs-card";
import { MintBurnCard } from "@/components/home-alt-mini-cards/mint-burn-card";
import { PegHealthCard } from "@/components/home-alt-mini-cards/peg-health-card";
import { PsiBandCard } from "@/components/home-alt-mini-cards/psi-band-card";
import { RecentFreezesCard } from "@/components/home-alt-mini-cards/recent-freezes-card";
import { SupplyMovesCard } from "@/components/home-alt-mini-cards/supply-moves-card";
import type { ApiMeta } from "@/lib/api";
import { makeMintBurnCoinValuation, makeMintBurnFlowCoin } from "@/test-utils/mint-burn-fixtures";

type MonitoringState = "loading" | "ready" | "empty" | "unavailable" | "stale-with-data";

const {
  stablecoinTablePropsMock,
  useActiveDepegEventsMock,
  useBlacklistEventsPageMock,
  useBlacklistSummaryMock,
  useDexLiquidityMock,
  useHomeAltFiltersMock,
  useMintBurnFlowsMock,
  usePegSummaryMock,
  usePinnedStablecoinsMock,
  useReportCardsV9Mock,
  useStabilityIndexMock,
  useStablecoinsMock,
  useStressSignalsMock,
} = vi.hoisted(() => ({
  stablecoinTablePropsMock: vi.fn(),
  useActiveDepegEventsMock: vi.fn(),
  useBlacklistEventsPageMock: vi.fn(),
  useBlacklistSummaryMock: vi.fn(),
  useDexLiquidityMock: vi.fn(),
  useHomeAltFiltersMock: vi.fn(),
  useMintBurnFlowsMock: vi.fn(),
  usePegSummaryMock: vi.fn(),
  usePinnedStablecoinsMock: vi.fn(),
  useReportCardsV9Mock: vi.fn(),
  useStabilityIndexMock: vi.fn(),
  useStablecoinsMock: vi.fn(),
  useStressSignalsMock: vi.fn(),
}));

vi.mock("next/dynamic", () => ({
  default: () => {
    function MockStablecoinTable(props: Record<string, unknown>) {
      stablecoinTablePropsMock(props);
      return <div data-testid="stablecoin-table">{props.isLoading ? "table loading" : "table ready"}</div>;
    }
    return MockStablecoinTable;
  },
}));

vi.mock("next/image", () => ({
  default: ({ alt = "", ...props }: React.ImgHTMLAttributes<HTMLImageElement>) => <img alt={alt} {...props} />,
}));

vi.mock("@/hooks/api-hooks", () => ({
  useDexLiquidity: useDexLiquidityMock,
  usePegSummary: usePegSummaryMock,
  useReportCardsV9: useReportCardsV9Mock,
  useStabilityIndex: useStabilityIndexMock,
  useStressSignals: useStressSignalsMock,
}));
vi.mock("@/hooks/use-blacklist-events", () => ({
  useBlacklistEventsPage: useBlacklistEventsPageMock,
  useBlacklistSummary: useBlacklistSummaryMock,
}));
vi.mock("@/hooks/use-depeg-events", () => ({ useActiveDepegEvents: useActiveDepegEventsMock }));
vi.mock("@/hooks/use-home-alt-filters", () => ({ useHomeAltFilters: useHomeAltFiltersMock }));
vi.mock("@/hooks/use-mint-burn-flows", () => ({ useMintBurnFlows: useMintBurnFlowsMock }));
vi.mock("@/hooks/use-pinned-stablecoins", () => ({ usePinnedStablecoins: usePinnedStablecoinsMock }));
vi.mock("@/hooks/use-stablecoins", () => ({ useStablecoins: useStablecoinsMock }));
vi.mock("@/lib/stablecoin-static-data", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/stablecoin-static-data")>()),
  ACTIVE_STABLECOIN_ID_SET: new Set(["usdc-circle"]),
}));
vi.mock("@/components/homepage-client-view-model", () => ({
  buildHomepageCriticalViewModel: ({ stablecoinsData }: { stablecoinsData?: { peggedAssets?: unknown[] } }) => ({
    filteredRowCount: stablecoinsData?.peggedAssets?.length ?? 0,
    pegScores: new Map(),
  }),
  buildHomepageOptionalViewModel: () => ({ reportCardMap: {} }),
}));
vi.mock("@/components/peg-distribution-grid", () => ({ PegBrowseStrip: () => <div /> }));

const retry = vi.fn();
const UPDATED_AT = 1_700_000_000_000;
const stateError = new Error("refresh failed");

function queryFor<T>(state: MonitoringState, readyData: T, emptyData: T) {
  return {
    data: state === "loading" || state === "unavailable" ? undefined : state === "empty" ? emptyData : readyData,
    dataUpdatedAt: state === "loading" || state === "unavailable" ? 0 : UPDATED_AT,
    error: state === "unavailable" || state === "stale-with-data" ? stateError : null,
    isLoading: state === "loading",
    refetch: retry,
  };
}

const pegReady = {
  coins: [{ id: "usdc-circle", activeDepeg: true, currentDeviationBps: -75 }],
  summary: { activeDepegCount: 1, coinsAtPeg: 0, medianDeviationBps: 75, totalTracked: 1 },
};
const pegEmpty = {
  coins: [],
  summary: { activeDepegCount: 0, coinsAtPeg: 0, medianDeviationBps: 0, totalTracked: 0 },
};
const activeReady = {
  events: [{
    id: 1,
    stablecoinId: "usdc-circle",
    symbol: "USDC",
    startedAt: 1_699_999_900,
  }],
};
const psiReady = {
  current: {
    avg24h: 39,
    avg24hBand: "BEDROCK",
    band: "BEDROCK",
    components: { breadth: 1, severity: 1, stressBreadth: 1, trend: 1 },
    computedAt: 1_700_000_000,
    contributors: [],
    methodologyVersion: "test",
    score: 40,
    totalMcapUsd: 1,
  },
  history: [{ date: 1_699_913_600, score: 38, band: "BEDROCK", methodologyVersion: "test" }],
};
const flowReady = {
  coins: [{ has24hActivity: true, netFlow24hUsd: 1_000_000, stablecoinId: "usdc-circle", symbol: "USDC" }],
  gauge: { band: "MINTING", score: 10 },
};
const flowEmpty = { coins: [], gauge: { band: "NEUTRAL", score: 0 } };
const stablecoinReady = {
  peggedAssets: [{
    circulating: { peggedUSD: 20_000_000 },
    circulatingPrevWeek: { peggedUSD: 10_000_000 },
    id: "usdc-circle",
    name: "USD Coin",
    symbol: "USDC",
  }],
};
const freezesReady = {
  events: [{
    amountUsdAtEvent: 1_000,
    eventType: "blacklist",
    id: "freeze-1",
    stablecoin: "USDC",
    stablecoinId: "usdc-circle",
    timestamp: Math.floor(UPDATED_AT / 1000) - 60,
  }],
};
const freezeSummaryReady = {
  stats: {
    recentFreezeCount24h: 1,
    recentFreezeCount7d: 1,
    recentFreezeAmount24hUsd: 1_000,
    recentFreezeAmount7dUsd: 1_000,
    valuationCoverage: { recent24h: { knownCount: 1, unavailableCount: 0 }, recent7d: { knownCount: 1, unavailableCount: 0 } },
  },
};
const freezeSummaryEmpty = {
  stats: {
    recentFreezeCount24h: 0,
    recentFreezeCount7d: 0,
    recentFreezeAmount24hUsd: 0,
    recentFreezeAmount7dUsd: 0,
    valuationCoverage: { recent24h: { knownCount: 0, unavailableCount: 0 }, recent7d: { knownCount: 0, unavailableCount: 0 } },
  },
};

interface SurfaceCase {
  Component: ComponentType;
  configure: (state: MonitoringState) => void;
  emptyText: string | RegExp;
  emptyExtraText?: string;
  readyText: string;
}

const SURFACES: SurfaceCase[] = [
  {
    Component: ActiveDepegsCard,
    configure(state) {
      const active = queryFor(state, activeReady, { events: [] });
      useActiveDepegEventsMock.mockReturnValue({
        ...active,
        loadedCount: active.data?.events.length ?? 0,
      });
      usePegSummaryMock.mockReturnValue(queryFor(state, pegReady, pegEmpty));
    },
    emptyText: "No active incidents",
    readyText: "USDC",
  },
  {
    Component: PegHealthCard,
    configure(state) {
      usePegSummaryMock.mockReturnValue(queryFor(state, pegReady, pegEmpty));
    },
    emptyText: "No coin-level deviation rows",
    readyText: "Alert",
  },
  {
    Component: PsiBandCard,
    configure(state) {
      useStabilityIndexMock.mockReturnValue(
        queryFor<Record<string, unknown>>(state, psiReady, { current: null, history: [] }),
      );
    },
    emptyText: /90D/,
    readyText: "40.00",
  },
  {
    Component: MintBurnCard,
    configure(state) {
      useMintBurnFlowsMock.mockReturnValue(queryFor(state, flowReady, flowEmpty));
    },
    emptyText: "No 24h activity",
    readyText: "USDC",
  },
  {
    Component: SupplyMovesCard,
    configure(state) {
      useStablecoinsMock.mockReturnValue(queryFor(state, stablecoinReady, { peggedAssets: [] }));
    },
    emptyText: "No qualifying 7-day supply moves",
    readyText: "USDC",
  },
  {
    Component: RecentFreezesCard,
    configure(state) {
      useBlacklistEventsPageMock.mockReturnValue(queryFor(state, freezesReady, { events: [] }));
      useBlacklistSummaryMock.mockReturnValue(queryFor(state, freezeSummaryReady, freezeSummaryEmpty));
    },
    emptyText: "$0",
    emptyExtraText: "0X",
    readyText: "$1K",
  },
  {
    Component: (() => <HomeAltRankingsSection titleId="rankings-title" />) as ComponentType,
    configure(state) {
      useStablecoinsMock.mockReturnValue(queryFor(state, stablecoinReady, { peggedAssets: [] }));
      usePegSummaryMock.mockReturnValue(queryFor(state, pegReady, pegEmpty));
      useDexLiquidityMock.mockReturnValue(queryFor(state, {}, {}));
      useReportCardsV9Mock.mockReturnValue(queryFor(state, { cards: [] }, { cards: [] }));
      useStressSignalsMock.mockReturnValue(queryFor(state, { signals: {} }, { signals: {} }));
    },
    emptyText: "table ready",
    readyText: "table ready",
  },
];

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(UPDATED_AT);
});

afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe.each(SURFACES)(
  "$Component.name semantic query states",
  ({ Component, configure, emptyText, emptyExtraText, readyText }) => {
    function renderState(state: MonitoringState) {
      useHomeAltFiltersMock.mockReturnValue({ activeFilters: [] });
      usePinnedStablecoinsMock.mockReturnValue({ pinnedIds: [], togglePinned: vi.fn() });
      configure(state);
      return render(<Component />);
    }

    it("renders loading without making a status claim", () => {
      const view = renderState("loading");
      expect(view.container.querySelector('[data-slot="skeleton"], [data-testid="stablecoin-table"]')).toBeTruthy();
      expect(screen.queryByRole("alert")).toBeNull();
      expect(screen.queryByRole("status")).toBeNull();
    });

    it("renders ready data", () => {
      renderState("ready");
      expect(screen.queryAllByText(readyText).length).toBeGreaterThan(0);
      expect(screen.queryByRole("alert")).toBeNull();
      expect(screen.queryByRole("status")).toBeNull();
    });

    it("renders a valid empty state", () => {
      renderState("empty");
      expect(screen.queryAllByText(emptyText).length).toBeGreaterThan(0);
      if (emptyExtraText) expect(screen.getByText(emptyExtraText)).toBeTruthy();
      expect(screen.queryByRole("alert")).toBeNull();
      expect(screen.queryByRole("status")).toBeNull();
    });

    it("renders unavailable without a healthy or empty claim", () => {
      renderState("unavailable");
      expect(screen.getByRole("alert").textContent).toContain("temporarily unavailable");
      expect(screen.queryAllByText(emptyText)).toHaveLength(0);
    });

    it("keeps retained data visible with a stale warning", () => {
      renderState("stale-with-data");
      expect(screen.getByRole("status").textContent).toMatch(/saved data|older snapshot|last available data/);
      expect(screen.queryAllByText(readyText).length).toBeGreaterThan(0);
    });
  },
);

describe("RecentFreezesCard authoritative totals", () => {
  it("uses freeze-only summary windows when a release and later freezes saturate the 200-row page", () => {
    const pageEvents = [
      {
        amountUsdAtEvent: 1,
        eventType: "unblacklist",
        id: "release",
        stablecoin: "USDC",
        stablecoinId: "usdc-circle",
        timestamp: Math.floor(UPDATED_AT / 1000) - 1,
      },
      ...Array.from({ length: 199 }, (_, index) => ({
        amountUsdAtEvent: 10,
        eventType: "blacklist",
        id: `freeze-${index}`,
        stablecoin: "USDC",
        stablecoinId: "usdc-circle",
        timestamp: Math.floor(UPDATED_AT / 1000) - index - 2,
      })),
    ];
    useBlacklistEventsPageMock.mockReturnValue(queryFor("ready", { events: pageEvents }, { events: [] }));
    useBlacklistSummaryMock.mockReturnValue(
      queryFor(
        "ready",
        {
          stats: {
            recentFreezeCount24h: 200,
            recentFreezeCount7d: 350,
            recentFreezeAmount24hUsd: 123_456,
            recentFreezeAmount7dUsd: 456_789,
            valuationCoverage: { recent24h: { knownCount: 200, unavailableCount: 0 }, recent7d: { knownCount: 350, unavailableCount: 0 } },
          },
        },
        freezeSummaryEmpty,
      ),
    );

    render(<RecentFreezesCard />);

    expect(useBlacklistEventsPageMock).toHaveBeenCalledWith(expect.objectContaining({ limit: 200 }));
    expect(screen.getByText("200X")).toBeTruthy();
    expect(screen.getByText("$123K")).toBeTruthy();
    expect(screen.queryByText("199X")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "7d" }));
    expect(screen.getByText("350X")).toBeTruthy();
    expect(screen.getByText("$457K")).toBeTruthy();
  });
});

describe.each(SURFACES.slice(0, 6))("$Component.name producer health", ({ Component, configure, emptyText }) => {
  it.each([
    ["old generation", { updatedAt: UPDATED_AT / 1000 - 7 * 86400, ageSeconds: 7 * 86400, status: "fresh" }, /older snapshot/],
    ["quality warning", { updatedAt: UPDATED_AT / 1000, ageSeconds: 0, status: "fresh", warning: "199 pharos source degraded" }, /quality warning/],
    ["non-fresh dependency", { updatedAt: UPDATED_AT / 1000, ageSeconds: 0, status: "fresh", dependencies: { source: { updatedAt: UPDATED_AT / 1000, ageSeconds: 0, status: "stale" } } }, /quality warning/],
  ] as const)("warns for a successful response with %s despite a fresh receipt", (_case, meta, warning) => {
    configure("ready");
    for (const hook of [useActiveDepegEventsMock, usePegSummaryMock, useMintBurnFlowsMock, useStabilityIndexMock, useStablecoinsMock, useBlacklistEventsPageMock, useBlacklistSummaryMock]) {
      const result = hook.getMockImplementation()?.();
      if (result) hook.mockReturnValue({ ...result, dataUpdatedAt: UPDATED_AT, meta });
    }
    render(<Component />);
    expect(screen.getByRole("status").textContent).toMatch(warning);
  });

  it("does not discard producer warnings on an observed empty result", () => {
    configure("empty");
    for (const hook of [useActiveDepegEventsMock, usePegSummaryMock, useMintBurnFlowsMock, useStabilityIndexMock, useStablecoinsMock, useBlacklistEventsPageMock, useBlacklistSummaryMock]) {
      const result = hook.getMockImplementation()?.();
      if (result) hook.mockReturnValue({ ...result, meta: { updatedAt: UPDATED_AT / 1000, ageSeconds: 0, status: "degraded" } satisfies ApiMeta });
    }
    render(<Component />);
    expect(screen.getByRole("status")).toBeTruthy();
    expect(screen.queryAllByText(emptyText).length).toBeGreaterThan(0);
  });
});

describe("MintBurnCard activity and valuation", () => {
  it.each([
    ["no events", { has24hActivity: false, mintCount24h: 0, burnCount24h: 0, mintVolume24hUsd: 0, burnVolume24hUsd: 0, netFlow24hUsd: 0 }, "No 24h activity"],
    ["balanced events", { has24hActivity: true, mintCount24h: 1, burnCount24h: 1, mintVolume24hUsd: 100_000_000, burnVolume24hUsd: 100_000_000, netFlow24hUsd: 0 }, "Balanced 24h mint / burn activity"],
    ["inferred balanced events", { has24hActivity: undefined, mintCount24h: 1, burnCount24h: 1, mintVolume24hUsd: 100_000_000, burnVolume24hUsd: 100_000_000, netFlow24hUsd: 0 }, "Balanced 24h mint / burn activity"],
    ["nonzero flow", { has24hActivity: true, mintCount24h: 1, burnCount24h: 0, mintVolume24hUsd: 100_000_000, burnVolume24hUsd: 0, netFlow24hUsd: 100_000_000 }, "USDC"],
    ["unavailable valuation", { has24hActivity: true, mintCount24h: 1, burnCount24h: 1, netFlow24hUsd: null }, "Net flows unavailable"],
  ] as const)("distinguishes %s", (_label, activity, expected) => {
    const data = {
      coins: [makeMintBurnFlowCoin({
        ...activity,
        valuation: makeMintBurnCoinValuation({
          completeness: activity.netFlow24hUsd == null ? "partial" : "complete",
          unpricedMintEventCount: activity.netFlow24hUsd == null ? 1 : 0,
        }),
      })],
      gauge: { band: "NEUTRAL", score: 0 },
    };
    useMintBurnFlowsMock.mockReturnValue(queryFor("ready", data, flowEmpty));

    render(<MintBurnCard />);

    expect(screen.getByText(expected)).toBeTruthy();
    for (const other of ["No 24h activity", "Balanced 24h mint / burn activity", "Net flows unavailable"]) {
      if (other !== expected) expect(screen.queryByText(other)).toBeNull();
    }
  });
});
