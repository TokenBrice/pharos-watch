// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { PegDeviationChart } from "@/components/chart-primitives/peg-deviation-chart";
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

it("headlines the live quote and its deviation when the caller supplies them", () => {
  render(<PegDeviationChart data={history} pegCurrency="USD" controlledRange="all" current={{ price: 0.9991, deviationBps: -9 }} />);
  expect(screen.getByText("$0.9991")).toBeTruthy();
  expect(screen.getByText("-9 bps")).toBeTruthy();
  expect(screen.getByText("In band")).toBeTruthy();
  expect(screen.queryByText("$0.9999")).toBeNull();
});

it("charts a non-USD peg as its plain USD price, without par bands or a deviation band", () => {
  const goldHistory = history.map((point, index) => ({ ...point, price: 3_500 + index * 50 }));
  const { container } = render(<PegDeviationChart data={goldHistory} pegCurrency="GOLD" controlledRange="all" current={{ price: 3_578.31, deviationBps: -1 }} />);
  expect(screen.getByRole("heading", { name: "Price (USD)" })).toBeTruthy();
  expect(screen.getByText("$3,578.31")).toBeTruthy();
  expect(screen.queryByText("-1 bps")).toBeNull();
  expect(container.querySelector(".recharts-reference-area")).toBeNull();
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
