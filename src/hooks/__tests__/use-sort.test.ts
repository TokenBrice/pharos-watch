// @vitest-environment node

import { describe, expect, it } from "vitest";
import { getNextSortState, shouldToggleSortOnKeyDown } from "@/hooks/use-sort";
import { sortTableRows, type TableSortState } from "@/hooks/use-sorted-table-rows";
import {
  derivePagination,
  reconcilePaginationStateOnTotalChange,
  type TablePaginationState,
} from "@/hooks/use-table-pagination";

type SortKey = "score" | "tvl";

describe("getNextSortState", () => {
  it("toggles direction when clicking the same key", () => {
    const next = getNextSortState<SortKey>({ key: "score", direction: "desc" }, "score");
    expect(next).toEqual({ key: "score", direction: "asc" });
  });

  it("resets to descending when switching columns", () => {
    const next = getNextSortState<SortKey>({ key: "score", direction: "asc" }, "tvl");
    expect(next).toEqual({ key: "tvl", direction: "desc" });
  });
});

describe("shouldToggleSortOnKeyDown", () => {
  it("accepts keyboard activation keys", () => {
    expect(shouldToggleSortOnKeyDown("Enter")).toBe(true);
    expect(shouldToggleSortOnKeyDown(" ")).toBe(true);
  });

  it("ignores non-activation keys", () => {
    expect(shouldToggleSortOnKeyDown("Tab")).toBe(false);
    expect(shouldToggleSortOnKeyDown("ArrowDown")).toBe(false);
  });
});

type RowSortKey = "score" | "name";

interface Row {
  name: string;
  score: number;
}

const rows: Row[] = [
  { name: "USDC", score: 99 },
  { name: "USDT", score: 97 },
  { name: "DAI", score: 98 },
];

function compareRows(a: Row, b: Row, sort: TableSortState<RowSortKey>): number {
  if (sort.key === "name") {
    return sort.direction === "asc"
      ? a.name.localeCompare(b.name)
      : b.name.localeCompare(a.name);
  }
  return sort.direction === "asc" ? a.score - b.score : b.score - a.score;
}

describe("sortTableRows", () => {
  it("does not mutate original rows", () => {
    const original = [...rows];
    void sortTableRows(rows, { key: "score", direction: "asc" }, compareRows);
    expect(rows).toEqual(original);
  });
});

describe("reconcilePaginationStateOnTotalChange", () => {
  it("persists page reset when row count changes", () => {
    let state: TablePaginationState = { page: 2, totalRowsSnapshot: 60 };

    state = reconcilePaginationStateOnTotalChange(state, 10, true);
    expect(state).toEqual({ page: 0, totalRowsSnapshot: 10 });

    state = reconcilePaginationStateOnTotalChange(state, 60, true);
    expect(state).toEqual({ page: 0, totalRowsSnapshot: 60 });
  });
});

describe("derivePagination", () => {
  it("clamps to first page when current page is out of range", () => {
    const pagination = derivePagination({ page: 4, totalRowsSnapshot: 100 }, 20, 25, false);
    expect(pagination).toMatchObject({
      basePage: 4,
      effectivePage: 0,
      totalPages: 1,
      pageStartIndex: 0,
    });
  });

  it("reflects persisted reset in shrink-then-restore flow", () => {
    const before = derivePagination({ page: 2, totalRowsSnapshot: 60 }, 60, 25, true);
    expect(before).toMatchObject({ effectivePage: 2, totalPages: 3, pageStartIndex: 50 });

    const afterShrink = derivePagination({ page: 0, totalRowsSnapshot: 10 }, 10, 25, true);
    expect(afterShrink).toMatchObject({ effectivePage: 0, totalPages: 1, pageStartIndex: 0 });

    const afterRestore = derivePagination({ page: 0, totalRowsSnapshot: 60 }, 60, 25, true);
    expect(afterRestore).toMatchObject({ effectivePage: 0, totalPages: 3, pageStartIndex: 0 });
  });
});
