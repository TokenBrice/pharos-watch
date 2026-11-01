// @vitest-environment jsdom

import { act, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StabilityIndexClient } from "./client";

let stabilityState: {
  data: {
    current: Record<string, unknown> | null;
    history: Array<Record<string, unknown>>;
    methodology: Record<string, unknown>;
    headlineAggregates?: { computedAt: number; generatedAt: number; daysInBand: number; eventScores: { date: number; score: number | null }[] };
  } | undefined;
  isLoading: boolean;
  isError: boolean;
  error: Error | null;
  dataUpdatedAt: number;
  meta: Record<string, unknown>;
} = {
  data: undefined,
  isLoading: false,
  isError: false,
  error: null,
  dataUpdatedAt: 0,
  meta: {},
};

const refetch = vi.fn();
const fullHistoryQuery = vi.fn();
let cachedFullHistoryData: typeof stabilityState.data;

vi.mock("@/hooks/api-hooks", () => ({
  useStabilityIndexDetail: () => ({
    ...stabilityState,
    refetch,
  }),
  useStabilityIndexFullHistory: (options?: { enabled?: boolean }) => {
    fullHistoryQuery(options);
    if (options?.enabled !== false && stabilityState.data) {
      cachedFullHistoryData = {
        ...stabilityState.data,
        history: [
          ...stabilityState.data.history,
          { date: 1_600_000_000, score: 30, band: "CRISIS" },
        ],
      };
    }
    return {
      ...stabilityState,
      // A disabled full-history query never carries the detail query's error.
      error: options?.enabled === false ? null : stabilityState.error,
      // Query-core keeps serving a disabled query's cached entry.
      data: cachedFullHistoryData,
      refetch,
    };
  },
}));

vi.mock("@/hooks/use-time-range-filter", () => ({
  useTimeRangeFilter: <T,>(data: T[]) => ({
    range: "30d",
    setRange: vi.fn(),
    filteredData: data,
    options: [{ value: "30d", label: "30d" }],
  }),
}));

vi.mock("@/lib/logos", () => ({
  logosById: { "usdc-circle": "/usdc.svg" },
}));

vi.mock("@/components/chart-primitives/axes", () => ({
  DateTooltip: () => null,
  MonoYAxis: () => null,
  TimeGrid: () => null,
  TimeXAxis: () => null,
}));

vi.mock("recharts", () => ({
  ResponsiveContainer: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  AreaChart: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Area: () => <div />,
  YAxis: () => null,
}));

vi.mock("@/components/psi-history-chart", () => ({
  ScoreChart: ({ data, initialRange, onRangeChange }: {
    data: unknown[];
    initialRange?: string;
    onRangeChange?: (range: string) => void;
  }) => (
    <div>
      <span>score-chart-{data.length}</span>
      <span>initial-range-{initialRange}</span>
      <button onClick={() => onRangeChange?.("all")}>All history</button>
      <button onClick={() => onRangeChange?.("30d")}>Recent history</button>
    </div>
  ),
  BAND_ZONES: [
    { y1: 90, label: "BEDROCK" },
    { y1: 75, label: "STEADY" },
    { y1: 60, label: "TREMOR" },
    { y1: 40, label: "FRACTURE" },
    { y1: 20, label: "CRISIS" },
    { y1: 0, label: "MELTDOWN" },
  ],
  PSI_EVENTS: [
    {
      label: "Silicon Valley Bank",
      date: Date.parse("2023-03-12T00:00:00Z"),
      links: [{ title: "Coverage", url: "https://example.com/svb" }],
    },
  ],
}));

vi.mock("@/components/stale-data-banner", () => ({
  StaleDataBanner: ({ queries }: { queries: { hasData?: boolean; error?: unknown; meta?: { updatedAt?: number } }[] }) => (
    <div
      data-testid="psi-stale-banner"
      data-has-data={String(queries[0]?.hasData)}
      data-error={String(!!queries[0]?.error)}
      data-updated-at={String(queries[0]?.meta?.updatedAt)}
    />
  ),
}));

vi.mock("@/components/query-error-notice", () => ({
  QueryErrorNotice: ({ error, hasData }: { error?: Error | null; hasData?: boolean }) =>
    error && !hasData ? <div role="alert">{error.message}</div> : null,
}));

vi.mock("@/components/stablecoin-logo", () => ({
  StablecoinLogo: ({ name }: { name: string }) => <span>{name}</span>,
}));

vi.mock("@/components/time-range-buttons", () => ({
  TimeRangeButtons: () => <div>time-range-buttons</div>,
}));

vi.mock("@/components/methodology-hint", () => ({
  MethodologyLabel: ({ children }: { children: ReactNode }) => <>{children}</>,
  MethodologyTriggerButton: ({ children }: { children?: ReactNode }) => <>{children}</>,
}));

vi.mock("@/lib/analytics", () => ({
  trackEvent: vi.fn(),
}));

describe("StabilityIndexClient", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("keeps offscreen history behind its reserved viewport gate without delaying headline statistics", () => {
    vi.stubGlobal("IntersectionObserver", class {
      observe() {}
      disconnect() {}
      unobserve() {}
    });
    const { container } = render(<StabilityIndexClient />);
    expect(screen.queryByText("score-chart-3")).toBeNull();
    expect(screen.getAllByText("89.4").length).toBeGreaterThan(0);
    expect(screen.getAllByText("30d high").length).toBeGreaterThan(0);
    expect(container.querySelector('[aria-label="PSI history"] > div')?.getAttribute("style")).toContain("min-height: 450px");
    expect(fullHistoryQuery).not.toHaveBeenCalled();
  });

  it("keeps chart mounting bounded and expands only after selecting All", () => {
    vi.stubGlobal("IntersectionObserver", class {
      observe() {}
      disconnect() {}
      unobserve() {}
    });
    const { container } = render(<StabilityIndexClient />);
    const gate = container.querySelector('[aria-label="PSI history"] > div')!;
    act(() => gate.dispatchEvent(new Event("pharos:lazy-section-reveal")));
    expect(screen.getByText("initial-range-1y")).toBeTruthy();
    expect(fullHistoryQuery.mock.calls.every(([options]) => options?.enabled === false)).toBe(true);
    expect(screen.getByText("score-chart-3")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "All history" }));
    expect(fullHistoryQuery).toHaveBeenLastCalledWith({ enabled: true });
    expect(screen.getByText("score-chart-4")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Recent history" }));
    expect(fullHistoryQuery).toHaveBeenLastCalledWith({ enabled: false });
    expect(screen.getByText("score-chart-3")).toBeTruthy();
    expect(screen.queryByText("score-chart-4")).toBeNull();
  });

  it("renders the authoritative streak instead of recounting bounded history", () => {
    stabilityState.data!.headlineAggregates!.daysInBand = 801;
    render(<StabilityIndexClient />);
    expect(screen.getByText("801 days in STEADY")).toBeTruthy();
  });

  it("refuses a streak from another current generation", () => {
    stabilityState.data!.headlineAggregates!.computedAt -= 1;
    render(<StabilityIndexClient />);
    expect(screen.getByRole("alert").textContent).toContain("temporarily unavailable");
    expect(screen.queryByTestId("psi-beacon")).toBeNull();
  });

  beforeEach(() => {
    refetch.mockReset();
    fullHistoryQuery.mockReset();
    cachedFullHistoryData = undefined;
    stabilityState = {
      data: {
        current: {
          score: 92.2,
          band: "BEDROCK",
          avg24h: 89.4,
          avg24hBand: "STEADY",
          components: { severity: 10, breadth: 5, stressBreadth: 2, trend: 4 },
          contributors: [
            { id: "usdc-circle", symbol: "USDC", bps: -120, mcapUsd: 60_000_000_000, ageDays: 3, factor: 1 },
          ],
          totalMcapUsd: 60_000_000_000,
          computedAt: 1_710_000_000,
          methodologyVersion: "1.0",
        },
        history: [
          { date: 1_709_913_600, score: 80, band: "STEADY", components: { severity: 9, breadth: 4, stressBreadth: 2, trend: 4 }, methodologyVersion: "1.0" },
          { date: 1_709_827_200, score: 76, band: "STEADY", components: { severity: 8, breadth: 4, stressBreadth: 1, trend: 4 }, methodologyVersion: "1.0" },
        ],
        headlineAggregates: { computedAt: 1_710_000_000, generatedAt: 1_710_000_000, daysInBand: 3, eventScores: [] },
        methodology: {
          versionLabel: "v1.0",
          currentVersionLabel: "v1.0",
          changelogPath: "/methodology/stability-index-changelog/",
          isCurrent: true,
        },
      },
      isLoading: false,
      isError: false,
      error: null,
      dataUpdatedAt: Date.now(),
      meta: {},
    };
  });


  it("renders the current PSI state, contributors, and methodology section", () => {
    render(<StabilityIndexClient />);

    expect(screen.getAllByText("89.4").length).toBeGreaterThan(0);
    expect(screen.getAllByText("rolling 24h avg").length).toBeGreaterThan(0);
    expect(screen.getAllByText("STEADY").length).toBeGreaterThan(0);
    expect(screen.getByText("Top contributors")).toBeTruthy();
    expect(screen.getAllByText("USDC").length).toBeGreaterThan(0);
    const contributorsTable = screen.getByRole("table", {
      name: "Stablecoins currently contributing to PSI score reduction",
    });
    expect(contributorsTable).toBeTruthy();
    expect(contributorsTable.parentElement?.getAttribute("data-slot")).toBe("table-viewport");
    const contributorsShell = screen.getByTestId("stability-index-top-contributors-table");
    expect(contributorsShell.getAttribute("data-table-id")).toBe("stability-index-top-contributors");
    expect(contributorsShell.className).toContain("pharos-density-compact");
    expect(screen.getByText("Methodology")).toBeTruthy();
    expect(screen.getByText("score-chart-3")).toBeTruthy();
  });

  it("draws the beacon lit when the sample is fresh", () => {
    const nowSec = Math.floor(Date.now() / 1000);
    stabilityState.data!.current!.computedAt = nowSec;
    stabilityState.data!.headlineAggregates!.computedAt = nowSec;
    stabilityState.meta = { updatedAt: nowSec, ageSeconds: 0, status: "fresh" };
    render(<StabilityIndexClient />);

    const beacon = screen.getByTestId("psi-beacon");
    expect(beacon.dataset.state).toBe("current");
    expect(beacon.dataset.paint).toBe("lit");
  });

  it("draws a retained beacon without band hue when the sample is stale", () => {
    const nowSec = Math.floor(Date.now() / 1000);
    stabilityState.data!.current!.computedAt = nowSec - 8 * 3600;
    stabilityState.data!.headlineAggregates!.computedAt = nowSec - 8 * 3600;
    stabilityState.meta = { updatedAt: nowSec - 8 * 3600, ageSeconds: 8 * 3600, status: "stale" };
    render(<StabilityIndexClient />);

    const beacon = screen.getByTestId("psi-beacon");
    expect(beacon.dataset.state).toBe("retained");
    expect(beacon.dataset.paint).toBe("outline");
    expect(beacon.querySelector("svg[role='img']")?.getAttribute("aria-label")).toMatch(/^Retained observation as of /);
  });

  it("keeps a retained coherent generation through a failed refetch and recovers", () => {
    const meta = { updatedAt: 1_710_000_000, ageSeconds: 60, status: "fresh" };
    stabilityState.meta = meta;
    const view = render(<StabilityIndexClient />);
    expect(screen.getAllByText("89.4").length).toBeGreaterThan(0);

    stabilityState = { ...stabilityState, isError: true, error: new Error("psi down") };
    view.rerender(<StabilityIndexClient />);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getAllByText("89.4").length).toBeGreaterThan(0);
    expect(screen.getByText("Top contributors")).toBeTruthy();
    expect(screen.getByText("score-chart-3")).toBeTruthy();
    const banner = screen.getByTestId("psi-stale-banner");
    // The shared banner owns material-age warnings; the producer clock is unchanged.
    expect(banner.dataset.hasData).toBe("true");
    expect(banner.dataset.error).toBe("true");
    expect(banner.dataset.updatedAt).toBe("1710000000");

    stabilityState = { ...stabilityState, isError: false, error: null };
    view.rerender(<StabilityIndexClient />);
    expect(screen.getByTestId("psi-stale-banner").dataset.error).toBe("false");
    expect(screen.getAllByText("89.4").length).toBeGreaterThan(0);
  });

  it("still withholds an incoherent retained generation during a failed refetch", () => {
    stabilityState.data!.headlineAggregates!.computedAt -= 1;
    stabilityState = { ...stabilityState, isError: true, error: new Error("psi down") };
    render(<StabilityIndexClient />);
    expect(screen.getByRole("alert").textContent).toContain("psi down");
    expect(screen.queryByTestId("psi-beacon")).toBeNull();
  });

  it("shows the query error notice when the PSI detail query fails without data", () => {
    stabilityState = {
      data: { current: null, history: [], methodology: { versionLabel: "v1.0", currentVersionLabel: "v1.0", changelogPath: "/methodology/stability-index-changelog/", isCurrent: true } },
      isLoading: false,
      isError: true,
      error: new Error("psi down"),
      dataUpdatedAt: 0,
      meta: {},
    };

    render(<StabilityIndexClient />);

    expect(screen.getByRole("alert").textContent).toContain("psi down");
  });
});
