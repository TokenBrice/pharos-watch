// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { ChainsLeaderboardClient } from "./client";
import { makeChain } from "@/hooks/__tests__/chain-profile-fixtures";
import { formatCompactUsd } from "@shared/lib/format";
import { RatioSchema } from "@shared/types/ratio";
import { useHarborSelection } from "@/components/harbor/harbor-selection-context";

const { useChainsMock, motion } = vi.hoisted(() => ({ useChainsMock: vi.fn(), motion: { reduced: false } }));
vi.mock("next/link", async () => (await import("@/test-utils/frontend")).createNextLinkMock());

vi.mock("@/hooks/use-prefers-reduced-motion", () => ({ usePrefersReducedMotion: () => motion.reduced }));
vi.mock("@/hooks/use-chains", () => ({ useChains: useChainsMock }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/components/harbor/harbor-hero", () => ({ HarborHero: () => {
  const { revealRow, hoverChainId } = useHarborSelection();
  return <button onClick={() => revealRow("ethereum")}>Show in table {hoverChainId}</button>;
} }));
vi.mock("./dominance-breakdown", () => ({ DominanceBreakdown: () => null }));

afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); motion.reduced = false; });

function renderChains(data: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
  useChainsMock.mockReturnValue({
    data: { chains: [makeChain()], globalTotalUsd: 456_000_000, globalChange7dPct: null, updatedAt: 1_760_000_000, ...data },
    isLoading: false, isError: false, error: null, refetch: vi.fn(), dataUpdatedAt: 0, meta: null, ...extra,
  });
  return render(<ChainsLeaderboardClient />);
}

function expectText(...labels: (string | RegExp)[]) {
  for (const label of labels) expect(screen.getByText(label)).toBeTruthy();
}

const coverage = (assets: number, observations: number, ids: string[] = []) => ({
  aggregateUnavailableAssetCount: assets, chainUnavailableObservationCount: observations, chainIdsWithUnavailableObservations: ids,
});

describe("ChainsLeaderboardClient", () => {
  it.each([false, true])("reveals the native row and focuses its identity link, reduced=%s", (reduced) => {
    motion.reduced = reduced;
    renderChains();
    const link = screen.getByRole("link", { name: /Ethereum.*supply/ }), row = link.closest("tr")!;
    const focus = vi.spyOn(link, "focus"), scroll = vi.fn();
    row.scrollIntoView = scroll;
    expect(link.getAttribute("href")).toBe("/chains/ethereum/");
    expect(within(row).getAllByRole("link")).toHaveLength(1);
    expect(screen.getAllByRole("row")).toContain(row);
    expect(screen.getAllByRole("columnheader")).toHaveLength(8);
    expect(within(row).getAllByRole("cell")).toHaveLength(8);
    expect(row.getAttribute("tabindex")).toBeNull();
    fireEvent.mouseEnter(row);
    expect(screen.getByRole("button", { name: "Show in table ethereum" })).toBeTruthy();
    fireEvent.mouseLeave(document.getElementById("chains-leaderboard")!);
    fireEvent.click(screen.getByRole("button", { name: "Show in table" }));
    expect(scroll).toHaveBeenCalledWith({ block: "center", behavior: reduced ? "auto" : "smooth" });
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(document.activeElement).toBe(link);
    expect(row.className).toContain("bg-muted/40");
    expect(screen.getByRole("button", { name: "Show in table ethereum" })).toBeTruthy();
  });

  it("renders unavailable global supply and shares while retaining observed chain supply", () => {
    renderChains({
      chains: [makeChain({ dominanceShare: null })],
      globalTotalUsd: null,
      chainAttributedTotalUsd: null,
      unattributedTotalUsd: null,
    });
    expect(screen.getAllByText("Unavailable").length).toBeGreaterThanOrEqual(3);
    expectText("Largest chain's share");
    expect(screen.queryByText("0.0%")).toBeNull();
    expectText(formatCompactUsd(makeChain().totalUsd));
  });

  it("does not identify a largest chain from an incomplete set of global shares", () => {
    renderChains({
      chains: [makeChain({ dominanceShare: null }), makeChain({ id: "tron", name: "Tron", dominanceShare: 0.3 })],
      globalTotalUsd: 1_000_000_000,
    });
    expectText("Largest chain's share");
    expect(screen.queryByText("Largest chain's share · Tron")).toBeNull();
    expect(screen.getAllByText("Unavailable").length).toBeGreaterThanOrEqual(2);
  });

  it("beams the largest dominanceShare, not the first row, and labels partial inputs on the beam and chip", () => {
    renderChains({
      chains: [
        makeChain({ id: "tron", name: "Tron", totalUsd: 123_000_000, dominanceShare: 0.27, unavailableSupplyObservationCount: 2 }),
        makeChain({ totalUsd: 200_000_000, dominanceShare: 0.44 }),
      ],
      supplyCoverage: coverage(3, 4, ["tron"]),
    });
    expectText("Largest chain's share · Ethereum · partial");
    const hero = screen.getByRole("group", { name: "Chain concentration" });
    expect(hero.textContent).toContain("44.0%");
    expect(hero.textContent).toContain("71.0%");
    const chip = screen.getByRole("button", { name: /Partial coverage/ });
    expect(chip.getAttribute("data-reason-codes")).toBe("aggregate-unavailable-assets chain-unavailable-observations");
    expectText("Known supply subtotal", /Partial · 2 unavailable/, formatCompactUsd(456_000_000), formatCompactUsd(123_000_000));
    expect(screen.queryByText(/assets excluded from global supply/)).toBeNull();
  });

  it("names only the excluded class that is present, never a zero count", () => {
    renderChains({ supplyCoverage: coverage(0, 2, ["ethereum"]) });
    const chip = screen.getByRole("button", { name: /Partial coverage/ });
    expect(chip.getAttribute("data-reason-codes")).toBe("chain-unavailable-observations");
    expectText("Observed stablecoin supply");

    cleanup();
    renderChains({ supplyCoverage: coverage(0, 0) });
    expect(screen.queryByRole("button", { name: /Partial coverage/ })).toBeNull();
    expectText("Largest chain's share · Ethereum");
  });

  it("renders unrated health as NR with Harbor's reason and tiny shares as <0.1%", () => {
    renderChains({
      chains: [
        makeChain(),
        makeChain({ id: "exsat", name: "exSat", totalUsd: 0.4, dominanceShare: 0.0000001, healthScore: null, healthBand: null }),
      ],
    });
    const nr = screen.getByTitle("Not rated: insufficient Chain Health coverage");
    expect(nr.textContent).toContain("NR");
    // the reason is also visible once above the table, since a title tooltip never reaches touch
    expect(screen.getByLabelText("Chain Health not rated").textContent).toContain("1 chain · Not rated: insufficient Chain Health coverage");
    expectText("<0.1%", "<$1");
    expect(screen.queryByText(/Swipe table horizontally/)).toBeNull();
  });

  it("stamps retained data with its source time", () => {
    // the hook exposes freshness as `meta`; the fetch layer strips `_meta` from the body
    renderChains({}, { meta: { status: "stale", updatedAt: 1_760_000_000, ageSeconds: 9_000 } });
    expectText(/^as of \w+ \d+, \d{4} at \d{2}:\d{2}/);
    expect(screen.queryByText(/Retained/)).toBeNull();
    expect(screen.getByRole("button", { name: /Stale data/ }).getAttribute("data-reason-codes")).toBe("api-stale health-stale");
  });

  it("keeps a failed refresh or fresh-budget-only delay on the original stamp and values, without retained health text", () => {
    for (const extra of [
      { isError: true, error: new Error("refresh failed"), meta: { status: "fresh", updatedAt: 1_760_000_000, ageSeconds: 60 } },
      { meta: { status: "degraded", updatedAt: 1_760_000_000, ageSeconds: 1_801, freshBudgetSec: 1_800, degradedBudgetSec: 3_600 } },
    ]) {
      renderChains({ supplyCoverage: coverage(1, 0) }, extra);
      expectText(/^as of \w+ \d+, \d{4} at \d{2}:\d{2}/);
      expect(document.body.textContent).not.toMatch(/retained/i);
      expectText("Known supply subtotal", formatCompactUsd(456_000_000));
      cleanup();
    }
  });

  it("ages the served supply generation into the hero chip without a refetch, never naming held Chain Health inputs", async () => {
    // let a hydration pass that earlier renders scheduled on real frames land before faking timers
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    vi.useFakeTimers();
    try {
      const generation = 1_760_000_000;
      vi.setSystemTime(generation * 1000);
      renderChains({ chains: [makeChain({ healthScore: null, healthBand: null })], updatedAt: generation }, {
        dataUpdatedAt: generation * 1000,
        meta: {
          updatedAt: generation, ageSeconds: 0, status: "degraded", freshBudgetSec: 1_800, degradedBudgetSec: 3_600,
          dependencies: { reportCards: { status: "degraded", reason: "publication-held", ageSeconds: 0 } },
        },
      });
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

  it("prints rounded-zero supply changes unsigned and keeps material declines negative", () => {
    const { container } = renderChains({
      chains: [
        makeChain({ change7dPct: RatioSchema.parse(-0.000001) }),
        makeChain({ id: "tron", name: "Tron", change7dPct: RatioSchema.parse(-0.05) }),
      ],
      globalTotalUsd: 1_000_000_000,
      globalChange7dPct: -0.0001,
    });
    expect(container.textContent).not.toMatch(/-0\.0+%|\+0\.0+%/);
    expectText("0.0%", "0.00%", "-5.00%");
  });
});
