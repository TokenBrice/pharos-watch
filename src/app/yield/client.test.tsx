// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { YieldClient } from "./client";
import { makeYieldProvenance, makeYieldRanking } from "@/test/fixtures/yield";
import type { YieldRankingsResponse } from "@shared/types";

const {
  useYieldAdapterManifestMock,
  useYieldRankingsMock,
  searchParamsMock,
  replaceParamsMock,
  setParamMock,
  pushMock,
  leaderboardPropsMock,
} = vi.hoisted(() => ({
  useYieldAdapterManifestMock: vi.fn(),
  useYieldRankingsMock: vi.fn(),
  searchParamsMock: new URLSearchParams(),
  replaceParamsMock: vi.fn(),
  setParamMock: vi.fn(),
  pushMock: vi.fn(),
  leaderboardPropsMock: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock }),
}));

vi.mock("@/hooks/api-hooks", () => ({
  useYieldAdapterManifest: useYieldAdapterManifestMock,
  useYieldRankings: useYieldRankingsMock,
}));

vi.mock("@/hooks/use-url-filters", () => ({
  useUrlFilters: () => ({
    searchParams: searchParamsMock,
    replaceParams: replaceParamsMock,
    setParam: setParamMock,
  }),
}));

vi.mock("@/hooks/use-logos", () => ({
  useLogos: () => ({ data: {} }),
}));

vi.mock("@/hooks/use-watchlist", () => ({
  useWatchlist: () => ({ idSet: new Set<string>() }),
}));

vi.mock("@/components/yield-scatter-plot", () => ({
  YieldScatterPlot: () => <div data-testid="yield-scatter-plot" />,
}));

vi.mock("@/components/yield-leaderboard", () => ({
  YieldLeaderboard: (props: unknown) => {
    leaderboardPropsMock(props);
    return <div data-testid="yield-leaderboard" />;
  },
}));

vi.mock("@/app/yield/source-board", () => ({
  YieldSourceBoard: () => <div data-testid="yield-source-board" />,
}));

vi.mock("@/app/yield/reference-rates-strip", () => ({
  ReferenceRatesStrip: () => <div data-testid="reference-rates-strip" />,
}));

vi.mock("@/app/yield/coin-index", () => ({
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

function makeResponse(): YieldRankingsResponse {
  return {
    rankings: rows,
    riskFreeRate: 4.25,
    scalingFactor: 1,
    medianApy: 5,
    updatedAt: 1_776_000_000,
    warnings: [],
  };
}

describe("YieldClient", () => {
  beforeEach(() => {
    searchParamsMock.forEach((_, key) => searchParamsMock.delete(key));
    useYieldRankingsMock.mockReturnValue({
      data: makeResponse(),
      meta: null,
      isLoading: false,
      error: null,
      dataUpdatedAt: 1_776_000_000,
      refetch: vi.fn(),
    });
    useYieldAdapterManifestMock.mockReturnValue({
      data: { adapters: [], generatedAt: 1_776_000_000 },
      meta: null,
      error: null,
      dataUpdatedAt: 1_776_000_000,
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

    expect(screen.getByRole("slider", { name: "Risk tolerance" })).toBeTruthy();
    expect(screen.getByTestId("yield-scatter-plot")).toBeTruthy();
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
