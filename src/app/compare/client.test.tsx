// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { CompareClient } from "@/components/compare/compare-client";
import type { CoinOption } from "@/lib/compare-types";

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

const collisionCoins = [
  { id: "ousd-open-standard", name: "Open USD", symbol: "OUSD" },
  { id: "ousd-origin-protocol", name: "Origin Dollar", symbol: "OUSD" },
];

vi.mock("@/hooks/use-compare-selection", () => ({
  useCompareSelection: () => ({
    coinOptions: collisionCoins, selectedCoins: collisionCoins,
    selectedIds: collisionCoins.map(coin => coin.id), disabledIds: new Set(),
    applyPreset: vi.fn(), handleRemove: vi.fn(), handleSelect: vi.fn(),
    setSelectedIds: vi.fn(), setFlowHours: vi.fn(), setRange: vi.fn(),
  }),
}));
vi.mock("@/hooks/use-compare-data-model", () => ({
  useCompareDataModel: () => ({
    comparisonCoins: [], detailErrors: [], flowCardData: [], flowSeries: [],
    freshnessQueries: [], radarCards: [], supplySeries: [], pegRates: {},
  }),
}));
vi.mock("@/hooks/use-compare-share-actions", () => ({
  useCompareShareActions: () => ({}),
}));
vi.mock("@/hooks/use-preferences", () => ({
  usePreference: () => ["peg", vi.fn()],
}));

describe("CompareClient collision identities", () => {
  it("identifies both selected assets in the heading and canonical detail links", () => {
    render(<CompareClient />);
    expect(screen.getByText("OUSD (Open USD) vs OUSD (Origin Dollar)")).toBeTruthy();
    expect(screen.getByRole("link", { name: "OUSD (Open USD) detail" }).getAttribute("href")).toMatch(/^\/stablecoin\/ousd-open-standard\/?$/);
    expect(screen.getByRole("link", { name: "OUSD (Origin Dollar) detail" }).getAttribute("href")).toMatch(/^\/stablecoin\/ousd-origin-protocol\/?$/);
  });
});

