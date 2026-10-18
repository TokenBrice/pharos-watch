// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { FlowRunLine } from "@/components/flow-run-line";
import { buildRunLineModel } from "@/lib/flow-run-line-model";
import { GAUGE_BAND_RANGES } from "@shared/lib/mint-burn-gauge-bands";
import { makeMintBurnFlowCoin } from "@/test-utils/mint-burn-fixtures";
import type { MintBurnGauge } from "@shared/types";

const mainPlot = (container: HTMLElement) =>
  [...container.querySelectorAll("svg")].find((svg) => svg.getAttribute("viewBox")?.startsWith("0 0 200"));

const gauge = (overrides: Partial<MintBurnGauge> = {}): MintBurnGauge => ({
  score: -6,
  band: "NEUTRAL",
  intensitySemantics: "signed-v2",
  flightToQuality: false,
  flightIntensity: 0,
  trackedCoins: 3,
  trackedMcapUsd: 300,
  ...overrides,
});

const coins = [
  makeMintBurnFlowCoin({ stablecoinId: "usdc-circle", symbol: "USDC", pressureShiftScore: -10, gaugeWeightUsd: 160 }),
  makeMintBurnFlowCoin({ stablecoinId: "usdg-global", symbol: "USDG", pressureShiftScore: 20, gaugeWeightUsd: 40 }),
  makeMintBurnFlowCoin({
    stablecoinId: "usdt-tether",
    symbol: "USDT",
    pressureShiftScore: null,
    has24hActivity: false,
    mintCount24h: 0,
    burnCount24h: 0,
    mintVolume24hUsd: 0,
    burnVolume24hUsd: 0,
    netFlow24hUsd: 0,
    gaugeWeightUsd: 100,
  }),
];

describe("FlowRunLine", () => {
  it("places each tick and the rule at score + 100 on the 0–200 axis, over zones from the shared bands", () => {
    const { container } = render(<FlowRunLine model={buildRunLineModel(gauge(), coins)} />);
    const plot = mainPlot(container)!;
    const xs = [...plot.querySelectorAll("line[stroke='currentColor']")].map((line) => line.getAttribute("x1"));

    expect(xs).toContain("90"); // USDC at -10
    expect(xs).toContain("120"); // USDG at +20
    expect(xs).toContain("94"); // the gauge rule at -6
    // Dashed guides at every inner band edge, derived from GAUGE_BAND_RANGES.
    const guides = [...plot.querySelectorAll("line[stroke-dasharray='2 4']")].map((line) => Number(line.getAttribute("x1")));
    expect(guides).toEqual(GAUGE_BAND_RANGES.slice(1).map((range) => range.min + 100));
    const zones = [...container.querySelectorAll<HTMLElement>("[style*='width']")]
      .filter((zone) => GAUGE_BAND_RANGES.some((range) => zone.textContent === { CRISIS: "Crisis", STRESS: "Stress", CAUTIOUS: "Cautious", NEUTRAL: "Neutral", HEALTHY: "Healthy", CONFIDENT: "Confident", SURGE: "Surge" }[range.band]))
      .map((zone) => zone.style.width);
    expect(zones).toEqual(GAUGE_BAND_RANGES.map((range) => `${(range.max - range.min) / 2}%`));
  });

  it("counts coins outside the score and lists every coin in the equivalent table", () => {
    render(<FlowRunLine model={buildRunLineModel(gauge(), coins)} />);

    expect(screen.getByText("not in score").previousElementSibling?.textContent).toBe("1");
    expect(screen.getAllByRole("row")).toHaveLength(1 + coins.length);
    expect(screen.getByText("No 24h mint or burn")).toBeTruthy();
  });

  it("draws no rule and says so when the gauge is not rated", () => {
    const { container } = render(<FlowRunLine model={buildRunLineModel(gauge({ score: null, band: null }), [])} />);

    expect(screen.getByText("Gauge not rated")).toBeTruthy();
    expect(container.querySelector("line[stroke-width='3']")).toBeNull();
    expect(screen.getByRole("img").getAttribute("aria-label")).toMatch(/not rated/);
  });

  it("collapses the stage when per-coin weights are not published", () => {
    const legacy = coins.map(({ gaugeWeightUsd: _omit, ...coin }) => coin);
    const { container } = render(<FlowRunLine model={buildRunLineModel(gauge(), legacy)} />);

    expect(mainPlot(container)?.getAttribute("viewBox")).toBe("0 0 200 72");
  });
});
