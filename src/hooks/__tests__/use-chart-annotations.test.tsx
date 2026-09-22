// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TapeEvent } from "@shared/types/tape-event";

const {
  useInfiniteQueryMock,
  apiFetchWithMetaMock,
  isChartAnnotationsEnabledMock,
  getCuratedAnnotationsMock,
} = vi.hoisted(() => ({
  useInfiniteQueryMock: vi.fn(),
  apiFetchWithMetaMock: vi.fn(),
  isChartAnnotationsEnabledMock: vi.fn(),
  getCuratedAnnotationsMock: vi.fn(),
}));

vi.mock("@tanstack/react-query", () => ({
  infiniteQueryOptions: (options: unknown) => options,
  keepPreviousData: Symbol("keepPreviousData"),
  useQuery: vi.fn(),
  useInfiniteQuery: useInfiniteQueryMock,
}));

vi.mock("@/lib/api", () => ({
  apiFetch: vi.fn(),
  apiFetchWithMeta: apiFetchWithMetaMock,
}));

vi.mock("@/lib/feature-flags", () => ({
  isChartAnnotationsEnabled: isChartAnnotationsEnabledMock,
}));

vi.mock("@shared/data/annotations/curated-annotations", () => ({
  getCuratedAnnotations: getCuratedAnnotationsMock,
}));

import { CRON_TAPE } from "@/lib/cron-intervals";
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

function queryResult(
  events: TapeEvent[],
  overrides: Record<string, unknown> = {},
  nextCursor: string | null = null,
) {
  return {
    data: {
      pages: [{
        data: {
          events,
          nextCursor,
          total: events.length,
          totalExact: true,
        },
        meta: null,
      }],
    },
    error: null,
    fetchNextPage: vi.fn(async () => undefined),
    hasNextPage: nextCursor !== null,
    isFetchingNextPage: false,
    isLoading: false,
    ...overrides,
  };
}

function pagedQueryResult(
  pages: Array<{ events: TapeEvent[]; nextCursor: string | null }>,
  overrides: Record<string, unknown> = {},
) {
  return {
    data: {
      pages: pages.map((page) => ({
        data: {
          ...page,
          total: null,
          totalExact: false,
        },
        meta: null,
      })),
    },
    error: null,
    fetchNextPage: vi.fn(async () => undefined),
    hasNextPage: pages.at(-1)?.nextCursor != null,
    isFetchingNextPage: false,
    isLoading: false,
    ...overrides,
  };
}

describe("useChartAnnotations", () => {
  beforeEach(() => {
    useInfiniteQueryMock.mockReset();
    apiFetchWithMetaMock.mockReset();
    isChartAnnotationsEnabledMock.mockReset();
    getCuratedAnnotationsMock.mockReset();
    isChartAnnotationsEnabledMock.mockReturnValue(true);
    useInfiniteQueryMock.mockReturnValue(queryResult([]));
    getCuratedAnnotationsMock.mockReturnValue([]);
  });

  it("returns empty + suspends the query when the flag is off", () => {
    isChartAnnotationsEnabledMock.mockReturnValue(false);
    getCuratedAnnotationsMock.mockReturnValue([
      { ts: Date.UTC(2023, 2, 11), kind: "depeg", label: "curated", severity: "high" },
    ]);

    const { result } = renderHook(() =>
      useChartAnnotations("usdc-circle", Date.UTC(2023, 0, 1), Date.UTC(2023, 5, 1)),
    );

    expect(result.current.data).toEqual([]);
    const opts = useInfiniteQueryMock.mock.calls.at(-1)?.[0] as { enabled: boolean };
    expect(opts.enabled).toBe(false);
  });

  it("returns empty when from/to are missing", () => {
    getCuratedAnnotationsMock.mockReturnValue([
      { ts: Date.UTC(2023, 2, 11), kind: "depeg", label: "curated", severity: "high" },
    ]);

    const { result } = renderHook(() =>
      useChartAnnotations("usdc-circle", null, null),
    );

    expect(result.current.data).toEqual([]);
  });

  it("uses the events producer polling interval for tape event annotations", () => {
    renderHook(() =>
      useChartAnnotations("usdc-circle", Date.UTC(2023, 0, 1), Date.UTC(2023, 5, 1)),
    );

    expect(useInfiniteQueryMock.mock.calls.at(-1)?.[0]?.staleTime).toBe(CRON_TAPE);
    expect(useInfiniteQueryMock.mock.calls.at(-1)?.[0]?.refetchInterval).toBe(2 * CRON_TAPE);
  });

  it("clamps curated annotations to the [fromMs, toMs] window", () => {
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

  it("uses a bucketed event query window across brush moves while preserving the raw display clamp", async () => {
    const bucketStart = 30 * DAY_MS * 650;
    const rawFrom = bucketStart + 5 * DAY_MS;
    const rawTo = bucketStart + 10 * DAY_MS;
    useInfiniteQueryMock.mockReturnValue(queryResult([
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
    ]));

    const { result, rerender } = renderHook(
      ({ from, to }) => useChartAnnotations("usdc-circle", from, to),
      { initialProps: { from: rawFrom, to: rawTo } },
    );

    expect(result.current.data.map((a) => a.label)).toEqual(["Inside raw window"]);
    const firstCall = useInfiniteQueryMock.mock.calls.at(-1);
    const firstKey = JSON.stringify(firstCall?.[0]?.queryKey);
    apiFetchWithMetaMock.mockResolvedValue({
      data: queryResult([]).data.pages[0].data,
      meta: null,
    });
    await firstCall?.[0]?.queryFn({ pageParam: "older-events" });
    const firstPath = apiFetchWithMetaMock.mock.calls.at(-1)?.[0] as string;
    const firstUrl = new URL(firstPath, "https://pharos.test");
    expect(firstUrl.searchParams.get("since")).toBe(String(bucketStart));
    expect(firstUrl.searchParams.get("until")).toBe(String(bucketStart + 30 * DAY_MS));
    expect(firstUrl.searchParams.get("severityFloor")).toBe("warning");
    expect(firstUrl.searchParams.getAll("type")).toEqual(["depeg.opened", "depeg.peak_worsened"]);
    expect(firstUrl.searchParams.getAll("class")).toEqual(["methodology"]);
    expect(firstUrl.searchParams.get("limit")).toBe("200");
    expect(firstUrl.searchParams.get("cursor")).toBe("older-events");

    rerender({ from: rawFrom + 60_000, to: rawTo + 60_000 });

    const secondCall = useInfiniteQueryMock.mock.calls.at(-1);
    expect(JSON.stringify(secondCall?.[0]?.queryKey)).toBe(firstKey);
    expect(result.current.data.map((a) => a.label)).toEqual(["Inside raw window"]);
  });

  it("merges a second cursor page so the oldest of 201 events is included", () => {
    const newest = Date.UTC(2025, 0, 1);
    const firstPage = Array.from({ length: 200 }, (_, index) =>
      tape({
        id: `event-${index}`,
        type: "depeg.opened",
        ts: newest - index * DAY_MS,
        title: `Event ${index}`,
      }),
    );
    const oldest = tape({
      id: "event-oldest",
      type: "depeg.opened",
      ts: newest - 200 * DAY_MS,
      title: "Oldest event",
    });
    useInfiniteQueryMock.mockReturnValue(pagedQueryResult([
      { events: firstPage, nextCursor: "page-2" },
      { events: [oldest], nextCursor: null },
    ]));

    const { result } = renderHook(() =>
      useChartAnnotations("usdc-circle", oldest.ts, newest),
    );

    expect(result.current.data).toHaveLength(201);
    expect(result.current.data[0]?.label).toBe("Oldest event");
    expect(result.current.isTruncated).toBe(false);
  });

  it("discloses truncation when the hard page cap is reached with a cursor remaining", () => {
    const fetchNextPage = vi.fn(async () => undefined);
    useInfiniteQueryMock.mockReturnValue(pagedQueryResult(
      Array.from({ length: 10 }, (_, index) => ({
        events: [],
        nextCursor: `page-${index + 2}`,
      })),
      { fetchNextPage, hasNextPage: true },
    ));

    const { result } = renderHook(() =>
      useChartAnnotations("usdc-circle", Date.UTC(2023, 0, 1), Date.UTC(2023, 5, 1)),
    );

    expect(result.current.isTruncated).toBe(true);
    expect(fetchNextPage).not.toHaveBeenCalled();
  });

  it("merges curated + tape sources and dedupes same-day same-kind (curated wins)", () => {
    useInfiniteQueryMock.mockReturnValue(queryResult([
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
    ]));
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
    useInfiniteQueryMock.mockReturnValue(queryResult([
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
    ]));

    const { result } = renderHook(() =>
      useChartAnnotations("usdt-tether", Date.UTC(2023, 0, 1), Date.UTC(2023, 5, 1)),
    );

    expect(result.current.data).toEqual([]);
  });

  it("ignores tape rows with unmapped event-type prefixes", () => {
    useInfiniteQueryMock.mockReturnValue(queryResult([
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
    ]));

    const { result } = renderHook(() =>
      useChartAnnotations("usdc-circle", Date.UTC(2023, 0, 1), Date.UTC(2023, 5, 1)),
    );

    expect(result.current.data).toEqual([]);
  });

  it("drops low-severity tape rows (info, notice) but keeps curated annotations", () => {
    useInfiniteQueryMock.mockReturnValue(queryResult([
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
    ]));
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
    useInfiniteQueryMock.mockReturnValue(queryResult([
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
    ]));

    const { result } = renderHook(() =>
      useChartAnnotations("usdc-circle", Date.UTC(2023, 0, 1), Date.UTC(2023, 5, 1)),
    );

    expect(result.current.data.map((a) => a.label)).toEqual(["Depeg opened (kept)"]);
  });

  it("keeps material depeg peak-worsened tape rows", () => {
    useInfiniteQueryMock.mockReturnValue(queryResult([
      tape({
        id: "tape-peak-worsened",
        type: "depeg.peak_worsened",
        severity: "critical",
        ts: Date.UTC(2023, 3, 11),
        title: "Active depeg widened",
        sourceUrl: "https://example.com/depeg-peak",
      }),
    ]));

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
    useInfiniteQueryMock.mockReturnValue(queryResult([
      tape({
        id: "tape-late",
        type: "depeg.opened",
        severity: "severe",
        ts: Date.UTC(2023, 4, 1),
        title: "Late tape",
      }),
    ]));
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
