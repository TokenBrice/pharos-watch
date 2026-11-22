// @vitest-environment jsdom
import { getPriceSourceHealthMissingCounts } from "@shared/lib/pricing-sources";
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PriceSourceHealthSchema } from "@shared/types/pricing-source-health";
import { PriceSourceHealthCard } from "@/components/status/price-source-health";
import { buildPipelineModeSummaries } from "@/lib/pipeline-workspace-model";
import { makeHealthyStatusResponse } from "@/test-utils/status-fixtures";

const legacy = {
  totalAssets: 567, lastSync: 100,
  confidenceDistribution: { high: 115, "single-source": 325, low: 20, fallback: 1 },
  sourceDistribution: { missing: 106 },
};

const liveShape = {
  totalAssets: 570, lastSync: 100,
  confidenceDistribution: { high: 116, "single-source": 335, low: 16, fallback: 7 },
  sourceDistribution: { missing: 96 },
  active: {
    totalAssets: 335,
    confidenceDistribution: { high: 115, "single-source": 187, low: 16, fallback: 7 },
    sourceDistribution: { missing: 10 },
    confidenceMarketCapUsd: { high: 312_472_000_000, "single-source": 11_096_000_000, low: 154_000_000, fallback: 2_000_000 },
    pricedMarketCapUsd: 323_724_000_000,
    supplyCoverage: { complete: true, observedCount: 335, unavailableCount: 0 },
  },
};

function renderCard(raw: unknown) {
  const health = PriceSourceHealthSchema.parse(raw);
  const view = render(<PriceSourceHealthCard health={health} nowSeconds={100} />);
  return { health, ...view };
}

it.each([[-5, 0, 7], [99, 7, 0], [3, 3, 4]])("bounds closure count %s by the remaining missing rows", (input, scheduledClosure, unacknowledged) => {
  expect(getPriceSourceHealthMissingCounts(9, 2, input)).toEqual({ acknowledged: 2, scheduledClosure, unacknowledged });
});

describe("price source health scope", () => {
  it("labels old payloads as cache-wide instead of claiming active scope", () => {
    renderCard(legacy);
    expect(screen.getByText(/567 cached assets/)).toBeTruthy();
    expect(screen.getByText("106")).toBeTruthy();
    expect(screen.getByText("20.3%")).toBeTruthy();
  });

  it("shows active missing prices while retaining all-cache counts", () => {
    renderCard({
      ...legacy,
      active: { totalAssets: 334, confidenceDistribution: { high: 111, "single-source": 186, low: 20, fallback: 1 }, sourceDistribution: { missing: 16 } },
    });
    expect(screen.getByText(/334 active assets/)).toBeTruthy();
    expect(screen.getByText("16")).toBeTruthy();
    expect(screen.getByText("4.8%")).toBeTruthy();
    expect(screen.getByText(/Full cache: 567 rows · 106 missing/)).toBeTruthy();
  });
});

describe("price confidence value coverage and missing splits", () => {
  it("displays value-weighted shares when corroborated prices cover complete supply", () => {
    renderCard(liveShape);
    expect(screen.getByText("115")).toBeTruthy();
    expect(screen.getByText("96.5% of value")).toBeTruthy();
    expect(screen.getByText("3.4% of value")).toBeTruthy();
  });

  it("withholds full-cohort value shares when priced supply coverage is partial", () => {
    renderCard({ ...liveShape, active: { ...liveShape.active, supplyCoverage: { complete: false, observedCount: 334, unavailableCount: 1 } } });
    expect(screen.queryByText(/% of value/)).toBeNull();
    expect(screen.getByText(/known priced-supply subtotal/).textContent).toContain("1 unavailable");
  });

  it("does not publish a zero-dollar exposure when no supply was observed", () => {
    renderCard({
      ...liveShape,
      active: {
        ...liveShape.active, pricedMarketCapUsd: 0,
        confidenceMarketCapUsd: { high: 0, "single-source": 0, low: 0, fallback: 0 },
        supplyCoverage: { complete: false, observedCount: 0, unavailableCount: 335 },
      },
    });
    expect(screen.getByText(/Priced supply unavailable/)).toBeTruthy();
    expect(screen.queryByText(/\$0/)).toBeNull();
  });

  it("keeps scheduled closures distinct from acknowledgements and drives Missing from unacknowledged gaps", () => {
    const { unmount } = renderCard({
      ...liveShape,
      active: { ...liveShape.active, sourceDistribution: { missing: 7 }, acknowledgedMissingCount: 2, scheduledClosureMissingCount: 5 },
    });
    const closedTile = within(screen.getByText("Missing").parentElement!);
    expect(closedTile.getByText("0")).toBeTruthy();
    expect(closedTile.getByText(/2 acknowledged · 5 market closed/)).toBeTruthy();
    unmount();

    renderCard({ ...liveShape, active: { ...liveShape.active, sourceDistribution: { missing: 9 }, acknowledgedMissingCount: 5 } });
    expect(within(screen.getByText("Missing").parentElement!).getByText("4")).toBeTruthy();
    expect(screen.getByText(/5 acknowledged/)).toBeTruthy();
  });
});

describe("Markets and Missing tile review parity", () => {
  it.each([
    ["all acknowledged", 4, 4, true, 0, "healthy", undefined],
    ["partially acknowledged", 4, 2, true, 2, "watch", undefined],
    ["expired review producer count", 4, 0, true, 4, "critical", undefined],
    ["legacy full-cache fallback", 4, undefined, false, 4, "critical", undefined],
    ["calendar closed", 5, 0, true, 0, "healthy", 5],
  ] as const)("uses unacknowledged counts for %s", (_label, missing, acknowledgedMissingCount, active, expectedCount, severity, scheduledClosureMissingCount) => {
    const dist = { totalAssets: 10, confidenceDistribution: { high: 6, "single-source": 0, low: 0, fallback: 0 }, sourceDistribution: { missing }, acknowledgedMissingCount, scheduledClosureMissingCount };
    const { health } = renderCard({ ...dist, lastSync: 100, ...(active ? { active: dist } : {}) });
    const cov = { primary: 10, mixed: 0, fallback: 0, legacy: 0, unobserved: 0 };
    const data = {
      ...makeHealthyStatusResponse(), priceSourceHealth: health,
      liquidityHealth: {
        lastRunStatus: "ok", currentCoverage: 10, previousCoverage: 10,
        currentGlobalTvl: 100, previousGlobalTvl: 100, currentTop10CoveredTvl: 100, previousTop10CoveredTvl: 100,
        currentTop10GuardTvl: 100, previousTop10GuardTvl: 100, failedSources: [],
        nearCoverageGuard: false, nearValueGuard: false, nearMajorCoverageGuard: false,
        currentCoverageClasses: cov, previousCoverageClasses: cov,
      },
      coingeckoPriceDiff: { checkedAt: 100, trackedWithGeckoId: 10, comparedCoins: 10, mismatchedCount: 0, thresholdPct: 5, rows: [] },
    };
    const tile = within(screen.getByText("Missing").parentElement!);
    expect(tile.getByText(String(expectedCount))).toBeTruthy();
    if ((acknowledgedMissingCount ?? 0) > 0) expect(tile.getByText(/acknowledged/)).toBeTruthy();
    expect(buildPipelineModeSummaries(data).find((mode) => mode.id === "markets")).toMatchObject({ issueCount: expectedCount, severity });
  });
});
