// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  PysHistorySparkline,
  type PysHistorySparklinePoint,
} from "@/components/pys-history-sparkline";
import { CHART_GREEN, CHART_RED, CHART_SLATE } from "@/lib/chart-colors";

const DAY_MS = 24 * 60 * 60 * 1000;
const BASE_TS = 1_700_000_000_000;

function buildPoints(
  count: number,
  valueFn: (i: number) => number | null | undefined,
): PysHistorySparklinePoint[] {
  return Array.from({ length: count }, (_, i) => ({
    ts: BASE_TS + i * DAY_MS,
    pysAtPublish: valueFn(i),
  }));
}


describe("PysHistorySparkline", () => {
  it("renders an SVG polyline when 30 points have pysAtPublish values", () => {
    const history = buildPoints(30, (i) => 50 + i);
    const { container } = render(<PysHistorySparkline history={history} />);
    const polyline = container.querySelector("polyline");
    expect(polyline).not.toBeNull();
    const points = polyline?.getAttribute("points") ?? "";
    // 30 "x,y" pairs separated by spaces
    expect(points.split(" ")).toHaveLength(30);
  });

  it("renders the collecting placeholder when fewer than 7 non-null points exist", () => {
    const history = buildPoints(5, (i) => 50 + i);
    const { container } = render(<PysHistorySparkline history={history} />);
    expect(container.querySelector("polyline")).toBeNull();
    expect(screen.getByTestId("pys-sparkline-placeholder").textContent).toContain(
      "PYS history collecting",
    );
  });

  it("breaks SVG segments across unavailable scores without counting gaps as measurements", () => {
    const tooFew = render(<PysHistorySparkline history={buildPoints(10, (i) => i % 2 === 0 ? 60 : null)} />);
    expect(tooFew.container.querySelector("polyline")).toBeNull();
    expect(screen.getByTestId("pys-sparkline-placeholder")).toBeDefined();
    cleanup();

    const history = buildPoints(12, (i) => {
      if (i === 0 || i === 5) return null;
      if (i === 6 || i === 11) return undefined;
      return 50 + i;
    });
    const { container } = render(<PysHistorySparkline history={history} />);
    const segments = [...container.querySelectorAll("polyline")];
    expect(segments).toHaveLength(2);
    expect(segments.map((segment) => segment.getAttribute("points")?.split(" ").length)).toEqual([4, 4]);
    expect(segments.every((segment) => segment.getAttribute("stroke") === CHART_GREEN)).toBe(true);
    expect(screen.getByRole("img").getAttribute("aria-label")).toContain("starts at 51, ends at 60, ranges 51 to 60");
    expect(screen.getByText("PYS 60 (+9)")).toBeDefined();
  });

  it("never connects isolated measurements across alternating NR observations", () => {
    const history = Array.from({ length: 16 }, (_, i) => ({
      ts: BASE_TS + i * 60 * 60 * 1000,
      pysAtPublish: i % 2 === 0 ? 50 + i : null,
    }));
    const { container } = render(<PysHistorySparkline history={history} />);
    expect(container.querySelectorAll("polyline")).toHaveLength(0);
    expect(screen.getByText("PYS 64 (+14)")).toBeDefined();
  });

  it("uses emerald stroke when the series is ascending", () => {
    const history = buildPoints(10, (i) => 50 + i * 2); // 50 → 68
    const { container } = render(<PysHistorySparkline history={history} />);
    expect(container.querySelector("polyline")?.getAttribute("stroke")).toBe(CHART_GREEN);
  });

  it("uses red stroke when the series is descending", () => {
    const history = buildPoints(10, (i) => 90 - i * 2); // 90 → 72
    const { container } = render(<PysHistorySparkline history={history} />);
    expect(container.querySelector("polyline")?.getAttribute("stroke")).toBe(CHART_RED);
  });

  it("uses slate stroke when the series is flat (within tolerance)", () => {
    // First and last differ by < 1, which is the flat tolerance
    const history: PysHistorySparklinePoint[] = buildPoints(10, (i) => 60 + (i % 2) * 0.5);
    history[0].pysAtPublish = 60;
    history[history.length - 1].pysAtPublish = 60.4;
    const { container } = render(<PysHistorySparkline history={history} />);
    expect(container.querySelector("polyline")?.getAttribute("stroke")).toBe(CHART_SLATE);
  });

  it("exposes an aria-label describing the window range", () => {
    const history = buildPoints(10, (i) => 50 + i);
    render(<PysHistorySparkline history={history} />);
    const svg = screen.getByRole("img");
    const label = svg.getAttribute("aria-label") ?? "";
    expect(label).toContain("9-day PYS history");
    expect(label).toContain("starts at 50");
    expect(label).toContain("ends at 59");
  });

  it("labels the observed span, not the requested window, when data is shorter (E22)", () => {
    const history: PysHistorySparklinePoint[] = Array.from({ length: 8 }, (_, i) => ({
      ts: BASE_TS + i * 60 * 60 * 1000, // hourly points: 7h span
      pysAtPublish: 50 + i,
    }));
    render(<PysHistorySparkline history={history} />);
    const svg = screen.getByRole("img");
    const label = svg.getAttribute("aria-label") ?? "";
    expect(label).toContain("1-day PYS history");
    expect(label).not.toContain("30-day PYS history");
  });
});
