// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
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

  it("names the canonical series and plots all requested overlays (F6, E19)", () => {
    const history = Array.from({ length: 10 }, (_, index) => ({
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
        stablecoinId="usdc-circle"
        benchmarkRate={3}
        benchmarkLabel="SOFR"
        medianApy={0}
        availableSources={[
          { sourceKey: "a", yieldSource: "Source A" },
          { sourceKey: "b", yieldSource: "Source B" },
        ]}
      />,
    );

    // F6: the selector called the canonical series "Best yield (highest APY)".
    expect(screen.getAllByText("Canonical (published) source").length).toBeGreaterThan(0);
    expect(screen.queryByText("Best yield (highest APY)")).toBeNull();

    // E19: overlays beyond the old 4-source cap must still be requested.
    render(
      <YieldHistoryChart
        stablecoinId="usdc-circle"
        benchmarkRate={3}
        benchmarkLabel="SOFR"
        medianApy={0}
        externalSourceKeys={["a", "b", "c", "d", "e", "f", "g"]}
        availableSources={[
          { sourceKey: "a", yieldSource: "Source A" },
          { sourceKey: "b", yieldSource: "Source B" },
          { sourceKey: "g", yieldSource: "Source G" },
        ]}
      />,
    );
    const requestedSourceKeys = useYieldHistoryMock.mock.calls
      .map(([, options]) => (options?.sourceKey ?? null))
      .filter(Boolean);
    for (const key of ["b", "c", "d", "e", "f", "g"]) {
      expect(requestedSourceKeys).toContain(key);
    }
  });

});

describe("YieldHistoryTooltip spike copy (E22)", () => {
  it("labels the effective trailing span of the spike average", async () => {
    const { YieldHistoryTooltip } = await import("@/components/yield-history-chart-ui");
    const payloadPoint = {
      date: Date.UTC(2026, 4, 10),
      apy: 9,
      apyBase: null,
      apyReward: null,
      sourceTvlUsd: null,
      warningSignals: [],
      sourceKey: null,
      yieldSource: "Source A",
      dataSource: null,
      isBest: true,
      sourceSwitch: false,
    };
    const { render: rtlRender, screen: rtlScreen } = await import("@testing-library/react");
    rtlRender(
      <YieldHistoryTooltip
        active
        showBreakdown={false}
        compact={false}
        label={Date.UTC(2026, 4, 10)}
        spikesByDate={new Map([[Date.UTC(2026, 4, 10), { trailingAvg: 3, ratio: 3, windowDays: 7 }]])}
        payload={[{ dataKey: "apy", payload: payloadPoint }]}
      />,
    );
    expect(rtlScreen.getByText(/3\.0× the trailing 7d average of 3\.00%/)).toBeTruthy();
  });
});
