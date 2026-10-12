// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  deriveReferenceTablePage,
  parseReferenceTablePage,
  useReferenceTablePage,
} from "@/hooks/use-reference-table-page";

afterEach(() => {
  window.history.replaceState(null, "", "/");
});

describe("parseReferenceTablePage", () => {
  it("accepts positive integers and falls back to page 1 otherwise", () => {
    expect(parseReferenceTablePage("3")).toBe(3);
    expect(parseReferenceTablePage(null)).toBe(1);
    expect(parseReferenceTablePage("0")).toBe(1);
    expect(parseReferenceTablePage("-2")).toBe(1);
    expect(parseReferenceTablePage("2.5")).toBe(1);
    expect(parseReferenceTablePage("abc")).toBe(1);
  });
});

describe("deriveReferenceTablePage", () => {
  it("returns an inclusive 1-based range for the requested page", () => {
    expect(deriveReferenceTablePage(2, 60, 25)).toEqual({
      page: 2,
      totalPages: 3,
      pageStartIndex: 25,
      rangeStart: 26,
      rangeEnd: 50,
    });
  });

  it("clamps an out-of-range page to the last page and reports 0–0 for no rows", () => {
    expect(deriveReferenceTablePage(9, 60, 25)).toMatchObject({ page: 3, rangeStart: 51, rangeEnd: 60 });
    expect(deriveReferenceTablePage(4, 0, 25)).toMatchObject({ page: 1, totalPages: 1, rangeStart: 0, rangeEnd: 0 });
  });
});

describe("useReferenceTablePage", () => {
  it("reads the page from the URL and writes it back, omitting page 1", () => {
    window.history.replaceState(null, "", "/coverage/?filter=yield&page=2");
    const { result } = renderHook(() => useReferenceTablePage({ totalRows: 80, pageSize: 25 }));

    expect(result.current.page).toBe(2);
    act(() => result.current.setPage(3));
    expect(window.location.search).toBe("?filter=yield&page=3");
    expect(result.current.page).toBe(3);
    act(() => result.current.setPage(1));
    expect(window.location.search).toBe("?filter=yield");
  });

  it("keeps a shared deep-linked page on load but returns to page 1 when the filter signature changes", () => {
    window.history.replaceState(null, "", "/coverage/?page=3");
    const { result, rerender } = renderHook(
      ({ resetKey }) => useReferenceTablePage({ totalRows: 80, pageSize: 25, resetKey }),
      { initialProps: { resetKey: "all" } },
    );

    expect(result.current.page).toBe(3);
    rerender({ resetKey: "yield" });
    expect(window.location.search).toBe("");
    expect(result.current.page).toBe(1);
  });

  it("uses a custom param so two tables on one route page independently", () => {
    window.history.replaceState(null, "", "/compliance/?page=2&watchPage=4");
    const { result } = renderHook(() => useReferenceTablePage({ totalRows: 200, pageSize: 25, param: "watchPage" }));

    expect(result.current.page).toBe(4);
  });
});
