// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { RowSparkline } from "@/components/row-sparkline";


describe("RowSparkline", () => {
  it("renders the '—' fallback when fewer than 2 valid samples are present", () => {
    const data = Array<null>(30).fill(null);
    render(<RowSparkline data={data} ariaLabel="Test placeholder" />);
    expect(screen.getByTestId("row-sparkline-empty").textContent).toBe("—");
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("renders an SVG with a path when given a positive series", () => {
    const data = Array.from({ length: 30 }, (_, i) => i);
    const { container } = render(
      <RowSparkline data={data} ariaLabel="Ascending" />,
    );
    const svg = container.querySelector("svg");
    expect(svg).not.toBeNull();
    expect(svg?.querySelectorAll("path").length).toBeGreaterThanOrEqual(1);
  });

  it("draws a reference line when referenceValue is provided", () => {
    const data = Array.from({ length: 30 }, (_, i) => (i % 2 === 0 ? 50 : -50));
    const { container } = render(
      <RowSparkline data={data} signed referenceValue={0} ariaLabel="Signed" />,
    );
    expect(container.querySelector("line")).not.toBeNull();
  });

  it("breaks the path across nulls into multiple segments", () => {
    // 30 points: first 10 valid, then 10 nulls (gap), then 10 valid → 2 segments
    const data: Array<number | null> = [
      ...Array.from({ length: 10 }, (_, i) => i),
      ...Array<null>(10).fill(null),
      ...Array.from({ length: 10 }, (_, i) => i + 20),
    ];
    const { container } = render(<RowSparkline data={data} ariaLabel="Gapped" />);
    // Two segments → at least two stroke paths (each segment also has a fill).
    const paths = container.querySelectorAll("path");
    expect(paths.length).toBeGreaterThanOrEqual(4); // 2 segments × (area + line)
  });

  it("renders accessible title via aria-labelledby", () => {
    const data = Array.from({ length: 10 }, (_, i) => i);
    render(<RowSparkline data={data} ariaLabel="Test sparkline" />);
    const svg = screen.getByRole("img");
    expect(svg.getAttribute("aria-labelledby")).toBeTruthy();
    expect(svg.querySelector("title")?.textContent).toBe("Test sparkline");
  });
});
