// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { CompareMobileSelectionControls } from "./client";
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
