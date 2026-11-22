// @vitest-environment jsdom

import { act, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StabilityIndexClient } from "./client";
import { downloadChartPng } from "@/lib/chart-export";

vi.mock("@/lib/chart-export", () => ({ downloadChartPng: vi.fn() }));

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
};

const refetch = vi.fn();
const fullHistoryQuery = vi.fn();
let reducedMotion = false;
let area: { isAnimationActive?: boolean; animationDuration?: number; onAnimationEnd?: () => void };
vi.mock("@/hooks/use-prefers-reduced-motion", () => ({
  usePrefersReducedMotion: (options: unknown) => {
    expect(options).toEqual({ ssrDefault: true });
    return reducedMotion;
  },
}));
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

const useTimeRangeFilterSpy = vi.fn();

vi.mock("@/hooks/use-time-range-filter", () => ({
  useTimeRangeFilter: <T,>(data: T[], tsKey?: string, options?: unknown, config?: unknown) => {
    useTimeRangeFilterSpy(tsKey, options, config);
    return {
      range: "30d",
      setRange: vi.fn(),
      filteredData: data,
      options: [{ value: "30d", label: "30d" }],
    };
  },
}));

vi.mock("@/lib/logos", () => ({
  logosById: { "usdc-circle": "/usdc.svg" },
}));

vi.mock("@/components/chart-primitives/axes", () => ({
  useSvgId: () => "psi-score",
  ChartAreaGradient: () => null,
  DateTooltip: () => null,
  MonoYAxis: () => null,
  TimeGrid: () => null,
  TimeXAxis: () => null,
}));

vi.mock("recharts", () => ({
  ResponsiveContainer: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  AreaChart: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Area: (props: typeof area) => { if (props.onAnimationEnd) area = props; return <div />; },
  YAxis: () => null,
}));

vi.mock("@/components/psi-beacon/psi-history-chart", () => ({
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

function keepHistoryOffscreen() {
  vi.stubGlobal("IntersectionObserver", class {
    observe() {}
    disconnect() {}
    unobserve() {}
  });
}

describe("StabilityIndexClient", () => {
  afterEach(() => vi.unstubAllGlobals());

  it.each([false, true])("serializes PNG captures and allows retry after success=%s", async (success) => {
    const { ScoreChart } = await vi.importActual<typeof import("@/components/psi-beacon/psi-history-chart")>("@/components/psi-beacon/psi-history-chart");
    let finish!: (success: boolean) => void;
    vi.mocked(downloadChartPng).mockReset().mockReturnValue(new Promise<boolean>((resolve) => {
      finish = resolve;
    }));
    render(<ScoreChart data={[{ ts: 1_710_000_000, score: 80 }]} />);
    const button = screen.getByRole("button", { name: "Save chart as PNG" }) as HTMLButtonElement;
    button.focus();
    await act(async () => { fireEvent.click(button); fireEvent.click(button); });
    expect(downloadChartPng).toHaveBeenCalledTimes(1);
    expect(button.disabled).toBe(false);
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(document.activeElement).toBe(button);
    await act(async () => finish(success));
    expect(button.getAttribute("aria-disabled")).toBe("false");
    expect(document.activeElement).toBe(button);
    expect(screen.queryByRole("alert")?.textContent ?? null).toBe(success ? null : "Chart export failed. Try again from this browser.");
    vi.mocked(downloadChartPng).mockResolvedValue(true);
    await act(async () => fireEvent.click(button));
    expect(downloadChartPng).toHaveBeenCalledTimes(2);
    expect(downloadChartPng).toHaveBeenLastCalledWith(expect.objectContaining({ current: expect.any(HTMLDivElement) }), "pharos-psi-history");
    expect(button.disabled).toBe(false);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("keeps offscreen history behind its reserved viewport gate without delaying headline statistics", () => {
    keepHistoryOffscreen();
    const { container } = render(<StabilityIndexClient />);
    expect(screen.queryByText("score-chart-3")).toBeNull();
    expect(screen.getAllByText("89.4").length).toBeGreaterThan(0);
    expect(screen.getAllByText("30d high").length).toBeGreaterThan(0);
    expect(container.querySelector('[aria-label="PSI history"] > div')?.getAttribute("style")).toContain("min-height: 450px");
    expect(fullHistoryQuery).not.toHaveBeenCalled();
  });

  it("keeps chart mounting bounded and expands only after selecting All", () => {
    keepHistoryOffscreen();
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
    reducedMotion = false;
    refetch.mockReset();
    fullHistoryQuery.mockReset();
    useTimeRangeFilterSpy.mockReset();
    cachedFullHistoryData = undefined;
    HTMLElement.prototype.scrollIntoView = vi.fn();
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


  it("gates dimmer motion without replay after completion", () => {
    const view = render(<StabilityIndexClient />);
    expect(area.animationDuration).toBe(800);
    for (const completed of [false, true]) {
      if (completed) act(() => area.onAnimationEnd!());
      for (const reduced of [true, false]) {
        reducedMotion = reduced;
        view.rerender(<StabilityIndexClient />);
        expect(area.isAnimationActive).toBe(!reduced && !completed);
        expect(screen.getAllByRole("figure").length).toBeGreaterThan(0);
      }
    }
  });

  it("renders the current PSI state, contributors, and methodology section", () => {
    render(<StabilityIndexClient />);

    for (const text of ["89.4", "rolling 24h avg", "STEADY"]) {
      expect(screen.getAllByText(text).length).toBeGreaterThan(0);
    }
    expect(screen.getAllByText("USDC").length).toBeGreaterThan(0);
    const contributorsTable = screen.getByRole("table", {
      name: "Stablecoins currently contributing to PSI score reduction",
    });
    expect(contributorsTable).toBeTruthy();
    expect(contributorsTable.parentElement?.getAttribute("data-slot")).toBe("table-viewport");
    const contributorsShell = screen.getByTestId("stability-index-top-contributors-table");
    expect(contributorsShell.getAttribute("data-table-id")).toBe("stability-index-top-contributors");
    expect(contributorsShell.className).toContain("pharos-density-compact");
    for (const text of ["Top contributors", "Methodology", "score-chart-3"]) expect(screen.getByText(text)).toBeTruthy();
  });

  it.each([
    ["fresh", 0, "current", "lit"],
    ["stale", 8 * 3600, "retained", "outline"],
  ] as const)("draws the %s beacon", (status, ageSeconds, state, paint) => {
    const computedAt = Math.floor(Date.now() / 1000) - ageSeconds;
    stabilityState.data!.current!.computedAt = computedAt;
    stabilityState.data!.headlineAggregates!.computedAt = computedAt;
    stabilityState.meta = { updatedAt: computedAt, ageSeconds, status };
    render(<StabilityIndexClient />);
    const beacon = screen.getByTestId("psi-beacon");
    expect(beacon.dataset.state).toBe(state);
    expect(beacon.dataset.paint).toBe(paint);
    if (ageSeconds) expect(beacon.querySelector("svg[role='img']")?.getAttribute("aria-label")).toMatch(/^Retained observation as of /);
  });

  it("keeps a retained coherent generation through a failed refetch and recovers", () => {
    stabilityState.meta = { updatedAt: 1_710_000_000, ageSeconds: 60, status: "fresh" };
    const view = render(<StabilityIndexClient />);
    expect(screen.getAllByText("89.4").length).toBeGreaterThan(0);

    stabilityState = { ...stabilityState, isError: true, error: new Error("psi down") };
    view.rerender(<StabilityIndexClient />);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getAllByText("89.4").length).toBeGreaterThan(0);
    for (const text of ["Top contributors", "score-chart-3"]) expect(screen.getByText(text)).toBeTruthy();
    const banner = screen.getByTestId("psi-stale-banner");
    // The shared banner owns material-age warnings; the producer clock is unchanged.
    expect(banner.dataset).toMatchObject({ hasData: "true", error: "true", updatedAt: "1710000000" });

    stabilityState = { ...stabilityState, isError: false, error: null };
    view.rerender(<StabilityIndexClient />);
    expect(screen.getByTestId("psi-stale-banner").dataset.error).toBe("false");
    expect(screen.getAllByText("89.4").length).toBeGreaterThan(0);
  });

  it.each(["incoherent", "missing"])("withholds %s data during a failed refetch", (state) => {
    if (state === "missing") {
      stabilityState.data = { ...stabilityState.data!, current: null, history: [] };
      stabilityState.dataUpdatedAt = 0;
    } else {
      stabilityState.data!.headlineAggregates!.computedAt -= 1;
    }
    stabilityState = { ...stabilityState, isError: true, error: new Error("psi down") };
    render(<StabilityIndexClient />);
    expect(screen.getByRole("alert").textContent).toContain("psi down");
    expect(screen.queryByTestId("psi-beacon")).toBeNull();
  });

  it("renders KPI-left / Beacon-right split hero, 6-band Regime Scale, divergence note, Show inputs toggle, and 30D actionable dimmers", () => {
    const { container } = render(<StabilityIndexClient />);

    // FeatureHeroSplit renders KPI block before the Beacon in DOM order (KPI-left / Beacon-right).
    const heroGroup = screen.getByRole("group", { name: "Pharos Stability Index overview" });
    const kpiEl = heroGroup.querySelector(".pharos-hero-kpi");
    const beaconEl = screen.getByTestId("psi-beacon");
    expect(kpiEl).not.toBeNull();
    expect(kpiEl!.compareDocumentPosition(beaconEl) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    // PsiBeacon hides duplicate component legend rows on /stability-index/.
    const beaconLegend = screen.getByTestId("psi-beacon-legend").textContent ?? "";
    expect(beaconLegend).toContain("instant");
    expect(beaconLegend).toContain("24h avg");
    expect(beaconLegend).not.toContain("stress breadth");

    // 6-band Regime Scale and inline instant vs 24h avg band divergence explanation.
    const scale = screen.getByTestId("psi-regime-scale");
    for (const band of ["BEDROCK", "STEADY", "TREMOR", "FRACTURE", "CRISIS", "MELTDOWN"]) {
      expect(scale.textContent).toContain(band);
    }
    expect(screen.getByTestId("psi-band-divergence-note").textContent).toContain("92.2 (BEDROCK)");
    expect(screen.getByTestId("psi-band-divergence-note").textContent).toContain("89.4, STEADY");

    // Beam dimmers default to 30D and expose live drill-down links.
    expect(useTimeRangeFilterSpy).toHaveBeenCalledWith("ts", undefined, { initialRange: "30d" });
    expect(screen.getByRole("link", { name: "Severity" }).getAttribute("href")).toMatch(/^\/depeg\/?$/);
    expect(screen.getByRole("link", { name: "Breadth" }).getAttribute("href")).toMatch(/^\/depeg\/?$/);
    expect(screen.getByRole("link", { name: "Stress breadth" }).getAttribute("href")).toMatch(/^\/depeg\/?#dews-radar$/);
    expect(screen.getByRole("link", { name: "Trend" }).getAttribute("href")).toMatch(/^\/flows\/?$/);

    // ShowYourWorkToggle is present.
    expect(screen.getByRole("button", { name: /show inputs/i })).toBeTruthy();

    // Contributor row uses crisp driver badge (never verbatim "Open incident, counted by size").
    expect(container.textContent).not.toContain("Open incident, counted by size");
  });

  it("focuses ScoreChart and links internal case studies when an event timeline row is clicked", () => {
    render(<StabilityIndexClient />);

    expect(
      screen.getByRole("link", { name: /Case study: USDC and the Silicon Valley Bank weekend/i }).getAttribute("href"),
    ).toMatch(/^\/learn\/case-studies\/usdc-svb-2023\/?$/);

    const svbButton = screen.getByRole("button", { name: /SVB Weekend/i });
    fireEvent.click(svbButton);
    expect(svbButton.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByTestId("psi-focused-event-banner").textContent).toContain("SVB Weekend");
    expect(fullHistoryQuery).toHaveBeenLastCalledWith({ enabled: true });

    fireEvent.click(screen.getByRole("button", { name: /clear focus/i }));
    expect(screen.queryByTestId("psi-focused-event-banner")).toBeNull();
  });

  it("shows Breadth badge with Recovery pending cue for near-peg breadth-driven contributors", () => {
    stabilityState.data!.current!.contributors = [
      { id: "xaum-matrixdock", symbol: "XAUm", bps: 14, mcapUsd: 1_500_000_000, ageDays: 3, factor: 1 },
    ];
    stabilityState.data!.current!.totalMcapUsd = 300_000_000_000;
    render(<StabilityIndexClient />);
    expect(screen.getByText("Recovery pending")).toBeTruthy();
    expect(screen.queryByText("Open incident, counted by size")).toBeNull();
  });
});
