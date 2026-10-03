// @vitest-environment jsdom

import { cleanup, render } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeStablecoin } from "@shared/test-utils/stablecoin";
import { makeReportCardsV9Response, makeV9Card, makeV9Pillars } from "@/test/fixtures/safety-score-v9";
import { makeReportCardsV9PartialCard, makeReportCardsV9PipelineGapCard } from "@shared/test-utils/report-cards-v9";
import type { ScreenerRow } from "@/lib/screener-filters";
import type { CsvColumn } from "@/lib/exports/csv";

import { ScreenerClient } from "./client";

const mocks = vi.hoisted(() => ({
  QueryFreshnessNotices: vi.fn(),
  ScreenerTable: vi.fn(),
  useDexLiquidity: vi.fn(),
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

vi.mock("@/components/screener/screener-toolbar", () => ({
  ScreenerToolbar: ({ rightSlot }: { rightSlot?: ReactNode }) => (
    <div data-testid="screener-toolbar">{rightSlot}</div>
  ),
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
  useDexLiquidity: mocks.useDexLiquidity,
  usePegSummary: mocks.usePegSummary,
  useReportCardsV9: mocks.useReportCardsV9,
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
    data: { cards: [] },
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
  mocks.useDexLiquidity.mockReturnValue({
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

  afterEach(() => {
    cleanup();
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
      kind: "reason:missing-mint-authority",
      limit: 61,
      source: "evidence" as const,
      reason: "Mint control evidence caps the published score.",
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
      safetyEvidence: "limited",
      safetyWeakestPillar: "backing",
      safetyWeakestScore: 86,
      safetyBindingCapReason: "Mint control evidence caps the published score.",
    }));
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
    expect(props.asOfISO).toBe("2026-05-16T06:00:00.000Z");
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
