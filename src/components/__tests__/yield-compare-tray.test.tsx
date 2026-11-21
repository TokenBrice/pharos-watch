// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import { YieldCompareTray } from "@/components/yield/yield-compare-tray";
import type { YieldViewModelRow } from "@/lib/yield-view-model";

vi.mock("@/components/stablecoin-logo", () => ({
  StablecoinLogo: ({ name, src }: { name: string; src?: string }) => (
    <span data-testid="logo" data-src={src ?? ""}>
      {name}
    </span>
  ),
}));

function makeRow(id: string, symbol: string, name: string): YieldViewModelRow {
  return { id, symbol, name } as unknown as YieldViewModelRow;
}

const rows: YieldViewModelRow[] = [
  makeRow("usdc-circle", "USDC", "USD Coin"),
  makeRow("usdt-tether", "USDT", "Tether"),
];


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

  it("respects --mobile-utility-safe-offset on mobile and tablet widths before dropping to bottom-4 at lg", () => {
    window.history.replaceState(null, "", "/yield/?compare=usdc-circle,usdt-tether");
    render(<YieldCompareTray rows={rows} logos={{}} onOpenDrawer={vi.fn()} />);

    const region = screen.getByRole("region", { name: "Compare selection" });
    expect(region.className).toContain("bottom-[calc(var(--mobile-utility-safe-offset,4.5rem)+0.75rem)]");
    expect(region.className).toContain("lg:bottom-4");
    expect(region.className).not.toContain("sm:bottom-4");
  });

});
