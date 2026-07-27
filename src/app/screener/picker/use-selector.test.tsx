// @vitest-environment jsdom

import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SelectorInput } from "@shared/lib/selector";

const { buildSelectorRowsMock, runSelectorMock, useStablecoinsMock } = vi.hoisted(() => ({
  buildSelectorRowsMock: vi.fn(),
  runSelectorMock: vi.fn(),
  useStablecoinsMock: vi.fn(),
}));

vi.mock("@shared/lib/selector", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@shared/lib/selector")>()),
  runSelector: runSelectorMock,
}));

vi.mock("./selector-data-adapter", () => ({ buildSelectorRows: buildSelectorRowsMock }));

vi.mock("@/hooks/use-stablecoins", () => ({ useStablecoins: useStablecoinsMock }));

vi.mock("@/hooks/api-hooks", () => ({
  usePegSummary: () => ({ data: { coins: [] }, dataUpdatedAt: 1, error: null }),
  useReportCardsV9: () => ({ data: { cards: [] }, dataUpdatedAt: 1, error: null }),
  useStressSignals: () => ({ data: { signals: {} }, dataUpdatedAt: 1, error: null }),
  useDexLiquidity: () => ({ data: {}, dataUpdatedAt: 1, error: null }),
  useYieldRankings: () => ({ data: { rankings: [] }, dataUpdatedAt: 1, error: null }),
  useBluechipRatings: () => ({ data: {}, dataUpdatedAt: 1, error: null }),
  useRedemptionBackstops: () => ({ data: { coins: {} }, dataUpdatedAt: 1, error: null }),
}));

const INPUT = {
  profile: "treasury",
  pegCurrency: "USD",
} as SelectorInput;

import { useSelector } from "./use-selector";

describe("useSelector", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
    expect(buildSelectorRowsMock).not.toHaveBeenCalled();
    expect(runSelectorMock).not.toHaveBeenCalled();
  });

  it("fails closed without V8 recomputation while V9 recommendation thresholds are unreviewed", () => {
    useStablecoinsMock.mockReturnValue({
      data: { peggedAssets: [] },
      dataUpdatedAt: 1,
      isLoading: false,
      error: null,
    });

    const { result } = renderHook(() => useSelector(INPUT, null));

    expect(result.current).toEqual({ status: "error", reason: "v9-selector-thresholds-unreviewed" });
    expect(buildSelectorRowsMock).not.toHaveBeenCalled();
    expect(runSelectorMock).not.toHaveBeenCalled();
  });
});
