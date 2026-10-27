// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const useCompareDataModelMock = vi.hoisted(() => vi.fn());
const compareOptions = vi.hoisted(() => [
  { id: "usdc-circle", name: "USD Coin", symbol: "USDC", frozen: false },
  { id: "ust-terra", name: "TerraUSD", symbol: "UST", frozen: true },
  { id: "eurc-circle", name: "EURC", symbol: "EURC", frozen: false },
]);
vi.mock("@/hooks/use-compare-data-model", () => ({ useCompareDataModel: useCompareDataModelMock }));
vi.mock("@/hooks/use-compare-selection", () => ({
  useCompareSelection: () => ({
    selectedIds: ["usdc-circle", "usdt-tether"], selectedCoins: [null, null], coinOptions: compareOptions,
    disabledIds: new Set(), flowHours: 24, range: "all", applyPreset: vi.fn(), handleRemove: vi.fn(),
    handleSelect: vi.fn(), setSelectedIds: vi.fn(), setFlowHours: vi.fn(), setRange: vi.fn(),
  }),
}));
vi.mock("@/hooks/use-compare-share-actions", () => ({
  useCompareShareActions: () => ({ handleDownload: vi.fn(), handleTwitterShare: vi.fn(), handleWebShare: vi.fn(), shareLoading: false }),
}));
vi.mock("@/hooks/use-preferences", () => ({ usePreference: () => ["peg", vi.fn()] }));
vi.mock("next/dynamic", () => ({ default: () => () => null }));
vi.mock("@/components/coin-selector", () => ({ CoinSelector: () => null }));

import { CompareClient } from "@/components/compare/compare-client";

describe("CompareClient flow coverage", () => {
  it.each([null, 0, 1])("distinguishes unavailable aggregate coverage (%s) from an observed tracking count", (flowCoverageCount) => {
    useCompareDataModelMock.mockReturnValue({
      comparisonCoins: [], detailErrors: {}, detailLoading: false, flowCardData: [], flowCoverageCount,
      flowErrorNotice: null, flowScopeLabel: "Configured issuance chains", flowSeries: [{ id: "usdc-circle", data: [] }],
      flowUpdatedAt: null, freshnessQueries: [], globalError: null, handleRetry: vi.fn(), hasPrimaryData: true,
      pegRates: {}, radarCards: [], supplySeries: [],
    });
    const { container } = render(<CompareClient />);
    expect(screen.getByRole("heading", { name: "Live Flow Signals" })).toBeTruthy();
    if (flowCoverageCount === null) {
      expect(screen.getByText("Issuance-flow tracking coverage is unavailable.")).toBeTruthy();
      expect(container.textContent).not.toContain("0 of 2 selected coins have tracked issuance flows");
    } else {
      expect(screen.getByText(`${flowCoverageCount} of 2 selected coins have tracked issuance flows.`)).toBeTruthy();
      expect(container.textContent).not.toContain("tracking coverage is unavailable");
    }
  });

  it("names the active-plus-frozen population behind the comparable count", () => {
    useCompareDataModelMock.mockReturnValue({
      comparisonCoins: [], detailErrors: {}, detailLoading: false, flowCardData: [], flowCoverageCount: 0,
      flowErrorNotice: null, flowScopeLabel: "Configured issuance chains", flowSeries: [],
      flowUpdatedAt: null, freshnessQueries: [], globalError: null, handleRetry: vi.fn(), hasPrimaryData: true,
      pegRates: {}, radarCards: [], supplySeries: [],
    });
    const { container } = render(<CompareClient />);
    const hero = screen.getByRole("group", { name: "Comparison scope overview" });
    expect(hero.textContent).toContain("Active + frozen");
    expect(hero.textContent).toContain("3");
    expect(container.textContent).not.toContain("Stablecoins ready to compare");
  });
});
