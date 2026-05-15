// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TapeEvent } from "@shared/types/tape-event";

const {
  useApiQueryWithMetaMock,
  isChartAnnotationsEnabledMock,
  getCuratedAnnotationsMock,
} = vi.hoisted(() => ({
  useApiQueryWithMetaMock: vi.fn(),
  isChartAnnotationsEnabledMock: vi.fn(),
  getCuratedAnnotationsMock: vi.fn(),
}));

vi.mock("../use-api-query", () => ({
  useApiQueryWithMeta: useApiQueryWithMetaMock,
}));

vi.mock("@/lib/feature-flags", () => ({
  isChartAnnotationsEnabled: isChartAnnotationsEnabledMock,
}));

vi.mock("@shared/data/annotations/curated-annotations", () => ({
  getCuratedAnnotations: getCuratedAnnotationsMock,
}));

import { useChartAnnotations } from "../use-chart-annotations";

function tape(partial: Partial<TapeEvent> & Pick<TapeEvent, "id" | "type" | "ts" | "title">): TapeEvent {
  return {
    severity: "warning",
    endsAt: null,
    coinId: null,
    issuerId: null,
    pegCurrency: null,
    chain: null,
    summary: "",
    payload: {},
    sourceTable: "test",
    sourceRowId: "test",
    transition: "snapshot",
    sourceUrl: null,
    methodologyVersion: null,
    ...partial,
  };
}

describe("useChartAnnotations", () => {
  beforeEach(() => {
    useApiQueryWithMetaMock.mockReset();
    isChartAnnotationsEnabledMock.mockReset();
    getCuratedAnnotationsMock.mockReset();
  });

  it("returns empty + suspends the query when the flag is off", () => {
    isChartAnnotationsEnabledMock.mockReturnValue(false);
    useApiQueryWithMetaMock.mockReturnValue({ data: undefined, isLoading: false });
    getCuratedAnnotationsMock.mockReturnValue([
      { ts: Date.UTC(2023, 2, 11), kind: "depeg", label: "curated", severity: "high" },
    ]);

    const { result } = renderHook(() =>
      useChartAnnotations("usdc-circle", Date.UTC(2023, 0, 1), Date.UTC(2023, 5, 1)),
    );

    expect(result.current.data).toEqual([]);
    const opts = useApiQueryWithMetaMock.mock.calls.at(-1)?.[3] as { enabled: boolean };
    expect(opts.enabled).toBe(false);
  });

  it("returns empty when from/to are missing", () => {
    isChartAnnotationsEnabledMock.mockReturnValue(true);
    useApiQueryWithMetaMock.mockReturnValue({ data: undefined, isLoading: false });
    getCuratedAnnotationsMock.mockReturnValue([
      { ts: Date.UTC(2023, 2, 11), kind: "depeg", label: "curated", severity: "high" },
    ]);

    const { result } = renderHook(() =>
      useChartAnnotations("usdc-circle", null, null),
    );

    expect(result.current.data).toEqual([]);
  });

  it("clamps curated annotations to the [fromMs, toMs] window", () => {
    isChartAnnotationsEnabledMock.mockReturnValue(true);
    useApiQueryWithMetaMock.mockReturnValue({ data: undefined, isLoading: false });
    getCuratedAnnotationsMock.mockReturnValue([
      { ts: Date.UTC(2022, 11, 31), kind: "depeg", label: "before", severity: "low" },
      { ts: Date.UTC(2023, 2, 11), kind: "depeg", label: "in range", severity: "high" },
      { ts: Date.UTC(2023, 11, 31), kind: "depeg", label: "after", severity: "low" },
    ]);

    const { result } = renderHook(() =>
      useChartAnnotations("usdc-circle", Date.UTC(2023, 0, 1), Date.UTC(2023, 5, 1)),
    );

    expect(result.current.data.map((a) => a.label)).toEqual(["in range"]);
  });

  it("merges curated + tape sources and dedupes same-day same-kind (curated wins)", () => {
    isChartAnnotationsEnabledMock.mockReturnValue(true);
    useApiQueryWithMetaMock.mockReturnValue({
      data: {
        events: [
          tape({
            id: "tape-depeg",
            type: "depeg.usdc.svb",
            severity: "critical",
            ts: Date.UTC(2023, 2, 11, 6, 30),
            title: "Tape depeg row",
            sourceUrl: "https://example.com/tape",
          }),
          tape({
            id: "tape-mint",
            type: "mint_burn.usdc.spike",
            severity: "warning",
            ts: Date.UTC(2023, 3, 1),
            title: "Tape mint-burn",
          }),
        ],
        nextCursor: null,
        total: 2,
        totalExact: true,
      },
      isLoading: false,
    });
    getCuratedAnnotationsMock.mockReturnValue([
      {
        ts: Date.UTC(2023, 2, 11),
        kind: "depeg",
        label: "Curated depeg",
        severity: "high",
      },
    ]);

    const { result } = renderHook(() =>
      useChartAnnotations("usdc-circle", Date.UTC(2023, 0, 1), Date.UTC(2023, 5, 1)),
    );

    expect(result.current.data).toHaveLength(2);
    // Curated wins same-day same-kind
    expect(result.current.data[0]).toMatchObject({
      ts: Date.UTC(2023, 2, 11),
      kind: "depeg",
      label: "Curated depeg",
    });
    // Tape mint-burn maps and survives
    expect(result.current.data[1]).toMatchObject({
      ts: Date.UTC(2023, 3, 1),
      kind: "mint-burn-spike",
      label: "Tape mint-burn",
      severity: "med",
    });
  });

  it("ignores tape rows with unmapped event-type prefixes", () => {
    isChartAnnotationsEnabledMock.mockReturnValue(true);
    useApiQueryWithMetaMock.mockReturnValue({
      data: {
        events: [
          tape({
            id: "psi-1",
            type: "score.psi.drop",
            ts: Date.UTC(2023, 2, 11),
            title: "PSI drop",
          }),
          tape({
            id: "yield-1",
            type: "yield.spike",
            ts: Date.UTC(2023, 2, 12),
            title: "Yield spike",
          }),
        ],
        nextCursor: null,
        total: 2,
        totalExact: true,
      },
      isLoading: false,
    });
    getCuratedAnnotationsMock.mockReturnValue([]);

    const { result } = renderHook(() =>
      useChartAnnotations("usdc-circle", Date.UTC(2023, 0, 1), Date.UTC(2023, 5, 1)),
    );

    expect(result.current.data).toEqual([]);
  });

  it("sorts merged output by timestamp ascending", () => {
    isChartAnnotationsEnabledMock.mockReturnValue(true);
    useApiQueryWithMetaMock.mockReturnValue({
      data: {
        events: [
          tape({
            id: "tape-late",
            type: "depeg.test",
            ts: Date.UTC(2023, 4, 1),
            title: "Late tape",
          }),
        ],
        nextCursor: null,
        total: 1,
        totalExact: true,
      },
      isLoading: false,
    });
    getCuratedAnnotationsMock.mockReturnValue([
      { ts: Date.UTC(2023, 1, 1), kind: "governance", label: "Early curated", severity: "med" },
      { ts: Date.UTC(2023, 3, 1), kind: "regulatory", label: "Mid curated", severity: "med" },
    ]);

    const { result } = renderHook(() =>
      useChartAnnotations("usdc-circle", Date.UTC(2023, 0, 1), Date.UTC(2023, 5, 1)),
    );

    expect(result.current.data.map((a) => a.label)).toEqual([
      "Early curated",
      "Mid curated",
      "Late tape",
    ]);
  });
});
