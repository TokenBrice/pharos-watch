// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { YieldClient } from "@/components/yield/yield-client";
import { makeYieldProvenance, makeYieldRanking } from "@shared/test-utils/yield-ranking-fixtures";
import { projectYieldRankingsSummary } from "@shared/lib/yield-rankings-summary";
import type { YieldRankingsSummaryResponse } from "@shared/types/yield-summary";

const {
  useYieldAdapterManifestMock,
  useYieldRankingsSummaryMock,
  searchParamsMock,
  replaceParamsMock,
  setParamMock,
  pushMock,
  leaderboardPropsMock,
  scatterPropsMock,
  staleQueriesMock,
  trackEventMock,
} = vi.hoisted(() => ({
  useYieldAdapterManifestMock: vi.fn(),
  useYieldRankingsSummaryMock: vi.fn(),
  searchParamsMock: new URLSearchParams(),
  replaceParamsMock: vi.fn(),
  setParamMock: vi.fn(),
  pushMock: vi.fn(),
  leaderboardPropsMock: vi.fn(),
  scatterPropsMock: vi.fn(),
  staleQueriesMock: vi.fn(),
  trackEventMock: vi.fn(),
}));

vi.mock("@/lib/analytics", () => ({ trackEvent: trackEventMock }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock }),
}));

vi.mock("@/hooks/api-hooks", () => ({
  useYieldAdapterManifest: useYieldAdapterManifestMock,
  useYieldRankingsSummary: useYieldRankingsSummaryMock,
}));

vi.mock("@/hooks/use-url-filters", () => ({
  useUrlFilters: () => ({
    searchParams: searchParamsMock,
    replaceParams: replaceParamsMock,
    setParam: setParamMock,
  }),
}));

vi.mock("@/lib/logos", () => ({
  logosById: {},
}));

vi.mock("@/hooks/use-watchlist", () => ({
  useWatchlist: () => ({ idSet: new Set<string>() }),
}));

vi.mock("@/components/yield-scatter-plot", () => ({
  YieldScatterPlot: (props: unknown) => {
    scatterPropsMock(props);
    return <div data-testid="yield-scatter-plot" />;
  },
}));

vi.mock("@/components/yield-leaderboard", () => ({
  YieldLeaderboard: (props: unknown) => {
    leaderboardPropsMock(props);
    return <div data-testid="yield-leaderboard" />;
  },
}));

vi.mock("@/components/stale-data-banner", () => ({
  StaleDataBanner: ({ queries }: { queries: unknown[] }) => {
    staleQueriesMock(queries);
    return <div data-testid="stale-data-banner" />;
  },
}));

vi.mock("@/components/yield/yield-source-board", () => ({
  YieldSourceBoard: () => <div data-testid="yield-source-board" />,
}));

vi.mock("@/components/yield/reference-rates-strip", () => ({
  ReferenceRatesStrip: () => <div data-testid="reference-rates-strip" />,
}));

vi.mock("@/components/yield/coin-index", () => ({
  YieldCoinIndex: () => <div data-testid="yield-coin-index" />,
}));

const rows = [
  makeYieldRanking({
    id: "usdc-circle",
    symbol: "USDC",
    name: "USD Coin",
    safetyScore: 82,
    sourceTvlUsd: 5_000_000,
    provenance: makeYieldProvenance({ confidenceTier: "curated" }),
  }),
  makeYieldRanking({
    id: "usdt-tether",
    symbol: "USDT",
    name: "Tether USD",
    safetyScore: 60,
    sourceTvlUsd: 10_000_000,
    provenance: makeYieldProvenance({ confidenceTier: "discovered" }),
  }),
];

function makeResponse(): YieldRankingsSummaryResponse {
  return projectYieldRankingsSummary({
    rankings: rows,
    riskFreeRate: 4.25,
    scalingFactor: 1,
    medianApy: 5,
    updatedAt: 1_776_000_000,
    warnings: [],
  });
}

describe("YieldClient", () => {
  beforeEach(() => {
    searchParamsMock.forEach((_, key) => searchParamsMock.delete(key));
    useYieldRankingsSummaryMock.mockReturnValue({
      data: makeResponse(),
      meta: null,
      isLoading: false,
      error: null,
      dataUpdatedAt: 1_776_000_000,
      refetch: vi.fn(),
    });
    useYieldAdapterManifestMock.mockReturnValue({
      data: { methodologyVersion: "v1", updatedAt: 1_776_000_000, entries: [] },
      isLoading: false,
      error: null,
      dataUpdatedAt: 1_776_000_000,
      refetch: vi.fn(),
    });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("keeps the risk budget slider available when filters hide every yield row", () => {
    searchParamsMock.set("q", "zzzz-no-match");

    render(<YieldClient />);

    expect(screen.getByRole("slider", { name: "Risk tolerance" })).toBeTruthy();
    expect(screen.queryByTestId("yield-scatter-plot")).toBeNull();
  });

  it.each([
    { data: undefined, isLoading: true, error: null },
    { data: undefined, isLoading: false, error: null },
    { data: undefined, isLoading: false, error: new Error("Unavailable") },
    { data: makeResponse(), isLoading: false, error: new Error("Refresh failed") },
  ])("waits for loaded error-free data before tracking an empty view (%#)", (pending) => {
    searchParamsMock.set("q", "zzzz-no-match");
    const ready = useYieldRankingsSummaryMock();
    useYieldRankingsSummaryMock.mockReturnValue({ ...ready, ...pending });
    const { rerender } = render(<YieldClient />);
    expect(trackEventMock).not.toHaveBeenCalledWith("yield_zero_results", expect.anything());

    useYieldRankingsSummaryMock.mockReturnValue(ready);
    rerender(<YieldClient />);
    expect(trackEventMock).toHaveBeenCalledWith("yield_zero_results", { active_filter_count: 0 });
    rerender(<YieldClient />);
    expect(trackEventMock.mock.calls.filter(([name]) => name === "yield_zero_results")).toHaveLength(1);
  });

  it("still tracks a successfully loaded empty payload", () => {
    useYieldRankingsSummaryMock.mockReturnValue({
      ...useYieldRankingsSummaryMock(),
      data: { ...makeResponse(), rankings: [] },
    });
    render(<YieldClient />);
    expect(trackEventMock).toHaveBeenCalledWith("yield_zero_results", { active_filter_count: 0 });
  });

  it("preserves a valid incoming yield-type filter while ranking options load", () => {
    searchParamsMock.set("yieldType", "lending-opportunity");
    const ready = useYieldRankingsSummaryMock();
    useYieldRankingsSummaryMock.mockReturnValue({ ...ready, data: undefined, isLoading: true });
    const { rerender } = render(<YieldClient />);
    expect(replaceParamsMock).not.toHaveBeenCalled();

    useYieldRankingsSummaryMock.mockReturnValue(ready);
    rerender(<YieldClient />);
    expect(replaceParamsMock).not.toHaveBeenCalled();
    expect(searchParamsMock.get("yieldType")).toBe("lending-opportunity");
  });

  it("resolves comparison rows independently of the current filters", () => {
    searchParamsMock.set("q", "zzzz-no-match");

    render(<YieldClient />);

    const props = leaderboardPropsMock.mock.calls.at(-1)?.[0] as {
      rows: unknown[];
      comparisonRows: Array<{ id: string }>;
    };
    expect(props.rows).toHaveLength(0);
    expect(props.comparisonRows.map((row) => row.id)).toEqual(["usdc-circle", "usdt-tether"]);
  });

  it("renders both the risk budget slider and scatter plot when yield rows are visible", () => {
    render(<YieldClient />);

    expect(useYieldRankingsSummaryMock).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("slider", { name: "Risk tolerance" })).toBeTruthy();
    expect(screen.getByTestId("yield-scatter-plot")).toBeTruthy();
  });

  it("shows the top three PYS rows as a ranked hero podium", () => {
    const podiumRows = [
      makeYieldRanking({ id: "rank-three", name: "Third Coin", symbol: "THREE", pharosYieldScore: 63 }),
      makeYieldRanking({ id: "rank-one", name: "First Coin", symbol: "ONE", pharosYieldScore: 91 }),
      makeYieldRanking({ id: "rank-four", name: "Fourth Coin", symbol: "FOUR", pharosYieldScore: 42 }),
      makeYieldRanking({ id: "rank-two", name: "Second Coin", symbol: "TWO", pharosYieldScore: 78 }),
    ];
    useYieldRankingsSummaryMock.mockReturnValue({
      data: projectYieldRankingsSummary({
        rankings: podiumRows,
        riskFreeRate: 4.25,
        scalingFactor: 1,
        medianApy: 5,
        updatedAt: 1_776_000_000,
        warnings: [],
      }),
      meta: null,
      isLoading: false,
      error: null,
      dataUpdatedAt: 1_776_000_000,
      refetch: vi.fn(),
    });

    render(<YieldClient />);

    const podium = screen.getByRole("group", { name: "Top three Pharos Yield Scores" });
    expect(within(podium).getByRole("button", { name: "Rank 1: First Coin (ONE), PYS 91.0" })).toBeTruthy();
    expect(within(podium).getByRole("button", { name: "Rank 2: Second Coin (TWO), PYS 78.0" })).toBeTruthy();
    expect(within(podium).getByRole("button", { name: "Rank 3: Third Coin (THREE), PYS 63.0" })).toBeTruthy();
    expect(within(podium).queryByText("FOUR")).toBeNull();
  });

  it("passes every filtered opportunity to the scatter plot", () => {
    const manyRows = Array.from({ length: 60 }, (_, index) =>
      makeYieldRanking({
        id: `test-yield-${index}`,
        symbol: `T${index}`,
        name: `Test Yield ${index}`,
        currentApy: 5 + index / 10,
        apy30d: 5 + index / 10,
        safetyScore: 40 + (index % 55),
      }),
    );
    useYieldRankingsSummaryMock.mockReturnValue({
      data: projectYieldRankingsSummary({
        rankings: manyRows,
        riskFreeRate: 4.25,
        scalingFactor: 1,
        medianApy: 8,
        updatedAt: 1_776_000_000,
        warnings: [],
      }),
      meta: null,
      isLoading: false,
      error: null,
      dataUpdatedAt: 1_776_000_000,
      refetch: vi.fn(),
    });

    render(<YieldClient />);

    const props = scatterPropsMock.mock.calls.at(-1)?.[0] as { rankings: unknown[] };
    expect(props.rankings).toHaveLength(60);
  });

  it("keeps the build-static adapter manifest out of live freshness aggregation", () => {
    render(<YieldClient />);

    const queries = staleQueriesMock.mock.calls.at(-1)?.[0] as Array<{ label?: string; preset?: string }>;
    expect(queries).toEqual([expect.objectContaining({ preset: "yieldRankings" })]);
    expect(queries.some((query) => query.label === "Yield source roster")).toBe(false);
  });

  it("preserves a retryable error notice when the static adapter manifest fails", () => {
    const refetch = vi.fn();
    useYieldAdapterManifestMock.mockReturnValue({
      data: undefined,
      isLoading: false,
      error: new Error("Manifest unavailable"),
      dataUpdatedAt: 0,
      refetch,
    });

    render(<YieldClient />);

    expect(screen.getByText("Manifest unavailable")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(refetch).toHaveBeenCalledOnce();
  });

  it("shows the selector return strip when opened from the Stablecoin Picker", () => {
    searchParamsMock.set("from", "selector");

    render(<YieldClient />);

    expect(screen.getByText("Opened from the Yield profile in Stablecoin Picker.")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Adjust picker answers" }).getAttribute("href")).toBe(
      "/screener/picker?p=yield",
    );
  });

  it("explains when an omitted per-coin workbench falls back to the leaderboard", () => {
    searchParamsMock.set("workbenchFallback", "usdc-circle");

    render(<YieldClient />);

    expect(screen.getByRole("region", { name: "Yield workbench fallback" })).toBeTruthy();
    expect(screen.getByText(/dedicated Yield workbench for/i).textContent).toContain("USDC");
    expect(screen.getByRole("link", { name: "View USDC dossier" }).getAttribute("href")).toBe(
      "/stablecoin/usdc-circle",
    );
  });

  it("does not render fallback metadata for an invalid or untracked id", () => {
    searchParamsMock.set("workbenchFallback", "not-a-tracked-stablecoin");

    render(<YieldClient />);

    expect(screen.queryByRole("region", { name: "Yield workbench fallback" })).toBeNull();
  });

  it("risk budget changes preserve non-risk research filters", () => {
    searchParamsMock.set("peg", "USD");
    searchParamsMock.set("q", "coin");
    searchParamsMock.set("minSafety", "65");
    searchParamsMock.set("depth", "thin");
    searchParamsMock.set("sourcePosture", "speculative");
    searchParamsMock.set("sourceConfidence", "curated");
    searchParamsMock.set("warnings", "only");

    render(<YieldClient />);

    fireEvent.change(screen.getByRole("slider", { name: "Risk tolerance" }), {
      target: { value: "0" },
    });

    expect(replaceParamsMock).toHaveBeenCalledTimes(1);
    const update = replaceParamsMock.mock.calls[0]?.[0] as (params: URLSearchParams) => void;
    const params = new URLSearchParams(searchParamsMock);
    update(params);

    expect(params.get("peg")).toBe("USD");
    expect(params.get("q")).toBe("coin");
    expect(params.get("minSafety")).toBe("80");
    expect(params.get("depth")).toBe("hide-thin");
    expect(params.get("sourcePosture")).toBe("clean");
    expect(params.get("warnings")).toBe("hide");
    expect(params.get("sourceConfidence")).toBeNull();
  });
});
