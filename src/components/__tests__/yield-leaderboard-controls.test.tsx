// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { YieldLeaderboardControls } from "@/components/yield-leaderboard-controls";
import { makeYieldProvenance, makeYieldRanking } from "@shared/test-utils/yield-ranking-fixtures";
import { buildYieldViewModel, prepareYieldUniverse } from "@/lib/yield-view-model";

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

function buildModel(params: Parameters<typeof buildYieldViewModel>[1] = {}, watchlistIds?: ReadonlySet<string>) {
  return buildYieldViewModel(prepareYieldUniverse(rows, watchlistIds ?? null), params);
}

describe("YieldLeaderboardControls", () => {
  it("does not render the Watching chip when the watchlist is empty", () => {
    render(
      <YieldLeaderboardControls
        viewModel={buildModel()}
        hasExplicitFilterParams={false}
        onFilterChange={vi.fn()}
        onClearFilters={vi.fn()}
        onApplyPreset={vi.fn()}
      />,
    );

    expect(screen.queryByRole("button", { name: /^Watching\d+$/ })).toBeNull();
  });

  it("shows the watchlist count and toggles the filter when clicked", () => {
    const onFilterChange = vi.fn();

    render(
      <YieldLeaderboardControls
        viewModel={buildModel({}, new Set(["usdc-circle", "usdt-tether"]))}
        hasExplicitFilterParams={false}
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

  it("counts only watched coins that have a published yield row", () => {
    const watchlistIds = new Set(["usdc-circle", "not-ranked-coin"]);

    render(
      <YieldLeaderboardControls
        viewModel={buildModel({}, watchlistIds)}
        hasExplicitFilterParams={false}
        onFilterChange={vi.fn()}
        onClearFilters={vi.fn()}
        onApplyPreset={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: /^Watching1$/ }).textContent).toContain("1");
  });

  it("does not render the Watching chip when no watched coin has a yield row", () => {
    render(
      <YieldLeaderboardControls
        viewModel={buildModel({}, new Set(["not-ranked-coin"]))}
        hasExplicitFilterParams={false}
        onFilterChange={vi.fn()}
        onClearFilters={vi.fn()}
        onApplyPreset={vi.fn()}
      />,
    );

    expect(screen.queryByRole("button", { name: /^Watching\d+$/ })).toBeNull();
  });

  it("counts and applies the watchlist-attention preset so its chip cannot open an empty view", () => {
    const watchlistIds = new Set(["usdt-tether"]);
    const onApplyPreset = vi.fn();

    render(
      <YieldLeaderboardControls
        viewModel={buildModel({}, watchlistIds)}
        hasExplicitFilterParams={false}
        onFilterChange={vi.fn()}
        onClearFilters={vi.fn()}
        onApplyPreset={onApplyPreset}
      />,
    );

    const presetRows = buildYieldViewModel(
      prepareYieldUniverse(rows, watchlistIds),
      { attention: "watchlist", warnings: "all" },
    ).visibleRows.length;
    const attentionOnlyRows = buildYieldViewModel(
      prepareYieldUniverse(rows, watchlistIds),
      { attention: "watchlist" },
    ).visibleRows.length;
    expect(presetRows).toBe(1);
    expect(attentionOnlyRows).toBe(0);

    const chip = screen.getByRole("button", { name: /^Needs attention\d+$/ });
    expect(chip.textContent).toContain(String(presetRows));
    expect(chip.getAttribute("data-active")).toBe("false");
    expect(chip.getAttribute("aria-pressed")).toBe("false");

    fireEvent.click(chip);
    expect(onApplyPreset).toHaveBeenCalledWith("watchlist-warnings");
  });

  it("renders the attention preset chip as active and clears it through the same preset", () => {
    const onApplyPreset = vi.fn();

    render(
      <YieldLeaderboardControls
        viewModel={buildModel({ attention: "watchlist", risk: "any" }, new Set(["usdc-circle"]))}
        hasExplicitFilterParams
        onFilterChange={vi.fn()}
        onClearFilters={vi.fn()}
        onApplyPreset={onApplyPreset}
      />,
    );

    const chip = screen.getByRole("button", { name: /^Needs attention\d+$/ });
    expect(chip.getAttribute("data-active")).toBe("true");
    expect(chip.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByText("Starred rows with warnings or source changes")).toBeTruthy();

    fireEvent.click(chip);
    expect(onApplyPreset).toHaveBeenCalledWith("watchlist-warnings");
  });

  it("renders the Watching chip as active and toggles back to all when already filtering", () => {
    const onFilterChange = vi.fn();

    render(
      <YieldLeaderboardControls
        viewModel={buildModel({ watchlist: "only" }, new Set(["usdc-circle"]))}
        hasExplicitFilterParams
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

  it("hides Reset on the implicit landing band while keeping the active filter pills", () => {
    render(
      <YieldLeaderboardControls
        viewModel={buildModel()}
        hasExplicitFilterParams={false}
        onFilterChange={vi.fn()}
        onClearFilters={vi.fn()}
        onApplyPreset={vi.fn()}
      />,
    );

    expect(screen.getByText("Filters (2 active)")).toBeTruthy();
    expect(screen.getByText("No warnings")).toBeTruthy();
    expect(screen.getByText("50+ safety")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Reset" })).toBeNull();
  });

  it("renders Reset for an explicit URL filter and clears it", () => {
    const onClearFilters = vi.fn();

    render(
      <YieldLeaderboardControls
        viewModel={buildModel({ risk: "any", minSafety: "80" })}
        hasExplicitFilterParams
        onFilterChange={vi.fn()}
        onClearFilters={onClearFilters}
        onApplyPreset={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Reset" }));
    expect(onClearFilters).toHaveBeenCalledOnce();
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

    it("invokes onFilterChange with the yield type when a tab is clicked", () => {
      const onFilterChange = vi.fn();
      render(
        <YieldLeaderboardControls
          viewModel={buildCohortModel()}
          hasExplicitFilterParams={false}
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

  });

  it("clears the watchlist filter from the active-filter pill", () => {
    const onFilterChange = vi.fn();

    render(
      <YieldLeaderboardControls
        viewModel={buildModel({ watchlist: "only" }, new Set(["usdc-circle"]))}
        hasExplicitFilterParams
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
