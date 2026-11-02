// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { YieldLeaderboard } from "@/components/yield-leaderboard";
import {
  makeYieldViewModelRow,
  YIELD_TEST_PROVENANCE,
} from "@/components/__tests__/yield-test-support";

const { downloadCsvWithPreambleMock } = vi.hoisted(() => ({
  downloadCsvWithPreambleMock: vi.fn(),
}));

vi.mock("@/lib/exports/csv", () => ({
  downloadCsvWithPreamble: downloadCsvWithPreambleMock,
}));
vi.mock("@/hooks/api-hooks", () => ({
  useYieldRankings: () => ({ data: undefined, dataUpdatedAt: 0 }),
}));
vi.mock("@/hooks/use-yield-compare-selection", () => ({
  useYieldCompareSelection: () => ({
    ids: [],
    has: () => false,
    toggle: vi.fn(),
    clear: vi.fn(),
    canAdd: true,
  }),
}));
vi.mock("@/hooks/use-prefetch-stablecoin", () => ({
  usePrefetchStablecoin: () => vi.fn(),
}));
vi.mock("@/hooks/use-sorted-paginated-table", () => ({
  useSortedPaginatedTable: (rows: unknown[]) => ({
    sortKey: "pys",
    sortDirection: "desc",
    toggleSort: vi.fn(),
    sortedRows: rows,
    effectivePage: 1,
    totalPages: 1,
    paginatedRows: [],
    pageStartIndex: 0,
    rangeStart: rows.length > 0 ? 1 : 0,
    rangeEnd: rows.length,
    totalRows: rows.length,
    onPreviousPage: vi.fn(),
    onNextPage: vi.fn(),
  }),
}));
vi.mock("@/components/yield-instrument-board", () => ({ YieldInstrumentBoard: () => null }));
vi.mock("@/components/yield-source-sheet", () => ({ YieldSourceSheet: () => null }));
vi.mock("@/components/yield-compare-tray", () => ({ YieldCompareTray: () => null }));
vi.mock("@/components/yield-compare-drawer", () => ({ YieldCompareDrawer: () => null }));
vi.mock("@/components/table-pagination", () => ({ TablePagination: () => null }));

afterEach(() => {
  downloadCsvWithPreambleMock.mockClear();
});

describe("YieldLeaderboard export", () => {
  it("preserves default-safety provenance verbatim", () => {
    const row = makeYieldViewModelRow({
      provenance: {
        ...YIELD_TEST_PROVENANCE,
        safetyProvenance: "default-safety",
      },
    });

    render(
      <YieldLeaderboard
        rows={[row]}
        logos={{}}
        riskFreeRate={3.5}
        medianApy={4}
        scalingFactor={1}
        updatedAt={1_778_908_800}
        filterSummary={{
          visibleCount: 1,
          totalCount: 1,
          comparisonLabel: "",
          activeFilters: [],
        }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Export 1 yield rows as CSV" }));
    expect(downloadCsvWithPreambleMock).toHaveBeenCalledTimes(1);

    const [data, columns] = downloadCsvWithPreambleMock.mock.calls[0]!;
    const safetyProvenance = (columns as Array<{
      header: string;
      accessor: (entry: unknown) => unknown;
    }>).find((column) => column.header === "Safety provenance");

    expect(safetyProvenance?.accessor((data as unknown[])[0])).toBe("default-safety");
  });

  it("exports the published view rank instead of the current sort position", () => {
    const rows = [
      makeYieldViewModelRow({ id: "b", symbol: "B", viewRank: 2, rankLabel: "#2" }),
      makeYieldViewModelRow({ id: "a", symbol: "A", viewRank: 1, rankLabel: "#1" }),
    ];

    render(
      <YieldLeaderboard
        rows={rows}
        logos={{}}
        riskFreeRate={3.5}
        medianApy={4}
        scalingFactor={1}
        updatedAt={1_778_908_800}
        filterSummary={{
          visibleCount: 2,
          totalCount: 2,
          comparisonLabel: "",
          activeFilters: [],
        }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Export 2 yield rows as CSV" }));
    const [data, columns] = downloadCsvWithPreambleMock.mock.calls[0]!;
    const rank = (columns as Array<{
      header: string;
      accessor: (entry: unknown) => unknown;
    }>).find((column) => column.header === "Rank")!;

    expect(rank.accessor((data as unknown[])[0])).toBe(2);
    expect(rank.accessor((data as unknown[])[1])).toBe(1);
  });
});
