// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ComponentType } from "react";

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
  referenceRatesPropsMock,
  staleQueriesMock,
} = vi.hoisted(() => ({
  useYieldAdapterManifestMock: vi.fn(),
  useYieldRankingsSummaryMock: vi.fn(),
  searchParamsMock: new URLSearchParams(),
  replaceParamsMock: vi.fn(),
  setParamMock: vi.fn(),
  pushMock: vi.fn(),
  leaderboardPropsMock: vi.fn(),
  scatterPropsMock: vi.fn(),
  referenceRatesPropsMock: vi.fn(),
  staleQueriesMock: vi.fn(),
}));

vi.mock("@/lib/analytics", () => ({ trackEvent: vi.fn() }));

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
  getLogoSrc: () => undefined,
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
  ReferenceRatesStrip: (props: unknown) => {
    referenceRatesPropsMock(props);
    return <div data-testid="reference-rates-strip" />;
  },
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
    [...searchParamsMock.keys()].forEach((key) => searchParamsMock.delete(key));
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

  it("hands the leaderboard the benchmark registry and methodology version the payload carries", () => {
    const response = makeResponse();
    useYieldRankingsSummaryMock.mockReturnValue({
      data: {
        ...response,
        benchmarks: { USD: { key: "USD", rate: 4.25, source: "test", fetchedAt: 1_776_000_000, isFallback: false, fallbackMode: null } },
        methodology: { ...response.methodology, version: "8.43" },
      },
      meta: null,
      isLoading: false,
      error: null,
      dataUpdatedAt: 1_776_000_000,
      refetch: vi.fn(),
    });

    render(<YieldClient />);

    const props = leaderboardPropsMock.mock.calls.at(-1)?.[0] as {
      benchmarks: Record<string, { rate: number }> | null;
      methodologyVersion: string | undefined;
    };
    expect(props.benchmarks?.USD?.rate).toBe(4.25);
    expect(props.methodologyVersion).toBe("8.43");
  });

  it("counts hidden-peg benchmark currencies from the row universe", () => {
    // SGD and MXN have no individual peg filter pill, but the reference-rates
    // table ships benchmark rows for both and must not read "Tracked 0".
    useYieldRankingsSummaryMock.mockReturnValue({
      data: projectYieldRankingsSummary({
        rankings: [
          makeYieldRanking({ id: "xsgd-straitsx", symbol: "XSGD", name: "XSGD" }),
          makeYieldRanking({ id: "mxnb-juno", symbol: "MXNB", name: "MXNB" }),
        ],
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

    const props = referenceRatesPropsMock.mock.calls.at(-1)?.[0] as {
      currencyCounts?: Record<string, number>;
    };
    expect(props.currencyCounts).toMatchObject({ SGD: 1, MXN: 1 });
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

    searchParamsMock.set("risk", "any");
    render(<YieldClient />);

    const props = scatterPropsMock.mock.calls.at(-1)?.[0] as { rankings: unknown[] };
    expect(props.rankings).toHaveLength(60);
  });

  it("relabells the largest-market tile as tracked and footnotes the unmeasured-TVL rows", () => {
    useYieldRankingsSummaryMock.mockReturnValue({
      data: projectYieldRankingsSummary({
        rankings: [
          makeYieldRanking({ id: "usdc-circle", symbol: "USDC", name: "USD Coin", sourceTvlUsd: 5_000_000 }),
          makeYieldRanking({ id: "usdt-tether", symbol: "USDT", name: "Tether USD", sourceTvlUsd: 10_000_000 }),
          makeYieldRanking({ id: "usde-ethena", symbol: "USDE", name: "Ethena USDe", sourceTvlUsd: null }),
        ],
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

    expect(screen.getByText("Largest tracked market")).toBeTruthy();
    expect(screen.getByText(/1 of 3 rows publish no source TVL/)).toBeTruthy();
  });

  it("hands the hero scatter the registry and the reference benchmark's age evidence", () => {
    render(<YieldClient />);

    const props = scatterPropsMock.mock.calls.at(-1)?.[0] as {
      benchmarks: unknown;
      benchmarkAgeEvidence: unknown;
    };
    expect(props).toHaveProperty("benchmarks");
    expect(props).toHaveProperty("benchmarkAgeEvidence");
  });

  it("shows the clipped-outlier count and the unscored-row note on the compact hero scatter", async () => {
    const { YieldScatterPlot } = (await vi.importActual("@/components/yield-scatter-plot")) as {
      YieldScatterPlot: ComponentType<{
        rankings: Array<{ safetyScore: number | null; apy30d: number } & Record<string, unknown>>;
        benchmarkRate: number;
        compact?: boolean;
        frame?: "stage" | "bare";
        usesDefaultBenchmarkFrame?: boolean;
      }>;
    };
    const scatterRows = [
      ...Array.from({ length: 13 }, (_, index) =>
        makeYieldRanking({
          id: `steady-${index}`,
          symbol: `S${index}`,
          name: `Steady ${index}`,
          apy30d: 5,
          safetyScore: 50 + index,
        }),
      ),
      makeYieldRanking({ id: "rocket", symbol: "RKT", name: "Rocket", apy30d: 200, safetyScore: 70 }),
      makeYieldRanking({ id: "unscored", symbol: "UNSC", name: "Unscored", apy30d: 6, safetyScore: null }),
    ];

    render(
      <YieldScatterPlot
        rankings={scatterRows}
        benchmarkRate={4.25}
        compact
        frame="bare"
        usesDefaultBenchmarkFrame
      />,
    );

    // E10: the compact hero surface shows the clipped count...
    expect(screen.getByText(/outlier pinned above/)).toBeTruthy();
    // E13: ...labelled as the chart-wide USD frame in mixed views.
    expect(screen.getByText("(USD frame)")).toBeTruthy();
    // E17: null-safety rows are annotated, not silently dropped.
    expect(screen.getByText(/1 row without a safety score not shown/)).toBeTruthy();
    const figure = screen.getByRole("figure");
    expect(figure.getAttribute("aria-label")).toContain("1 row without a safety score not shown");
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
    expect(params.get("risk")).toBe("conservative");
    expect(params.get("minSafety")).toBeNull();
    expect(params.get("depth")).toBeNull();
    expect(params.get("sourcePosture")).toBeNull();
    expect(params.get("sourceConfidence")).toBeNull();
    expect(params.get("warnings")).toBeNull();
  });

  it("selecting the all risk-budget stop writes the neutral any param", () => {
    render(<YieldClient />);

    fireEvent.change(screen.getByRole("slider", { name: "Risk tolerance" }), {
      target: { value: "3" },
    });

    const update = replaceParamsMock.mock.calls[0]?.[0] as (params: URLSearchParams) => void;
    const params = new URLSearchParams(searchParamsMock);
    update(params);

    expect(params.get("risk")).toBe("any");
  });
});
