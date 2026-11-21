// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { YieldClient } from "@/components/yield/yield-client";
import { makeYieldProvenance, makeYieldRanking } from "@shared/test-utils/yield-ranking-fixtures";
import { projectYieldRankingsSummary } from "@shared/lib/yield-rankings-summary";
import type { YieldRankingsSummaryResponse } from "@shared/types/yield-summary";
import { YIELD_OPPORTUNITY_SAFETY_DESCRIPTION } from "@shared/lib/yield-opportunity-provenance";

vi.mock("@/hooks/use-hydrated", () => ({ useHydrated: () => true }));

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
  coinStatesByIdMock,
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
  coinStatesByIdMock: { current: new Map() as ReadonlyMap<string, readonly unknown[]> },
}));

vi.mock("@/lib/analytics", () => ({ trackEvent: vi.fn() }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock }),
}));

vi.mock("@/hooks/api-hooks", () => ({
  usePegSummary: () => ({ data: {}, isError: false }),
  useYieldAdapterManifest: useYieldAdapterManifestMock,
  useYieldRankingsSummary: useYieldRankingsSummaryMock,
}));

vi.mock("@/hooks/use-coin-states", () => ({
  useCoinStates: () => ({ byId: coinStatesByIdMock.current, liveReady: true, clockReady: true }),
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

vi.mock("@/components/yield/yield-scatter-plot", () => ({
  YieldScatterPlot: (props: unknown) => {
    scatterPropsMock(props);
    return <div data-testid="yield-scatter-plot" />;
  },
}));

vi.mock("@/components/yield/yield-leaderboard", () => ({
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
    vi.useRealTimers();
    vi.clearAllMocks();
    coinStatesByIdMock.current = new Map();
  });

  it("passes over a paused coin's best-paid row", () => {
    coinStatesByIdMock.current = new Map([["usdc-circle", [{ kind: "paused", notice: { type: "warning", title: "Deposits disabled", kind: "paused" } }]]]);
    searchParamsMock.set("risk", "any");
    useYieldRankingsSummaryMock.mockReturnValue({ ...useYieldRankingsSummaryMock(), data: projectYieldRankingsSummary({
      rankings: [makeYieldRanking({ id: "usdc-circle", symbol: "USDC", apy30d: 9, pharosYieldScore: 91 }), makeYieldRanking({ id: "usdt-tether", symbol: "USDT", apy30d: 5, pharosYieldScore: 78 })],
      riskFreeRate: 4.25, scalingFactor: 1, medianApy: 5, updatedAt: 1_776_000_000, warnings: [],
    }) });
    render(<YieldClient />);
    const hero = screen.getByRole("group", { name: "Yield landscape overview" });
    within(hero).getByText((_, node) => node?.textContent === "Best-paid risk in view · USDT");
    // The Highest APY tile still names USDC, led by its state, counted as a warning.
    const tile = within(hero).getByText("Highest APY").closest("button")!;
    expect(tile.querySelector('[data-coin-state="paused"]')).not.toBeNull();
    expect(tile.textContent).toContain("1 warn");
  });

  it("withdraws a delivery-only score during a refresh and keeps it withheld on failure", () => {
    vi.useFakeTimers();
    const now = 1_776_000_000;
    const budget = 6 * 3600;
    vi.setSystemTime(now * 1000);
    searchParamsMock.set("risk", "any");
    const ready = { ...useYieldRankingsSummaryMock(), dataUpdatedAt: now * 1000, isFetching: true,
      data: projectYieldRankingsSummary({ ...makeResponse(), rankings: [
        { ...rows[0], dataSource: "defillama", pharosYieldScore: 91, warningSignals: ["data-freshness-unknown"],
          provenance: makeYieldProvenance({ sourceObservedAt: null, sourceAgeSeconds: null, sourceFreshness: "unknown", sourceMaxAgeSeconds: budget }) },
        rows[1],
      ], provenance: {
        selectionMethod: "confidence-weighted",
        benchmark: { rate: 4.25, recordDate: null, fetchedAt: now, ageSeconds: 0, source: "test", isFallback: false, fallbackMode: null },
        dlPools: { mode: "dex-cache", updatedAt: now - budget + 2, ageSeconds: budget - 2, poolCount: 1, fallbackMode: null },
        safetySnapshot: { kind: "ok", coverageRatio: 1, coveredCount: 2, trackedCount: 2, reason: null },
      } }),
    };
    useYieldRankingsSummaryMock.mockReturnValue(ready);
    const { rerender } = render(<YieldClient />);
    const hero = within(screen.getByRole("group", { name: "Yield landscape overview" }));
    const bestPaid = (symbol: string) => hero.getByText((_, node) => node?.textContent === `Best-paid risk in view · ${symbol}`);
    act(() => vi.advanceTimersByTime(1999));
    expect(bestPaid("USDC")).toBeTruthy();
    act(() => vi.advanceTimersByTime(1));
    expect(bestPaid("USDT")).toBeTruthy();
    useYieldRankingsSummaryMock.mockReturnValue({ ...ready, isFetching: false, error: new Error("Refresh failed") });
    rerender(<YieldClient />);
    expect(bestPaid("USDT")).toBeTruthy();
    const comparison = leaderboardPropsMock.mock.lastCall?.[0].comparisonRows;
    expect(comparison.find((row: { id: string }) => row.id === "usdc-circle")).toMatchObject({
      pharosYieldScore: null, pysNullReason: "source-stale", currentApy: rows[0].currentApy,
    });
    expect(ready.refetch).not.toHaveBeenCalled();
  });

  it.each([
    { provenance: "opportunity-safety" as const, label: "B\u2020", explained: true },
    { provenance: "live-report-card" as const, label: "· B ·", explained: false },
  ])("marks hero opportunity safety provenance without replacing the underlying score ($provenance)", ({ provenance, label, explained }) => {
    const ready = useYieldRankingsSummaryMock();
    useYieldRankingsSummaryMock.mockReturnValue({
      ...ready,
      data: projectYieldRankingsSummary({
        rankings: [makeYieldRanking({
          safetyScore: 72,
          safetyGrade: "B",
          provenance: makeYieldProvenance({ safetyProvenance: provenance }),
        })],
        riskFreeRate: 4.25,
        scalingFactor: 1,
        medianApy: 5,
        updatedAt: 1_776_000_000,
        warnings: [],
      }),
    });
    render(<YieldClient />);
    const hero = screen.getByRole("group", { name: "Yield landscape overview" });
    expect(within(hero).getAllByText((text) => text.includes(label)).length).toBeGreaterThan(0);
    expect(within(hero).queryAllByTitle(YIELD_OPPORTUNITY_SAFETY_DESCRIPTION).length > 0).toBe(explained);
  });

  it("co-headlines PYS alongside APY and local currency spread pill for a non-USD leader like ZCHF", () => {
    const zchf = makeYieldRanking({
      id: "zchf-frankencoin",
      symbol: "ZCHF",
      name: "Frankencoin",
      apy30d: 3.5,
      currentApy: 3.5,
      pharosYieldScore: 83,
      safetyScore: 82,
      safetyGrade: "A",
      benchmarkKey: "CHF",
      benchmarkLabel: "CHF 3M compounded SARON",
      benchmarkRate: -0.05,
      provenance: makeYieldProvenance({ safetyProvenance: "opportunity-safety" }),
    });
    const usdRow = makeYieldRanking({
      id: "usdc-circle",
      symbol: "USDC",
      name: "USD Coin",
      apy30d: 4.86,
      pharosYieldScore: 71,
      safetyScore: 86,
      safetyGrade: "A",
      benchmarkKey: "USD",
      benchmarkLabel: "USD 3M T-Bill",
      benchmarkRate: 4.39,
    });
    useYieldRankingsSummaryMock.mockReturnValue({
      ...useYieldRankingsSummaryMock(),
      data: projectYieldRankingsSummary({
        rankings: [zchf, usdRow],
        riskFreeRate: 4.39,
        scalingFactor: 1,
        medianApy: 4.1,
        updatedAt: 1_776_000_000,
        warnings: [],
        benchmarks: {
          USD: { key: "USD", label: "USD 3M T-Bill", currency: "USD", rate: 4.39, recordDate: "2026-11-20", fetchedAt: 1_776_000_000, ageSeconds: 0, source: "fred", isFallback: false, fallbackMode: null },
          CHF: { key: "CHF", label: "CHF 3M compounded SARON", currency: "CHF", rate: -0.05, recordDate: "2026-11-20", fetchedAt: 1_776_000_000, ageSeconds: 0, source: "snb", isFallback: false, fallbackMode: null },
        },
      }),
    });

    render(<YieldClient />);
    const hero = screen.getByRole("group", { name: "Yield landscape overview" });

    expect(within(hero).getByText("83.0")).toBeTruthy();
    expect(within(hero).getByText("3.50%")).toBeTruthy();
    const spreadPill = within(hero).getByTestId("hero-local-spread-pill");
    expect(spreadPill.textContent).toContain("+3.55 pp");
    expect(spreadPill.textContent).toContain("vs CHF 3M");
    expect(within(hero).getAllByText((text) => text.includes("Sweet Spot · A\u2020 · PYS 83.0 · 0 warns")).length).toBeGreaterThan(0);
    expect(within(hero).getByText(/Venue-adjusted Safety Score/)).toBeTruthy();
    expect(within(hero).getByText(/Non-USD coins are graded vs local currency rates/)).toBeTruthy();
  });

  it("wires scatter click-to-row to highlight the selected leaderboard row", () => {
    render(<YieldClient />);
    const scatterProps = scatterPropsMock.mock.calls.at(-1)?.[0] as {
      onSelectRow?: (id: string) => void;
    };
    expect(typeof scatterProps.onSelectRow).toBe("function");

    act(() => {
      scatterProps.onSelectRow?.("usdt-tether");
    });

    const leaderboardProps = leaderboardPropsMock.mock.calls.at(-1)?.[0] as {
      highlightedRowId?: string | null;
    };
    expect(leaderboardProps.highlightedRowId).toBe("usdt-tether");
  });

  it("preserves a valid incoming yield-type filter while ranking options load", () => {
    searchParamsMock.set("yieldType", "lending-opportunity");
    const ready = useYieldRankingsSummaryMock();
    useYieldRankingsSummaryMock.mockReturnValue({ ...ready, data: undefined, isLoading: true });
    const { rerender } = render(<YieldClient />);
    expect(useYieldAdapterManifestMock).toHaveBeenCalledTimes(1);
    expect(replaceParamsMock).not.toHaveBeenCalled();

    useYieldRankingsSummaryMock.mockReturnValue(ready);
    rerender(<YieldClient />);
    expect(replaceParamsMock).not.toHaveBeenCalled();
    expect(searchParamsMock.get("yieldType")).toBe("lending-opportunity");
  });

  it("hides Reset on the paramless landing view and shows it once a filter param exists", () => {
    render(<YieldClient />);
    expect(screen.getByText("No warnings")).toBeTruthy();
    expect(screen.getByText("50+ safety")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Reset" })).toBeNull();

    cleanup();
    searchParamsMock.set("minSafety", "80");
    render(<YieldClient />);
    expect(screen.getByRole("button", { name: "Reset" })).toBeTruthy();
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

  it.each([false, true])("uses an effective Treasury comparison only when a comparable row is visible (xGLD only=%s)", (xgldOnly) => {
    const response = makeResponse();
    const xgld = projectYieldRankingsSummary({
      ...response,
      rankings: [makeYieldRanking({
        id: "xgld-unitas", safetyScore: 80,
        provenance: makeYieldProvenance({ sourceKey: "onchain:xgld-unitas" }),
      })],
    }).rankings[0];
    useYieldRankingsSummaryMock.mockReturnValue({
      data: {
        ...response,
        rankings: xgldOnly ? [xgld] : [xgld, ...response.rankings],
        riskFreeRate: 4.04,
        benchmarks: { USD: { key: "USD", rate: 4, source: "fred-dgs3mo", isFallback: false } },
      },
      meta: null, isLoading: false, error: null, dataUpdatedAt: 1_776_000_000, refetch: vi.fn(),
    });
    render(<YieldClient />);
    expect(scatterPropsMock.mock.calls.at(-1)?.[0]).toMatchObject({ benchmarkRate: xgldOnly ? null : 4.04 });
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

    fireEvent.click(screen.getByRole("button", { name: /Conservative/ }));

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

    const riskBands = screen.getByRole("group", { name: "Risk tolerance bands" });
    fireEvent.click(within(riskBands).getByRole("button", { name: /^All/ }));

    const update = replaceParamsMock.mock.calls[0]?.[0] as (params: URLSearchParams) => void;
    const params = new URLSearchParams(searchParamsMock);
    update(params);

    expect(params.get("risk")).toBe("any");
  });
});
