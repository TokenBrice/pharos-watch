// @vitest-environment jsdom

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AltPegsClient } from "@/app/alt-pegs/client";
import { makeAltPegCoin, makeStablecoin } from "@shared/test-utils/stablecoin";
import { API_FRESHNESS_MAX_AGE_SEC } from "@shared/lib/api-freshness";
import { CORE_NON_USD_IDS, coreNonUsdRows } from "@shared/test-utils/alt-peg-fixtures";

const completeNonUsd = (caps: Record<string, number | null | "omit">) =>
  coreNonUsdRows((id, cap) => (cap === null ? { ...makeAltPegCoin(id, 0), circulating: {} } : makeAltPegCoin(id, cap)), caps);

const refetchMock = vi.fn();

const {
  useStablecoinsMock,
  useNonUsdShareMock,
  usePegSummaryMock,
  useDexLiquidityTableMock,
  useReportCardsV9Mock,
  useStablecoinChartsMock,
} = vi.hoisted(() => ({
  useStablecoinsMock: vi.fn(),
  useNonUsdShareMock: vi.fn(),
  usePegSummaryMock: vi.fn(),
  useDexLiquidityTableMock: vi.fn(),
  useReportCardsV9Mock: vi.fn(),
  useStablecoinChartsMock: vi.fn(),
}));

vi.mock("@/hooks/use-stablecoins", () => ({
  useStablecoins: useStablecoinsMock,
}));

vi.mock("@/hooks/api-hooks", () => ({
  useNonUsdShare: useNonUsdShareMock,
  usePegSummary: usePegSummaryMock,
  useDexLiquidityTable: useDexLiquidityTableMock,
  useReportCardsV9Table: useReportCardsV9Mock,
  useStablecoinCharts: useStablecoinChartsMock,
}));

vi.mock("@/app/alt-pegs/alt-peg-stablecoin-table", () => ({
  AltPegStablecoinTable: ({ dexLiquidity, selectedPeg, sourceGenerations }: {
    dexLiquidity?: Record<string, { liquidityScore: number | null }>;
    selectedPeg: string | null;
    sourceGenerations?: Record<string, number | undefined>;
  }) => (
    <div
      data-testid="alt-peg-stablecoin-table"
      data-selected-peg={selectedPeg ?? ""}
      data-source-generations={JSON.stringify(sourceGenerations ?? null)}
    >
      <span data-testid="alt-peg-liquidity-score">{dexLiquidity?.["eurc-circle"]?.liquidityScore ?? "unavailable"}</span>
    </div>
  ),
}));

function ChartStub({
  kind, initialRange, isFocused, onOpenFocus, onCloseFocus, onRangeChange,
}: {
  kind: "share" | "cohorts";
  initialRange?: string;
  isFocused?: boolean;
  onOpenFocus?: (value: string) => void;
  onCloseFocus?: () => void;
  onRangeChange?: (value: string) => void;
}) {
  const share = kind === "share";
  return (
    <div data-testid={share ? "non-usd-share-chart" : "alt-peg-cohort-chart"}>
      {share ? "share" : "cohort"}-chart {isFocused ? "focused" : "default"} {initialRange}
      <button type="button" onClick={() => onOpenFocus?.("90d")}>open-{kind}</button>
      {share && <button type="button" onClick={() => onOpenFocus?.("all")}>open-share-all</button>}
      <button type="button" onClick={() => onCloseFocus?.()}>close-{kind}</button>
      <button type="button" onClick={() => onRangeChange?.(share ? "30d" : "all")}>range-{kind}</button>
    </div>
  );
}

vi.mock("@/components/non-usd-share-chart", () => ({
  NonUsdShareChart: (props: Omit<Parameters<typeof ChartStub>[0], "kind">) => <ChartStub {...props} kind="share" />,
}));

vi.mock("@/app/alt-pegs/alt-peg-cohort-history-chart", () => ({
  AltPegCohortHistoryChart: (props: Omit<Parameters<typeof ChartStub>[0], "kind">) => <ChartStub {...props} kind="cohorts" />,
}));


function expectFocusSearch(expected: { view?: string | null; chart?: string | null; range?: string | null }) {
  const params = new URLSearchParams(window.location.search);
  expect(params.get("view")).toBe(expected.view ?? null);
  expect(params.get("chart")).toBe(expected.chart ?? null);
  expect(params.get("range")).toBe(expected.range ?? null);
}

describe("AltPegsClient", () => {
  it("starts cohort history even while the independent current-market request is loading", () => {
    useStablecoinsMock.mockReturnValue({ data: undefined, isLoading: true });
    useStablecoinChartsMock.mockClear();
    render(<AltPegsClient />);
    expect(useStablecoinChartsMock).toHaveBeenCalled();
    expect(screen.queryByTestId("alt-peg-cohort-chart")).toBeNull();
  });


  beforeEach(() => {
    window.history.replaceState(null, "", "/alt-pegs/");
    refetchMock.mockReset();
    useStablecoinsMock.mockReturnValue({
      data: {
        peggedAssets: [
          makeAltPegCoin("usdc-circle", 100_000_000),
          ...completeNonUsd({ "eurc-circle": 60_000_000, "paxg-paxos": 20_000_000 }),
        ],
      },
      isLoading: false,
      isError: false,
      error: null,
      dataUpdatedAt: 1,
      refetch: refetchMock,
      meta: null,
    });
    usePegSummaryMock.mockReturnValue({
      data: { coins: [] },
      isLoading: false,
      isError: false,
      error: null,
      dataUpdatedAt: 0,
    });
    useDexLiquidityTableMock.mockReturnValue({
      data: null,
      isLoading: false,
      isError: false,
      error: null,
      dataUpdatedAt: 0,
    });
    useReportCardsV9Mock.mockReturnValue({
      data: { cards: [] },
      isLoading: false,
      isError: false,
      error: null,
      dataUpdatedAt: 0,
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

  it("preserves compact table liquidity scores, including observed zero and unavailable", () => {
    useDexLiquidityTableMock.mockReturnValue({ data: { "eurc-circle": { liquidityScore: 0 } } });
    const view = render(<AltPegsClient />);
    expect(screen.getByTestId("alt-peg-liquidity-score").textContent).toBe("0");
    useDexLiquidityTableMock.mockReturnValue({ data: { "eurc-circle": { liquidityScore: null } } });
    view.rerender(<AltPegsClient />);
    expect(screen.getByTestId("alt-peg-liquidity-score").textContent).toBe("unavailable");
  });
  it.each([
    { ageBudgets: 0, error: null, hasData: true, notice: null },
    { ageBudgets: 20, error: null, hasData: true, notice: "Showing an older snapshot" },
    // A failed refresh over retained data is operator signal (ADR-42).
    { ageBudgets: 0, error: new Error("Offline"), hasData: true, notice: null },
    { ageBudgets: 0, error: new Error("Offline"), hasData: false, notice: "Refresh failed" },
  ])("surfaces share health for $ageBudgets snapshot budgets and hasData=$hasData", ({ ageBudgets, error, hasData, notice }) => {
    const now = Date.now();
    useStablecoinsMock.mockReturnValue({ ...useStablecoinsMock(), dataUpdatedAt: now });
    const saved = useNonUsdShareMock();
    useNonUsdShareMock.mockReturnValue({
      ...saved,
      data: hasData ? saved.data : undefined,
      dataUpdatedAt: now,
      error,
      meta: {
        updatedAt: Math.floor(now / 1000) - ageBudgets * API_FRESHNESS_MAX_AGE_SEC.nonUsdShare,
        ageSeconds: ageBudgets * API_FRESHNESS_MAX_AGE_SEC.nonUsdShare,
        status: "fresh",
      },
    });
    render(<AltPegsClient />);
    if (notice) {
      expect(screen.getByText(notice)).toBeTruthy();
      expect(screen.getByText(/Non-USD Share/)).toBeTruthy();
    } else {
      expect(screen.queryByText("Showing an older snapshot")).toBeNull();
      expect(screen.queryByText(/Refresh failed/)).toBeNull();
    }
    expect(screen.getByTestId("non-usd-share-chart")).toBeTruthy();
  });

  it("passes the four producer generations to the table export", () => {
    useStablecoinsMock.mockReturnValue({ ...useStablecoinsMock(), meta: { updatedAt: 11_111, ageSeconds: 0, status: "fresh" } });
    usePegSummaryMock.mockReturnValue({ ...usePegSummaryMock(), meta: { updatedAt: 22_222, ageSeconds: 0, status: "fresh" } });
    useDexLiquidityTableMock.mockReturnValue({ ...useDexLiquidityTableMock(), meta: { updatedAt: 33_333, ageSeconds: 0, status: "fresh" } });
    useReportCardsV9Mock.mockReturnValue({ ...useReportCardsV9Mock(), meta: { updatedAt: 44_444, ageSeconds: 0, status: "fresh" } });
    render(<AltPegsClient />);
    expect(JSON.parse(screen.getByTestId("alt-peg-stablecoin-table").getAttribute("data-source-generations")!)).toEqual({
      stablecoins: 11_111,
      pegSummary: 22_222,
      dexLiquidity: 33_333,
      reportCards: 44_444,
    });
  });

  function freshMeta(updatedAt: number) {
    return { updatedAt, ageSeconds: 0, status: "fresh" };
  }

  // Aliases keep the mock identifiers out of hook-shaped helper names.
  const queryMocks = {
    stablecoins: useStablecoinsMock,
    share: useNonUsdShareMock,
    pegSummary: usePegSummaryMock,
    dexLiquidity: useDexLiquidityTableMock,
    reportCards: useReportCardsV9Mock,
  };

  /** Every source healthy and populated; one overlay is then aged by the caller. */
  function primeOverlayHealth(now: number) {
    const nowSec = Math.floor(now / 1000);
    queryMocks.stablecoins.mockReturnValue({ ...queryMocks.stablecoins(), dataUpdatedAt: now, meta: freshMeta(nowSec) });
    queryMocks.share.mockReturnValue({ ...queryMocks.share(), dataUpdatedAt: now, meta: freshMeta(nowSec) });
    queryMocks.pegSummary.mockReturnValue({
      ...queryMocks.pegSummary(), data: { coins: [{ id: "usdc-circle" }] }, dataUpdatedAt: now, meta: freshMeta(nowSec),
    });
    queryMocks.dexLiquidity.mockReturnValue({
      ...queryMocks.dexLiquidity(), data: { "eurc-circle": { liquidityScore: 0 } }, dataUpdatedAt: now, meta: freshMeta(nowSec),
    });
    queryMocks.reportCards.mockReturnValue({
      ...queryMocks.reportCards(), data: { cards: [{ id: "usdc-circle" }] }, dataUpdatedAt: now, meta: freshMeta(nowSec),
    });
  }

  it.each([
    {
      label: "Peg Data",
      maxAgeSec: API_FRESHNESS_MAX_AGE_SEC.pegSummary,
      apply: (meta: object) => queryMocks.pegSummary.mockReturnValue({ ...queryMocks.pegSummary(), meta }),
    },
    {
      label: "Liquidity",
      maxAgeSec: API_FRESHNESS_MAX_AGE_SEC.dexLiquidity,
      apply: (meta: object) => queryMocks.dexLiquidity.mockReturnValue({ ...queryMocks.dexLiquidity(), meta }),
    },
    {
      label: "Report Cards",
      maxAgeSec: API_FRESHNESS_MAX_AGE_SEC.reportCards,
      apply: (meta: object) => queryMocks.reportCards.mockReturnValue({ ...queryMocks.reportCards(), meta }),
    },
  ])("ages $label in the page banner once it passes its public stale band", ({ label, maxAgeSec, apply }) => {
    const now = Date.now();
    primeOverlayHealth(now);
    const ageSeconds = maxAgeSec * 12 + 1;
    apply({ updatedAt: Math.floor(now / 1000) - ageSeconds, ageSeconds, status: "fresh" });
    render(<AltPegsClient />);
    expect(screen.getByText("Showing an older snapshot")).toBeTruthy();
    expect(screen.getAllByText(label, { exact: false }).length).toBeGreaterThan(0);
  });

  it("keeps the page banner quiet while an overlay is inside its stale band", () => {
    const now = Date.now();
    primeOverlayHealth(now);
    const ageSeconds = API_FRESHNESS_MAX_AGE_SEC.pegSummary * 12 - 1;
    usePegSummaryMock.mockReturnValue({
      ...usePegSummaryMock(),
      meta: { updatedAt: Math.floor(now / 1000) - ageSeconds, ageSeconds, status: "fresh" },
    });
    render(<AltPegsClient />);
    expect(screen.queryByText("Showing an older snapshot")).toBeNull();
  });

  it.each([false, true])("separates initial failure from retained failed refresh (hasData=%s)", (hasData) => {
    const now = Date.now();
    const saved = useStablecoinsMock();
    useStablecoinsMock.mockReturnValue({
      ...saved,
      data: hasData ? saved.data : undefined,
      isError: true,
      error: new Error("Offline"),
      dataUpdatedAt: hasData ? now : 0,
    });
    useNonUsdShareMock.mockReturnValue({ ...useNonUsdShareMock(), dataUpdatedAt: now });
    render(<AltPegsClient />);
    expect(screen.queryByTestId("alt-peg-stablecoin-table") !== null).toBe(hasData);
    expect(screen.queryByTestId("alt-peg-cohort-chart") !== null).toBe(hasData);
    expect(screen.queryByText("Peg diversity atlas") !== null).toBe(hasData);
    if (hasData) {
      // Retained data stays usable without a reader notice (ADR-42).
      expect(screen.queryByText(/Refresh failed/)).toBeNull();
      expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
      return;
    }
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(refetchMock).toHaveBeenCalledOnce();
  });

  it("qualifies annual historical comparisons when the reference cohort was partial", () => {
    const saved = useNonUsdShareMock();
    useNonUsdShareMock.mockReturnValue({
      ...saved,
      data: saved.data.map((point: object, index: number) => ({ ...point,
        coverage: { basis: "interior-gap-prior-value", total: index === 0 ? 0.99 : 1, commodity: 1, fiatNonUsd: 1 },
      })),
    });
    render(<AltPegsClient />);
    const row = screen.getByText("1-year change").parentElement!;
    expect(row.textContent).toContain("+65.0%");
    expect(row.textContent).toContain("partial coverage");
  });

  it("leads with the core non-USD cap, a computed universe chip and a dated share", () => {
    render(<AltPegsClient />);
    const hero = screen.getByRole("group", { name: "Non-USD stablecoin market" });
    expect(hero.textContent).toContain("Non-USD stablecoin market cap");
    expect(hero.textContent).toContain("$80.0M");
    expect(hero.textContent).toContain(`${CORE_NON_USD_IDS.length} non-USD of`);
    expect(screen.getByText("Share of all stablecoins").parentElement!.textContent).toMatch(/2\.60%.*as of/);
    expect(screen.queryByText("Partial supply")).toBeNull();
    expect(screen.getByTestId("cohort-mix").textContent).toContain("Commodities");
  });

  it("retains an unknown-supply cohort without formatting its segment as $0", () => {
    useStablecoinsMock.mockReturnValue({
      ...useStablecoinsMock(),
      data: { peggedAssets: [makeAltPegCoin("usdc-circle", 100), ...completeNonUsd(Object.fromEntries(CORE_NON_USD_IDS.map((id) => [id, null])))] },
    });
    render(<AltPegsClient />);
    const mix = screen.getByTestId("cohort-mix");
    expect(mix.textContent).toContain("Mix withheld");
    expect(mix.textContent).not.toContain("$0");
    expect(screen.getByRole("group", { name: "Non-USD stablecoin market" }).textContent).toContain("—");
    expect(screen.getByTestId("alt-peg-stablecoin-table")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Pegs by market cap" })).toBeTruthy();
    expect(screen.getAllByText("supply unavailable").length).toBeGreaterThan(0);
  });

  it("labels retained partial supply totals on the beam and chip and withholds shares and ranks", () => {
    useStablecoinsMock.mockReturnValue({
      ...useStablecoinsMock(),
      data: { peggedAssets: completeNonUsd({ "eurc-circle": 100, "eurs-stasis": null }) },
    });
    render(<AltPegsClient />);
    expect(screen.getByText(/known subtotal, partial/)).toBeTruthy();
    const chip = screen.getByRole("button", { name: /Partial supply/ });
    expect(chip.getAttribute("data-reason-codes")).toBe("supply-unavailable");
    expect(screen.getByText(/known · \d+\/\d+ observed/)).toBeTruthy();
    expect(screen.getByTestId("cohort-mix").textContent).toContain("Mix withheld");
  });

  it("keeps a partial-chain remainder in the observed row count", () => {
    const assets = completeNonUsd({});
    const index = assets.findIndex((asset) => asset.id === "xsgd-straitsx");
    assets[index] = makeStablecoin({
      ...assets[index],
      circulating: { peggedSGD: 100_000_000 },
      supplyChainGuard: {
        reason: "supply-chain-dropout",
        status: "chains-unavailable",
        partialCoverage: true,
        chains: [{
          chainLabel: "Polygon",
          listCurrentUsd: 0,
          baselineUsd: 2_000_000,
          baselineObservedAt: 1_792_700_000,
          baselineSource: "state",
          resolution: "unavailable",
        }],
      },
    });
    useStablecoinsMock.mockReturnValue({
      ...useStablecoinsMock(),
      data: { peggedAssets: [makeAltPegCoin("usdc-circle", 100_000_000), ...assets] },
    });
    render(<AltPegsClient />);
    expect(screen.getByText("known · 1/1 observed")).toBeTruthy();
    expect(screen.queryByText("known · 0/1 observed")).toBeNull();
  });

  it("orders hero, atlas, ranking, then the coin table", () => {
    render(<AltPegsClient />);
    const order = [
      screen.getByRole("group", { name: "Non-USD stablecoin market" }),
      screen.getByRole("heading", { name: "Peg diversity atlas" }),
      screen.getByRole("heading", { name: "Pegs by market cap" }),
      screen.getByTestId("alt-peg-stablecoin-table"),
    ];
    for (let i = 1; i < order.length; i++) {
      expect(order[i - 1]!.compareDocumentPosition(order[i]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
  });

  it("labels the beam partial when a core non-USD coin is missing from the list", () => {
    useStablecoinsMock.mockReturnValue({
      ...useStablecoinsMock(),
      data: { peggedAssets: completeNonUsd({ "eurc-circle": 100, "eurs-stasis": "omit" }) },
    });
    render(<AltPegsClient />);
    expect(screen.getByText(/known subtotal, partial/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /Partial supply/ })).toBeTruthy();
    expect(screen.getByTestId("cohort-mix").textContent).toContain("Mix withheld");
  });

  it("ignores a ?peg= value with no core coins instead of showing an empty table", () => {
    window.history.replaceState(null, "", "/alt-pegs/?peg=inr");
    render(<AltPegsClient />);
    expect(screen.getByTestId("alt-peg-stablecoin-table").getAttribute("data-selected-peg")).toBe("");
  });

  it("drives the table's peg filter from a ranking row through ?peg=", async () => {
    render(<AltPegsClient />);
    fireEvent.click(screen.getByRole("button", { name: /^Euro/ }));
    await waitFor(() => expect(new URLSearchParams(window.location.search).get("peg")).toBe("eur"));
    expect(screen.getByTestId("alt-peg-stablecoin-table").getAttribute("data-selected-peg")).toBe("EUR");
    const euro = screen.getByRole("button", { name: /^Euro/ });
    expect(euro.getAttribute("aria-pressed")).toBe("true");
    expect(euro.closest("li")!.getAttribute("style")).toContain("inset 3px 0 0");
    fireEvent.click(screen.getByRole("button", { name: "Show all pegs" }));
    await waitFor(() => expect(new URLSearchParams(window.location.search).get("peg")).toBeNull());
  });

  it("restores a focused share chart from the URL", () => {
    window.history.replaceState(null, "", "/alt-pegs/?view=focused&chart=share&range=90d");

    render(<AltPegsClient />);

    expect(screen.getByText(/share-chart focused 90d/i)).toBeTruthy();
    expect(screen.getByText(/cohort-chart default 1y/i)).toBeTruthy();
  });

  it("preserves a hydrated focused range when returning to the overview", async () => {
    window.history.replaceState(null, "", "/alt-pegs/?view=focused&chart=share&range=90d#charts");
    const container = document.createElement("div");
    container.innerHTML = renderToString(<AltPegsClient />);
    document.body.append(container);
    const errors: unknown[] = [];
    let root: ReturnType<typeof hydrateRoot>;
    await act(async () => {
      root = hydrateRoot(container, <AltPegsClient />, { onRecoverableError: (error) => errors.push(error) });
    });
    try {
      expect(screen.getByText(/share-chart focused 90d/i)).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "close-share" }));
      await waitFor(() => expect(screen.getByText(/share-chart default 90d/i)).toBeTruthy());
      expectFocusSearch({});
      expect(window.location.hash).toBe("#charts");
      expect(errors).toEqual([]);
    } finally {
      act(() => root!.unmount());
      container.remove();
    }
  });

  it("opens and updates a focused share chart through URL state", async () => {
    render(<AltPegsClient />);

    fireEvent.click(screen.getByRole("button", { name: "open-share" }));

    await waitFor(() => {
      expectFocusSearch({ view: "focused", chart: "share", range: "90d" });
    });

    fireEvent.click(screen.getByRole("button", { name: "range-share" }));

    await waitFor(() => {
      expectFocusSearch({ view: "focused", chart: "share", range: "30d" });
    });
  });

  it("keeps an explicit all-range focused share URL", async () => {
    render(<AltPegsClient />);

    fireEvent.click(screen.getByRole("button", { name: "open-share-all" }));

    await waitFor(() => {
      expectFocusSearch({ view: "focused", chart: "share", range: "all" });
    });
  });

  it("closes the focused share chart and clears focus params", async () => {
    window.history.replaceState(null, "", "/alt-pegs/?view=focused&chart=share&range=90d");

    render(<AltPegsClient />);
    fireEvent.click(screen.getByRole("button", { name: "close-share" }));

    await waitFor(() => {
      expectFocusSearch({});
    });
  });

  it("opens, updates, and closes a focused cohort chart through URL state", async () => {
    render(<AltPegsClient />);

    fireEvent.click(screen.getByRole("button", { name: "open-cohorts" }));

    await waitFor(() => {
      expectFocusSearch({ view: "focused", chart: "cohorts", range: "90d" });
    });

    fireEvent.click(screen.getByRole("button", { name: "range-cohorts" }));

    await waitFor(() => {
      expectFocusSearch({ view: "focused", chart: "cohorts", range: "all" });
    });

    fireEvent.click(screen.getByRole("button", { name: "close-cohorts" }));

    await waitFor(() => {
      expectFocusSearch({});
    });
  });

  it("responds to popstate changes for focused chart URLs", async () => {
    render(<AltPegsClient />);

    await waitFor(() => {
      expect(screen.getByText(/share-chart default 1y/i)).toBeTruthy();
    });

    act(() => {
      window.history.replaceState(null, "", "/alt-pegs/?view=focused&chart=share&range=90d");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });

    await waitFor(() => {
      expect(screen.getByText(/share-chart focused 90d/i)).toBeTruthy();
    });

    act(() => {
      window.history.replaceState(null, "", "/alt-pegs/");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });

    await waitFor(() => {
      expect(screen.getByText(/share-chart default 1y/i)).toBeTruthy();
    });
  });
});
