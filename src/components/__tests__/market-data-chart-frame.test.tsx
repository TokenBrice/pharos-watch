// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
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


vi.mock("@/components/chart-primitives/sync", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/components/chart-primitives/sync")>()),
  useMarketDataChartSync: () => ({ hoveredTs, setHoveredTs: vi.fn(), brushedRange: null, setBrushedRange: vi.fn() }),
}));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("preserves ordinary chart variants, crosshairs and controls without event overlays or reads", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { container } = render(
      <div>
        <McapChart data={data} stablecoinId="test-coin" controlledRange="all" />
        <PegDeviationChart data={data} pegCurrency="USD" controlledRange="all" />
      </div>,
    );

    const mcap = screen.getByRole("figure", { name: "Market cap chart showing 3 data points" });
    const peg = screen.getByRole("figure", { name: "Peg deviation chart showing 3 data points" });
    expect(screen.queryByLabelText("Annotation event density by quarter")).toBeNull();
    expect(screen.queryByRole("list", { name: "Chart events" })).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByRole("radiogroup", { name: "Y-axis scale" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "All" })).toBeNull();
    expect(container.querySelector(".recharts-area")).toBeTruthy();
    expect(container.querySelector(".recharts-line")).toBeTruthy();
    expect(container.querySelectorAll(".pointer-events-none.absolute")).toHaveLength(2);
    expect(mcap.parentElement?.className).toBe("relative h-[250px] sm:h-[350px]");
    expect(peg.parentElement?.className).toBe("relative h-[250px] sm:h-[350px]");
});
