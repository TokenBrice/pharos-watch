// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CoinSelector } from "@/components/coin-selector";

const COINS = [
  { id: "usdc-circle", name: "USD Coin", symbol: "USDC" },
  { id: "usdt-tether", name: "Tether", symbol: "USDT" },
];

afterEach(cleanup);

describe("CoinSelector disabled state", () => {
  it("locks an open picker and prevents option selection", () => {
    const onSelect = vi.fn();
    const view = render(
      <CoinSelector coins={COINS} selected={null} onSelect={onSelect} onRemove={vi.fn()} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Add stablecoin..." }));
    view.rerender(
      <CoinSelector coins={COINS} selected={null} disabled onSelect={onSelect} onRemove={vi.fn()} />,
    );

    expect((screen.getByRole("button", { name: "Add stablecoin..." }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("combobox", { name: "Search coins" }) as HTMLInputElement).disabled).toBe(true);
    const option = screen.getByRole("option", { name: /USD Coin.*USDC/i });
    expect(option.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(option);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("prevents removal of a locked selection", () => {
    const onRemove = vi.fn();
    render(
      <CoinSelector coins={COINS} selected={COINS[0] ?? null} disabled onSelect={vi.fn()} onRemove={onRemove} />,
    );

    const remove = screen.getByRole("button", { name: "Remove USD Coin" }) as HTMLButtonElement;
    expect(remove.disabled).toBe(true);
    fireEvent.click(remove);
    expect(onRemove).not.toHaveBeenCalled();
  });
});
