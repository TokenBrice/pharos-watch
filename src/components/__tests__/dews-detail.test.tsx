// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ApiFetchError } from "@/lib/api";

import { DEWSDetail, describeUnscoredSignal } from "@/components/dews/dews-detail";
import type { ReactNode } from "react";

const { useDetailMock, chartMock, areaMock, tooltipMock, bandAreaMock, yAxisMock } = vi.hoisted(() => ({
  useDetailMock: vi.fn(), chartMock: vi.fn(), areaMock: vi.fn(), tooltipMock: vi.fn(), bandAreaMock: vi.fn(), yAxisMock: vi.fn(),
}));

vi.mock("@/hooks/api-hooks", () => ({ useStressSignalDetail: useDetailMock }));
vi.mock("@/hooks/use-chart-container-ready", () => ({
  useChartContainerReady: () => ({ ref: { current: null }, ready: true, width: 600, height: 240 }),
}));
vi.mock("recharts", () => ({
  AreaChart: (props: { children: ReactNode }) => { chartMock(props); return <div>{props.children}</div>; },
  Area: (props: unknown) => { areaMock(props); return null; },
  ReferenceArea: (props: unknown) => { bandAreaMock(props); return null; },
}));
vi.mock("@/components/chart-primitives/axes", () => ({
  TimeXAxis: () => null,
  MonoYAxis: (props: unknown) => { yAxisMock(props); return null; },
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
    // Measured zero stays a reading; the failed sub-signal is named with a plain reason.
    expect(container.querySelector("[data-dews-score]")?.textContent).toBe("0");
    expect(screen.getByText(/blacklist activity \(freeze tracker read failed\)/)).toBeTruthy();
    expect(container.textContent).not.toContain("blacklist-source-failed");
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

  it("hides the module when a successful read has no current row", () => {
    useDetailMock.mockReturnValue({
      isLoading: false,
      error: new Error("HTTP 502"),
      data: { current: null, currentStatus: "unavailable", currentReasons: ["current-row-malformed"], history: [] },
      refetch: vi.fn(),
    });
    render(<DEWSDetail stablecoinId="usdc-circle" />);
    expect(screen.queryByText(/DEWS score unavailable/)).toBeNull();
    expect(screen.queryByText(/No DEWS data available yet|next computation cycle/)).toBeNull();
    expect(screen.queryByText(/Connection issue|Failed to load/)).toBeNull();
    expect(screen.queryByText("Depeg Early Warning")).toBeNull();
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
    const { container } = render(<DEWSDetail stablecoinId="usdt-tether" />);
    const modeGroup = screen.getByRole("group", { name: "DEWS chart mode" });
    expect(modeGroup.className).toContain("pharos-segmented");
    const breakdownBtn = screen.getByRole("button", { name: "Signal breakdown" });
    expect(breakdownBtn.className).toContain("pharos-segmented-item");
    fireEvent.click(breakdownBtn);
    const points = chartMock.mock.calls.at(-1)![0].data;
    expect(points.map((point: { black: number | null }) => point.black)).toEqual([80, null, 0, null]);
    expect(areaMock.mock.calls.filter(([props]) => props.dataKey === "black").at(-1)![0].connectNulls).toBe(false);
    const formatter = tooltipMock.mock.calls.at(-1)![0].formatter;
    expect(formatter(null, "black")).toBeNull();
    expect(formatter(0, "black")[0]).toBe("0/100");
    expect(container.querySelector("[data-dews-unscored]")?.textContent).toContain("blacklist activity (freeze tracker read failed)");
    expect(container.textContent).not.toContain("blacklist-source-failed");
    expect(screen.queryByText(/not applicable/)).toBeNull();
    // Both modes read on the fixed 0–100 threat ladder, never an auto-scaled axis.
    expect(yAxisMock.mock.calls.at(-1)![0].domain).toEqual([0, 100]);
    expect(bandAreaMock.mock.calls.slice(-5).map(([props]) => [props.y1, props.y2, props.label.value])).toEqual([
      [0, 15, "Calm"], [15, 35, "Watch"], [35, 55, "Alert"], [55, 75, "Warning"], [75, 100, "Danger"],
    ]);
  });

  it("reserves not applicable for an explicit applicability reason", () => {
    useDetailMock.mockReturnValue({ isLoading: false, error: null, data: {
      current: { score: 0, band: "CALM", signals: { black: {
        value: 0, available: false, unavailableReason: "not-applicable",
      } } }, history: [],
    } });
    render(<DEWSDetail stablecoinId="fixture" />);
    expect(screen.getByText(/not applicable/).textContent).toContain("blacklist activity (not applicable)");
    expect(screen.getByText(/not applicable/).textContent).not.toContain("not-applicable");
  });

  it("maps every producer reason to plain text and never shows an unknown code", () => {
    const producerCodes = [
      "supply-history-anchors-missing", "price-evidence-unavailable", "invalid-price", "peg-type-unavailable",
      "peg-reference-missing", "peg-reference-unavailable", "peg-reference-untrusted", "thin-reference",
      "blacklist-source-failed", "mint-burn-data-missing", "mint-burn-baseline-too-short", "mint-burn-stale",
      "mint-burn-valuation-partial", "mint-burn-valuation-unknown", "mint-burn-baseline-valuation-partial",
      "mint-burn-baseline-valuation-unknown", "mint-burn-isolated-no-outflow", "mint-burn-isolated-no-stress-increase",
      "yield-warnings-unscored", "not-applicable",
    ];
    for (const code of producerCodes) {
      const text = describeUnscoredSignal("flow", code);
      expect(text).not.toBe("no reading this cycle");
      expect(text).not.toContain(code);
    }
    expect(describeUnscoredSignal("flow", "brand-new-code")).toBe("no reading this cycle");
    expect(describeUnscoredSignal("black", undefined)).toBe("no freeze ledger");
    expect(describeUnscoredSignal("yield", null)).toBe("no yield warnings");
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
    const { container } = render(<DEWSDetail stablecoinId="fixture" />);
    const rows = [...container.querySelectorAll<HTMLElement>("[data-dews-signal]")];
    // One row-major list at every width; the odd last signal spans the lg row.
    expect(rows.map((row) => row.dataset.dewsSignal)).toEqual(["diverg", "supply", "pool"]);
    expect(screen.getAllByLabelText(/out of 100$/).map((element) => element.textContent)).toEqual(["80", "55", "0"]);
    expect(rows.every((row) => row.className.includes("lg:odd:last:col-span-2"))).toBe(true);
    // A measured zero reads at full contrast, not dimmed as if disabled.
    expect(rows[2].className).not.toMatch(/opacity/);
    expect(screen.getByText(/Largest input: cross-source divergence/)).toBeTruthy();
  });
});
