// @vitest-environment jsdom

import { renderHook } from "@testing-library/react";
import { useMemo } from "react";
import { describe, expect, it } from "vitest";
import { useQuerySlice, type QueryResultLike } from "@/hooks/use-query-slice";
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

function useOptionalQueryGroup(enabled: boolean) {
  const optional = useQuerySlice({ dataUpdatedAt: 0, enabled });
  return useMemo(() => ({ optional }), [optional]);
}

function useQueryPair<TList, TPeg>(listQuery: QueryResultLike<TList>, pegQuery: QueryResultLike<TPeg>) {
  const list = useQuerySlice(listQuery);
  const peg = useQuerySlice(pegQuery);
  return useMemo(() => ({ list, peg }), [list, peg]);
}

describe("useQuerySlice", () => {
  it("produces a new identity when exactly one transported field changes", () => {
    const stableData = { n: 1 };
    const stableError = new Error("stable");
    const baseline: QueryResultLike<{ n: number }> = {
      data: stableData,
      isLoading: true,
      isError: true,
      error: stableError,
      dataUpdatedAt: 1,
      meta: META,
    };
    const { result, rerender } = renderHook(
      (props: QueryResultLike<{ n: number }>) => useQuerySlice(makeQueryResult(props)),
      { initialProps: baseline },
    );

    const baselineSlice = result.current;
    expect(baselineSlice.data).toBe(stableData);
    expect(baselineSlice.error).toBe(stableError);
    expect(baselineSlice.meta).toBe(META);

    // One axis moves per case; every other input keeps its identity, so a dropped
    // dependency cannot be masked by an incidentally reallocated neighbour.
    // (Same-props identity stability is pinned separately by the stable-group test.)
    for (const changed of [
      { data: { n: 2 } },
      { dataUpdatedAt: 2 },
      { isLoading: false },
      { isError: false },
      { error: null },
      { meta: null },
    ] satisfies Partial<QueryResultLike<{ n: number }>>[]) {
      rerender({ ...baseline, ...changed });
      expect(result.current).not.toBe(baselineSlice);
      expect(result.current).toMatchObject(changed);

      // Unmoved members keep their exact identities across the rebuild.
      if (!("data" in changed)) expect(result.current.data).toBe(stableData);
      if (!("error" in changed)) expect(result.current.error).toBe(stableError);
      if (!("meta" in changed)) expect(result.current.meta).toBe(META);
    }
  });
});

describe("caller-local query groups", () => {
  it("preserves query enablement and updates it even when transport fields are unchanged", () => {
    const { result, rerender } = renderHook(
      ({ enabled }) => useOptionalQueryGroup(enabled),
      { initialProps: { enabled: false } },
    );

    expect(result.current.optional).toHaveProperty("enabled", false);
    const first = result.current;
    rerender({ enabled: true });
    expect(result.current).not.toBe(first);
    expect(result.current.optional).toHaveProperty("enabled", true);
  });

  it("keeps the container and every member stable while inputs are unchanged", () => {
    const listData = { peggedAssets: [] };
    const pegData = { coins: [] };
    const { result, rerender } = renderHook(() =>
      useQueryPair(
        makeQueryResult({ data: listData, dataUpdatedAt: 10, meta: META }),
        makeQueryResult({ data: pegData, dataUpdatedAt: 20 }),
      ),
    );

    const first = result.current;
    rerender();

    expect(result.current).toBe(first);
    expect(result.current.list).toBe(first.list);
    expect(result.current.peg).toBe(first.peg);
  });
});
