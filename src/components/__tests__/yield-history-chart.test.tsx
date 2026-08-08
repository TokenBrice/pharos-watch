// @vitest-environment jsdom

import { fireEvent, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { YieldHistoryChart } from "@/components/yield-history-chart";

const { useYieldHistoryMock } = vi.hoisted(() => ({
  useYieldHistoryMock: vi.fn(),
}));

vi.mock("@/hooks/api-hooks", () => ({
  useYieldHistory: useYieldHistoryMock,
}));

vi.mock("@/hooks/use-chart-container-ready", () => ({
  useChartContainerReady: () => ({
    ref: { current: null },
    ready: false,
    width: 0,
    height: 0,
  }),
}));

afterEach(() => {
  cleanup();
  useYieldHistoryMock.mockReset();
});

describe("YieldHistoryChart", () => {
  it("exposes publish-time PYS snapshots on the full chart", () => {
    const history = Array.from({ length: 30 }, (_, index) => ({
      date: Date.UTC(2026, 3, index + 1),
      apy: 4 + index * 0.01,
      apyBase: null,
      apyReward: null,
      exchangeRate: null,
      sourceTvlUsd: 1_000_000,
      warningSignals: [],
      sourceKey: "primary-source",
      yieldSource: "Primary Source",
      dataSource: "defillama",
      isBest: true,
      sourceSwitch: false,
      pysAtPublish: 60 + index,
    }));
    useYieldHistoryMock.mockImplementation((_stablecoinId, options) => ({
      data: options?.enabled === false
        ? { current: null, history: [], methodology: { version: "v8.14" } }
        : { current: null, history, methodology: { version: "v8.14" } },
      meta: null,
      error: null,
      isLoading: false,
    }));

    render(
      <YieldHistoryChart
        stablecoinId="dola-inverse-finance"
        benchmarkRate={3}
        benchmarkLabel="SOFR"
        medianApy={4}
        compact={false}
      />,
    );

    // The publish-time PYS strip now rides the breakdown toggle.
    expect(screen.queryByTestId("pys-sparkline")).toBeNull();
    fireEvent.click(screen.getByLabelText("Show APY and PYS breakdown detail"));
    expect(screen.getByTestId("pys-sparkline")).toBeTruthy();
    expect(screen.getByText(/PYS 89 \(\+29\)/)).toBeTruthy();
  });
});
