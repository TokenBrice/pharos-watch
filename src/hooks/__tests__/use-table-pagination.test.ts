import { describe, expect, it } from "vitest";
import {
  derivePagination,
  reconcilePaginationStateOnTotalChange,
  type TablePaginationState,
} from "@/hooks/use-table-pagination";

describe("reconcilePaginationStateOnTotalChange", () => {
  it("persists page reset when row count changes", () => {
    let state: TablePaginationState = { page: 2, totalRowsSnapshot: 60 };

    state = reconcilePaginationStateOnTotalChange(state, 10, true);
    expect(state).toEqual({ page: 0, totalRowsSnapshot: 10 });

    state = reconcilePaginationStateOnTotalChange(state, 60, true);
    expect(state).toEqual({ page: 0, totalRowsSnapshot: 60 });
  });

  it("keeps state when reset-on-change is disabled", () => {
    const state = reconcilePaginationStateOnTotalChange(
      { page: 3, totalRowsSnapshot: 100 },
      20,
      false
    );
    expect(state).toEqual({ page: 3, totalRowsSnapshot: 100 });
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
