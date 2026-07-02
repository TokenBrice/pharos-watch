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

const DAY_MS = 86_400_000;

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

  it("uses a bucketed event query window across brush moves while preserving the raw display clamp", () => {
    isChartAnnotationsEnabledMock.mockReturnValue(true);
    const bucketStart = 30 * DAY_MS * 650;
    const rawFrom = bucketStart + 5 * DAY_MS;
    const rawTo = bucketStart + 10 * DAY_MS;
    useApiQueryWithMetaMock.mockReturnValue({
      data: {
        events: [
          tape({
            id: "before-raw-window",
            type: "depeg.opened",
            severity: "warning",
            ts: rawFrom - DAY_MS,
            title: "Before raw window",
          }),
          tape({
            id: "inside-raw-window",
            type: "depeg.opened",
            severity: "warning",
            ts: rawFrom + DAY_MS,
            title: "Inside raw window",
          }),
          tape({
            id: "after-raw-window",
            type: "depeg.opened",
            severity: "warning",
            ts: rawTo + DAY_MS,
            title: "After raw window",
          }),
        ],
        nextCursor: null,
        total: 3,
        totalExact: true,
      },
      isLoading: false,
    });
    getCuratedAnnotationsMock.mockReturnValue([]);

    const { result, rerender } = renderHook(
      ({ from, to }) => useChartAnnotations("usdc-circle", from, to),
      { initialProps: { from: rawFrom, to: rawTo } },
    );

    expect(result.current.data.map((a) => a.label)).toEqual(["Inside raw window"]);
    const firstCall = useApiQueryWithMetaMock.mock.calls.at(-1);
    const firstKey = JSON.stringify(firstCall?.[0]);
    const firstPath = firstCall?.[1] as string;
    const firstUrl = new URL(firstPath, "https://pharos.test");
    expect(firstUrl.searchParams.get("since")).toBe(String(bucketStart));
    expect(firstUrl.searchParams.get("until")).toBe(String(bucketStart + 30 * DAY_MS));

    rerender({ from: rawFrom + 60_000, to: rawTo + 60_000 });

    const secondCall = useApiQueryWithMetaMock.mock.calls.at(-1);
    expect(JSON.stringify(secondCall?.[0])).toBe(firstKey);
    expect(secondCall?.[1]).toBe(firstPath);
    expect(result.current.data.map((a) => a.label)).toEqual(["Inside raw window"]);
  });

  it("merges curated + tape sources and dedupes same-day same-kind (curated wins)", () => {
    isChartAnnotationsEnabledMock.mockReturnValue(true);
    useApiQueryWithMetaMock.mockReturnValue({
      data: {
        events: [
          tape({
            id: "tape-depeg",
            type: "depeg.opened",
            severity: "critical",
            ts: Date.UTC(2023, 2, 11, 6, 30),
            title: "Tape depeg row",
            sourceUrl: "https://example.com/tape",
          }),
          tape({
            id: "tape-methodology",
            type: "methodology.bump",
            severity: "warning",
            ts: Date.UTC(2023, 3, 1),
            title: "Tape methodology bump",
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
    // High-signal tape kinds (methodology) map and survive
    expect(result.current.data[1]).toMatchObject({
      ts: Date.UTC(2023, 3, 1),
      kind: "methodology-change",
      label: "Tape methodology bump",
      severity: "med",
    });
  });

  it("drops mint_burn and freeze tape rows from chart annotations", () => {
    isChartAnnotationsEnabledMock.mockReturnValue(true);
    useApiQueryWithMetaMock.mockReturnValue({
      data: {
        events: [
          tape({
            id: "tape-mint",
            type: "mint_burn.usdt.spike",
            severity: "warning",
            ts: Date.UTC(2023, 3, 1),
            title: "Tape mint",
          }),
          tape({
            id: "tape-freeze",
            type: "freeze.usdt.surge",
            severity: "severe",
            ts: Date.UTC(2023, 3, 2),
            title: "Tape freeze",
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
      useChartAnnotations("usdt-tether", Date.UTC(2023, 0, 1), Date.UTC(2023, 5, 1)),
    );

    expect(result.current.data).toEqual([]);
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

  it("drops low-severity tape rows (info, notice) but keeps curated annotations", () => {
    isChartAnnotationsEnabledMock.mockReturnValue(true);
    useApiQueryWithMetaMock.mockReturnValue({
      data: {
        events: [
          tape({
            id: "tape-notice",
            type: "depeg.opened",
            severity: "notice",
            ts: Date.UTC(2023, 2, 11),
            title: "Threshold-skimming depeg",
          }),
          tape({
            id: "tape-info",
            type: "depeg.opened",
            severity: "info",
            ts: Date.UTC(2023, 2, 12),
            title: "Info depeg",
          }),
          tape({
            id: "tape-warn",
            type: "depeg.opened",
            severity: "warning",
            ts: Date.UTC(2023, 2, 13),
            title: "Real depeg",
          }),
        ],
        nextCursor: null,
        total: 3,
        totalExact: true,
      },
      isLoading: false,
    });
    getCuratedAnnotationsMock.mockReturnValue([
      {
        ts: Date.UTC(2023, 2, 10),
        kind: "depeg",
        label: "Curated low-severity row survives",
        severity: "low",
      },
    ]);

    const { result } = renderHook(() =>
      useChartAnnotations("usdc-circle", Date.UTC(2023, 0, 1), Date.UTC(2023, 5, 1)),
    );

    expect(result.current.data.map((a) => a.label)).toEqual([
      "Curated low-severity row survives",
      "Real depeg",
    ]);
  });

  it("drops depeg.resolved tape rows even when severity passes the filter", () => {
    isChartAnnotationsEnabledMock.mockReturnValue(true);
    useApiQueryWithMetaMock.mockReturnValue({
      data: {
        events: [
          tape({
            id: "tape-resolved",
            type: "depeg.resolved",
            severity: "warning",
            ts: Date.UTC(2023, 2, 11),
            title: "Depeg resolved (should be dropped)",
          }),
          tape({
            id: "tape-opened",
            type: "depeg.opened",
            severity: "warning",
            ts: Date.UTC(2023, 2, 12),
            title: "Depeg opened (kept)",
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

    expect(result.current.data.map((a) => a.label)).toEqual(["Depeg opened (kept)"]);
  });

  it("keeps material depeg peak-worsened tape rows", () => {
    isChartAnnotationsEnabledMock.mockReturnValue(true);
    useApiQueryWithMetaMock.mockReturnValue({
      data: {
        events: [
          tape({
            id: "tape-peak-worsened",
            type: "depeg.peak_worsened",
            severity: "critical",
            ts: Date.UTC(2023, 3, 11),
            title: "Active depeg widened",
            sourceUrl: "https://example.com/depeg-peak",
          }),
        ],
        nextCursor: null,
        total: 1,
        totalExact: true,
      },
      isLoading: false,
    });
    getCuratedAnnotationsMock.mockReturnValue([]);

    const { result } = renderHook(() =>
      useChartAnnotations("test-coin", Date.UTC(2023, 0, 1), Date.UTC(2023, 5, 1)),
    );

    expect(result.current.data).toEqual([
      {
        ts: Date.UTC(2023, 3, 11),
        kind: "depeg",
        label: "Active depeg widened",
        severity: "high",
        href: "https://example.com/depeg-peak",
      },
    ]);
  });

  it("sorts merged output by timestamp ascending", () => {
    isChartAnnotationsEnabledMock.mockReturnValue(true);
    useApiQueryWithMetaMock.mockReturnValue({
      data: {
        events: [
          tape({
            id: "tape-late",
            type: "depeg.opened",
            severity: "severe",
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
