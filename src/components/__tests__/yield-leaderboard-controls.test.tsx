// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { YieldLeaderboardControls } from "@/components/yield-leaderboard-controls";
import { makeYieldProvenance, makeYieldRanking } from "@/app/yield/test-helpers";
import { buildYieldViewModel } from "@/lib/yield-view-model";

const STORAGE_KEY = "pharos:yield-watchlist:v1";

const rows = [
  makeYieldRanking({
    id: "usdc-circle",
    symbol: "USDC",
    name: "USD Coin",
    yieldType: "lending-opportunity",
    safetyScore: 82,
    sourceTvlUsd: 5_000_000,
    pharosYieldScore: 72,
    provenance: makeYieldProvenance({ confidenceTier: "curated" }),
  }),
  makeYieldRanking({
    id: "usdt-tether",
    symbol: "USDT",
    name: "Tether USD",
    yieldType: "lending-opportunity",
    safetyScore: 65,
    sourceTvlUsd: 50_000_000,
    pharosYieldScore: 58,
    provenance: makeYieldProvenance({ confidenceTier: "discovered" }),
  }),
];

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
});

function buildModel(params: Parameters<typeof buildYieldViewModel>[1] = {}, watchlistIds?: ReadonlySet<string>) {
  return buildYieldViewModel(rows, params, { watchlistIds: watchlistIds ?? null });
}

describe("YieldLeaderboardControls", () => {
  it("renders the controls without throwing", () => {
    render(
      <YieldLeaderboardControls
        viewModel={buildModel()}
        onFilterChange={vi.fn()}
        onClearFilters={vi.fn()}
        onApplyPreset={vi.fn()}
      />,
    );

    expect(screen.getByPlaceholderText("Search stablecoin...")).toBeTruthy();
  });

  it("renders the Watching chip as disabled when the watchlist is empty", () => {
    render(
      <YieldLeaderboardControls
        viewModel={buildModel()}
        onFilterChange={vi.fn()}
        onClearFilters={vi.fn()}
        onApplyPreset={vi.fn()}
      />,
    );

    const chip = screen.getByRole("button", { name: /^Watching\d+$/ });
    expect(chip.hasAttribute("disabled")).toBe(true);
    expect(chip.getAttribute("aria-disabled")).toBe("true");
    expect(chip.getAttribute("data-active")).toBe("false");
    expect(chip.getAttribute("title")).toBe("Star yields on the leaderboard to follow them here");
  });

  it("shows the watchlist count and toggles the filter when clicked", () => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(["usdc-circle", "usdt-tether"]));
    const onFilterChange = vi.fn();

    render(
      <YieldLeaderboardControls
        viewModel={buildModel({}, new Set(["usdc-circle", "usdt-tether"]))}
        onFilterChange={onFilterChange}
        onClearFilters={vi.fn()}
        onApplyPreset={vi.fn()}
      />,
    );

    const chip = screen.getByRole("button", { name: /^Watching\d+$/ });
    expect(chip.hasAttribute("disabled")).toBe(false);
    expect(chip.textContent).toContain("2");
    expect(chip.getAttribute("data-active")).toBe("false");
    expect(chip.getAttribute("aria-pressed")).toBe("false");

    fireEvent.click(chip);
    expect(onFilterChange).toHaveBeenCalledWith("watchlist", "only");
  });

  it("renders the Watching chip as active and toggles back to all when already filtering", () => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(["usdc-circle"]));
    const onFilterChange = vi.fn();

    render(
      <YieldLeaderboardControls
        viewModel={buildModel({ watchlist: "only" }, new Set(["usdc-circle"]))}
        onFilterChange={onFilterChange}
        onClearFilters={vi.fn()}
        onApplyPreset={vi.fn()}
      />,
    );

    const chip = screen.getByRole("button", { name: /^Watching\d+$/ });
    expect(chip.getAttribute("data-active")).toBe("true");
    expect(chip.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByText("Watching only")).toBeTruthy();

    fireEvent.click(chip);
    expect(onFilterChange).toHaveBeenCalledWith("watchlist", "all");
  });

  it("clears the watchlist filter from the active-filter pill", () => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(["usdc-circle"]));
    const onFilterChange = vi.fn();

    render(
      <YieldLeaderboardControls
        viewModel={buildModel({ watchlist: "only" }, new Set(["usdc-circle"]))}
        onFilterChange={onFilterChange}
        onClearFilters={vi.fn()}
        onApplyPreset={vi.fn()}
      />,
    );

    const pill = screen.getByRole("button", { name: /Watching only/ });
    fireEvent.click(pill);
    expect(onFilterChange).toHaveBeenCalledWith("watchlist", "all");
  });
});
