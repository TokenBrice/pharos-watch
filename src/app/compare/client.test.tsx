// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import {
  CompareMobileSelectionControls,
} from "@/components/compare/compare-client";
import { buildCompareSelectionInsights } from "@/lib/compare-selection-insights";
import type { CoinOption } from "@/lib/compare-types";
import type { ComparisonCoinEntry } from "@/lib/compare-derive";

vi.mock("next/dynamic", () => ({
  default: () => () => null,
}));

vi.mock("@/components/coin-selector", () => ({
  CoinSelector: ({
    coins,
    disabledIds,
    onRemove,
    onSelect,
    selected,
  }: {
    coins: CoinOption[];
    disabledIds?: Set<string>;
    onRemove: () => void;
    onSelect: (coin: CoinOption) => void;
    selected: CoinOption | null;
  }) => selected ? (
    <div>
      <span>{selected.symbol}</span>
      <button type="button" onClick={onRemove}>Remove {selected.symbol}</button>
    </div>
  ) : (
    <button
      type="button"
      onClick={() => onSelect(coins.find((coin) => !disabledIds?.has(coin.id)) ?? coins[0])}
    >
      Add coin
    </button>
  ),
}));

const coins: CoinOption[] = [
  { id: "usdt-tether", name: "Tether", symbol: "USDT" },
  { id: "usdc-circle", name: "USD Coin", symbol: "USDC" },
  { id: "dai-makerdao", name: "Dai", symbol: "DAI" },
];

describe("CompareMobileSelectionControls", () => {
  it("uses the next mobile add slot without rendering empty desktop slots", () => {
    const onSelect = vi.fn();
    const onRemove = vi.fn();
    const onClear = vi.fn();

    render(
      <CompareMobileSelectionControls
        selectedIds={["usdt-tether", "usdc-circle"]}
        selectedCoins={[coins[0], coins[1]]}
        coinOptions={coins}
        disabledIds={new Set(["usdt-tether", "usdc-circle"])}
        onSelect={onSelect}
        onRemove={onRemove}
        onClear={onClear}
      />,
    );

    expect(screen.getByText("2/5 selected")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Add coin" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove USDC" }));
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));

    expect(onSelect).toHaveBeenCalledWith(2, coins[2]);
    expect(onRemove).toHaveBeenCalledWith(1);
    expect(onClear).toHaveBeenCalledTimes(1);
  });
});

function makeComparisonCoin(
  id: string,
  symbol: string,
  flags: {
    pegCurrency: string;
    governance: string;
    backing: string;
  },
): ComparisonCoinEntry {
  return {
    id,
    symbol,
    name: symbol,
    data: { id, symbol, name: symbol },
    meta: { id, symbol, name: symbol, flags },
  } as unknown as ComparisonCoinEntry;
}

describe("buildCompareSelectionInsights", () => {
  it("describes same-peg peer sets and keeps detail links in selected order", () => {
    const insights = buildCompareSelectionInsights({
      selectedIds: ["usdc-circle", "usdt-tether"],
      selectedCoins: [coins[1], coins[0]],
      comparisonCoins: [
        makeComparisonCoin("usdc-circle", "USDC", {
          pegCurrency: "USD",
          governance: "centralized",
          backing: "rwa-backed",
        }),
        makeComparisonCoin("usdt-tether", "USDT", {
          pegCurrency: "USD",
          governance: "centralized",
          backing: "rwa-backed",
        }),
      ],
    });

    expect(insights?.lens).toContain("Same-peg peer set");
    expect(insights?.cohort).toContain("Centralized");
    expect(insights?.structure).toContain("Real-World Asset Backed");
    expect(insights?.structure).toContain("Common peg target: US Dollar");
    expect(insights?.links.map((coin) => coin.id)).toEqual(["usdc-circle", "usdt-tether"]);
  });

  it("falls back to loading guidance until comparison metadata lands", () => {
    const insights = buildCompareSelectionInsights({
      selectedIds: ["usdc-circle", "usdt-tether"],
      selectedCoins: [coins[1], coins[0]],
      comparisonCoins: [],
    });

    expect(insights?.cohort).toBe("Live metadata is still loading for the selected set.");
    expect(insights?.links.map((coin) => coin.symbol)).toEqual(["USDC", "USDT"]);
  });
});
