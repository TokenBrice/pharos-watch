// @vitest-environment jsdom

import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { HomeAltHeroChart } from "@/components/home-alt-hero-chart";

vi.mock("@/hooks/use-chart-shell", () => ({
  useChartShell: () => ({
    chartContainerRef: { current: null },
    isChartReady: true,
    width: 900,
    height: 360,
  }),
}));


describe("HomeAltHeroChart", () => {
  const rows = [
    {
      ts: Date.UTC(2020, 8, 13),
      usdt: 40,
      usdc: 10,
      sky: 3,
      others: 6,
      nonUsd: 2,
      total: 61,
    },
    {
      ts: Date.UTC(2026, 5, 1),
      usdt: 70,
      usdc: 20,
      sky: 4,
      others: 12,
      nonUsd: 5,
      total: 111,
    },
  ];

  it("renders lines for every market cohort represented by the legend", () => {
    const { container } = render(
      <HomeAltHeroChart rows={rows} />,
    );

    const pathTitles = Array.from(container.querySelectorAll("path title")).map((title) => title.textContent);
    expect(pathTitles).toEqual(
      expect.arrayContaining([
        "Total market cap",
        "USDT",
        "USDC",
        "USDS + DAI",
        "Others",
        "Non-USD market cap",
      ]),
    );
  });

  it("reveals a dated cohort readout while the pointer is over the plot", () => {
    const { container } = render(<HomeAltHeroChart rows={rows} />);
    const svg = container.querySelector("svg")!;

    expect(screen.queryByRole("tooltip")).toBeNull();

    // jsdom reports a zero-origin bounding box, so clientX maps straight onto
    // chart coordinates: 868 is the right plot edge (width 900 - right margin).
    fireEvent.pointerMove(svg, { clientX: 868, clientY: 100 });

    const readout = screen.getByRole("tooltip");
    expect(readout.textContent).toContain("Jun 1, 2026");
    expect(readout.textContent).toContain("Total market cap");
    // The dashed series is a USD level: its readout carries the currency value,
    // never a share of the total.
    expect(readout.textContent).toContain("Non-USD market cap");
    expect(readout.textContent).not.toMatch(/Non-USD share/);
    const nonUsdRow = within(readout).getByText("Non-USD market cap").closest("div");
    expect(nonUsdRow?.querySelector("dd")?.textContent).toBe("$5.00");
    // Crosshair marker per plotted series at the hovered date.
    expect(container.querySelectorAll("circle")).toHaveLength(6);

    fireEvent.pointerLeave(svg);
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("preserves a single-day gap in long histories and avoids isolated area slivers", () => {
    const longRows = Array.from({ length: 300 }, (_, index) => ({
      ...rows[0]!, ts: rows[0]!.ts + index * 86400000,
      total: index === 297 || index === 298 ? null : 61,
    }));
    const { container } = render(<HomeAltHeroChart rows={longRows} />);
    const totalPath = [...container.querySelectorAll("path title")]
      .find((title) => title.textContent === "Total market cap")!.parentElement!;
    expect(totalPath.getAttribute("d")!.split("M ").length - 1).toBe(2);
    expect(container.querySelector('path[fill="url(#homeAltTotalGrad)"]')!.getAttribute("d")!.split("Z").length - 1).toBe(1);
  });

  it("shows unavailable total and non-USD history as gaps rather than zero geometry", () => {
    const { container } = render(<HomeAltHeroChart rows={rows.map((row) => ({
      ...row, total: null, nonUsd: null, others: null,
    }))} />);
    // Gaps stay visible in the geometry; the homepage carries no data-health caption (ADR-42).
    expect(container.textContent).not.toContain("gaps are not zero");
    const totalPath = [...container.querySelectorAll("path title")]
      .find((title) => title.textContent === "Total market cap")?.parentElement;
    expect(totalPath?.getAttribute("d")).toBe("");
    expect(container.innerHTML).not.toContain("NaN");
    expect(container.innerHTML).not.toContain("Infinity");
  });
});
