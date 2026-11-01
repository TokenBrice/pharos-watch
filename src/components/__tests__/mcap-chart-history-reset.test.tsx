// @vitest-environment jsdom

import { useState } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { McapChart } from "@/components/mcap-chart";
import type { TimeRangeOption } from "@/hooks/use-time-range-filter";

const history = vi.hoisted(() => ({
  current: {
    data: [] as Array<{ date: number; circulatingUsd: number; price?: number | null }>,
    isLoading: false,
    isFetching: false,
    isError: false,
    error: null as Error | null,
    refetch: vi.fn(),
  },
}));

vi.mock("@/hooks/use-stablecoins", () => ({
  useSupplyHistory: () => history.current,
}));

vi.mock("@/hooks/use-chart-container-ready", () => ({
  useChartContainerReady: () => ({ ref: vi.fn(), ready: true, width: 640, height: 350 }),
}));

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", ResizeObserverStub);
  history.current = {
    data: [],
    isLoading: false,
    isFetching: false,
    isError: false,
    error: null,
    refetch: vi.fn(),
  };
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const START = Date.UTC(2026, 0, 1) / 1000;
const seed = [
  { date: START, circulatingUsd: 1_000_000, price: 0.999 },
  { date: START + 86_400, circulatingUsd: 1_100_000, price: 1.001 },
  { date: START + 172_800, circulatingUsd: 1_200_000, price: 0.998 },
];
const expanded = [{ date: Date.UTC(2025, 0, 1) / 1000, circulatingUsd: 900_000, price: 1 }, ...seed];

function ControlledChart({ initialRange }: { initialRange: TimeRangeOption }) {
  const [range, setRange] = useState(initialRange);
  return (
    <>
      <output data-testid="requested-range">{range}</output>
      <McapChart
        data={seed}
        stablecoinId="usdt-tether"
        controlledRange={range}
        onControlledRangeChange={setRange}
        expandHistoryOnWideRange
      />
    </>
  );
}

function loadingState() {
  return { ...history.current, isLoading: true, isFetching: true };
}

describe("ExpandableHistoryMcapChart wide-read recovery", () => {
  it("resets a failed wide selection to the 90-day seed without a notice", async () => {
    history.current = { ...history.current, isError: true, error: new Error("upstream down") };
    render(<ControlledChart initialRange="1y" />);

    await waitFor(() => expect(screen.getByTestId("requested-range").textContent).toBe("90d"));
    expect(screen.queryByRole("status", { name: "Market history coverage" })).toBeNull();
    expect(screen.getByRole("button", { name: "90D" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("resets a successful empty wide selection to the 90-day seed without a notice", async () => {
    render(<ControlledChart initialRange="all" />);

    await waitFor(() => expect(screen.getByTestId("requested-range").textContent).toBe("90d"));
    expect(screen.queryByRole("status", { name: "Market history coverage" })).toBeNull();
    expect(screen.getByRole("button", { name: "90D" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("keeps the requested wide range in state while its read is in flight", async () => {
    history.current = loadingState();
    render(<ControlledChart initialRange="1y" />);

    await waitFor(() => expect(screen.getByTestId("requested-range").textContent).toBe("1y"));
    expect(screen.getByRole("button", { name: "90D" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "1Y" }).getAttribute("aria-pressed")).toBe("false");
  });

  it("retries on a wide-range click and moves the pill once wider data arrives", async () => {
    history.current = { ...history.current, isError: true, error: new Error("upstream down") };
    render(<ControlledChart initialRange="all" />);
    await waitFor(() => expect(screen.getByTestId("requested-range").textContent).toBe("90d"));

    const refetch = history.current.refetch;
    history.current = { ...history.current, data: expanded };
    fireEvent.click(screen.getByRole("button", { name: "All" }));

    expect(refetch).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.getByTestId("requested-range").textContent).toBe("all"));
    expect(screen.getByRole("button", { name: "All" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("figure", { name: "Market cap chart showing 4 data points" })).toBeTruthy();
  });
});
