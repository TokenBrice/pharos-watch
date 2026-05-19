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
        onApplyRiskBudget={vi.fn()}
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
        onApplyRiskBudget={vi.fn()}
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
        onApplyRiskBudget={vi.fn()}
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
        onApplyRiskBudget={vi.fn()}
      />,
    );

    const chip = screen.getByRole("button", { name: /^Watching\d+$/ });
    expect(chip.getAttribute("data-active")).toBe("true");
    expect(chip.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByText("Watching only")).toBeTruthy();

    fireEvent.click(chip);
    expect(onFilterChange).toHaveBeenCalledWith("watchlist", "all");
  });

  it("renders the risk-budget slider with all four stops and their row counts", () => {
    render(
      <YieldLeaderboardControls
        viewModel={buildModel()}
        onFilterChange={vi.fn()}
        onClearFilters={vi.fn()}
        onApplyPreset={vi.fn()}
        onApplyRiskBudget={vi.fn()}
      />,
    );

    const slider = screen.getByRole("group", { name: "Risk budget" });
    expect(slider).toBeTruthy();
    const stops = slider.querySelectorAll("button[aria-pressed]");
    expect(stops.length).toBe(4);
    for (const stop of stops) {
      expect(stop.textContent).toMatch(/\d/);
    }
  });

  it("invokes onApplyRiskBudget with the matching stop key when a stop is clicked", () => {
    const onApplyRiskBudget = vi.fn();

    render(
      <YieldLeaderboardControls
        viewModel={buildModel()}
        onFilterChange={vi.fn()}
        onClearFilters={vi.fn()}
        onApplyPreset={vi.fn()}
        onApplyRiskBudget={onApplyRiskBudget}
      />,
    );

    const slider = screen.getByRole("group", { name: "Risk budget" });
    const balancedStop = slider.querySelectorAll("button[aria-pressed]")[1] as HTMLButtonElement;
    fireEvent.click(balancedStop);

    expect(onApplyRiskBudget).toHaveBeenCalledWith("balanced");
  });

  it("marks the active risk-budget stop and leaves others inactive", () => {
    render(
      <YieldLeaderboardControls
        viewModel={buildModel({ minSafety: "70", depth: "hide-thin", warnings: "hide" })}
        onFilterChange={vi.fn()}
        onClearFilters={vi.fn()}
        onApplyPreset={vi.fn()}
        onApplyRiskBudget={vi.fn()}
      />,
    );

    const slider = screen.getByRole("group", { name: "Risk budget" });
    const stops = Array.from(
      slider.querySelectorAll<HTMLButtonElement>("button[aria-pressed]"),
    );
    const activeStops = stops.filter((stop) => stop.getAttribute("aria-pressed") === "true");
    expect(activeStops).toHaveLength(1);
    expect(activeStops[0]?.textContent).toContain("Balanced");
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
      return buildYieldViewModel(cohortRows, params, { watchlistIds: null });
    }

    it("renders non-zero yield types in descending count order with All first", () => {
      render(
        <YieldLeaderboardControls
          viewModel={buildCohortModel()}
          onFilterChange={vi.fn()}
          onClearFilters={vi.fn()}
          onApplyPreset={vi.fn()}
          onApplyRiskBudget={vi.fn()}
        />,
      );

      const tablist = screen.getByRole("tablist", { name: "Filter by yield type" });
      const tabLabels = Array.from(
        tablist.querySelectorAll<HTMLButtonElement>("button[aria-pressed]"),
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
          onApplyRiskBudget={vi.fn()}
        />,
      );

      const tablist = screen.getByRole("tablist", { name: "Filter by yield type" });
      const rebaseTab = Array.from(
        tablist.querySelectorAll<HTMLButtonElement>("button[aria-pressed]"),
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
          onApplyRiskBudget={vi.fn()}
        />,
      );

      const tablist = screen.getByRole("tablist", { name: "Filter by yield type" });
      const tabs = Array.from(
        tablist.querySelectorAll<HTMLButtonElement>("button[aria-pressed]"),
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
        onApplyRiskBudget={vi.fn()}
      />,
    );

    const pill = screen.getByRole("button", { name: /Watching only/ });
    fireEvent.click(pill);
    expect(onFilterChange).toHaveBeenCalledWith("watchlist", "all");
  });
});
