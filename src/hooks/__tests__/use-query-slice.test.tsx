// @vitest-environment jsdom

import { act, render, renderHook } from "@testing-library/react";
import { startTransition, Suspense, useLayoutEffect, useMemo } from "react";
import { describe, expect, it, vi } from "vitest";
import { useQuerySlice, type QueryResultLike, type QuerySlice } from "@/hooks/use-query-slice";
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

type NumberQueryPair = { list: QuerySlice<number>; peg: QuerySlice<number> };
const pendingQueryPair = new Promise<never>(() => {});

function SuspendedQueryPair({
  updatedAt,
  suspend,
  onCommit,
  onSuspend,
}: {
  updatedAt: number;
  suspend: boolean;
  onCommit: (group: NumberQueryPair) => void;
  onSuspend: () => void;
}) {
  const group = useQueryPair(
    makeQueryResult({ data: 1, dataUpdatedAt: updatedAt }),
    makeQueryResult({ data: 2, dataUpdatedAt: 20 }),
  );
  useLayoutEffect(() => {
    onCommit(group);
  });
  if (suspend) {
    onSuspend();
    throw pendingQueryPair;
  }
  return <span>{group.list.dataUpdatedAt}</span>;
}

describe("useQuerySlice", () => {
  it("preserves an explicit feature gate across single-slice projections", () => {
    const { result, rerender } = renderHook(
      ({ enabled }) => useQuerySlice({ dataUpdatedAt: 0, enabled }),
      { initialProps: { enabled: false } },
    );

    expect(result.current.enabled).toBe(false);
    const first = result.current;
    rerender({ enabled: true });
    expect(result.current).not.toBe(first);
    expect(result.current.enabled).toBe(true);
  });

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
    // (Same-props identity stability is pinned separately by the rebuild test above.)
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

  it("rebuilds only the changed member and exposes normalized slices", () => {
    const listData = { peggedAssets: [] };
    const pegError = new Error("peg down");
    const { result, rerender } = renderHook(
      (props: { updatedAt: number }) =>
        useQueryPair(
          makeQueryResult({ data: listData, dataUpdatedAt: props.updatedAt }),
          makeQueryResult({ dataUpdatedAt: 20, error: pegError }),
        ),
      { initialProps: { updatedAt: 10 } },
    );

    const first = result.current;
    rerender({ updatedAt: 11 });

    expect(result.current).not.toBe(first);
    expect(result.current.list).not.toBe(first.list);
    expect(result.current.list.dataUpdatedAt).toBe(11);
    expect(result.current.list.data).toBe(listData);
    // The untouched member keeps its exact transported values across the rebuild.
    expect(result.current.peg.error).toBe(pegError);
    expect(result.current.peg.dataUpdatedAt).toBe(20);
    expect(result.current.peg.meta).toBeNull();
  });

  it("preserves committed group identities after abandoning a suspended transition", async () => {
    const onCommit = vi.fn<(group: NumberQueryPair) => void>();
    const onSuspend = vi.fn<() => void>();
    const view = (updatedAt: number, suspend = false) => (
      <Suspense fallback={<span>Loading</span>}>
        <SuspendedQueryPair updatedAt={updatedAt} suspend={suspend} onCommit={onCommit} onSuspend={onSuspend} />
      </Suspense>
    );
    const { rerender, unmount } = render(view(10));
    const first = onCommit.mock.calls[0][0];

    await act(async () => {
      startTransition(() => rerender(view(11, true)));
    });
    expect(onSuspend).toHaveBeenCalled();
    expect(onCommit).toHaveBeenCalledTimes(1);

    rerender(view(10));
    const resumed = onCommit.mock.calls[onCommit.mock.calls.length - 1][0];
    expect(resumed).toBe(first);
    expect(resumed.list).toBe(first.list);
    expect(resumed.peg).toBe(first.peg);
    rerender(view(10));
    expect(onCommit.mock.calls[onCommit.mock.calls.length - 1][0]).toBe(first);
    unmount();
  });
});
