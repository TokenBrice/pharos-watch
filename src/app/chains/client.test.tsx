// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { ChainsLeaderboardClient } from "./client";
import { makeChain } from "@/hooks/__tests__/chain-profile-fixtures";
import { formatCompactUsd } from "@shared/lib/format";

const { useChainsMock } = vi.hoisted(() => ({ useChainsMock: vi.fn() }));
vi.mock("@/hooks/use-chains", () => ({ useChains: useChainsMock }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/components/harbor/harbor-hero", () => ({ HarborHero: () => null }));
vi.mock("./dominance-breakdown", () => ({ DominanceBreakdown: () => null }));

afterEach(() => { cleanup(); vi.clearAllMocks(); });

function mockChains(data: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  useChainsMock.mockReturnValue({
    data: { globalChange7dPct: null, updatedAt: 1_760_000_000, ...data },
    isLoading: false, isError: false, error: null, refetch: vi.fn(), dataUpdatedAt: 0, meta: null, ...extra,
  });
}

const coverage = (assets: number, observations: number, ids: string[] = []) => ({
  aggregateUnavailableAssetCount: assets, chainUnavailableObservationCount: observations, chainIdsWithUnavailableObservations: ids,
});

describe("ChainsLeaderboardClient", () => {
  it("renders unavailable global supply and shares while retaining observed chain supply", () => {
    mockChains({
      chains: [makeChain({ dominanceShare: null })],
      globalTotalUsd: null,
      chainAttributedTotalUsd: null,
      unattributedTotalUsd: null,
    });
    render(<ChainsLeaderboardClient />);
    expect(screen.getAllByText("Unavailable").length).toBeGreaterThanOrEqual(3);
    expect(screen.getByText("Largest chain's share")).toBeTruthy();
    expect(screen.queryByText("0.0%")).toBeNull();
    expect(screen.getByText(formatCompactUsd(makeChain().totalUsd))).toBeTruthy();
  });

  it("does not identify a largest chain from an incomplete set of global shares", () => {
    mockChains({
      chains: [makeChain({ dominanceShare: null }), makeChain({ id: "tron", name: "Tron", dominanceShare: 0.3 })],
      globalTotalUsd: 1_000_000_000,
    });
    render(<ChainsLeaderboardClient />);
    expect(screen.getByText("Largest chain's share")).toBeTruthy();
    expect(screen.queryByText("Largest chain's share · Tron")).toBeNull();
    expect(screen.getAllByText("Unavailable").length).toBeGreaterThanOrEqual(2);
  });

  it("beams the largest dominanceShare, not the first row, and labels partial inputs on the beam and chip", () => {
    mockChains({
      chains: [
        makeChain({ id: "tron", name: "Tron", totalUsd: 123_000_000, dominanceShare: 0.27, unavailableSupplyObservationCount: 2 }),
        makeChain({ id: "ethereum", name: "Ethereum", totalUsd: 200_000_000, dominanceShare: 0.44 }),
      ],
      globalTotalUsd: 456_000_000,
      supplyCoverage: coverage(3, 4, ["tron"]),
    });
    render(<ChainsLeaderboardClient />);
    expect(screen.getByText("Largest chain's share · Ethereum · partial")).toBeTruthy();
    const hero = screen.getByRole("group", { name: "Chain concentration" });
    expect(hero.textContent).toContain("44.0%");
    expect(hero.textContent).toContain("71.0%");
    const chip = screen.getByRole("button", { name: /Partial coverage/ });
    expect(chip.getAttribute("data-reason-codes")).toBe("aggregate-unavailable-assets chain-unavailable-observations");
    expect(screen.getByText("Known supply subtotal")).toBeTruthy();
    expect(screen.getByText(/Partial · 2 unavailable/)).toBeTruthy();
    expect(screen.getByText(formatCompactUsd(456_000_000))).toBeTruthy();
    expect(screen.getByText(formatCompactUsd(123_000_000))).toBeTruthy();
    expect(screen.queryByText(/assets excluded from global supply/)).toBeNull();
  });

  it("names only the excluded class that is present, never a zero count", () => {
    mockChains({ chains: [makeChain()], globalTotalUsd: 456_000_000, supplyCoverage: coverage(0, 2, ["ethereum"]) });
    render(<ChainsLeaderboardClient />);
    const chip = screen.getByRole("button", { name: /Partial coverage/ });
    expect(chip.getAttribute("data-reason-codes")).toBe("chain-unavailable-observations");
    expect(screen.getByText("Observed stablecoin supply")).toBeTruthy();

    cleanup();
    mockChains({ chains: [makeChain()], globalTotalUsd: 456_000_000, supplyCoverage: coverage(0, 0) });
    render(<ChainsLeaderboardClient />);
    expect(screen.queryByRole("button", { name: /Partial coverage/ })).toBeNull();
    expect(screen.getByText("Largest chain's share · Ethereum")).toBeTruthy();
  });

  it("renders unrated health as NR with Harbor's reason and tiny shares as <0.1%", () => {
    mockChains({
      chains: [
        makeChain(),
        makeChain({ id: "exsat", name: "exSat", totalUsd: 0.4, dominanceShare: 0.0000001, healthScore: null, healthBand: null }),
      ],
      globalTotalUsd: 456_000_000,
    });
    render(<ChainsLeaderboardClient />);
    const nr = screen.getByTitle("Not rated: insufficient Chain Health coverage");
    expect(nr.textContent).toContain("NR");
    // the reason is also visible once above the table, since a title tooltip never reaches touch
    expect(screen.getByLabelText("Chain Health not rated").textContent).toContain("1 chain · Not rated: insufficient Chain Health coverage");
    expect(screen.getByText("<0.1%")).toBeTruthy();
    expect(screen.getByText("<$1")).toBeTruthy();
    expect(screen.queryByText(/Swipe table horizontally/)).toBeNull();
  });

  it("stamps retained data with its source time", () => {
    // the hook exposes freshness as `meta`; the fetch layer strips `_meta` from the body
    mockChains({ chains: [makeChain()], globalTotalUsd: 456_000_000 }, { meta: { status: "stale", updatedAt: 1_760_000_000, ageSeconds: 9_000 } });
    render(<ChainsLeaderboardClient />);
    expect(screen.getByText(/^Retained · as of \w+ \d+, \d{4} at \d{2}:\d{2}/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /Stale data/ }).getAttribute("data-reason-codes")).toBe("api-stale health-stale");
  });

  it("ages the served supply generation into the hero chip without a refetch, never naming held Chain Health inputs", async () => {
    // let a hydration pass that earlier renders scheduled on real frames land before faking timers
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    vi.useFakeTimers();
    try {
      const generation = 1_760_000_000;
      vi.setSystemTime(generation * 1000);
      mockChains({ chains: [makeChain({ healthScore: null, healthBand: null })], globalTotalUsd: 456_000_000, updatedAt: generation }, {
        dataUpdatedAt: generation * 1000,
        meta: {
          updatedAt: generation, ageSeconds: 0, status: "degraded", freshBudgetSec: 1_800, degradedBudgetSec: 3_600,
          dependencies: { reportCards: { status: "degraded", reason: "publication-held", ageSeconds: 0 } },
        },
      });
      render(<ChainsLeaderboardClient />);
      await act(async () => { vi.advanceTimersByTime(0); });
      expect(screen.queryByRole("button", { name: /Stale data|Chain Health inputs/ })).toBeNull();
      expect(screen.getAllByText("NR").length).toBeGreaterThan(0);

      await act(async () => { vi.advanceTimersByTime(3_600_001); });
      expect(screen.getByRole("button", { name: /Stale data/ })).toBeTruthy();
      expect(useChainsMock.mock.results.at(-1)?.value.refetch).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
