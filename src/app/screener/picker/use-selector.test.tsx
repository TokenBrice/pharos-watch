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

vi.mock("@/hooks/api-hooks", () => makePickerQueryData());

const OUTPUT = mockSelectorOutput({ recommended: [] });
const INPUT = OUTPUT.input;

import { useSelector } from "@/hooks/use-selector";

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
  });
});
