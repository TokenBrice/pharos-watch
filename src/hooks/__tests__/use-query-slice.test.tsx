// @vitest-environment jsdom

import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useQuerySlice, useQuerySlices, type QueryResultLike } from "@/hooks/use-query-slice";
import type { ApiMeta } from "@/lib/api";

const META: ApiMeta = { updatedAt: 1_700_000_000, ageSeconds: 12, status: "fresh" };

/** Mirrors TanStack v5: a fresh result object on every render, stable field references. */
function makeQueryResult<TData>(overrides: Partial<QueryResultLike<TData>> = {}): QueryResultLike<TData> {
  return {
    data: undefined,
    isLoading: false,
    isError: false,
    error: null,
    dataUpdatedAt: 0,
    meta: null,
    ...overrides,
  };
}

describe("useQuerySlice", () => {
  it("keeps one identity across re-renders that only rebuild the query object", () => {
    const data = { rows: [1, 2, 3] };
    const { result, rerender } = renderHook(
      (props: { data: typeof data }) => useQuerySlice(makeQueryResult({ data: props.data, dataUpdatedAt: 5 })),
      { initialProps: { data } },
    );

    const first = result.current;
    rerender({ data });
    rerender({ data });

    expect(result.current).toBe(first);
  });

  it("normalizes the optional transport fields", () => {
    const { result } = renderHook(() => useQuerySlice({ dataUpdatedAt: 7 }));

    expect(result.current).toEqual({
      data: undefined,
      isLoading: false,
      isError: false,
      error: null,
      dataUpdatedAt: 7,
      meta: null,
    });
  });

  it("produces a new identity when any transported field changes", () => {
    const { result, rerender } = renderHook(
      (props: QueryResultLike<{ n: number }>) => useQuerySlice(makeQueryResult(props)),
      { initialProps: { dataUpdatedAt: 1 } as QueryResultLike<{ n: number }> },
    );

    const identities = [result.current];
    for (const next of [
      { dataUpdatedAt: 1, data: { n: 1 } },
      { dataUpdatedAt: 2, data: { n: 1 } },
      { dataUpdatedAt: 2, data: { n: 1 }, isLoading: true },
      { dataUpdatedAt: 2, data: { n: 1 }, isLoading: true, isError: true },
      { dataUpdatedAt: 2, data: { n: 1 }, isLoading: true, isError: true, error: new Error("x") },
      { dataUpdatedAt: 2, data: { n: 1 }, isLoading: true, isError: true, error: new Error("x"), meta: META },
    ] satisfies QueryResultLike<{ n: number }>[]) {
      const previous = result.current;
      rerender(next);
      expect(result.current).not.toBe(previous);
      identities.push(result.current);
    }

    expect(new Set(identities).size).toBe(identities.length);
  });
});

describe("useQuerySlices", () => {
  it("keeps the container and every member stable while inputs are unchanged", () => {
    const listData = { peggedAssets: [] };
    const pegData = { coins: [] };
    const { result, rerender } = renderHook(() =>
      useQuerySlices({
        list: makeQueryResult({ data: listData, dataUpdatedAt: 10, meta: META }),
        peg: makeQueryResult({ data: pegData, dataUpdatedAt: 20 }),
      }),
    );

    const first = result.current;
    rerender();

    expect(result.current).toBe(first);
    expect(result.current.list).toBe(first.list);
    expect(result.current.peg).toBe(first.peg);
  });

  it("rebuilds when one member changes and exposes normalized slices", () => {
    const listData = { peggedAssets: [] };
    const { result, rerender } = renderHook(
      (props: { updatedAt: number }) =>
        useQuerySlices({
          list: makeQueryResult({ data: listData, dataUpdatedAt: props.updatedAt }),
          peg: makeQueryResult({ dataUpdatedAt: 20, error: new Error("peg down") }),
        }),
      { initialProps: { updatedAt: 10 } },
    );

    const first = result.current;
    rerender({ updatedAt: 11 });

    expect(result.current).not.toBe(first);
    expect(result.current.list.dataUpdatedAt).toBe(11);
    expect(result.current.list.data).toBe(listData);
    expect(result.current.peg.error).toBeInstanceOf(Error);
    expect(result.current.peg.meta).toBeNull();
  });
});
