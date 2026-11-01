// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ApiFetchError } from "@/lib/api";

import { DEWSDetail } from "@/components/dews-detail";
import type { ReactNode } from "react";

const { useDetailMock, chartMock, areaMock, tooltipMock } = vi.hoisted(() => ({
  useDetailMock: vi.fn(), chartMock: vi.fn(), areaMock: vi.fn(), tooltipMock: vi.fn(),
}));

vi.mock("@/hooks/api-hooks", () => ({ useStressSignalDetail: useDetailMock }));
vi.mock("@/hooks/use-chart-container-ready", () => ({
  useChartContainerReady: () => ({ ref: { current: null }, ready: true, width: 600, height: 240 }),
}));
vi.mock("recharts", () => ({
  AreaChart: (props: { children: ReactNode }) => { chartMock(props); return <div>{props.children}</div>; },
  Area: (props: unknown) => { areaMock(props); return null; },
  ReferenceLine: () => null,
}));
vi.mock("@/components/chart-primitives/axes", () => ({
  ChartAreaGradient: () => null, TimeGrid: () => null, TimeXAxis: () => null, MonoYAxis: () => null,
  useSvgId: () => "dews-test",
  DateTooltip: (props: unknown) => { tooltipMock(props); return null; },
}));
vi.mock("@/components/show-your-work-panel", () => ({ ShowYourWorkPanel: () => null }));
vi.mock("@/components/show-your-work-toggle", () => ({
  ShowYourWorkToggle: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}));

// Hydrate synchronously so the shared banner ages against the fake wall clock; fake timers
// here fake only setTimeout and Date, so they never capture this stub.
beforeEach(() => {
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { callback(0); return 0; });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

const COMPUTED_AT = 1_800_000_000;
const SIX_HOURS_MS = 21_600_000;

function retainedDetail(overrides: Record<string, unknown> = {}) {
  return {
    current: {
      score: 0, band: "CALM", computedAt: COMPUTED_AT,
      signals: {
        supply: { value: 0, available: true },
        black: { value: 0, available: false, unavailableReason: "blacklist-source-failed" },
      },
    },
    history: [
      { date: COMPUTED_AT - 86_400, score: 30, band: "WATCH", signals: { supply: { value: 30, available: true } } },
      { date: COMPUTED_AT, score: 0, band: "CALM", signals: { supply: { value: 0, available: false } } },
    ],
    ...overrides,
  };
}

describe("DEWSDetail retained evidence", () => {
  it("keeps the retained score, gaps and chart through a failed refresh with no load-error notice", () => {
    vi.useFakeTimers({ now: COMPUTED_AT * 1000 + 2 * 3_600_000, toFake: ["setTimeout", "clearTimeout", "Date"] });
    const refetch = vi.fn();
    useDetailMock.mockReturnValue({
      isLoading: false, error: new ApiFetchError("/api/stress-signals", 503, null), data: retainedDetail(), meta: undefined, refetch,
    });
    const { container } = render(<DEWSDetail stablecoinId="usdc-circle" />);
    act(() => vi.advanceTimersByTime(0));
    expect(screen.getByText("Depeg Early Warning")).toBeTruthy();
    // Measured zero stays a reading; the failed sub-signal stays named unavailable.
    expect(container.querySelector(".text-3xl")?.textContent).toBe("0");
    expect(screen.getByText(/blacklist-source-failed/)).toBeTruthy();
    expect(chartMock.mock.calls.at(-1)![0].data.map((point: { supply: number | null }) => point.supply)).toEqual([30, null]);
    expect(screen.queryByText(/Connection issue|Failed to load|Waiting for first sync/)).toBeNull();
    expect(container.querySelector("[data-health-state]")).toBeNull();
    expect(refetch).not.toHaveBeenCalled();
  });

  it("keeps the load-error notice and retry only when nothing is retained", () => {
    const refetch = vi.fn();
    useDetailMock.mockReturnValue({ isLoading: false, error: new TypeError("Failed to fetch"), data: undefined, refetch });
    render(<DEWSDetail stablecoinId="usdc-circle" />);
    expect(screen.getByText("Connection issue")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(refetch).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("Depeg Early Warning")).toBeNull();
  });

  it("names the machine reason when a successful read has no current row", () => {
    useDetailMock.mockReturnValue({
      isLoading: false,
      error: new Error("HTTP 502"),
      data: { current: null, currentStatus: "unavailable", currentReasons: ["current-row-malformed"], history: [] },
      refetch: vi.fn(),
    });
    render(<DEWSDetail stablecoinId="usdc-circle" />);
    expect(screen.getByText("DEWS score unavailable (current-row-malformed).")).toBeTruthy();
    expect(screen.queryByText(/No DEWS data available yet|next computation cycle/)).toBeNull();
    expect(screen.queryByText(/Connection issue|Failed to load/)).toBeNull();
  });

  it("ages this detail's own generation and warns only past the shared six-hour band", () => {
    vi.useFakeTimers({ now: COMPUTED_AT * 1000 + 2 * 3_600_000, toFake: ["setTimeout", "clearTimeout", "Date"] });
    const refetch = vi.fn();
    useDetailMock.mockReturnValue({ isLoading: false, error: null, data: retainedDetail(), meta: undefined, refetch });
    const { container } = render(<DEWSDetail stablecoinId="usdc-circle" />);
    const banner = () => container.querySelector("[data-health-state]");
    act(() => vi.advanceTimersByTime(0));
    expect(banner()).toBeNull();
    act(() => vi.advanceTimersByTime(SIX_HOURS_MS - 2 * 3_600_000));
    expect(banner()).toBeNull();
    act(() => vi.advanceTimersByTime(1));
    expect(banner()?.getAttribute("data-health-state")).toBe("stale");
    expect(screen.getByText("Depeg Early Warning")).toBeTruthy();
    expect(chartMock).toHaveBeenCalled();
    expect(refetch).not.toHaveBeenCalled();
  });

  it("keeps an unknown producer clock typed unavailable while the chart stays mounted", () => {
    useDetailMock.mockReturnValue({
      isLoading: false, error: null, data: retainedDetail(), refetch: vi.fn(),
      meta: { updatedAt: null, ageSeconds: null, status: "unknown", reason: "detail clock unavailable" },
    });
    const { container } = render(<DEWSDetail stablecoinId="usdc-circle" />);
    expect(container.querySelector("[data-health-state]")?.getAttribute("data-health-state")).toBe("unavailable");
    expect(screen.getByText("Depeg Early Warning")).toBeTruthy();
  });
});

describe("DEWSDetail", () => {
  it("preserves stressed-to-unavailable history gaps and genuine measured zero", () => {
    useDetailMock.mockReturnValue({ isLoading: false, error: null, data: {
      current: { score: 20, band: "CALM", signals: { black: {
        value: 0, available: false, unavailableReason: "blacklist-source-failed",
      } } },
      history: [
        { date: 1, score: 80, band: "DANGER", signals: { black: { value: 80, available: true } } },
        { date: 2, score: 20, band: "CALM", signals: { black: { value: 0, available: false } } },
        { date: 3, score: 0, band: "CALM", signals: { black: { value: 0, available: true } } },
        { date: 4, score: 0, band: "CALM" },
      ],
    } });
    render(<DEWSDetail stablecoinId="usdt-tether" />);
    fireEvent.click(screen.getByRole("button", { name: "Signal Breakdown" }));
    const points = chartMock.mock.calls.at(-1)![0].data;
    expect(points.map((point: { black: number | null }) => point.black)).toEqual([80, null, 0, null]);
    expect(areaMock.mock.calls.filter(([props]) => props.dataKey === "black").at(-1)![0].connectNulls).toBe(false);
    const formatter = tooltipMock.mock.calls.at(-1)![0].formatter;
    expect(formatter(null, "black")).toBeNull();
    expect(formatter(0, "black")[0]).toBe("0/100");
    expect(screen.getByText(/blacklist-source-failed/).textContent).toContain("unavailable (blacklist-source-failed)");
    expect(screen.queryByText(/not applicable/)).toBeNull();
  });

  it("reserves not applicable for an explicit applicability reason", () => {
    useDetailMock.mockReturnValue({ isLoading: false, error: null, data: {
      current: { score: 0, band: "CALM", signals: { black: {
        value: 0, available: false, unavailableReason: "not-applicable",
      } } }, history: [],
    } });
    render(<DEWSDetail stablecoinId="fixture" />);
    expect(screen.getByText(/not applicable/).textContent).toContain("not applicable (not-applicable)");
  });

  it("sorts available signal rows by score and retains measured zero", () => {
    useDetailMock.mockReturnValue({ isLoading: false, error: null, data: {
      current: { score: 20, band: "CALM", signals: {
        supply: { value: 55, available: true },
        pool: { value: 0, available: true },
        price: { value: 99, available: false },
        diverg: { value: 80, available: true },
      } }, history: [],
    } });
    render(<DEWSDetail stablecoinId="fixture" />);
    const scores = screen.getAllByText(/^· \d+ \/ 100$/)
      .map((element) => Number(element.textContent?.match(/\d+/)?.[0]));
    expect(scores).toEqual([80, 55, 0, 80, 55, 0]);
  });
});
