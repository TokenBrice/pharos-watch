// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { YieldLeaderboardControls } from "@/components/yield-leaderboard-controls";
import { makeYieldProvenance, makeYieldRanking } from "@shared/test-utils/yield-ranking-fixtures";
import { buildYieldViewModel, prepareYieldUniverse } from "@/lib/yield-view-model";

const STORAGE_KEY = "pharos-watchlist-v1";

const rows = [
  makeYieldRanking({
    id: "usdc-circle",
    symbol: "USDC",
    name: "USD Coin",
    yieldType: "lending-opportunity",
    safetyScore: 82,
    sourceTvlUsd: 5_000_000,
    pharosYieldScore: 72,
    provenance: makeYieldProvenance({ confidenceTier: "curated", sourceSwitch: true }),
  }),
  makeYieldRanking({
    id: "usdt-tether",
    symbol: "USDT",
    name: "Tether USD",
    yieldType: "lending-opportunity",
    warningSignals: ["low-source-tvl"],
    safetyScore: 65,
    sourceTvlUsd: 50_000_000,
    pharosYieldScore: 58,
    provenance: makeYieldProvenance({ confidenceTier: "discovered" }),
  }),
];

beforeEach(() => {
  window.localStorage.clear();
});


function buildModel(params: Parameters<typeof buildYieldViewModel>[1] = {}, watchlistIds?: ReadonlySet<string>) {
  return buildYieldViewModel(prepareYieldUniverse(rows, watchlistIds ?? null), params);
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

  it("does not render the Watching chip when the watchlist is empty", () => {
    render(
      <YieldLeaderboardControls
        viewModel={buildModel()}
        onFilterChange={vi.fn()}
        onClearFilters={vi.fn()}
        onApplyPreset={vi.fn()}
      />,
    );

    expect(screen.queryByRole("button", { name: /^Watching\d+$/ })).toBeNull();
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

  it("shows a watchlist attention inbox chip and toggles its composite filter", () => {
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

    const chip = screen.getByRole("button", { name: /^Needs attention\d+$/ });
    expect(chip.textContent).toContain("2");
    expect(chip.getAttribute("data-active")).toBe("false");
    expect(chip.getAttribute("aria-pressed")).toBe("false");

    fireEvent.click(chip);
    expect(onFilterChange).toHaveBeenCalledWith("attention", "watchlist");
  });

  it("renders the attention inbox chip as active and toggles back to all", () => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(["usdc-circle"]));
    const onFilterChange = vi.fn();

    render(
      <YieldLeaderboardControls
        viewModel={buildModel({ attention: "watchlist" }, new Set(["usdc-circle"]))}
        onFilterChange={onFilterChange}
        onClearFilters={vi.fn()}
        onApplyPreset={vi.fn()}
      />,
    );

    const chip = screen.getByRole("button", { name: /^Needs attention\d+$/ });
    expect(chip.getAttribute("data-active")).toBe("true");
    expect(chip.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByText("Starred rows with warnings or source changes")).toBeTruthy();

    fireEvent.click(chip);
    expect(onFilterChange).toHaveBeenCalledWith("attention", "all");
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

  describe("yield-type cohort tab strip", () => {
    const cohortRows = [
      makeYieldRanking({
        id: "usdc-aave",
        symbol: "USDC",
        name: "USD Coin",
        yieldType: "lending-opportunity",
      }),
      makeYieldRanking({
        id: "usdt-aave",
        symbol: "USDT",
        name: "Tether USD",
        yieldType: "lending-opportunity",
      }),
      makeYieldRanking({
        id: "dai-aave",
        symbol: "DAI",
        name: "Dai Stablecoin",
        yieldType: "lending-opportunity",
      }),
      makeYieldRanking({
        id: "susde-ethena",
        symbol: "sUSDe",
        name: "Staked USDe",
        yieldType: "rebase",
      }),
      makeYieldRanking({
        id: "susds-sky",
        symbol: "sUSDS",
        name: "Sky Savings",
        yieldType: "rebase",
      }),
      makeYieldRanking({
        id: "scrvusd-curve",
        symbol: "scrvUSD",
        name: "Savings crvUSD",
        yieldType: "fee-sharing",
      }),
    ];

    function buildCohortModel(params: Parameters<typeof buildYieldViewModel>[1] = {}) {
      return buildYieldViewModel(prepareYieldUniverse(cohortRows, null), params);
    }

    it("renders non-zero yield types in descending count order with All first", () => {
      render(
        <YieldLeaderboardControls
          viewModel={buildCohortModel()}
          onFilterChange={vi.fn()}
          onClearFilters={vi.fn()}
          onApplyPreset={vi.fn()}
        />,
      );

      const group = screen.getByRole("group", { name: "Filter by yield type" });
      const tabLabels = Array.from(
        group.querySelectorAll<HTMLButtonElement>("button[aria-pressed]"),
      ).map((button) => button.textContent ?? "");

      expect(tabLabels).toEqual([
        "All types6",
        "Lending Opp.3",
        "Rebase2",
        "Fee Share1",
      ]);
    });

    it("invokes onFilterChange with the yield type when a tab is clicked", () => {
      const onFilterChange = vi.fn();
      render(
        <YieldLeaderboardControls
          viewModel={buildCohortModel()}
          onFilterChange={onFilterChange}
          onClearFilters={vi.fn()}
          onApplyPreset={vi.fn()}
        />,
      );

      const group = screen.getByRole("group", { name: "Filter by yield type" });
      const rebaseTab = Array.from(
        group.querySelectorAll<HTMLButtonElement>("button[aria-pressed]"),
      ).find((button) => button.textContent?.startsWith("Rebase"));
      expect(rebaseTab).toBeTruthy();

      fireEvent.click(rebaseTab!);
      expect(onFilterChange).toHaveBeenCalledWith("yieldType", "rebase");
    });

    it("marks the active tab when filters.yieldType matches", () => {
      render(
        <YieldLeaderboardControls
          viewModel={buildCohortModel({ yieldType: "rebase" })}
          onFilterChange={vi.fn()}
          onClearFilters={vi.fn()}
          onApplyPreset={vi.fn()}
        />,
      );

      const group = screen.getByRole("group", { name: "Filter by yield type" });
      const tabs = Array.from(
        group.querySelectorAll<HTMLButtonElement>("button[aria-pressed]"),
      );
      const activeTabs = tabs.filter((button) => button.getAttribute("aria-pressed") === "true");
      expect(activeTabs).toHaveLength(1);
      expect(activeTabs[0]?.textContent).toContain("Rebase");
    });
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
