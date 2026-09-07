// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { McapChart } from "@/components/mcap-chart";
import { PegDeviationChart } from "@/components/peg-deviation-chart";

const START = Date.UTC(2026, 0, 1) / 1000;
const data = [
  { date: START, circulatingUsd: 1_000_000, price: 0.999 },
  { date: START + 86_400, circulatingUsd: 1_100_000, price: 1.001 },
  { date: START + 172_800, circulatingUsd: 1_200_000, price: 0.998 },
];
const hoveredTs = (START + 86_400) * 1000;

vi.mock("@/hooks/use-chart-container-ready", () => ({
  useChartContainerReady: () => ({ ref: vi.fn(), ready: true, width: 640, height: 350 }),
}));

vi.mock("@/hooks/use-chart-annotations", () => ({
  useChartAnnotations: () => ({ data: [{ ts: hoveredTs, kind: "depeg", label: "Test depeg" }] }),
}));

vi.mock("@/components/chart-primitives/sync", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/components/chart-primitives/sync")>()),
  useMarketDataChartSync: () => ({ hoveredTs, setHoveredTs: vi.fn(), brushedRange: null, setBrushedRange: vi.fn() }),
}));

it("preserves both chart variants, shared overlays, controls, legends, and DOM order", () => {
    const { container } = render(
      <div>
        <McapChart data={data} stablecoinId="test-coin" controlledRange="all" />
        <PegDeviationChart data={data} pegCurrency="USD" stablecoinId="test-coin" controlledRange="all" />
      </div>,
    );

    const mcap = screen.getByRole("figure", { name: "Market cap chart showing 3 data points" });
    const peg = screen.getByRole("figure", { name: "Peg deviation chart showing 3 data points" });
    const density = screen.getByLabelText("Annotation event density by quarter");
    const legends = screen.getAllByRole("list", { name: "Chart events" });
    expect(screen.getByRole("radiogroup", { name: "Y-axis scale" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "All" })).toBeNull();
    expect(container.querySelector(".recharts-area")).toBeTruthy();
    expect(container.querySelector(".recharts-line")).toBeTruthy();
    expect(container.querySelectorAll(".pointer-events-none.absolute")).toHaveLength(2);
    expect(mcap.parentElement?.className).toBe("relative h-[250px] sm:h-[350px]");
    expect(density.className).toBe("absolute");
    expect(peg.compareDocumentPosition(density) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(density.compareDocumentPosition(legends[1]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});
