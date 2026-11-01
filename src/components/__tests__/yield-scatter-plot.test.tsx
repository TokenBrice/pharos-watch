// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cloneElement, createElement, isValidElement, type ReactElement } from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import type * as Recharts from "recharts";
import { YieldScatterPlot } from "@/components/yield-scatter-plot";
import { prepareYieldUniverse, selectVisibleYieldRows } from "@/lib/yield-view-model";
import { makeYieldProvenance, makeYieldRanking } from "@shared/test-utils/yield-ranking-fixtures";
import { YIELD_OPPORTUNITY_SAFETY_DESCRIPTION } from "@shared/lib/yield-opportunity-provenance";

const chart = vi.hoisted(() => ({ mobile: false, width: 900, scatter: vi.fn(), tooltip: vi.fn() }));
vi.mock("@/hooks/use-chart-container-ready", () => ({
  useChartContainerReady: () => ({ ref: () => {}, ready: true, width: chart.width, height: 420 }),
}));
vi.mock("@/hooks/use-is-mobile", () => ({ useIsMobile: () => chart.mobile }));
vi.mock("recharts", async (importOriginal) => {
  const actual = await importOriginal<typeof Recharts>();
  return {
    ...actual,
    Scatter: (props: Parameters<typeof actual.Scatter>[0]) => {
      chart.scatter(props);
      return createElement(actual.Scatter, { ...props, isAnimationActive: false });
    },
    Tooltip: (props: Parameters<typeof actual.Tooltip>[0]) => { chart.tooltip(props); return null; },
  };
});
afterEach(() => { cleanup(); vi.clearAllMocks(); chart.mobile = false; chart.width = 900; });

function showTooltip(id: string) {
  const points = chart.scatter.mock.calls.at(-1)![0].data as Array<{ id: string }>;
  const content = chart.tooltip.mock.calls.at(-1)![0].content;
  if (!isValidElement(content)) throw new Error("Scatter tooltip is missing");
  return render(cloneElement(content as ReactElement<Record<string, unknown>>, {
    active: true, payload: [{ payload: points.find((point) => point.id === id) }],
  }));
}

describe("YieldScatterPlot", () => {
  it.each([
    { risk: undefined, mobile: false },
    { risk: "any", mobile: false },
    { risk: undefined, mobile: true },
    { risk: "any", mobile: true },
  ])("renders captured acrdx loss inside the $risk cohort, mobile=$mobile", async ({ risk, mobile }) => {
    chart.mobile = mobile;
    chart.width = mobile ? 360 : 900;
    const rows = [
      makeYieldRanking({ id: "acrdx", symbol: "acrdx", apy30d: -1.9549203966, safetyScore: 52, pharosYieldScore: null }),
      makeYieldRanking({ id: "positive", apy30d: 5, safetyScore: 80 }),
    ];
    const rankings = selectVisibleYieldRows(prepareYieldUniverse(rows, null), { risk });
    expect(rankings.map((row) => row.id)).toContain("acrdx");
    const { container } = render(<YieldScatterPlot rankings={rankings} benchmarkRate={4.25} logos={{ acrdx: "/acrdx.svg" }} />);
    await waitFor(() => expect(container.querySelector('image[href="/acrdx.svg"]')).not.toBeNull());
    const marker = container.querySelector('image[href="/acrdx.svg"]')!.closest("g")!;
    const position = marker.getAttribute("transform")!.match(/translate\(([^,]+),\s*([^)]+)\)/)!;
    expect(Number(position[2])).toBeGreaterThan(0);
    expect(Number(position[2])).toBeLessThan(420);
    expect(container.querySelectorAll(".recharts-scatter-symbol")).toHaveLength(2);
    expect(screen.getByRole("figure").getAttribute("aria-label")).toContain("2 yield-source rows plotted");
    expect([...container.querySelectorAll(".recharts-yAxis-tick-labels .recharts-cartesian-axis-tick-value")].some((tick) => Number(tick.textContent) < 0)).toBe(true);
    showTooltip("acrdx");
    expect(screen.getByText("-1.95%")).toBeTruthy();
    expect(screen.getByText("-6.20 pp")).toBeTruthy();
  });

  it("accounts for upper-railed and unscored rows without losing negative rows", () => {
    const rankings = [
      ...Array.from({ length: 13 }, (_, i) => makeYieldRanking({ id: `steady-${i}`, apy30d: 5 })),
      makeYieldRanking({ id: "loss", apy30d: -100 }),
      makeYieldRanking({ id: "rocket", apy30d: 200 }),
      makeYieldRanking({ id: "unscored", safetyScore: null }),
    ];
    render(<YieldScatterPlot rankings={rankings} benchmarkRate={4.25} />);
    expect(screen.getByRole("figure").getAttribute("aria-label")).toContain("15 yield-source rows plotted, including 1 on the upper rail");
    expect(screen.getByText(/1 row without a measured safety score not shown/)).toBeTruthy();
    showTooltip("rocket");
    expect(screen.getByText("200.00%")).toBeTruthy();
    expect(screen.getByText(/Chart rail:/)).toBeTruthy();
  });

  it.each([
    { apy30d: 5, spread: "+0.75 pp" },
    { apy30d: 3, spread: "-1.25 pp" },
    { apy30d: 4.249, spread: "+0.00 pp" },
  ])("keeps rate levels in percent and differences in pp: $spread", ({ apy30d, spread }) => {
    render(<YieldScatterPlot rankings={[makeYieldRanking({ apy30d })]} benchmarkRate={4.25} />);
    showTooltip("usdc-circle");
    expect(screen.getByText(spread)).toBeTruthy();
    expect(screen.getAllByText(`${apy30d.toFixed(2)}%`).length).toBeGreaterThan(0);
    expect(screen.getAllByText("4.25%").length).toBeGreaterThan(0);
  });

  it("distinguishes opportunity-derived safety without replacing the row score", () => {
    render(<YieldScatterPlot rankings={[
      makeYieldRanking({ safetyScore: 72, safetyGrade: "B", provenance: makeYieldProvenance({ safetyProvenance: "opportunity-safety" }) }),
      makeYieldRanking({ id: "holder", safetyScore: 90, safetyGrade: "A", provenance: makeYieldProvenance({ safetyProvenance: "live-report-card" }) }),
    ]} benchmarkRate={4.25} />);
    expect(screen.getByText("Row / opportunity safety")).toBeTruthy();
    const opportunity = showTooltip("usdc-circle");
    expect(screen.getByText(/Opportunity safety:/).textContent).toContain("(72/100)");
    expect(screen.getByText(YIELD_OPPORTUNITY_SAFETY_DESCRIPTION)).toBeTruthy();
    opportunity.unmount();
    showTooltip("holder");
    expect(screen.getByText(/^Safety:/).textContent).toContain("(90/100)");
    expect(screen.queryByText(YIELD_OPPORTUNITY_SAFETY_DESCRIPTION)).toBeNull();
  });

  it("discloses an entirely unscored population", () => {
    render(<YieldScatterPlot rankings={[makeYieldRanking({ safetyScore: null })]} benchmarkRate={4.25} />);
    expect(screen.getByText(/1 row without a measured safety score not shown/)).toBeTruthy();
  });

  it("does not plot the default-safety sentinel as a measured score", () => {
    render(<YieldScatterPlot rankings={[
      makeYieldRanking({
        id: "sentinel",
        symbol: "sentinel",
        safetyScore: 40,
        safetyGrade: "NR",
        provenance: makeYieldProvenance({ usedDefaultSafety: true, safetyProvenance: "default-safety" }),
      }),
      makeYieldRanking({ id: "measured", safetyScore: 80 }),
    ]} benchmarkRate={4.25} />);
    expect(screen.getByText(/1 row without a measured safety score not shown/)).toBeTruthy();
    const points = chart.scatter.mock.calls.at(-1)![0].data as Array<{ id: string; x: number }>;
    expect(points.map((point) => point.id)).toEqual(["measured"]);
    expect(points[0].x).toBe(80);
  });
});
