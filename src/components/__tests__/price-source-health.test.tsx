// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { PriceSourceHealthSchema } from "@shared/types/pricing-source-health";
import { PriceSourceHealthCard } from "@/components/status/price-source-health";
import { buildPipelineModeSummaries } from "@/lib/pipeline-workspace-model";
import { makeHealthyStatusResponse } from "@/test-utils/status-fixtures";

const legacy = { totalAssets: 567, lastSync: 100,
  confidenceDistribution: { high: 115, "single-source": 325, low: 20, fallback: 1 },
  sourceDistribution: { missing: 106 } };
afterEach(cleanup);
describe("price source health scope", () => {
  it("labels old payloads as cache-wide instead of claiming active scope", () => {
    render(<PriceSourceHealthCard health={PriceSourceHealthSchema.parse(legacy)} nowSeconds={100} />);
    expect(screen.getByText(/567 cached assets/)).toBeTruthy();
    expect(screen.getByText("106")).toBeTruthy();
  });
  it("shows active missing prices while retaining all-cache counts", () => {
    const health = PriceSourceHealthSchema.parse({ ...legacy, active: { totalAssets: 334,
      confidenceDistribution: { high: 111, "single-source": 186, low: 20, fallback: 1 },
      sourceDistribution: { missing: 16 } } });
    render(<PriceSourceHealthCard health={health} nowSeconds={100} />);
    expect(screen.getByText(/334 active assets/)).toBeTruthy();
    expect(screen.getByText("16")).toBeTruthy();
    expect(screen.getByText("4.8%")).toBeTruthy();
    expect(screen.getByText(/Full cache: 567 rows · 106 missing/)).toBeTruthy();
  });
});

describe("price confidence severity calibration", () => {
  const liveShape = {
    totalAssets: 570, lastSync: 100,
    confidenceDistribution: { high: 116, "single-source": 335, low: 16, fallback: 7 },
    sourceDistribution: { missing: 96 },
    active: {
      totalAssets: 335,
      confidenceDistribution: { high: 115, "single-source": 187, low: 16, fallback: 7 },
      sourceDistribution: { missing: 10 },
      // Illustrative long-tail mix: 34% of rows high-confidence, 96.5% of value.
      confidenceMarketCapUsd: { high: 312_472_000_000, "single-source": 11_096_000_000, low: 154_000_000, fallback: 2_000_000 },
      pricedMarketCapUsd: 323_724_000_000,
      supplyCoverage: { complete: true, observedCount: 335, unavailableCount: 0 },
    },
  };

  it("colors High green when corroborated prices cover material value despite a low count share", () => {
    render(<PriceSourceHealthCard health={PriceSourceHealthSchema.parse(liveShape)} nowSeconds={100} />);
    expect(screen.getByText("115").className).toContain("text-emerald");
    expect(screen.getByText("96.5% of value")).toBeTruthy();
    expect(screen.getByText("3.4% of value")).toBeTruthy();
  });

  it("keeps Low neutral while low-confidence marks hold immaterial value", () => {
    render(<PriceSourceHealthCard health={PriceSourceHealthSchema.parse(liveShape)} nowSeconds={100} />);
    expect(screen.getByText("16").className).toContain("text-muted-foreground");
  });

  it("renders legacy snapshots without market-cap sums as unknown rather than red", () => {
    render(<PriceSourceHealthCard health={PriceSourceHealthSchema.parse(legacy)} nowSeconds={100} />);
    expect(screen.getByText("115").className).toContain("text-muted-foreground");
    expect(screen.getByText("20.3%")).toBeTruthy();
  });

  it("keeps partial value exposure neutral instead of certifying full-cohort confidence", () => {
    const health = PriceSourceHealthSchema.parse({
      ...liveShape,
      active: { ...liveShape.active, supplyCoverage: { complete: false, observedCount: 334, unavailableCount: 1 } },
    });
    render(<PriceSourceHealthCard health={health} nowSeconds={100} />);
    expect(screen.getByText("115").className).toContain("text-muted-foreground");
    expect(screen.queryByText(/% of value/)).toBeNull();
    expect(screen.getByText(/known priced-supply subtotal/).textContent).toContain("1 unavailable");
  });

  it("does not publish a zero-dollar exposure when no supply was observed", () => {
    const health = PriceSourceHealthSchema.parse({
      ...liveShape,
      active: { ...liveShape.active, pricedMarketCapUsd: 0,
        confidenceMarketCapUsd: { high: 0, "single-source": 0, low: 0, fallback: 0 },
        supplyCoverage: { complete: false, observedCount: 0, unavailableCount: 335 } },
    });
    render(<PriceSourceHealthCard health={health} nowSeconds={100} />);
    expect(screen.getByText(/Priced supply unavailable/)).toBeTruthy();
    expect(screen.queryByText(/\$0/)).toBeNull();
    expect(screen.getByText("115").className).toContain("text-muted-foreground");
  });

  it("drives the Missing tile from unacknowledged gaps only", () => {
    const health = PriceSourceHealthSchema.parse({
      ...liveShape,
      active: { ...liveShape.active, sourceDistribution: { missing: 9 }, acknowledgedMissingCount: 5 },
    });
    render(<PriceSourceHealthCard health={health} nowSeconds={100} />);
    expect(screen.getByText("4").className).toContain("text-red");
    expect(screen.getByText(/5 acknowledged/)).toBeTruthy();
  });

  it("goes amber when every remaining missing price is unacknowledged within the amber band", () => {
    const health = PriceSourceHealthSchema.parse({
      ...liveShape,
      active: { ...liveShape.active, sourceDistribution: { missing: 7 }, acknowledgedMissingCount: 5 },
    });
    render(<PriceSourceHealthCard health={health} nowSeconds={100} />);
    expect(screen.getByText("2").className).toContain("text-amber");
  });
});

describe("Markets and Missing tile review parity", () => {
  it.each([
    ["all acknowledged", 4, 4, true, 0, "healthy"],
    ["partially acknowledged", 4, 2, true, 2, "watch"],
    ["expired review producer count", 4, 0, true, 4, "critical"],
    ["legacy full-cache fallback", 4, undefined, false, 4, "critical"],
  ] as const)("uses unacknowledged counts for %s", (_label, missing, acknowledgedMissingCount, active, expectedCount, severity) => {
    const distribution = {
      totalAssets: 10, confidenceDistribution: { high: 6, "single-source": 0, low: 0, fallback: 0 },
      sourceDistribution: { missing }, acknowledgedMissingCount,
    };
    const health = PriceSourceHealthSchema.parse({
      ...distribution, lastSync: 100, ...(active ? { active: distribution } : {}),
    });
    const data = {
      ...makeHealthyStatusResponse(), priceSourceHealth: health,
      liquidityHealth: {
        lastRunStatus: "ok", currentCoverage: 10, previousCoverage: 10,
        currentGlobalTvl: 100, previousGlobalTvl: 100,
        currentTop10CoveredTvl: 100, previousTop10CoveredTvl: 100,
        currentTop10GuardTvl: 100, previousTop10GuardTvl: 100,
        failedSources: [], nearCoverageGuard: false, nearValueGuard: false, nearMajorCoverageGuard: false,
        currentCoverageClasses: { primary: 10, mixed: 0, fallback: 0, legacy: 0, unobserved: 0 },
        previousCoverageClasses: { primary: 10, mixed: 0, fallback: 0, legacy: 0, unobserved: 0 },
      },
      coingeckoPriceDiff: {
        checkedAt: 100, trackedWithGeckoId: 10, comparedCoins: 10, mismatchedCount: 0, thresholdPct: 5, rows: [],
      },
    };
    render(<PriceSourceHealthCard health={health} nowSeconds={100} />);
    const tile = within(screen.getByText("Missing").parentElement!);
    expect(tile.getByText(String(expectedCount))).toBeTruthy();
    if ((acknowledgedMissingCount ?? 0) > 0) expect(tile.getByText(/acknowledged/)).toBeTruthy();
    expect(buildPipelineModeSummaries(data).find((mode) => mode.id === "markets"))
      .toMatchObject({ issueCount: expectedCount, severity });
  });
});
