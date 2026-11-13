// @vitest-environment jsdom

import { useState } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { McapChart } from "@/components/chart-primitives/mcap-chart";
import type { SupplyHistoryPoint } from "@shared/types/supply";
import type { TimeRangeOption } from "@/hooks/use-time-range-filter";

type HistoryState = {
  data: SupplyHistoryPoint[];
  isLoading: boolean;
  isFetching: boolean;
  isError: boolean;
  error: Error | null;
  refetch: ReturnType<typeof vi.fn>;
};

const history = vi.hoisted(() => {
  const windows = new Map<string, HistoryState>();
  const refetches: string[] = [];
  function stateFor(window: string): HistoryState {
    let state = windows.get(window);
    if (!state) {
      state = {
        data: [],
        isLoading: false,
        isFetching: false,
        isError: false,
        error: null,
        refetch: vi.fn(() => {
          refetches.push(window);
          return Promise.resolve();
        }),
      };
      windows.set(window, state);
    }
    return state;
  }
  return { windows, refetches, stateFor };
});

vi.mock("@/hooks/use-stablecoins", () => ({
  useSupplyHistory: (_id: string, window?: number | "all") => history.stateFor(String(window)),
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
  history.windows.clear();
  history.refetches.length = 0;
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

function setWindowState(window: "365" | "all", state: Partial<HistoryState>) {
  Object.assign(history.stateFor(window), state);
}

describe("ExpandableHistoryMcapChart wide-read recovery", () => {
  it.each([true, false])("resets an unavailable wide selection without a notice (error: %s)", async (failed) => {
    if (failed) setWindowState("365", { isError: true, error: new Error("upstream down") });
    render(<ControlledChart initialRange={failed ? "1y" : "all"} />);
    await waitFor(() => expect(screen.getByTestId("requested-range").textContent).toBe("90d"));
    expect(screen.queryByRole("status", { name: "Market history coverage" })).toBeNull();
    expect(screen.getByRole("button", { name: "90D" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("keeps the requested wide range in state while its read is in flight", async () => {
    setWindowState("365", { isLoading: true, isFetching: true });
    render(<ControlledChart initialRange="1y" />);

    await waitFor(() => expect(screen.getByTestId("requested-range").textContent).toBe("1y"));
    expect(screen.getByRole("button", { name: "90D" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "1Y" }).getAttribute("aria-pressed")).toBe("false");
  });

  it.each([
    ["all", "All", "all", 4], ["365", "1Y", "1y", 3],
  ] as const)("retries %s against its history key", async (key, button, range, points) => {
    setWindowState("all", { isError: true, error: new Error("upstream down") });
    render(<ControlledChart initialRange="all" />);
    await waitFor(() => expect(screen.getByTestId("requested-range").textContent).toBe("90d"));

    setWindowState(key, { data: expanded, isError: false, error: null });
    fireEvent.click(screen.getByRole("button", { name: button }));

    expect(history.refetches).toEqual([key]);
    await waitFor(() => expect(screen.getByTestId("requested-range").textContent).toBe(range));
    expect(screen.getByRole("button", { name: button }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("figure", { name: `Market cap chart showing ${points} data points` })).toBeTruthy();
  });
});

it.each([
  ["gho-aave", 12, 0, null], ["gho-aave", 13, 0, null],
  ["gho-aave", 12, 11, null], ["usdt-tether", 12, 0, "-61.56% 24h"],
  ["gho-aave", 14, 0, "-61.56% 24h"],
] as const)("guards %s header delta on November %s at %s UTC", (stablecoinId, day, hour, delta) => {
  const data = [697_750_000, 268_200_000].map((circulatingUsd, i) => ({
    date: Date.UTC(2026, 10, day + i, hour) / 1000, circulatingUsd, price: 1,
  }));
  render(<McapChart stablecoinId={stablecoinId} data={data} />);
  expect(screen.queryByText(/% 24h/)?.textContent ?? null).toBe(delta);
});
