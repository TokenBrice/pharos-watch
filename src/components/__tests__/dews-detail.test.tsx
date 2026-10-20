// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import { DEWSDetail } from "@/components/dews-detail";
import type { ReactNode } from "react";

const { useDetailMock, chartMock, areaMock, tooltipMock } = vi.hoisted(() => ({
  useDetailMock: vi.fn(), chartMock: vi.fn(), areaMock: vi.fn(), tooltipMock: vi.fn(),
}));

vi.mock("@/hooks/api-hooks", () => ({ useStressSignalDetail: useDetailMock }));
vi.mock("@/hooks/use-chart-container-ready", () => ({
  useChartContainerReady: () => ({ ref: { current: null }, ready: true, width: 600, height: 240 }),
}));
vi.mock("recharts", () => ({
  AreaChart: (props: { children: ReactNode }) => { chartMock(props); return <div>{props.children}</div>; },
  Area: (props: unknown) => { areaMock(props); return null; },
  ReferenceLine: () => null,
}));
vi.mock("@/components/chart-primitives/axes", () => ({
  ChartAreaGradient: () => null, TimeGrid: () => null, TimeXAxis: () => null, MonoYAxis: () => null,
  useSvgId: () => "dews-test",
  DateTooltip: (props: unknown) => { tooltipMock(props); return null; },
}));
vi.mock("@/components/show-your-work-panel", () => ({ ShowYourWorkPanel: () => null }));
vi.mock("@/components/show-your-work-toggle", () => ({
  ShowYourWorkToggle: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}));

describe("DEWSDetail", () => {
  it("preserves stressed-to-unavailable history gaps and genuine measured zero", () => {
    useDetailMock.mockReturnValue({ isLoading: false, error: null, data: {
      current: { score: 20, band: "CALM", signals: { black: {
        value: 0, available: false, unavailableReason: "blacklist-source-failed",
      } } },
      history: [
        { date: 1, score: 80, band: "DANGER", signals: { black: { value: 80, available: true } } },
        { date: 2, score: 20, band: "CALM", signals: { black: { value: 0, available: false } } },
        { date: 3, score: 0, band: "CALM", signals: { black: { value: 0, available: true } } },
        { date: 4, score: 0, band: "CALM" },
      ],
    } });
    render(<DEWSDetail stablecoinId="usdt-tether" />);
    fireEvent.click(screen.getByRole("button", { name: "Signal Breakdown" }));
    const points = chartMock.mock.calls.at(-1)![0].data;
    expect(points.map((point: { black: number | null }) => point.black)).toEqual([80, null, 0, null]);
    expect(areaMock.mock.calls.filter(([props]) => props.dataKey === "black").at(-1)![0].connectNulls).toBe(false);
    const formatter = tooltipMock.mock.calls.at(-1)![0].formatter;
    expect(formatter(null, "black")).toBeNull();
    expect(formatter(0, "black")[0]).toBe("0/100");
    expect(screen.getByText(/blacklist-source-failed/).textContent).toContain("unavailable (blacklist-source-failed)");
    expect(screen.queryByText(/not applicable/)).toBeNull();
  });

  it("reserves not applicable for an explicit applicability reason", () => {
    useDetailMock.mockReturnValue({ isLoading: false, error: null, data: {
      current: { score: 0, band: "CALM", signals: { black: {
        value: 0, available: false, unavailableReason: "not-applicable",
      } } }, history: [],
    } });
    render(<DEWSDetail stablecoinId="fixture" />);
    expect(screen.getByText(/not applicable/).textContent).toContain("not applicable (not-applicable)");
  });

  it("sorts available signal rows by score and retains measured zero", () => {
    useDetailMock.mockReturnValue({ isLoading: false, error: null, data: {
      current: { score: 20, band: "CALM", signals: {
        supply: { value: 55, available: true },
        pool: { value: 0, available: true },
        price: { value: 99, available: false },
        diverg: { value: 80, available: true },
      } }, history: [],
    } });
    render(<DEWSDetail stablecoinId="fixture" />);
    const scores = screen.getAllByText(/^· \d+ \/ 100$/)
      .map((element) => Number(element.textContent?.match(/\d+/)?.[0]));
    expect(scores).toEqual([80, 55, 0, 80, 55, 0]);
  });
});
