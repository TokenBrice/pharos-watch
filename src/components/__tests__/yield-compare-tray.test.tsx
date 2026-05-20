// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { YieldCompareTray } from "@/components/yield-compare-tray";
import type { YieldViewModelRow } from "@/lib/yield-view-model";

vi.mock("@/components/stablecoin-logo", () => ({
  StablecoinLogo: ({ name }: { name: string }) => <span data-testid="logo">{name}</span>,
}));

function makeRow(id: string, symbol: string, name: string): YieldViewModelRow {
  return { id, symbol, name } as unknown as YieldViewModelRow;
}

const rows: YieldViewModelRow[] = [
  makeRow("usdc-circle", "USDC", "USD Coin"),
  makeRow("usdt-tether", "USDT", "Tether"),
];

afterEach(() => {
  cleanup();
});

beforeEach(() => {
  window.history.replaceState(null, "", "/yield/");
});

describe("YieldCompareTray", () => {
  it("renders nothing when no ids are selected", () => {
    const { container } = render(
      <YieldCompareTray rows={rows} logos={{}} onOpenDrawer={vi.fn()} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("shows the selection count and disables Compare when only one id is selected", () => {
    window.history.replaceState(null, "", "/yield/?compare=usdc-circle");
    const onOpenDrawer = vi.fn();
    render(<YieldCompareTray rows={rows} logos={{}} onOpenDrawer={onOpenDrawer} />);

    expect(screen.getByText("1 selected")).toBeTruthy();
    const compareButton = screen.getByRole("button", {
      name: "Select at least 2 coins to compare",
    });
    expect((compareButton as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(compareButton);
    expect(onOpenDrawer).not.toHaveBeenCalled();
  });

  it("enables Compare and forwards the click when 2+ ids are selected", () => {
    window.history.replaceState(null, "", "/yield/?compare=usdc-circle,usdt-tether");
    const onOpenDrawer = vi.fn();
    render(<YieldCompareTray rows={rows} logos={{}} onOpenDrawer={onOpenDrawer} />);

    expect(screen.getByText("2 selected")).toBeTruthy();
    const compareButton = screen.getByRole("button", { name: "Open compare drawer" });
    expect((compareButton as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(compareButton);
    expect(onOpenDrawer).toHaveBeenCalledTimes(1);
  });

  it("Clear button removes all ids from the URL", () => {
    window.history.replaceState(null, "", "/yield/?compare=usdc-circle,usdt-tether");
    render(<YieldCompareTray rows={rows} logos={{}} onOpenDrawer={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "Clear compare selection" }));
    expect(window.location.search).toBe("");
  });
});
