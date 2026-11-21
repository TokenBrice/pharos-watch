// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { HomeAltHeroChart } from "@/components/homepage/home-alt-hero-chart";

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
        "Non-USD share",
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
    expect(readout.textContent).toContain("Non-USD share");
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
    expect(container.querySelector('path[data-series="total-area"]')!.getAttribute("d")!.split("Z").length - 1).toBe(1);
  });

  it("renders stacked cohort areas and switches range via the 90D | 1Y | ALL segmented toggle", () => {
    const multiYearRows = [
      { ...rows[0]!, ts: Date.UTC(2024, 0, 1), total: 120, usdt: 80, usdc: 25, sky: 5, others: 10 },
      { ...rows[0]!, ts: Date.UTC(2025, 6, 1), total: 180, usdt: 110, usdc: 45, sky: 10, others: 15 },
      { ...rows[1]!, ts: Date.UTC(2026, 4, 1), total: 240, usdt: 140, usdc: 60, sky: 15, others: 25 },
      { ...rows[1]!, ts: Date.UTC(2026, 5, 1), total: 250, usdt: 145, usdc: 65, sky: 15, others: 25 },
    ];
    const { container } = render(<HomeAltHeroChart rows={multiYearRows} />);
    for (const band of ["usdt-area", "usdc-area", "sky-area", "others-area"]) {
      expect(container.querySelector(`path[data-series="${band}"]`)?.getAttribute("d")).toContain("Z");
    }
    const btn90d = screen.getByRole("button", { name: "90D" });
    const btnAll = screen.getByRole("button", { name: "ALL" });
    expect(btnAll.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(btn90d);
    expect(btn90d.getAttribute("aria-pressed")).toBe("true");
    expect(btnAll.getAttribute("aria-pressed")).toBe("false");
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
