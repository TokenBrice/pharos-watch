// @vitest-environment jsdom

import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SelectorInput, SelectorOutput } from "@shared/lib/selector";

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

vi.mock("./selector-data-adapter", () => ({ buildSelectorRows: buildSelectorRowsMock }));

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

const OUTPUT = {
  profile: "treasury",
  input: INPUT,
  universe: { active: 1, surviving: 1 },
  recommended: [],
  lowerRanked: [],
  coverageWarnings: {
    skippedForCoverageCount: 0,
    skippedForCoverage: [],
    sparse: false,
    uneven: false,
    newListingCount: 0,
    redistributionCount: 0,
  },
  lowConfidence: false,
  usedRelaxedFallback: false,
  relaxedReasons: [],
  exclusionSummary: [],
  closestSurvivors: [],
  relaxableConstraints: [],
  timestamp: 1,
  engineVersion: "selector-v1.91",
  methodologyVersions: {
    safetyScore: "v9",
    pegScoreAndDews: "v3",
    yieldIntelligence: "v8",
    bluechipAlignment: "unversioned",
    exclusionFilters: "selector-v1.91",
  },
  datasetHash: "hash",
} satisfies SelectorOutput;

import { useSelector } from "./use-selector";

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
    expect(buildSelectorRowsMock).toHaveBeenCalledWith(expect.objectContaining({
      pegCurrency: "USD",
      reportData: { cards: [] },
      stablecoinsData: { peggedAssets: [] },
    }));
    expect(runSelectorMock).toHaveBeenCalledWith(
      INPUT,
      { rows: expect.any(Map) },
      {
        timestamp: 1,
        datasetHash: "hash",
        methodologyVersions: OUTPUT.methodologyVersions,
      },
    );
  });
});
