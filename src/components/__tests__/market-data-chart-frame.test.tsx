// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { McapChart } from "@/components/mcap-chart";

const START = Date.UTC(2026, 0, 1) / 1000;
const data = [
  { date: START, circulatingUsd: 1_000_000, price: 0.999 },
  { date: START + 86_400, circulatingUsd: 1_100_000, price: 1.001 },
  { date: START + 172_800, circulatingUsd: 1_200_000, price: 0.998 },
];
const hoveredTs = (START + 86_400) * 1000;
const syncState = vi.hoisted(() => ({ brushedRange: null as [number, number] | null }));

vi.mock("@/hooks/use-chart-container-ready", () => ({
  useChartContainerReady: () => ({ ref: vi.fn(), ready: true, width: 640, height: 350 }),
}));


vi.mock("@/components/chart-primitives/sync", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/components/chart-primitives/sync")>()),
  useMarketDataChartSync: () => ({ hoveredTs, setHoveredTs: vi.fn(), brushedRange: syncState.brushedRange, setBrushedRange: vi.fn() }),
}));

afterEach(() => {
  cleanup();
  syncState.brushedRange = null;
});


it("labels only consecutive UTC-day observations as a 24h market-cap change", () => {
  const { rerender } = render(<McapChart data={data.slice(0, 2)} stablecoinId="test" controlledRange="all" />);
  expect(screen.getByText("+10.00% 24h")).toBeTruthy();
  rerender(<McapChart data={[
    data[0], { ...data[1], date: START + 3 * 86_400 },
  ]} stablecoinId="test" controlledRange="all" />);
  expect(screen.queryByText(/% 24h/)).toBeNull();
});

it("qualifies the 24h anchor inside a brush ending at an older observation", () => {
  const sparse = [...data.slice(0, 2), { ...data[2], date: START + 4 * 86_400 }];
  syncState.brushedRange = [START * 1000, (START + 86_400) * 1000];
  const { rerender } = render(<McapChart data={sparse} stablecoinId="test" controlledRange="all" />);
  expect(screen.getByText("+10.00% 24h")).toBeTruthy();
  syncState.brushedRange = [(START + 86_400) * 1000, (START + 4 * 86_400) * 1000];
  rerender(<McapChart data={sparse} stablecoinId="test" controlledRange="all" />);
  expect(screen.queryByText(/% 24h/)).toBeNull();
});

it("keeps observed zero supply but withholds a percentage with a zero baseline", () => {
  const { rerender } = render(<McapChart data={[
    data[0], { ...data[1], circulatingUsd: 0 },
  ]} stablecoinId="test" controlledRange="all" />);
  expect(screen.getByText("-100.00% 24h")).toBeTruthy();
  expect(screen.getByRole("figure", { name: "Market cap chart showing 2 data points" })).toBeTruthy();
  rerender(<McapChart data={[
    { ...data[0], circulatingUsd: 0 }, data[1],
  ]} stablecoinId="test" controlledRange="all" />);
  expect(screen.queryByText(/% 24h/)).toBeNull();
});
