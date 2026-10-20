// @vitest-environment jsdom

import type { ComponentProps } from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { BlacklistFilters } from "@/components/blacklist-filters";

const props = {
  chains: [],
  stablecoinFilter: "USDT",
  chainFilter: "all",
  eventTypeFilter: "all",
  onStablecoinChange: vi.fn(),
  onChainChange: vi.fn(),
  onEventTypeChange: vi.fn(),
} satisfies ComponentProps<typeof BlacklistFilters>;

describe("BlacklistFilters", () => {
  it("keeps unknown counts selectable and groups only explicit zero counts", () => {
    render(<BlacklistFilters {...props} perCoinTotalEvents={{ USDC: 0, PAXG: 2 }} />);

    const primary = within(screen.getByRole("group", { name: "Filter by stablecoin" }));
    expect(primary.getByRole("button", { name: "USDT", pressed: true })).toBeTruthy();
    expect(primary.getByRole("button", { name: "PAXG" })).toBeTruthy();
    expect(primary.queryByRole("button", { name: "USDC" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { expanded: false }));
    const zeroCounts = within(screen.getByRole("group", { name: "Filter by stablecoin without recorded events" }));
    expect(zeroCounts.getAllByRole("button")).toHaveLength(1);
    expect(zeroCounts.getByRole("button", { name: "USDC" })).toBeTruthy();
    fireEvent.click(primary.getByRole("button", { name: "USDT" }));
    expect(props.onStablecoinChange).toHaveBeenCalledWith("USDT");
  });

  it("retains the selected coin as counts arrive and later become unknown", () => {
    const view = render(<BlacklistFilters {...props} />);
    expect(screen.getByRole("button", { name: "USDT", pressed: true })).toBeTruthy();

    view.rerender(<BlacklistFilters {...props} perCoinTotalEvents={{ USDT: 0 }} />);
    const zeroCounts = within(screen.getByRole("group", { name: "Filter by stablecoin without recorded events" }));
    expect(zeroCounts.getByRole("button", { name: "USDT", pressed: true })).toBeTruthy();
    expect(screen.getByRole("button", { expanded: true })).toBeTruthy();

    view.rerender(<BlacklistFilters {...props} perCoinTotalEvents={{ USDC: 0 }} />);
    const primary = within(screen.getByRole("group", { name: "Filter by stablecoin" }));
    expect(primary.getByRole("button", { name: "USDT", pressed: true })).toBeTruthy();
    expect(screen.queryByRole("group", { name: "Filter by stablecoin without recorded events" })).toBeNull();
  });
});
