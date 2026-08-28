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

  it("skips null entries and only draws non-null points", () => {
    // 10 points: every other one null → 5 non-null which is < 7 → placeholder
    const tooFewHistory = buildPoints(10, (i) => (i % 2 === 0 ? 60 : null));
    const tooFew = render(<PysHistorySparkline history={tooFewHistory} />);
    expect(tooFew.container.querySelector("polyline")).toBeNull();
    cleanup();

    // 30 points: every third null → ~20 non-null → polyline with 20 vertices
    const mixedHistory = buildPoints(30, (i) => (i % 3 === 0 ? null : 50 + i));
    const expectedNonNull = mixedHistory.filter(
      (p) => p.pysAtPublish !== null && p.pysAtPublish !== undefined,
    ).length;
    const { container } = render(<PysHistorySparkline history={mixedHistory} />);
    const polyline = container.querySelector("polyline");
    expect(polyline).not.toBeNull();
    expect(polyline?.getAttribute("points")?.split(" ")).toHaveLength(expectedNonNull);
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
    expect(label).toContain("30-day PYS history");
    expect(label).toContain("starts at 50");
    expect(label).toContain("ends at 59");
  });
});
