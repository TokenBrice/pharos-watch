// @vitest-environment jsdom

import type { ComponentProps } from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BlacklistFilters, TOP_COIN_PILL_LIMIT } from "@/components/freezewatch/blacklist-filters";
import { BLACKLIST_STABLECOINS } from "@shared/types/blacklist";

const props = {
  chains: [
    { id: "ethereum", name: "Ethereum" },
    { id: "tron", name: "Tron" },
  ],
  stablecoinFilter: "all",
  chainFilter: "all",
  eventTypeFilter: "all",
  onStablecoinChange: vi.fn(),
  onChainChange: vi.fn(),
  onEventTypeChange: vi.fn(),
  onResetFilters: vi.fn(),
} satisfies ComponentProps<typeof BlacklistFilters>;

describe("BlacklistFilters", () => {
  beforeEach(() => {
    props.onStablecoinChange.mockReset();
    props.onChainChange.mockReset();
    props.onEventTypeChange.mockReset();
    props.onResetFilters.mockReset();
  });

  it("caps quick coin pills to All plus top-8 volume coins and exposes searchable All coins combobox", () => {
    const perCoinTotalEvents: Partial<Record<(typeof BLACKLIST_STABLECOINS)[number], number>> = {
      USDT: 9_692,
      USDC: 2_325,
      PAXG: 285,
      USDG: 237,
      USDO: 190,
      PYUSD: 140,
      EURC: 110,
      XAUT: 95,
      FDUSD: 40,
      BUIDL: 12,
    };

    render(<BlacklistFilters {...props} perCoinTotalEvents={perCoinTotalEvents} />);

    const primary = within(screen.getByRole("group", { name: "Filter by stablecoin" }));
    const buttons = primary.getAllByRole("button");
    // "All" + top 8 coins by event volume.
    expect(buttons).toHaveLength(1 + TOP_COIN_PILL_LIMIT);
    expect(buttons.map((btn) => btn.textContent)).toEqual([
      "All",
      "USDT",
      "USDC",
      "PAXG",
      "USDG",
      "USDO",
      "PYUSD",
      "EURC",
      "XAUT",
    ]);
    expect(primary.queryByRole("button", { name: "FDUSD" })).toBeNull();

    // Combobox trigger is present for selecting any tracked coin outside top-8.
    const comboboxTrigger = screen.getByRole("button", { name: "All coins" });
    expect(comboboxTrigger).toBeTruthy();

    fireEvent.click(primary.getByRole("button", { name: "USDT" }));
    expect(props.onStablecoinChange).toHaveBeenCalledWith("USDT");

    // Reset button stays hidden when no filters are active.
    expect(screen.queryByRole("button", { name: /reset filters/i })).toBeNull();
  });

  it("shows Reset filters when any filter is active and reflects non-top-8 selection in combobox", () => {
    render(
      <BlacklistFilters
        {...props}
        stablecoinFilter="BUIDL"
        chainFilter="ethereum"
        perCoinTotalEvents={{ USDT: 500, USDC: 200, BUIDL: 2 }}
      />,
    );

    const comboboxTrigger = screen.getByRole("button", { name: "All coins" });
    expect(comboboxTrigger.textContent).toContain("BUIDL (2)");

    const resetButton = screen.getByRole("button", { name: /reset filters/i });
    fireEvent.click(resetButton);
    expect(props.onResetFilters).toHaveBeenCalledOnce();
  });
});
