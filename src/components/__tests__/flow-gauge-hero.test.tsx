// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { FlowGaugeHero } from "@/components/flow-gauge-hero";
import { makeMintBurnCoinValuation, makeMintBurnFlowCoin } from "@/test-utils/mint-burn-fixtures";
import type { MintBurnGauge } from "@shared/types";

const gauge = (overrides: Partial<MintBurnGauge> = {}): MintBurnGauge => ({
  score: -47.6,
  band: "STRESS",
  intensitySemantics: "signed-v2",
  flightToQuality: false,
  flightIntensity: 0,
  trackedCoins: 3,
  trackedMcapUsd: 300,
  partialValuationInputs: 0,
  ...overrides,
});

const coins = [
  makeMintBurnFlowCoin({ stablecoinId: "usdc-circle", symbol: "USDC", pressureShiftScore: -60, gaugeWeightUsd: 200 }),
  makeMintBurnFlowCoin({ stablecoinId: "usdg-global", symbol: "USDG", pressureShiftScore: 30, gaugeWeightUsd: 20 }),
  makeMintBurnFlowCoin({
    stablecoinId: "usdt-tether",
    symbol: "USDT",
    pressureShiftScore: null,
    valuation: makeMintBurnCoinValuation({ completeness: "partial", mintCompleteness: "partial", unpricedMintEventCount: 1 }),
    gaugeWeightUsd: 80,
  }),
];

describe("FlowGaugeHero", () => {
  it("leads with the gauge and its band chip, never a degraded headline", () => {
    const { container } = render(<FlowGaugeHero gauge={gauge()} coins={coins} sync={null} />);
    const hero = screen.getByRole("group", { name: "Bank Run Gauge overview" });

    // Beam: one rounding, typographic minus, and the published band beside it.
    expect(hero.querySelector("p.pharos-numeric")?.textContent).toBe("−48Stress");
    expect(container.textContent).not.toMatch(/Net direction unavailable|Pressure stable|Minting Pressure/i);
    // Verdict from structured fields: band, then the weighted driver.
    expect(screen.getByText(/Weighted redemption pressure is heavy against the 30-day norm\. USDC pulls it down most/)).toBeTruthy();
    expect(screen.getByText("Printed 24h")).toBeTruthy();
    expect(screen.getByRole("img", { name: /Run line: 2 coins in the Bank Run Gauge/ })).toBeTruthy();
    // Equivalent data surface: every tracked coin, with status.
    expect(screen.getByRole("table")).toBeTruthy();
    expect(screen.getAllByRole("row")).toHaveLength(4);
    expect(screen.getByText("Withheld: partial valuation")).toBeTruthy();
  });

  it("labels a re-weighted beam on the label and as a reason-coded chip", () => {
    const { container } = render(
      <FlowGaugeHero
        gauge={gauge({ partialValuationInputs: 1, partialValuationMcapUsd: 2, scoredMcapUsd: 220 })}
        coins={coins}
        sync={null}
      />,
    );

    expect(screen.getByText(/partial: 1 weighted coin withheld/)).toBeTruthy();
    expect(container.querySelector('[data-reason-codes="partial-valuation-inputs"]')?.textContent).toContain(
      "Partial valuation",
    );
  });

  it("renders an unrated gauge as an em dash with a Not rated chip, never 0", () => {
    const { container } = render(<FlowGaugeHero gauge={gauge({ score: null, band: null })} coins={[]} sync={null} />);
    const beam = container.querySelector("p.pharos-numeric");

    expect(container.querySelector('[data-reason-codes="gauge-score-null"]')).toBeTruthy();
    expect(screen.getAllByText("Not rated").length).toBeGreaterThan(0);
    expect(beam?.textContent).toBe("—Not rated");
    expect(beam?.textContent).not.toContain("0");
  });

  it("puts a sync warning in a status chip with its freshness reason", () => {
    const { container } = render(
      <FlowGaugeHero
        gauge={gauge()}
        coins={coins}
        sync={{ lastSuccessfulSyncAt: 1_790_000_000, freshnessStatus: "stale", warning: "Lane lagging", criticalLaneHealthy: false }}
      />,
    );

    expect(container.querySelector('[data-reason-codes="freshness-stale"]')?.textContent).toContain("Sync delayed");
  });

  it("prints no band, and says why, when withheld weight could carry the score across an edge", () => {
    const { container } = render(
      <FlowGaugeHero
        gauge={gauge({ partialValuationInputs: 1, partialValuationMcapUsd: 80, scoredMcapUsd: 220 })}
        coins={coins}
        sync={null}
      />,
    );

    expect(container.querySelector("p.pharos-numeric")?.textContent).toBe("−48");
    expect(container.querySelector('[data-reason-codes="band-not-robust-to-withheld-weight"]')?.textContent).toContain(
      "Band unsettled",
    );
    expect(container.textContent).not.toMatch(/Weighted redemption pressure is heavy/);
    expect(screen.getByText("USDC pulls it down most; USDG lifts it most.")).toBeTruthy();
  });

  it("names a degraded read as a reason-coded chip, not a body callout", () => {
    const { container } = render(
      <FlowGaugeHero
        gauge={gauge()}
        coins={coins}
        sync={null}
        dataHealth={{
          label: "Mint/Burn Flows",
          state: "degraded",
          message: "Data is delayed or from a degraded source.",
          dataUpdatedAt: 1_790_000_000_000,
          ageMs: 5_400_000,
          staleTime: 3_600_000,
          meta: null,
          degradationReason: "source",
        }}
      />,
    );

    expect(container.querySelector('[data-reason-codes="data-health-degraded source"]')?.textContent).toContain("Source warning");
    expect(container.textContent).not.toContain("Data quality warning");
  });
});
