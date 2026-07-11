// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { YieldWatchlistStar } from "@/components/yield-watchlist-star";

const STORAGE_KEY = "pharos-watchlist-v1";
const gtag = vi.fn();

beforeEach(() => {
  window.localStorage.clear();
  window.gtag = gtag;
});

afterEach(() => {
  cleanup();
  gtag.mockReset();
  delete window.gtag;
});

describe("YieldWatchlistStar", () => {
  it("renders aria-pressed false with add label when not in watchlist", async () => {
    render(<YieldWatchlistStar stablecoinId="usdc-circle" symbol="USDC" />);
    const button = await screen.findByRole("button", { name: "Add USDC to watchlist" });
    expect(button.getAttribute("aria-pressed")).toBe("false");
    expect(button.getAttribute("data-active")).toBe("false");
  });

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

  it("reads existing watchlist state from storage", async () => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(["usdc-circle"]));
    render(<YieldWatchlistStar stablecoinId="usdc-circle" symbol="USDC" />);

    const button = await screen.findByRole("button", { name: "Remove USDC from watchlist" });
    expect(button.getAttribute("aria-pressed")).toBe("true");
  });
});
