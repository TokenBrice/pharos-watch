// @vitest-environment jsdom

import { render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeStablecoin } from "@shared/test-utils/stablecoin";
import { makeReportCardsV9Response, makeV9Card, makeV9Pillars } from "@/test/fixtures/safety-score-v9";
import { makeReportCardsV9PartialCard, makeReportCardsV9PipelineGapCard } from "@shared/test-utils/report-cards-v9";
import type { ScreenerRow } from "@/lib/screener-filters";
import type { CsvColumn } from "@/lib/exports/csv";
import { escapeCsvField } from "@shared/lib/csv";

import { ScreenerClient } from "./client";

const mocks = vi.hoisted(() => ({
  QueryFreshnessNotices: vi.fn(),
  ScreenerTable: vi.fn(),
  useDexLiquidityTable: vi.fn(),
  useHydrated: vi.fn(),
  usePegSummary: vi.fn(),
  useReportCardsV9: vi.fn(),
  useSort: vi.fn(),
  useStablecoins: vi.fn(),
  useStressSignals: vi.fn(),
  TableExportMenu: vi.fn(),
  useUrlFilters: vi.fn(),
}));

vi.mock("@/components/query-freshness-notices", () => ({
  QueryFreshnessNotices: (props: { hasData: boolean; queries: Array<{ preset?: string }>; error?: unknown }) => {
    mocks.QueryFreshnessNotices(props);
    return <div data-testid="freshness-notices" />;
  },
}));

vi.mock("@/components/selector/selector-callout", () => ({
  SelectorCallout: () => <div data-testid="selector-callout" />,
}));

vi.mock("@/components/screener/screener-table", () => ({
  ScreenerTable: (props: { rows: ScreenerRow[] }) => {
    mocks.ScreenerTable(props);
    return <div data-testid="screener-table" />;
  },
}));

vi.mock("@/components/table-export-menu", () => ({
  TableExportMenu: (props: {
    data: ScreenerRow[];
    columns: CsvColumn<ScreenerRow>[];
    asOfISO: string;
  }) => {
    mocks.TableExportMenu(props);
    return <div data-testid="table-export-menu" />;
  },
}));

vi.mock("@/hooks/use-stablecoins", () => ({
  useStablecoins: mocks.useStablecoins,
}));

vi.mock("@/hooks/api-hooks", () => ({
  useDexLiquidityTable: mocks.useDexLiquidityTable,
  usePegSummary: mocks.usePegSummary,
  useReportCardsV9Table: mocks.useReportCardsV9,
  useStressSignals: mocks.useStressSignals,
}));

vi.mock("@/hooks/use-url-filters", () => ({
  useUrlFilters: mocks.useUrlFilters,
}));

vi.mock("@/hooks/use-sort", () => ({
  useSort: mocks.useSort,
}));

vi.mock("@/hooks/use-hydrated", () => ({
  useHydrated: mocks.useHydrated,
}));

function refetch() {
  return Promise.resolve({});
}

function setDefaultMocks() {
  mocks.useHydrated.mockReturnValue(true);
  mocks.useUrlFilters.mockReturnValue({
    searchParams: new URLSearchParams(),
    replaceParams: vi.fn(),
  });
  mocks.useSort.mockReturnValue({
    sortKey: "safetyScore",
    sortDirection: "desc",
    toggleSort: vi.fn(),
    getAriaSortValue: vi.fn(() => "none"),
  });
  mocks.useStablecoins.mockReturnValue({
    data: undefined,
    isLoading: false,
    error: null,
    dataUpdatedAt: 0,
    meta: null,
    refetch,
  });
  mocks.usePegSummary.mockReturnValue({
    data: {
      coins: [{ id: "usdc-circle", currentDeviationBps: 0, worstDeviationBps: 0 }],
    },
    error: null,
    dataUpdatedAt: 1_700_000_000,
    meta: null,
    refetch,
  });
  mocks.useReportCardsV9.mockReturnValue({
    data: makeReportCardsV9Response({ cards: [] }),
    isLoading: false,
    error: null,
    dataUpdatedAt: 1_700_000_000,
    meta: null,
    refetch,
  });
  mocks.useStressSignals.mockReturnValue({
    data: { signals: { "usdc-circle": { score: 12 } } },
    isLoading: false,
    error: null,
    dataUpdatedAt: 1_700_000_000,
    meta: null,
    refetch,
  });
  mocks.useDexLiquidityTable.mockReturnValue({
    data: { "usdc-circle": { liquidityScore: 80 } },
    error: null,
    dataUpdatedAt: 1_700_000_000,
    meta: null,
    refetch,
  });
}

function getFreshnessProps() {
  expect(mocks.QueryFreshnessNotices).toHaveBeenCalledTimes(1);
  return mocks.QueryFreshnessNotices.mock.calls[0]?.[0] as {
    hasData: boolean;
    queries: Array<{ preset?: string; hasData?: boolean }>;
    error?: unknown;
  };
}

describe("ScreenerClient freshness notices", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setDefaultMocks();
  });

  it("reserves the Picker slot until its viewport and stored preference can be read", () => {
    mocks.useHydrated.mockReturnValue(false);
    const view = render(<ScreenerClient />);
    expect(view.queryByTestId("selector-callout")).toBeNull();

    mocks.useHydrated.mockReturnValue(true);
    view.rerender(<ScreenerClient />);
    expect(view.getByTestId("selector-callout")).toBeTruthy();
  });

  it("keeps counts and export controls at a fixed footprint across loading and ready states", () => {
    const view = render(<ScreenerClient />);
    expect(view.getByRole("region", { name: "Data table" }).contains(view.getByTestId("freshness-notices"))).toBe(true);
    expect(mocks.TableExportMenu.mock.calls.at(-1)?.[0]).toMatchObject({ triggerClassName: "min-w-24" });
    const unavailableCount = view.getByText("Screener counts unavailable.");
    expect(unavailableCount.classList.contains("min-h-12")).toBe(true);
    expect(unavailableCount.classList.contains("lg:min-h-8")).toBe(true);
    expect(unavailableCount.parentElement?.parentElement?.classList.contains("grid")).toBe(true);

    mocks.useStablecoins.mockReturnValue({
      data: undefined, isLoading: true, error: null, dataUpdatedAt: 0, meta: null, refetch,
    });
    view.rerender(<ScreenerClient />);
    expect(view.getByText("Loading screener inputs…").classList.contains("min-h-12")).toBe(true);
    expect(mocks.TableExportMenu.mock.calls.at(-1)?.[0]).toMatchObject({
      triggerLabel: "Loading", triggerClassName: "min-w-24", disabled: true,
    });

    mocks.useStablecoins.mockReturnValue({
      data: { peggedAssets: [makeStablecoin()] }, isLoading: false, error: null,
      dataUpdatedAt: 1_700_000_000, meta: null, refetch,
    });
    view.rerender(<ScreenerClient />);
    const readyCount = view.getByText(/screenable coins/).closest("p");
    expect(readyCount?.classList.contains("min-h-12")).toBe(true);
    expect(readyCount?.classList.contains("lg:min-h-8")).toBe(true);
    expect(mocks.TableExportMenu.mock.calls.at(-1)?.[0]).toMatchObject({
      triggerLabel: "Export", triggerClassName: "min-w-24", disabled: false,
    });
  });

  it("exports every filtered sorted row, independently of the table's displayed page", () => {
    mocks.useStablecoins.mockReturnValue({
      data: { peggedAssets: [makeStablecoin()] },
      isLoading: false,
      error: null,
      dataUpdatedAt: 1_700_000_000,
      meta: null,
      refetch,
    });
    render(<ScreenerClient />);
    const table = mocks.ScreenerTable.mock.calls.at(-1)?.[0] as { rows: ScreenerRow[] };
    const exported = mocks.TableExportMenu.mock.calls.at(-1)?.[0] as { data: ScreenerRow[] };
    expect(exported.data.length).toBeGreaterThan(50);
    expect(exported.data).toBe(table.rows);
    expect(exported.data.map((row) => row.id)).toEqual(table.rows.map((row) => row.id));
    expect(exported.data.at(-1)?.id).toBe(table.rows.at(-1)?.id);
  });

  it("exports the reviewed blacklistable label, inherited upstream exposure included", () => {
    mocks.useStablecoins.mockReturnValue({
      data: { peggedAssets: [makeStablecoin()] },
      isLoading: false,
      error: null,
      dataUpdatedAt: 1_700_000_000,
      meta: null,
      refetch,
    });
    render(<ScreenerClient />);
    const exported = mocks.TableExportMenu.mock.calls.at(-1)?.[0] as {
      data: ScreenerRow[];
      columns: CsvColumn<ScreenerRow>[];
    };
    const column = exported.columns.find((entry) => entry.header === "blacklistable")!;
    const cell = (id: string) => column.accessor(exported.data.find((row) => row.id === id)!, 0);

    expect(cell("steakusdt-steakhouse")).toBe("Upstream");
    expect(cell("usdc-circle")).toBe("Yes");
    expect(cell("susdt-spark")).toBe("Possible");
    expect(cell("usdu-unitas")).toBe("No");
  });


  it.each([true, false])("withholds counts and export without primary data (loading=%s)", (isLoading) => {
    mocks.useStablecoins.mockReturnValue({
      data: undefined, isLoading, error: isLoading ? null : new Error("Offline"),
      dataUpdatedAt: 0, meta: null, refetch,
    });
    const view = render(<ScreenerClient />);
    expect(view.queryByText(/screenable coins/)).toBeNull();
    expect(view.getByText(isLoading ? "Loading screener inputs…" : "Screener counts unavailable.")).toBeTruthy();
    expect(mocks.ScreenerTable.mock.calls.at(-1)?.[0].dataState).toBe(isLoading ? "loading" : "unavailable");
    expect(mocks.TableExportMenu.mock.calls.at(-1)?.[0]).toMatchObject({ data: [], disabled: true });
  });

  it("keeps retained primary rows and compact liquidity scores available after refresh failure", () => {
    mocks.useStablecoins.mockReturnValue({
      data: { peggedAssets: [makeStablecoin()] }, isLoading: false, error: new Error("Offline"),
      dataUpdatedAt: 1_700_000_000, meta: null, refetch,
    });
    render(<ScreenerClient />);
    const table = mocks.ScreenerTable.mock.calls.at(-1)?.[0];
    expect(table.dataState).toBe("ready");
    expect(table.rows.find((row: ScreenerRow) => row.id === "usdc-circle")?.liquidityScore).toBe(80);
    expect(mocks.TableExportMenu.mock.calls.at(-1)?.[0].disabled).toBe(false);
  });

  it.each([
    ["report", "safetyScoreMin=100"],
    ["dews", "dewsMin=100"],
    ["peg", "pegScoreMin=100"],
    ["liquidity", "liquidityScoreMin=100"],
  ] as const)("requires an available %s publication before establishing zero matches", (source, query) => {
    mocks.useStablecoins.mockReturnValue({
      data: { peggedAssets: [makeStablecoin()] }, isLoading: false, error: null,
      dataUpdatedAt: 1_700_000_000, meta: null, refetch,
    });
    mocks.useUrlFilters.mockReturnValue({ searchParams: new URLSearchParams(query), replaceParams: vi.fn() });
    const hook = {
      report: mocks.useReportCardsV9, dews: mocks.useStressSignals,
      peg: mocks.usePegSummary, liquidity: mocks.useDexLiquidityTable,
    }[source]!;
    const empty = {
      report: makeReportCardsV9Response({ cards: [] }), dews: { signals: {} },
      peg: { coins: [] }, liquidity: {},
    }[source];
    hook.mockReturnValue({ data: undefined, isLoading: true, error: null, dataUpdatedAt: 0, meta: null, refetch });
    const view = render(<ScreenerClient />);
    expect(view.getByText("Loading screener inputs…")).toBeTruthy();
    expect(mocks.ScreenerTable.mock.calls.at(-1)?.[0]).toMatchObject({ dataState: "loading", rows: [] });
    expect(mocks.TableExportMenu.mock.calls.at(-1)?.[0]).toMatchObject({ disabled: true, data: [] });

    hook.mockReturnValue({ data: undefined, isLoading: false, error: new Error("offline"), dataUpdatedAt: 0, meta: null, refetch });
    view.rerender(<ScreenerClient />);
    expect(view.getByText("Screener counts unavailable.")).toBeTruthy();
    expect(view.queryByText(/screenable coins/)).toBeNull();
    expect(mocks.ScreenerTable.mock.calls.at(-1)?.[0]).toMatchObject({ dataState: "unavailable", rows: [] });
    expect(mocks.TableExportMenu.mock.calls.at(-1)?.[0]).toMatchObject({ disabled: true, data: [] });

    hook.mockReturnValue({ data: empty, isLoading: false, error: null, dataUpdatedAt: 1_700_000_000, meta: null, refetch });
    view.rerender(<ScreenerClient />);
    expect(mocks.ScreenerTable.mock.calls.at(-1)?.[0]).toMatchObject({ dataState: "ready", rows: [] });
    expect(mocks.TableExportMenu.mock.calls.at(-1)?.[0]).toMatchObject({ disabled: false, data: [] });
    expect(view.queryByText("Screener counts unavailable.")).toBeNull();

    hook.mockReturnValue({ data: empty, isLoading: false, error: new Error("refresh failed"), dataUpdatedAt: 1_700_000_000, meta: null, refetch });
    view.rerender(<ScreenerClient />);
    expect(mocks.ScreenerTable.mock.calls.at(-1)?.[0].dataState).toBe("ready");
    expect(mocks.TableExportMenu.mock.calls.at(-1)?.[0].disabled).toBe(false);
  });

  it("does not turn a missing report feed into mint NR, but admits NR from an available empty publication", () => {
    mocks.useStablecoins.mockReturnValue({ data: { peggedAssets: [makeStablecoin()] }, isLoading: false, error: null, dataUpdatedAt: 1, meta: null, refetch });
    mocks.useUrlFilters.mockReturnValue({ searchParams: new URLSearchParams("mintAuthorityScores=nr"), replaceParams: vi.fn() });
    mocks.useReportCardsV9.mockReturnValue({ data: undefined, isLoading: false, error: new Error("offline"), dataUpdatedAt: 0, meta: null, refetch });
    const view = render(<ScreenerClient />);
    expect(mocks.TableExportMenu.mock.calls.at(-1)?.[0]).toMatchObject({ disabled: true, data: [] });
    mocks.useReportCardsV9.mockReturnValue({ data: makeReportCardsV9Response({ cards: [] }), isLoading: false, error: null, dataUpdatedAt: 1, meta: null, refetch });
    view.rerender(<ScreenerClient />);
    expect(mocks.TableExportMenu.mock.calls.at(-1)?.[0].disabled).toBe(false);
    expect(mocks.TableExportMenu.mock.calls.at(-1)?.[0].data.length).toBeGreaterThan(0);
    expect(mocks.TableExportMenu.mock.calls.at(-1)?.[0].data.every((row: ScreenerRow) => row.mintAuthorityScoreBand === "nr")).toBe(true);
  });

  it.each(["lifecycle=active", "coins=usdc-circle&safetyScoreMin=100&dewsMin=100&pegScoreMin=100&liquidityScoreMin=100"])(
    "ignores unavailable feeds irrelevant to the admitted predicates: %s", (query) => {
      mocks.useStablecoins.mockReturnValue({ data: { peggedAssets: [makeStablecoin()] }, isLoading: false, error: null, dataUpdatedAt: 1, meta: null, refetch });
      mocks.useUrlFilters.mockReturnValue({ searchParams: new URLSearchParams(query), replaceParams: vi.fn() });
      for (const hook of [mocks.useReportCardsV9, mocks.useStressSignals, mocks.usePegSummary, mocks.useDexLiquidityTable]) {
        hook.mockReturnValue({ data: undefined, isLoading: false, error: new Error("offline"), dataUpdatedAt: 0, meta: null, refetch });
      }
      render(<ScreenerClient />);
      expect(mocks.ScreenerTable.mock.calls.at(-1)?.[0].dataState).toBe("ready");
      expect(mocks.TableExportMenu.mock.calls.at(-1)?.[0].disabled).toBe(false);
      if (query.startsWith("coins=")) expect(mocks.TableExportMenu.mock.calls.at(-1)?.[0].data.map((row: ScreenerRow) => row.id)).toEqual(["usdc-circle"]);
    },
  );

  it("exports mixed producer generations unchanged across later browser receipts and preserves unknown clocks", () => {
    const feeds = [
      { hook: mocks.useStablecoins, data: { peggedAssets: [makeStablecoin()] }, updatedAt: 1_700_000_100 },
      { hook: mocks.usePegSummary, data: { coins: [] }, updatedAt: 1_700_000_000 },
      { hook: mocks.useReportCardsV9, data: makeReportCardsV9Response({ cards: [] }), updatedAt: 1_700_000_200 },
      { hook: mocks.useStressSignals, data: { signals: {} }, updatedAt: 1_700_000_300 },
      { hook: mocks.useDexLiquidityTable, data: {}, updatedAt: 1_700_000_400 },
    ];
    for (const feed of feeds) feed.hook.mockReturnValue({
      data: feed.data, isLoading: false, error: null, dataUpdatedAt: 1_900_000_000_000,
      meta: { updatedAt: feed.updatedAt }, refetch,
    });
    const view = render(<ScreenerClient />);
    const expected = {
      stablecoins: "2023-11-14T22:15:00.000Z",
      "peg-summary": "2023-11-14T22:13:20.000Z",
      "report-cards": "2023-11-14T22:16:40.000Z",
      "stress-signals": "2023-11-14T22:18:20.000Z",
      "dex-liquidity": "2023-11-14T22:20:00.000Z",
    };
    expect(mocks.TableExportMenu.mock.calls.at(-1)?.[0]).toMatchObject({
      asOfISO: "2023-11-14T22:13:20.000Z", sourceGenerations: expected,
    });
    for (const feed of feeds) feed.hook.mockReturnValue({
      data: feed.data, isLoading: false, error: null, dataUpdatedAt: 1_950_000_000_000,
      meta: { updatedAt: feed.updatedAt }, refetch,
    });
    view.rerender(<ScreenerClient />);
    expect(mocks.TableExportMenu.mock.calls.at(-1)?.[0]).toMatchObject({
      asOfISO: "2023-11-14T22:13:20.000Z", sourceGenerations: expected,
    });
    mocks.useReportCardsV9.mockReturnValue({
      data: feeds[2].data, isLoading: false, error: null, dataUpdatedAt: 1_950_000_000_000, meta: null, refetch,
    });
    view.rerender(<ScreenerClient />);
    expect(mocks.TableExportMenu.mock.calls.at(-1)?.[0]).toMatchObject({
      asOfISO: "unknown", sourceGenerations: { ...expected, "report-cards": null }, disabled: false,
    });
  });

  it("exports an unknown mint band, not NR, when the report-card publication is unavailable", () => {
    mocks.useStablecoins.mockReturnValue({ data: { peggedAssets: [makeStablecoin()] }, isLoading: false, error: null, dataUpdatedAt: 1, meta: null, refetch });
    mocks.useReportCardsV9.mockReturnValue({ data: undefined, isLoading: false, error: new Error("offline"), dataUpdatedAt: 0, meta: null, refetch });
    render(<ScreenerClient />);
    const props = mocks.TableExportMenu.mock.calls.at(-1)?.[0] as {
      data: ScreenerRow[];
      columns: CsvColumn<ScreenerRow>[];
      disabled: boolean;
    };

    expect(props.disabled).toBe(false);
    expect(props.data.length).toBeGreaterThan(0);
    expect(props.data.every((row) => row.mintAuthorityScoreBand === null)).toBe(true);
    const bandColumn = props.columns.find((column) => column.header === "mint_authority_score_band")!;
    expect(bandColumn.accessor(props.data[0], 0)).toBeNull();
    expect(escapeCsvField(bandColumn.accessor(props.data[0], 0))).toBe("");
  });

  it("stamps the export with the admitted publication's prefixed methodology label", () => {
    mocks.useStablecoins.mockReturnValue({ data: { peggedAssets: [makeStablecoin()] }, isLoading: false, error: null, dataUpdatedAt: 1, meta: null, refetch });
    render(<ScreenerClient />);
    const props = mocks.TableExportMenu.mock.calls.at(-1)?.[0] as { methodologyLabel: string };

    expect(props.methodologyLabel).toContain("safety-score v9.0");
    expect(props.methodologyLabel).not.toContain("safety-score 9.0");
  });

  it("does not claim a methodology for safety columns this run did not read", () => {
    mocks.useStablecoins.mockReturnValue({ data: { peggedAssets: [makeStablecoin()] }, isLoading: false, error: null, dataUpdatedAt: 1, meta: null, refetch });
    mocks.useReportCardsV9.mockReturnValue({ data: undefined, isLoading: false, error: new Error("offline"), dataUpdatedAt: 0, meta: null, refetch });
    render(<ScreenerClient />);
    const props = mocks.TableExportMenu.mock.calls.at(-1)?.[0] as { methodologyLabel: string };

    expect(props.methodologyLabel).toContain("safety-score columns unavailable this run");
    expect(props.methodologyLabel).not.toMatch(/safety-score v9\b/);
  });

  it("keeps an inadmissible report publication unavailable rather than treating it as issuer NR", () => {
    mocks.useStablecoins.mockReturnValue({ data: { peggedAssets: [makeStablecoin()] }, isLoading: false, error: null, dataUpdatedAt: 1, meta: null, refetch });
    mocks.useUrlFilters.mockReturnValue({ searchParams: new URLSearchParams("mintAuthorityScores=nr"), replaceParams: vi.fn() });
    mocks.useReportCardsV9.mockReturnValue({ data: { cards: [] }, isLoading: false, error: null, dataUpdatedAt: 1, meta: null, refetch });
    render(<ScreenerClient />);
    expect(mocks.ScreenerTable.mock.calls.at(-1)?.[0]).toMatchObject({ dataState: "unavailable", rows: [] });
    expect(mocks.TableExportMenu.mock.calls.at(-1)?.[0]).toMatchObject({ disabled: true, data: [] });
  });
  it("keeps the global data gate tied to the primary stablecoin rows", () => {
    const stablecoinsError = new Error("stablecoin list unavailable");
    mocks.useStablecoins.mockReturnValue({
      data: undefined,
      isLoading: false,
      error: stablecoinsError,
      dataUpdatedAt: 0,
      meta: null,
      refetch,
    });

    render(<ScreenerClient />);

    const props = getFreshnessProps();
    expect(props.hasData).toBe(false);
    expect(props.error).toBe(stablecoinsError);
    expect(props.queries.some((query) => query.preset === "pegSummary" && query.hasData)).toBe(true);
    expect(props.queries.some((query) => query.preset === "stressSignals" && query.hasData)).toBe(true);
    expect(props.queries.some((query) => query.preset === "dexLiquidity" && query.hasData)).toBe(true);
  });

  it("projects the V9 score into the screener row, not the legacy weighted-pillar mean", () => {
    const bindingCap = {
      kind: "parent",
      limit: 61,
      source: "parent" as const,
      reason: "The required parent limits the published score.",
      binding: true,
    };
    // The legacy weighted-pillar mean (qualityScore 88) and the V9 post-cap
    // published score (61) diverge; the screener row must carry the V9 one.
    const response = makeReportCardsV9Response({
      cards: [
        makeV9Card({
          id: "usdc-circle",
          score: 61,
          grade: "C+",
          qualityScore: 88,
          pegAdjustedScore: 88,
          pillars: makeV9Pillars({ backing: 86, exit: 88, control: 90 }),
          caps: [bindingCap],
          bindingCap,
          dependencies: {
            serial: [{ upstreamAssetId: "required-parent", score: 61, blocked: false, ratingStatus: "rated", partialEvidence: null, causeGapRefs: [], limitedEvidenceCauses: [] }],
            basket: [], cycleBlocked: false, reasonCodes: [],
          },
          evidence: { level: "insufficient", freshness: "stale", reasons: [] },
        }),
      ],
    });

    mocks.useStablecoins.mockReturnValue({
      data: { peggedAssets: [makeStablecoin()] },
      isLoading: false,
      error: null,
      dataUpdatedAt: 1_700_000_000,
      meta: null,
      refetch,
    });
    mocks.useReportCardsV9.mockReturnValue({
      data: response,
      isLoading: false,
      error: null,
      dataUpdatedAt: 1_700_000_000,
      meta: null,
      refetch,
    });

    render(<ScreenerClient />);

    const props = mocks.ScreenerTable.mock.calls[0]?.[0] as { rows: ScreenerRow[] } | undefined;
    const row = props?.rows.find((candidate) => candidate.id === "usdc-circle");
    expect(row).toEqual(expect.objectContaining({
      safetyGrade: "C+",
      safetyScore: 61,
      safetyBackingScore: 86,
      safetyExitScore: 88,
      safetyControlScore: 90,
      safetyEvidence: "insufficient",
      safetyWeakestPillar: "backing",
      safetyWeakestScore: 86,
      safetyBindingCapReason: bindingCap.reason,
    }));
    const exported = mocks.TableExportMenu.mock.calls.at(-1)?.[0] as {
      data: ScreenerRow[];
      columns: CsvColumn<ScreenerRow>[];
    };
    const exportedRow = exported.data.find((candidate) => candidate.id === "usdc-circle")!;
    const evidenceCell = exported.columns.find((column) => column.header === "safety_evidence")!;
    expect(evidenceCell.accessor(exportedRow, 0)).toBe("insufficient");
  });
  it("preserves technical null grades, excluded pillars and causes in rows and exports", () => {
    const response = makeReportCardsV9Response({ cards: [
      makeReportCardsV9PipelineGapCard("control", "A", { id: "usdc-circle" }),
      makeReportCardsV9PartialCard("exit", "B", { id: "usdt-tether", score: 75 }),
    ] });
    mocks.useReportCardsV9.mockReturnValue({ data: response, isLoading: false, error: null, dataUpdatedAt: 1_700_000_000, meta: null, refetch });
    mocks.useStablecoins.mockReturnValue({ data: { peggedAssets: [makeStablecoin()] }, isLoading: false, error: null, dataUpdatedAt: 1_700_000_000, meta: null, refetch });
    render(<ScreenerClient />);
    const props = mocks.TableExportMenu.mock.calls.at(-1)?.[0] as { data: ScreenerRow[]; columns: CsvColumn<ScreenerRow>[] };
    const gap = props.data.find(row => row.id === "usdc-circle")!;
    const partial = props.data.find(row => row.id === "usdt-tether")!;
    expect(gap).toMatchObject({ safetyGrade: null, safetyScore: null, ratingStatus: "pipeline-gap", safetyEvidence: "pipeline-gap" });
    expect(partial).toMatchObject({ safetyGrade: "B+", safetyScore: 75, safetyExitScore: null, ratingStatus: "rated" });
    const cell = (header: string, row: ScreenerRow) => props.columns.find(column => column.header === header)!.accessor(row, 0);
    expect(cell("safety_grade", gap)).toBe("");
    expect(cell("safety_score", gap)).toBe("");
    expect(cell("safety_exit", partial)).toBe("");
    expect(cell("safety_rating_status", gap)).toBe("pipeline-gap");
    expect(cell("safety_gap_causes", gap)).toBe("pipeline unavailable (A)");
    expect(cell("safety_gap_causes", partial)).toBe("public data awaiting curation (B)");
    expect(props.data.find(row => row.id === "dai-makerdao")?.safetyEvidence).toBeNull();
  });

  it("keeps missing, empty and invalid supply unavailable through rows, filters and exports while keeping explicit zero", () => {
    const sourceUpdatedAt = Date.parse("2026-05-16T06:00:00.000Z");
    mocks.useStablecoins.mockReturnValue({
      data: {
        peggedAssets: [
          makeStablecoin({ id: "usdc-circle", circulating: { peggedUSD: 0 } }),
          makeStablecoin({ id: "usdt-tether", circulating: {} }),
          makeStablecoin({ id: "dai-makerdao", circulating: { peggedUSD: Number.NaN } }),
          makeStablecoin({ id: "usds-sky", circulating: { peggedUSD: 500 } }),
        ],
      },
      isLoading: false,
      error: null,
      dataUpdatedAt: sourceUpdatedAt,
      meta: null,
      refetch,
    });
    mocks.useUrlFilters.mockReturnValue({
      searchParams: new URLSearchParams("supplyMax=1000"),
      replaceParams: vi.fn(),
    });

    render(<ScreenerClient />);

    const props = mocks.TableExportMenu.mock.calls.at(-1)?.[0] as {
      data: ScreenerRow[];
      columns: CsvColumn<ScreenerRow>[];
      asOfISO: string;
    };
    const supplyColumn = props.columns.find((column) => column.header === "supply_usd");
    const exported = Object.fromEntries(props.data.map((row) => [row.id, supplyColumn?.accessor(row, 0)]));

    // Max-only supply filter: explicit zero and in-range supply pass; unknown supply (empty,
    // invalid-only, or an asset absent from the list such as a pre-launch row) never matches.
    expect(exported).toEqual({ "usdc-circle": 0, "usds-sky": 500 });
    expect(props.asOfISO).toBe("unknown");
  });

  it("exports unknown supply as an empty cell when no supply filter is active", () => {
    mocks.useStablecoins.mockReturnValue({
      data: { peggedAssets: [makeStablecoin({ id: "usdt-tether", circulating: {} })] },
      isLoading: false,
      error: null,
      dataUpdatedAt: 1_700_000_000,
      meta: null,
      refetch,
    });

    render(<ScreenerClient />);

    const props = mocks.TableExportMenu.mock.calls.at(-1)?.[0] as { data: ScreenerRow[]; columns: CsvColumn<ScreenerRow>[] };
    const row = props.data.find((candidate) => candidate.id === "usdt-tether");
    const supplyColumn = props.columns.find((column) => column.header === "supply_usd");

    expect(row?.supplyUsd).toBeNull();
    expect(supplyColumn?.accessor(row!, 0)).toBe("");
  });
});
