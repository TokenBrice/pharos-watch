// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { FlowGaugeHero } from "@/components/flow-gauge-hero";
import { makeMintBurnCoinValuation, makeMintBurnFlowCoin } from "@/test-utils/mint-burn-fixtures";
import type { MintBurnFlowsResponse, MintBurnGauge } from "@shared/types";

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

const evidenceWindow = (overrides: Partial<NonNullable<NonNullable<MintBurnFlowsResponse["window"]>["watermark"]>> = {}): MintBurnFlowsResponse["window"] => ({
  start: Date.UTC(2026, 0, 17, 16) / 1000,
  end: Date.UTC(2026, 0, 18, 16) / 1000,
  semantics: "closed-utc-hours",
  watermark: {
    timestamp: Date.UTC(2026, 0, 18, 16) / 1000,
    ageSec: 7200,
    maxAgeSec: 28800,
    unavailableReason: null,
    ...overrides,
  },
});

describe("FlowGaugeHero", () => {
  it("shows the common evidence hour separately from the newer sync clock", () => {
    render(<FlowGaugeHero gauge={gauge()} coins={coins}
      sync={{ lastSuccessfulSyncAt: Date.UTC(2026, 0, 18, 18) / 1000, freshnessStatus: "fresh", warning: null, criticalLaneHealthy: true }}
      window={evidenceWindow()} />);

    const cutoff = screen.getByRole("button", { name: "Data through 16:00 UTC" });
    expect(cutoff.querySelector("time")?.dateTime).toBe("2026-01-18T16:00:00.000Z");
    fireEvent.click(cutoff);
    expect(screen.getByText(/Common closed-hour cutoff: 18 Jan, 16:00 UTC/)).toBeTruthy();
    expect(screen.getByText(/Evidence budget: 8h · watermark 2h old/)).toBeTruthy();
  });

  it.each([undefined, { start: 0, end: 86400, semantics: "closed-utc-hours" as const }])(
    "preserves the old hero when watermark metadata is absent",
    (window) => {
      render(<FlowGaugeHero gauge={gauge()} coins={coins} sync={null} window={window} />);
      expect(screen.queryByRole("button", { name: /Data through|Data time unavailable/ })).toBeNull();
      expect(screen.getByRole("button", { name: /Universe: Active, 2 of 3 flow-tracked scored/ })).toBeTruthy();
      expect(screen.queryByRole("button", { name: /^Partial$/ })).toBeNull();
    },
  );

  it("discloses excluded scan members without confusing admitted and scored counts", () => {
    render(<FlowGaugeHero gauge={gauge({
      trackedCoins: 133,
      scanCoverage: { complete: false, unavailableReason: "scan-coverage-incomplete",
        admittedCoins: 128, excludedCoins: 5, excludedMcapUsd: 12_000_000 },
    })} coins={coins} sync={null} window={evidenceWindow()} />);
    expect(screen.getByRole("button", { name: /2 of 133 flow-tracked scored · 5 excluded \(\$12\.0M mcap\)/ })).toBeTruthy();
    const partial = screen.getByRole("button", { name: "Partial" });
    expect(partial.getAttribute("data-reason-codes")).toBe("scan-coverage-incomplete");
    fireEvent.click(partial);
    expect(screen.getByText(/128 of 133 flow-tracked coins have admitted 24h scan coverage/)).toBeTruthy();
    expect(screen.getByText(/Excluded supply weight: \$12\.0M/)).toBeTruthy();
    expect(screen.getByText(/not the full tracked set/)).toBeTruthy();
  });

  it("does not claim a partial gauge when no scan members are excluded", () => {
    render(<FlowGaugeHero gauge={gauge({ scanCoverage: {
      complete: true, unavailableReason: null, admittedCoins: 3, excludedCoins: 0, excludedMcapUsd: 0,
    } })} coins={coins} sync={null} />);
    expect(screen.queryByRole("button", { name: "Partial" })).toBeNull();
    expect(screen.getByRole("button", { name: /Universe: Active, 2 of 3 flow-tracked scored/ }).textContent).not.toContain("excluded");
  });

  it("labels missing excluded supply weight as unavailable, never zero", () => {
    render(<FlowGaugeHero gauge={gauge({ scanCoverage: {
      complete: false, unavailableReason: "scan-coverage-incomplete", excludedCoins: 1, excludedMcapUsd: null,
    } })} coins={coins} sync={null} />);
    expect(screen.getByRole("button", { name: /1 excluded \(mcap unavailable\)/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Partial" }));
    expect(screen.getByText("Excluded supply weight: unavailable.")).toBeTruthy();
  });

  it("marks stale watermark evidence even when the sync itself is fresh", () => {
    render(<FlowGaugeHero gauge={gauge()} coins={coins}
      sync={{ lastSuccessfulSyncAt: Date.UTC(2026, 0, 19, 2) / 1000, freshnessStatus: "fresh", warning: null, criticalLaneHealthy: true }}
      window={evidenceWindow({ ageSec: 36000, unavailableReason: "scan-watermark-stale" })} />);
    expect(screen.getByRole("button", { name: "Data through 16:00 UTC" })).toBeTruthy();
    const delayed = screen.getByRole("button", { name: "Data delayed" });
    expect(delayed.getAttribute("data-reason-codes")).toBe("scan-watermark-stale");
    fireEvent.click(delayed);
    expect(screen.getByText(/Evidence budget: 8h · watermark 10h old/)).toBeTruthy();
  });

  it("does not substitute a sync timestamp for an unavailable watermark", () => {
    const { container } = render(<FlowGaugeHero gauge={gauge()} coins={coins} sync={null}
      window={evidenceWindow({ timestamp: null, ageSec: null, unavailableReason: "scan-watermark-unavailable" })} />);
    expect(screen.queryByRole("button", { name: /Data through/ })).toBeNull();
    const unavailable = container.querySelector('[data-reason-codes="scan-watermark-unavailable"]');
    expect(unavailable?.textContent).toBe("Data time unavailable");
    fireEvent.click(unavailable!);
    expect(screen.getByText(/No common closed-hour scan watermark is available/)).toBeTruthy();
  });

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

  it("preserves unknown activity and unavailable totals in the hero and run-line data surface", () => {
    const { container } = render(
      <FlowGaugeHero
        gauge={gauge({ score: null, band: null })}
        coins={[makeMintBurnFlowCoin({
          has24hActivity: null,
          netFlow24hUsd: null,
          netFlowDirection24h: null,
          pressureShiftScore: null,
          pressureShiftState: "nr",
          mintVolume24hUsd: 0,
          burnVolume24hUsd: 0,
        })]}
        sync={null}
      />,
    );
    expect(screen.getByRole("table").textContent).toContain("24h activity unknown");
    expect(container.textContent).toContain("Summed signed net unavailable");
    expect(container.textContent).not.toContain("No 24h mint or burn");
    expect(container.querySelector('[data-reason-codes="gauge-score-null"]')).toBeTruthy();
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

  it("keeps a degraded read off the hero and names a stale one as a reason-coded chip", () => {
    const health = {
      label: "Mint/Burn Flows",
      message: "Data is delayed or from a degraded source.",
      dataUpdatedAt: 1_790_000_000_000,
      ageMs: 5_400_000,
      staleTime: 3_600_000,
      meta: null,
    };
    const { container, rerender } = render(
      <FlowGaugeHero gauge={gauge()} coins={coins} sync={null}
        dataHealth={{ ...health, state: "degraded", degradationReason: "source" }} />,
    );

    expect(container.querySelector('[data-reason-codes^="data-health-"]')).toBeNull();
    expect(container.textContent).not.toContain("Source warning");
    expect(container.textContent).not.toContain("Data quality warning");

    rerender(<FlowGaugeHero gauge={gauge()} coins={coins} sync={null} dataHealth={{ ...health, state: "stale" }} />);
    expect(container.querySelector('[data-reason-codes="data-health-stale"]')?.textContent).toContain("Older snapshot");
  });

  it.each(["source-stale", "publication-held"])("explains classification-null before valuation-null and retains its dependency budget: %s", (reason) => {
    const warning = `199 - "Flight-to-quality classification unavailable: Safety Score source (${reason}); budget 1h."`;
    const { container } = render(
      <FlowGaugeHero
        gauge={gauge({ flightToQuality: null, flightIntensity: null, classificationSource: "unavailable", classificationReason: reason })}
        coins={coins}
        sync={{ lastSuccessfulSyncAt: 1_790_000_000, freshnessStatus: "fresh", warning: null,
          classificationWarning: warning, criticalLaneHealthy: true }}
        dataHealth={{
          label: "Mint/Burn Flows", state: "degraded", message: "A source dependency is unavailable.",
          dataUpdatedAt: 1_790_000_000_000, ageMs: 120_000, staleTime: 3_600_000, degradationReason: "source",
          meta: { updatedAt: 1_790_000_000, ageSeconds: 120, status: "fresh", freshBudgetSec: 28800, warning,
            dependencies: { flightToQuality: { status: "unavailable", reason,
              updatedAt: 1_789_996_000, ageSeconds: 4000, freshBudgetSec: 3600, generationId: "accepted-generation" } } },
        }}
      />,
    );
    expect(container.querySelector('[data-reason-codes="valuation-incomplete"]')).toBeNull();
    expect(container.querySelector(`[data-reason-codes="classification-unavailable ${reason}"]`)).toBeTruthy();
    // "Active" also labels the independent tracked-universe chip, not an FTQ verdict.
    expect(screen.getByRole("button", { name: /^Universe: Active,/ })).toBeTruthy();
    expect(screen.queryByText("Flight to quality")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /FTQ unavailable/ }));
    expect(screen.getByText(/Flight-to-quality classification unavailable: Safety Score source/)).toBeTruthy();
    expect(screen.getByText(/Safety Score dependency budget: 1h/)).toBeTruthy();
    expect(document.body.textContent).not.toContain("199 -");
    expect(document.body.textContent).not.toContain("Missing valuation could change");
  });

  it("retains the valuation-specific FTQ reason when classification is admitted", () => {
    const { container } = render(
      <FlowGaugeHero
        gauge={gauge({ flightToQuality: null, flightIntensity: null,
          classificationSource: "safety-score-v9-publication", classificationReason: null })}
        coins={coins}
        sync={null}
      />,
    );
    expect(container.querySelector('[data-reason-codes="valuation-incomplete"]')).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /FTQ unavailable/ }));
    expect(screen.getByText("Missing valuation could change the flight-to-quality verdict, so none is published.")).toBeTruthy();
    expect(screen.queryByText(/Safety Score dependency budget/)).toBeNull();
  });

  it("explains a withheld verdict with its published cause instead of assuming valuation", () => {
    const { container } = render(
      <FlowGaugeHero
        gauge={gauge({ flightToQuality: null, flightIntensity: null,
          classificationSource: "safety-score-v9-publication", classificationReason: null,
          flightToQualityReason: "cohort-member-unpublished" })}
        coins={coins}
        sync={null}
      />,
    );
    expect(container.querySelector('[data-reason-codes="cohort-member-unpublished"]')).toBeTruthy();
    expect(container.querySelector('[data-reason-codes="valuation-incomplete"]')).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /FTQ unavailable/ }));
    expect(screen.getByText("A graded coin has no published 24h flow, so the flight-to-quality verdict is withheld.")).toBeTruthy();
    expect(screen.queryByText(/Missing valuation could change/)).toBeNull();
  });
});
