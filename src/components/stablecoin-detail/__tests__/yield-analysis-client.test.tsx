// @vitest-environment jsdom

import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import YieldAnalysisClient from "@/components/stablecoin-detail/yield-analysis-client";
import { makeYieldDetailRanking, makeYieldDetailResponse } from "@/components/__tests__/yield-detail.test-support";
import type { StablecoinStaticMeta } from "@/lib/stablecoin-static-meta";
import { formatChartDate } from "@shared/lib/format";
import type { YieldHistoryPoint, YieldRanking, YieldRankingsResponse } from "@shared/types";

const { useYieldRankingsMock, useYieldHistoryMock, replaceParamsMock, loadClientStablecoinDetailMock } = vi.hoisted(() => ({
  useYieldRankingsMock: vi.fn(),
  useYieldHistoryMock: vi.fn(),
  replaceParamsMock: vi.fn(),
  loadClientStablecoinDetailMock: vi.fn(),
}));

let sourcesParam = "";

vi.mock("next/dynamic", () => ({
  // Doubles are told apart by their own props, not by declaration order.
  default: () =>
    function DynamicYieldSection(props: {
      attribution?: unknown;
      availableSources?: Array<{ sourceKey: string }>;
      externalSourceKeys?: string[];
      benchmarkRate?: number;
      medianApy?: number;
    }) {
      if (props.attribution !== undefined) {
        return <div data-testid="yield-change-attribution" />;
      }
      return (
        <div
          data-testid="yield-history-chart"
          data-available-sources={(props.availableSources ?? []).map((source) => source.sourceKey).join(",")}
          data-external-source-keys={(props.externalSourceKeys ?? []).join(",")}
          data-benchmark-rate={props.benchmarkRate}
          data-median-apy={props.medianApy}
        />
      );
    },
}));

vi.mock("@/hooks/api-hooks", () => ({
  useYieldRankings: useYieldRankingsMock,
  useYieldHistory: useYieldHistoryMock,
}));

vi.mock("@shared/lib/stablecoins/client-detail", () => ({
  loadClientStablecoinDetail: loadClientStablecoinDetailMock,
}));

vi.mock("@/hooks/use-url-filters", () => ({
  useUrlFilters: () => ({
    getParam: (key: string) => (key === "sources" ? sourcesParam : ""),
    replaceParams: replaceParamsMock,
  }),
}));

vi.mock("@/components/pys-breakdown", () => ({
  PysBreakdown: ({ scalingFactor }: { scalingFactor: number }) => (
    <div data-testid="pys-breakdown" data-scaling-factor={scalingFactor} />
  ),
}));

vi.mock("@/components/yield-source-risk-card", () => ({
  YieldSourceRiskCard: () => <div data-testid="yield-source-risk-card" />,
}));

function makeRanking(overrides: Partial<YieldRanking> = {}): YieldRanking {
  return makeYieldDetailRanking({
    id: "usdn-smardex",
    symbol: "USDN",
    name: "SMARDEX USDN",
    benchmarkLabel: "SOFR",
    benchmarkRate: undefined,
    benchmarkSelectionMode: "fallback-usd",
    benchmarkIsFallback: true,
    ...overrides,
  });
}

function makeResponse(rankings: YieldRanking[] = []): YieldRankingsResponse {
  return makeYieldDetailResponse(rankings);
}

function staticCoin(
  id: string,
  name: string,
  symbol: string,
  yieldBearing: boolean,
): StablecoinStaticMeta {
  return {
    id,
    name,
    symbol,
    flags: {
      backing: "crypto-backed",
      pegCurrency: "USD",
      governance: "centralized",
      yieldBearing,
      rwa: false,
      navToken: false,
    },
  };
}

function setRankingsQuery(overrides: Record<string, unknown> = {}) {
  useYieldRankingsMock.mockReturnValue({
    data: makeResponse([]),
    meta: null,
    error: null,
    isLoading: false,
    ...overrides,
  });
}

function makeHistoryPoint(
  overrides: Partial<YieldHistoryPoint> & Pick<YieldHistoryPoint, "date" | "apy">,
): YieldHistoryPoint {
  return {
    apyBase: null,
    apyReward: null,
    exchangeRate: null,
    sourceTvlUsd: null,
    warningSignals: [],
    ...overrides,
  };
}

function setHistoryQuery(history: YieldHistoryPoint[] = [], overrides: Record<string, unknown> = {}) {
  useYieldHistoryMock.mockReturnValue({
    data: { current: null, history, methodology: { version: "v8.14" } },
    dataUpdatedAt: Date.now(),
    meta: null,
    error: null,
    isLoading: false,
    refetch: vi.fn(),
    ...overrides,
  });
}

function renderWorkbench() {
  return render(<YieldAnalysisClient id="usdn-smardex" staticCoin={staticCoin("usdn-smardex", "SMARDEX USDN", "USDN", true)} />);
}

function timelineCards() {
  return [document.getElementById("warning-signals")!, document.getElementById("source-switches")!];
}

describe("YieldAnalysisClient", () => {
  beforeEach(() => {
    sourcesParam = "";
    replaceParamsMock.mockReset();
    useYieldRankingsMock.mockReset();
    useYieldHistoryMock.mockReset();
    loadClientStablecoinDetailMock.mockReset();
    loadClientStablecoinDetailMock.mockImplementation(async (id: string) =>
      id === "benji-franklin-templeton"
        ? {
            id,
            listingStatusReview: {
              reason: "Temporarily withheld because permitted runtime sources do not provide a positive circulating supply or market cap.",
            },
          }
        : null,
    );
    setHistoryQuery();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders the ready workbench from the shared model and filters URL sources", () => {
    sourcesParam = " stale-source , alt-source ";
    setRankingsQuery({ data: makeResponse([makeRanking()]) });

    render(
      <YieldAnalysisClient
        id="usdn-smardex"
        staticCoin={staticCoin("usdn-smardex", "SMARDEX USDN", "USDN", true)}
      />,
    );

    expect(screen.getByRole("link", { name: "Back to USDN detail" })).toBeTruthy();
    expect(screen.getByTestId("pys-breakdown").getAttribute("data-scaling-factor")).toBe("8");
    expect(screen.getByTestId("yield-source-risk-card")).toBeTruthy();
    const chart = screen.getByTestId("yield-history-chart");
    expect(chart.getAttribute("data-available-sources")).toBe("primary-source,alt-source");
    expect(chart.getAttribute("data-external-source-keys")).toBe("alt-source");
    expect(chart.getAttribute("data-benchmark-rate")).toBe("0.031");
    expect(chart.getAttribute("data-median-apy")).toBe("0.04");
    expect(screen.getByRole("button", { name: "Reset to all sources" })).toBeTruthy();
  });

  it("retains the workbench without reader notices for refresh errors and quality advisories (ADR-42)", () => {
    setRankingsQuery({
      data: makeResponse([makeRanking()]),
      error: new Error("refresh failed"),
      meta: { warning: "Required input quality degraded" },
      refetch: vi.fn(),
    });
    render(<YieldAnalysisClient id="usdn-smardex" staticCoin={staticCoin("usdn-smardex", "SMARDEX USDN", "USDN", true)} />);
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByText("Required input quality degraded")).toBeNull();
    expect(screen.getByTestId("yield-history-chart")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it.each([
    {
      id: "usdn-smardex",
      coin: staticCoin("usdn-smardex", "SMARDEX USDN", "USDN", true),
      expected: "Yield tracking is expected for this stablecoin, but the latest ranking snapshot is not available yet.",
    },
    {
      id: "bd-basedollar",
      coin: staticCoin("bd-basedollar", "Base Dollar", "BD", false),
      expected:
        "This stablecoin doesn't currently have yield data tracked. The protocol may not expose a yield-bearing pool, or the source is not on the curated allowlist.",
    },
    {
      id: "u-united-stables",
      coin: staticCoin("u-united-stables", "United Stables", "U", false),
      expected: "Yield tracking is expected for this stablecoin, but the latest ranking snapshot is not available yet.",
    },
    {
      id: "buck-buck-assets",
      coin: staticCoin("buck-buck-assets", "Buck", "BUCK", true),
      expected: "This stablecoin is frozen — historical yield data is no longer being refreshed.",
    },
    {
      id: "brd-volpon",
      coin: staticCoin("brd-volpon", "BRD Stablecoin", "BRD", true),
      expected: "BRD Stablecoin is in pre-launch tracking. Yield history will appear here once the stablecoin is live and the cron has observed source data.",
    },
    {
      id: "benji-franklin-templeton",
      coin: staticCoin("benji-franklin-templeton", "Franklin OnChain U.S. Government Money Fund", "BENJI", true),
      expected:
        "Temporarily withheld because permitted runtime sources do not provide a positive circulating supply or market cap.",
    },
  ])("renders the $id lifecycle body inside the shared frame", async ({ id, coin, expected }) => {
    setRankingsQuery();

    render(<YieldAnalysisClient id={id} staticCoin={coin} />);

    expect(screen.getByRole("link", { name: `Back to ${coin.symbol} detail` })).toBeTruthy();
    await waitFor(() => expect(screen.getByText(expected)).toBeTruthy());
  });

  it("labels NAV tokens with their reference asset but keeps the peer cohort on its own peg", () => {
    setRankingsQuery({
      data: makeResponse([
        makeRanking({ id: "xgld-unitas", symbol: "xGLD", name: "xGLD" }),
        makeRanking({ id: "fpi-frax", symbol: "FPI", name: "Frax Price Index" }),
      ]),
    });
    render(
      <YieldAnalysisClient
        id="xgld-unitas"
        staticCoin={{
          id: "xgld-unitas",
          name: "xGLD",
          symbol: "xGLD",
          pegReferenceSymbol: "XAUT",
          flags: {
            backing: "crypto-backed",
            pegCurrency: "VAR",
            governance: "centralized",
            yieldBearing: true,
            rwa: true,
            navToken: true,
          },
        }}
      />,
    );

    const header = screen.getByRole("heading", { name: "xGLD" }).closest("section")!;
    expect(header.textContent).toContain("XAUT-denominated NAV");
    expect(header.textContent).not.toContain("CPI");

    const peerRail = screen.getByRole("heading", { name: "Nearby yield context" }).closest("section")!;
    expect(peerRail.textContent).toContain("CPI peg peers by PYS rank");
    expect(peerRail.textContent).not.toContain("XAUT-denominated NAV peg peers");
  });

  it("renders the query error in the shared frame", () => {
    setRankingsQuery({ data: undefined, error: new Error("yield rankings failed") });

    render(
      <YieldAnalysisClient
        id="usdn-smardex"
        staticCoin={staticCoin("usdn-smardex", "SMARDEX USDN", "USDN", true)}
      />,
    );

    expect(screen.getByRole("link", { name: "Back to USDN detail" })).toBeTruthy();
    expect(screen.getByRole("status")).toBeTruthy();
    expect(screen.getByText("yield rankings failed")).toBeTruthy();
  });


  it("withholds the all-clear when the fetched warning evidence is unreadable", () => {
    setRankingsQuery({ data: makeResponse([makeRanking()]) });
    setHistoryQuery([
      makeHistoryPoint({
        date: "2026-08-01T10:00:00Z",
        apy: 0.051,
        warningSignals: [],
        warningSignalsStatus: "unreadable",
      }),
    ]);

    renderWorkbench();

    expect(within(document.getElementById("warning-signals")!).queryByText(/No warning signals recorded/)).toBeNull();
  });

  it("publishes only the switch ledger, not the durable 30-day count over a different population", () => {
    setRankingsQuery({
      data: makeResponse([makeRanking({ sourceRisk: { sourceSwitchCount30d: 0 } as never })]),
    });
    setHistoryQuery([
      makeHistoryPoint({ date: "2026-08-01T10:00:00Z", apy: 0.05, yieldSource: "Primary Source" }),
      makeHistoryPoint({
        date: "2026-08-02T10:00:00Z", apy: 0.06, yieldSource: "Alt Source",
        sourceKey: "alt-source", sourceSwitch: true,
      }),
      makeHistoryPoint({
        date: "2026-08-03T10:00:00Z", apy: 0.05, yieldSource: "Primary Source",
        sourceKey: "primary-source", sourceSwitch: true,
      }),
    ]);

    renderWorkbench();

    const card = document.getElementById("source-switches")!;
    expect(card.querySelectorAll("li")).toHaveLength(2);
    expect(within(card).queryByText(/30 days/)).toBeNull();
    expect(within(card).queryByText(/30-day switch count/)).toBeNull();
  });

  it.each([
    ["loading", { data: undefined, error: null, isLoading: true }],
    ["failed", { data: undefined, error: new Error("history failed"), isLoading: false }],
  ] as const)("does not attribute a move from an unread history (%s)", (_state, overrides) => {
    setRankingsQuery({ data: makeResponse([makeRanking()]) });
    setHistoryQuery([], overrides);

    renderWorkbench();

    expect(screen.queryByTestId("yield-change-attribution")).toBeNull();
  });

  it("groups same signal-source pairs inside the 24h bucket, counts repeats, and orders groups newest first", () => {
    setRankingsQuery({ data: makeResponse([makeRanking()]) });
    setHistoryQuery([
      makeHistoryPoint({ date: "2026-08-01T10:00:00Z", apy: 0.05, yieldSource: "Primary Source", warningSignals: ["yield-spike"] }),
      makeHistoryPoint({ date: "2026-08-02T10:00:00Z", apy: 0.05, yieldSource: "Primary Source", warningSignals: ["yield-spike"] }),
      // The APY change no longer splits the run: within one 24h bucket the
      // signal-source pair merges, and the row shows the newest occurrence's APY.
      makeHistoryPoint({ date: "2026-08-03T10:00:00Z", apy: 0.06, yieldSource: "Primary Source", warningSignals: ["yield-spike"] }),
      makeHistoryPoint({ date: "2026-08-04T10:00:00Z", apy: 0.06, yieldSource: "Alt Source", warningSignals: ["yield-divergence"] }),
    ]);

    render(
      <YieldAnalysisClient
        id="usdn-smardex"
        staticCoin={staticCoin("usdn-smardex", "SMARDEX USDN", "USDN", true)}
      />,
    );

    const rows = Array.from(document.getElementById("warning-signals")!.querySelectorAll("li"));
    expect(rows).toHaveLength(3);
    expect(rows[0]!.textContent).toContain("Yield divergence");
    expect(rows[0]!.textContent).toContain("Alt Source at 0.06%");
    expect(rows[1]!.textContent).toContain("Yield spike");
    expect(rows[1]!.textContent).toContain("×2");
    expect(rows[1]!.textContent).toContain("Primary Source at 0.06%");
    expect(rows[1]!.textContent).toContain("–");
    expect(rows[2]!.textContent).toContain("Primary Source at 0.05%");
    expect(rows[2]!.textContent).not.toContain("×");
  });

  it("bounds every repeated warning group to 24h while retaining all seven interleaved occurrences", () => {
    const start = Date.parse("2026-08-01T00:00:00Z");
    const hourMs = 60 * 60 * 1000;
    setRankingsQuery({ data: makeResponse([makeRanking()]) });
    setHistoryQuery([
      ...[0, 12, 24, 36, 48].map((hour) => makeHistoryPoint({
        date: new Date(start + hour * hourMs).toISOString(),
        apy: 0.05, yieldSource: "Primary Source", warningSignals: ["yield-spike"],
      })),
      makeHistoryPoint({ date: new Date(start + 12 * hourMs).toISOString(), apy: 0.05, yieldSource: "Primary Source", warningSignals: ["yield-divergence"] }),
      makeHistoryPoint({ date: new Date(start + 36 * hourMs).toISOString(), apy: 0.05, yieldSource: "Alt Source", warningSignals: ["yield-spike"] }),
    ]);
    render(<YieldAnalysisClient id="usdn-smardex" staticCoin={staticCoin("usdn-smardex", "SMARDEX USDN", "USDN", true)} />);

    const rows = Array.from(document.getElementById("warning-signals")!.querySelectorAll("li"));
    const expectedGroups = [
      { first: 24, last: 48, count: 3, signal: "Yield spike", source: "Primary Source" },
      { first: 36, last: 36, count: 1, signal: "Yield spike", source: "Alt Source" },
      { first: 0, last: 12, count: 2, signal: "Yield spike", source: "Primary Source" },
      { first: 12, last: 12, count: 1, signal: "Yield divergence", source: "Primary Source" },
    ];
    expect(rows).toHaveLength(expectedGroups.length);
    let totalCount = 0;
    rows.forEach((row, index) => {
      const expected = expectedGroups[index]!;
      const count = Number(row.textContent?.match(/×(\d+)/)?.[1] ?? 1);
      totalCount += count;
      expect(count).toBe(expected.count);
      expect(expected.last - expected.first).toBeLessThanOrEqual(24);
      expect(row.textContent).toContain(formatChartDate(start + expected.first * hourMs, "with-time"));
      expect(row.textContent).toContain(formatChartDate(start + expected.last * hourMs, "with-time"));
      expect(row.textContent).toContain(expected.signal);
      expect(row.textContent).toContain(`${expected.source} at`);
    });
    expect(totalCount).toBe(7);
  });

  it("renders the source transition once and omits a switch stamped with an invalid date", () => {
    setRankingsQuery({ data: makeResponse([makeRanking()]) });
    setHistoryQuery([
      makeHistoryPoint({ date: "2026-08-01T10:00:00Z", apy: 0.05, yieldSource: "Primary Source" }),
      makeHistoryPoint({
        date: "2026-08-02T10:00:00Z",
        apy: 0.06,
        yieldSource: "Alt Source",
        sourceKey: "alt-source",
        sourceSwitch: true,
      }),
      makeHistoryPoint({
        date: "not-a-date",
        apy: 0.07,
        yieldSource: "Alt Source",
        sourceKey: "alt-source",
        sourceSwitch: true,
      }),
    ]);

    render(
      <YieldAnalysisClient
        id="usdn-smardex"
        staticCoin={staticCoin("usdn-smardex", "SMARDEX USDN", "USDN", true)}
      />,
    );

    const rows = Array.from(document.getElementById("source-switches")!.querySelectorAll("li"));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.textContent).toContain("Primary Source → Alt Source");
    expect(rows[0]!.textContent).toContain("APY at switch: 0.06%");
  });

  it("renders the history error notice with retry in both timeline cards instead of a false all-clear", () => {
    const refetch = vi.fn();
    setRankingsQuery({ data: makeResponse([makeRanking()]) });
    setHistoryQuery([], {
      data: undefined,
      meta: null,
      error: new Error("yield history failed"),
      refetch,
    });

    render(
      <YieldAnalysisClient
        id="usdn-smardex"
        staticCoin={staticCoin("usdn-smardex", "SMARDEX USDN", "USDN", true)}
      />,
    );

    expect(document.getElementById("warning-signals")!.querySelectorAll('[role="status"]')).toHaveLength(1);
    expect(document.getElementById("source-switches")!.querySelectorAll('[role="status"]')).toHaveLength(1);
    for (const card of timelineCards()) expect(within(card).getByText("yield history failed")).toBeTruthy();
    expect(screen.queryByText(/No warning signals recorded/)).toBeNull();
    expect(screen.queryByText(/No source switches recorded/)).toBeNull();
    for (const card of timelineCards()) fireEvent.click(within(card).getByRole("button", { name: /Retry/ }));
    expect(refetch).toHaveBeenCalledTimes(2);
  });

  it("retains both timelines when a background refresh fails over saved history", () => {
    setRankingsQuery({ data: makeResponse([makeRanking()]) });
    const history = [
      makeHistoryPoint({ date: "2026-08-01T10:00:00Z", apy: 0.05, yieldSource: "Primary Source" }),
      makeHistoryPoint({ date: "2026-08-02T10:00:00Z", apy: 0, yieldSource: "Alt Source", sourceKey: "alt-source", sourceSwitch: true, warningSignals: ["yield-spike"] }),
    ];
    setHistoryQuery(history);
    const { rerender } = renderWorkbench();
    setHistoryQuery(history, { error: new Error("history refresh failed") });
    rerender(<YieldAnalysisClient id="usdn-smardex" staticCoin={staticCoin("usdn-smardex", "SMARDEX USDN", "USDN", true)} />);

    const [warnings, switches] = timelineCards();
    expect(warnings.querySelector("li")!.textContent).toContain("Alt Source at 0.00%");
    expect(switches.querySelector("li")!.textContent).toContain("Primary Source → Alt Source");
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByText("history refresh failed")).toBeNull();
  });

  it("keeps the bounded empty-history copy when a refresh fails over a saved empty history", () => {
    setRankingsQuery({ data: makeResponse([makeRanking()]) });
    setHistoryQuery([], { error: new Error("history refresh failed") });
    renderWorkbench();

    expect(screen.getByText(/No warning signals recorded/)).toBeTruthy();
    expect(screen.getByText(/No source switches recorded/)).toBeTruthy();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("shows skeletons only while the initial history read has no data", () => {
    setRankingsQuery({ data: makeResponse([makeRanking()]) });
    setHistoryQuery([], { data: undefined, isLoading: true });
    renderWorkbench();
    for (const card of timelineCards()) expect(card.querySelector("li, [role='status']")).toBeNull();
    expect(screen.queryByText(/No warning signals recorded/)).toBeNull();
    expect(screen.queryByText(/No source switches recorded/)).toBeNull();
  });

  it.each([
    ["body", { data: { current: null, history: [], warning: "Source history incomplete" } }],
    ["header", { meta: { status: "degraded", warning: '110 - "Yield history freshness lookup failed; falling back to cache metadata."' } }],
    ["degraded clock", { meta: { updatedAt: Date.now() / 1000, status: "degraded", reason: "yield-publication-age" } }],
  ] as const)("keeps %s history advisories operator-only with the success empty copy (ADR-42)", (_case, overrides) => {
    setRankingsQuery({ data: makeResponse([makeRanking()]) });
    setHistoryQuery([], overrides);
    renderWorkbench();

    expect(screen.queryByText(/Source history incomplete|freshness lookup failed/)).toBeNull();
    expect(screen.getByText(/No warning signals recorded/)).toBeTruthy();
    expect(screen.getByText(/No source switches recorded/)).toBeTruthy();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it.each([
    ["explicit stale", { updatedAt: Date.now() / 1000 - 100_000, status: "stale", reason: "yield-publication-age" }],
    ["cutoff unavailable", { updatedAt: null, status: "stale", reason: "publication-cutoff-unavailable" }],
  ] as const)("shows the shared notice with retry in both timeline cards for %s history", (_case, meta) => {
    const refetch = vi.fn();
    setRankingsQuery({ data: makeResponse([makeRanking()]) });
    setHistoryQuery([
      makeHistoryPoint({ date: "2026-08-01T10:00:00Z", apy: 0, yieldSource: "Primary Source", warningSignals: ["yield-spike"] }),
    ], { meta, refetch });
    renderWorkbench();

    for (const card of timelineCards()) {
      expect(within(card).getByRole("status").getAttribute("data-health-state")).toBe("stale");
      fireEvent.click(within(card).getByRole("button", { name: "Retry" }));
    }
    expect(refetch).toHaveBeenCalledTimes(2);
    // Retained observations stay visible beside the notice, including observed-zero APY.
    expect(document.getElementById("warning-signals")!.querySelector("li")!.textContent).toContain("Primary Source at 0.00%");
  });

  it("shows the notice at the first millisecond beyond the producer's degraded budget without a refetch", async () => {
    const updatedAtSec = Date.parse("2026-08-01T00:00:00Z") / 1000;
    const degradedBudgetSec = 7_200;
    vi.useFakeTimers({ now: updatedAtSec * 1000 + degradedBudgetSec * 1000 - 1_000 });
    setRankingsQuery({ data: makeResponse([makeRanking()]) });
    setHistoryQuery([], {
      dataUpdatedAt: updatedAtSec * 1000,
      meta: { updatedAt: updatedAtSec, status: "degraded", freshBudgetSec: 1_800, degradedBudgetSec },
    });
    renderWorkbench();
    // Through hydration and up to the inclusive budget the clock is only degraded.
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(screen.queryByRole("status")).toBeNull();

    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(screen.getAllByRole("status")).toHaveLength(2);
    expect(useYieldHistoryMock.mock.results.every((result) => result.value.refetch.mock.calls.length === 0)).toBe(true);
  });

  it("keeps the ready workbench mounted when a refetch errors over cached rankings", () => {
    setRankingsQuery({ data: makeResponse([makeRanking()]), error: new Error("refetch failed") });

    render(
      <YieldAnalysisClient
        id="usdn-smardex"
        staticCoin={staticCoin("usdn-smardex", "SMARDEX USDN", "USDN", true)}
      />,
    );

    expect(screen.getByTestId("pys-breakdown")).toBeTruthy();
    expect(screen.getByTestId("yield-history-chart")).toBeTruthy();
    expect(screen.queryByRole("status")).toBeNull();
  });
});
