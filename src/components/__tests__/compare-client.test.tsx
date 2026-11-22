// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
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

import { CompareClient } from "@/components/compare/compare-client";
import { CompareCoinSlot } from "@/components/compare/compare-coin-slot";
import { CompareEmptyState } from "@/components/compare/compare-empty-state";
import { CoinSelector } from "@/components/coin-selector";
import { FlowComparisonChart } from "@/components/compare/flow-comparison-chart";
import { COMPARISON_PRESETS } from "@/lib/compare-config";
import { WATCHLIST_STORAGE_KEY } from "@/lib/watchlist-storage";

describe("CompareClient and coin selector", () => {
  it("discloses each hourly series scope", () => {
    render(<FlowComparisonChart series={[{ id: "usdt", label: "USDT", color: "red", data: [{ ts: 1, netFlowUsd: 100 }],
      unavailableHours: 0, unknownCoverageHours: 0, hourlyScopeLabel: "Tron-only" }]} hours={24} onHoursChange={vi.fn()} />);
    expect(screen.getByText("Hourly scope: USDT: Tron-only.")).toBeTruthy();
  });
  it.each(["ArrowDown", "ArrowUp"])("keeps active references valid for empty and replaced results (%s)", (key) => {
    const props = { coins: compareOptions, selected: null, onSelect: vi.fn(), onRemove: vi.fn() };
    const { rerender } = render(<CoinSelector {...props} coins={[]} />);
    fireEvent.click(screen.getByRole("button"));
    const input = screen.getByRole("combobox");
    fireEvent.keyDown(input, { key });
    expect(input.getAttribute("aria-activedescendant")).toBeNull();
    rerender(<CoinSelector {...props} />);
    expect(input.getAttribute("aria-activedescendant")).toBeNull();
    screen.getAllByRole("option").forEach((option) => { option.scrollIntoView = vi.fn(); });
    fireEvent.keyDown(input, { key });
    expect(screen.getAllByRole("option").map((option) => option.id)).toContain(input.getAttribute("aria-activedescendant"));
    rerender(<CoinSelector {...props} coins={[]} />);
    expect(input.getAttribute("aria-activedescendant")).toBeNull();
  });
  it.each(["Escape", "Tab", "outside", "toggle", "click", "Enter"])("resets dismissal state via %s while preserving selection guards", (action) => {
    const onSelect = vi.fn();
    render(<CoinSelector coins={compareOptions} selected={null} disabledIds={new Set([compareOptions[0].id])} onSelect={onSelect} onRemove={vi.fn()} />);
    const button = screen.getByRole("button");
    fireEvent.click(button);
    const input = screen.getByRole("combobox");
    fireEvent.change(input, { target: { value: "USD" } });
    const options = screen.getAllByRole("option");
    options.forEach((option) => { option.scrollIntoView = vi.fn(); });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.click(options[0]);
    expect(onSelect).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: "ArrowDown" });
    if (action === "outside") fireEvent.mouseDown(document.body);
    else if (action === "toggle") fireEvent.click(button);
    else if (action === "click") fireEvent.click(options[1]);
    else fireEvent.keyDown(input, { key: action });
    expect(screen.queryByRole("combobox")).toBeNull();
    if (action === "Escape") expect(document.activeElement).toBe(button);
    expect(onSelect.mock.calls).toEqual(action === "click" || action === "Enter" ? [[compareOptions[1]]] : []);
    fireEvent.click(button);
    expect(screen.getByRole("combobox").getAttribute("value")).toBe("");
    expect(screen.getByRole("combobox").getAttribute("aria-activedescendant")).toBeNull();
  });
  it.each([null, 0, 1])("distinguishes unavailable aggregate coverage (%s) from an observed tracking count", (flowCoverageCount) => {
    useCompareDataModelMock.mockReturnValue({
      comparisonCoins: [], detailErrors: {}, detailLoading: false, flowCardData: [], flowCoverageCount,
      flowErrorNotice: null, flowScopeLabel: "Configured issuance chains", flowSeries: [{ id: "usdc-circle", data: [] }],
      flowUpdatedAt: null, freshnessQueries: [], globalError: null, handleRetry: vi.fn(), hasPrimaryData: true,
      radarCards: [], supplySeries: [],
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

  it("labels the flow generation with the producer clock, never a clamped zero age", () => {
    const nowSec = 1_700_000_000;
    const model = (flowUpdatedAt: number) => ({
      comparisonCoins: [], detailErrors: {}, detailLoading: false, flowCardData: [], flowCoverageCount: 0,
      flowErrorNotice: null, flowScopeLabel: "Configured issuance chains", flowSeries: [{ id: "usdc-circle", data: [] }],
      flowUpdatedAt, freshnessQueries: [], globalError: null, handleRetry: vi.fn(), hasPrimaryData: true,
      radarCards: [], supplySeries: [],
    });
    vi.useFakeTimers();
    vi.setSystemTime(nowSec * 1000);
    try {
      useCompareDataModelMock.mockReturnValue(model(nowSec - 3_660));
      const { unmount } = render(<CompareClient />);
      expect(screen.getByText("Updated 61 min ago · Admitted totals: Configured issuance chains")).toBeTruthy();
      unmount();

      // A reader clock behind the producer has no computable age: no fresh claim.
      useCompareDataModelMock.mockReturnValue(model(nowSec + 7_200));
      render(<CompareClient />);
      expect(screen.queryByText(/min ago/)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("names the active-plus-frozen population behind the comparable count", () => {
    window.localStorage.removeItem(WATCHLIST_STORAGE_KEY);
    useCompareDataModelMock.mockReturnValue({
      comparisonCoins: [], detailErrors: {}, detailLoading: false, flowCardData: [], flowCoverageCount: 0,
      flowErrorNotice: null, flowScopeLabel: "Configured issuance chains", flowSeries: [],
      flowUpdatedAt: null, freshnessQueries: [], globalError: null, handleRetry: vi.fn(), hasPrimaryData: true,
      radarCards: [], supplySeries: [],
    });
    const { container } = render(<CompareClient />);
    const hero = screen.getByRole("group", { name: "Comparison scope overview" });
    expect(hero.textContent).toContain("Active + frozen");
    expect(hero.textContent).toContain("3");
    expect(hero.textContent).toContain(`${COMPARISON_PRESETS.length - 1} preset packs`);
    expect(container.textContent).not.toContain("Stablecoins ready to compare");
    expect(screen.getByRole("link", { name: "Model in Portfolio" }).getAttribute("href")).toMatch(
      /^\/portfolio\/?\?coins=usdc-circle%2Cusdt-tether$/,
    );
    expect(screen.getByRole("button", { name: "Copy comparison link" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Share comparison image" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Clear all selected coins" })).toBeTruthy();
  });

  it("allows click-to-swap on a filled CompareCoinSlot without removing first", () => {
    const onSelect = vi.fn();
    const onRemove = vi.fn();
    render(
      <CompareCoinSlot
        coins={compareOptions}
        selected={compareOptions[0]}
        disabledIds={new Set([compareOptions[0].id])}
        onSelect={onSelect}
        onRemove={onRemove}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Swap USD Coin (USDC)" }));
    const search = screen.getByRole("combobox", { name: "Replace USD Coin" });
    fireEvent.change(search, { target: { value: "EURC" } });
    fireEvent.click(screen.getByRole("option", { name: /EURC/ }));
    expect(onSelect).toHaveBeenCalledWith(compareOptions[2]);
    expect(onRemove).not.toHaveBeenCalled();
  });

  it("hides the My Watchlist preset until at least two comparable coins are starred", () => {
    window.localStorage.removeItem(WATCHLIST_STORAGE_KEY);
    const { unmount } = render(<CompareEmptyState presets={COMPARISON_PRESETS} onApplyPreset={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "Apply My Watchlist preset" })).toBeNull();
    expect(screen.getByText(`${COMPARISON_PRESETS.length - 1} packs`)).toBeTruthy();
    unmount();

    window.localStorage.setItem(WATCHLIST_STORAGE_KEY, JSON.stringify(["usdc-circle", "usdt-tether"]));
    try {
      render(<CompareEmptyState presets={COMPARISON_PRESETS} onApplyPreset={vi.fn()} />);
      expect(screen.getByRole("button", { name: "Apply My Watchlist preset" })).toBeTruthy();
      expect(screen.getByText(`${COMPARISON_PRESETS.length} packs`)).toBeTruthy();
    } finally {
      window.localStorage.removeItem(WATCHLIST_STORAGE_KEY);
    }
  });
});
