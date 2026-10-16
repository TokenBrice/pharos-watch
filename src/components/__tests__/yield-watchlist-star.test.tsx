// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { YieldWatchlistStar } from "@/components/yield-watchlist-star";

const STORAGE_KEY = "pharos-watchlist-v1";
const gtag = vi.fn();

beforeEach(() => {
  window.localStorage.clear();
  window.gtag = gtag;
});

afterEach(() => {
  gtag.mockReset();
  delete window.gtag;
});

describe("YieldWatchlistStar", () => {
  it("toggles to aria-pressed true after click and persists to storage", async () => {
    render(<YieldWatchlistStar stablecoinId="usdc-circle" symbol="USDC" />);
    const button = await screen.findByRole("button", { name: "Add USDC to watchlist" });

    fireEvent.click(button);

    const toggled = await screen.findByRole("button", { name: "Remove USDC from watchlist" });
    expect(toggled.getAttribute("aria-pressed")).toBe("true");
    expect(toggled.getAttribute("data-active")).toBe("true");

    await waitFor(() => {
      const stored = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "null");
      expect(stored).toEqual(["usdc-circle"]);
    });
    expect(gtag).toHaveBeenCalledWith("event", "yield_watchlist_changed", {
      action: "added",
      coin_id: "usdc-circle",
    });
  });

});
