// @vitest-environment jsdom

import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makePickerQueryData, mockSelectorOutput } from "./picker.test-support";

const { buildSelectorRowsMock, runSelectorMock, useStablecoinsMock } = vi.hoisted(() => ({
  buildSelectorRowsMock: vi.fn(),
  runSelectorMock: vi.fn(),
  useStablecoinsMock: vi.fn(),
}));

vi.mock("@/hooks/use-stablecoins", () => ({ useStablecoins: useStablecoinsMock }));

vi.mock("@shared/lib/selector", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("@shared/lib/selector/types");
  return {
    ...actual,
    runSelector: runSelectorMock,
    validateSelectorSnapshotResponse: vi.fn(() => ({ ok: false, error: "shape" })),
  };
});

vi.mock("@shared/lib/selector/data-adapter", () => ({ buildSelectorRows: buildSelectorRowsMock }));

vi.mock("@/hooks/api-hooks", () => Object.fromEntries(
  Object.entries(makePickerQueryData()).map(([name, hook]) => [name, vi.fn(hook)]),
));

const OUTPUT = mockSelectorOutput({ recommended: [] });
const INPUT = OUTPUT.input;

import { useSelector } from "@/hooks/use-selector";
import * as apiHooks from "@/hooks/api-hooks";
import { useReportCardsV9Table, usePegSummary } from "@/hooks/api-hooks";

describe("useSelector", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    buildSelectorRowsMock.mockReturnValue({
      rows: new Map(),
      timestamp: 1,
      datasetHash: "hash",
      methodologyVersions: OUTPUT.methodologyVersions,
    });
    runSelectorMock.mockReturnValue(OUTPUT);
  });
  it("keeps the first-step form independent of evaluation feeds and cached rankings", () => {
    useStablecoinsMock.mockReturnValue({ data: { peggedAssets: [] }, dataUpdatedAt: 1, error: null });
    const { result, rerender } = renderHook(
      ({ evaluating }) => useSelector(INPUT, null, evaluating),
      { initialProps: { evaluating: false } },
    );
    expect(useStablecoinsMock).toHaveBeenLastCalledWith({ enabled: false });
    expect(useReportCardsV9Table).toHaveBeenLastCalledWith({ enabled: false });
    expect(usePegSummary).toHaveBeenLastCalledWith({ enabled: false });
    expect(runSelectorMock).not.toHaveBeenCalled();
    expect(result.current).toEqual({ status: "loading" });
    rerender({ evaluating: true });
    expect(useReportCardsV9Table).toHaveBeenLastCalledWith({ enabled: true });
    expect(result.current).toEqual({ status: "ready", output: OUTPUT });
  });

  it("reuses the universe and hash for answer-only edits but rebuilds for a different peg or source", () => {
    useStablecoinsMock.mockReturnValue({ data: { peggedAssets: [] }, dataUpdatedAt: 1, error: null });
    const queries = makePickerQueryData();
    const names = ["usePegSummary", "useReportCardsV9Table", "useStressSignals", "useDexLiquidity",
      "useYieldRankings", "useBluechipRatings", "useRedemptionBackstops"] as const;
    for (const name of names) {
      vi.mocked(apiHooks[name]).mockReturnValue(queries[name]() as never);
    }
    const { rerender } = renderHook(
      ({ input }) => useSelector(input, null),
      { initialProps: { input: INPUT } },
    );
    expect(buildSelectorRowsMock).toHaveBeenCalledTimes(1);
    rerender({ input: { ...INPUT, horizon: "1to6m" } });
    expect(runSelectorMock).toHaveBeenCalledTimes(2);
    expect(buildSelectorRowsMock).toHaveBeenCalledTimes(1);
    rerender({ input: { ...INPUT, pegCurrency: "EUR" } });
    expect(buildSelectorRowsMock).toHaveBeenCalledTimes(2);
    useStablecoinsMock.mockReturnValue({ data: { peggedAssets: [] }, dataUpdatedAt: 2, error: null });
    rerender({ input: { ...INPUT, pegCurrency: "EUR" } });
    expect(buildSelectorRowsMock).toHaveBeenCalledTimes(3);
  });


  it("reaches the existing error UI when a critical query rejects", () => {
    useStablecoinsMock.mockReturnValue({
      data: undefined,
      dataUpdatedAt: 0,
      isLoading: false,
      error: new Error("market list unavailable"),
    });

    const { result } = renderHook(() => useSelector(INPUT, null));

    expect(result.current).toEqual({ status: "error", reason: "selector-data-unavailable" });
  });

  it("builds V9 rows and returns the selector output once critical data is ready", () => {
    useStablecoinsMock.mockReturnValue({
      data: { peggedAssets: [] },
      dataUpdatedAt: 1,
      isLoading: false,
      error: null,
    });

    const { result } = renderHook(() => useSelector(INPUT, null));

    expect(result.current).toEqual({ status: "ready", output: OUTPUT });
  });
});
