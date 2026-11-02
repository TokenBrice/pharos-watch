// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { PegDeviationChart } from "@/components/peg-deviation-chart";
import type { SupplyHistoryPoint } from "@/hooks/use-stablecoins";

const START = Date.UTC(2026, 0, 1) / 1000;
const syncState = vi.hoisted(() => ({ brushedRange: null as [number, number] | null }));

vi.mock("@/hooks/use-chart-container-ready", () => ({
  useChartContainerReady: () => ({ ref: vi.fn(), ready: true, width: 640, height: 350 }),
}));

vi.mock("@/components/chart-primitives/sync", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/components/chart-primitives/sync")>()),
  useMarketDataChartSync: () => ({
    hoveredTs: null,
    setHoveredTs: vi.fn(),
    brushedRange: syncState.brushedRange,
    setBrushedRange: vi.fn(),
  }),
}));

afterEach(() => {
  cleanup();
  syncState.brushedRange = null;
});

const history: SupplyHistoryPoint[] = [
  { date: START, circulatingUsd: 1_000_000, price: 0.999 },
  { date: START + 86_400, circulatingUsd: 1_000_000, price: 0.8774 },
  { date: START + 172_800, circulatingUsd: 1_000_000, price: 0.9999 },
];

it("keeps the header readout on the range's latest observation after a brush drag", () => {
  syncState.brushedRange = [START * 1000, (START + 86_400) * 1000];
  render(<PegDeviationChart data={history} pegCurrency="USD" controlledRange="all" />);
  expect(screen.getByText("$0.9999")).toBeTruthy();
  expect(screen.queryByText("$0.8774")).toBeNull();
  expect(screen.getByText("-1 bps")).toBeTruthy();
});

it("labels only the observed price series 'Price' in the tooltip", async () => {
  const { container } = render(<PegDeviationChart data={history} pegCurrency="USD" controlledRange="all" />);
  const wrapper = container.querySelector(".recharts-wrapper")!;
  wrapper.getBoundingClientRect = () => ({ x: 0, y: 0, width: 640, height: 350, top: 0, left: 0, right: 640, bottom: 350, toJSON: () => ({}) });
  fireEvent.mouseEnter(wrapper, { clientX: 600, clientY: 120 });
  fireEvent.mouseMove(wrapper, { clientX: 600, clientY: 120 });
  await waitFor(() => expect(screen.getByRole("status")).toBeTruthy());
  const tooltip = screen.getByRole("status");
  expect(tooltip.textContent?.match(/Price/g)?.length).toBe(1);
});
