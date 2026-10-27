// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HarborSceneInput } from "@shared/lib/harbor-scene";
import { HARBOR_LIVE } from "@shared/lib/__tests__/harbor-scene.test-support";
import { HarborHero } from "../harbor/harbor-hero";
import { HarborSelectionProvider } from "../harbor/harbor-selection-context";

vi.mock("next/link", async () => {
  const { createNextLinkMock } = await import("@/test-utils/frontend");
  return createNextLinkMock();
});

const LIVE = HARBOR_LIVE;
let phone = false;

beforeEach(() => {
  phone = false;
  window.history.replaceState(null, "", "/chains/");
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({
      matches: query.includes("max-width: 760px") ? phone : query.includes("min-width: 1280px") ? !phone : false,
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    })),
  );
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function renderHero(data: HarborSceneInput = LIVE) {
  render(
    <HarborSelectionProvider chainIds={data.chains.map((c) => c.id)}>
      <HarborHero data={data} />
    </HarborSelectionProvider>,
  );
  const berth = (id: string) => document.getElementById(`berth-${id}`) as HTMLElement;
  return { berth };
}

describe("HarborHero keyboard and pin contract", () => {
  it("pins observed supply with an unavailable global share without rendering a zero share", () => {
    const { berth } = renderHero({
      ...LIVE, globalTotalUsd: null, chainAttributedTotalUsd: null,
      unattributedTotalUsd: null, attributionDiscrepancyUsd: null,
      chains: LIVE.chains.map((chain) => ({ ...chain, dominanceShare: null })),
    });
    expect(berth("ethereum").getAttribute("aria-label")).toContain("global share unavailable");
    fireEvent.keyDown(berth("ethereum"), { key: "Enter" });
    const card = screen.getByRole("region", { name: "Ethereum" });
    expect(card.textContent).toContain("Unavailable");
    expect(card.textContent).not.toContain("0.00%");
  });

  it("has one tab stop on the largest ship and moves in rank order", () => {
    const { berth } = renderHero();
    const stops = [...document.querySelectorAll("[data-berth]")].filter((el) => el.getAttribute("tabindex") === "0");
    expect(stops.map((el) => el.id)).toEqual(["berth-ethereum"]);
    expect(berth("ethereum").getAttribute("aria-label")).toMatch(/^Ethereum, \$148\.\d+B, 46\.\d% of tracked supply, Chain Health robust 82/);
    act(() => berth("ethereum").focus());
    fireEvent.keyDown(berth("ethereum"), { key: "ArrowDown" });
    expect(document.activeElement).toBe(berth("tron"));
    fireEvent.keyDown(berth("tron"), { key: "End" });
    expect(document.activeElement).toBe(berth("harbor-unattributed"));
    fireEvent.keyDown(berth("harbor-unattributed"), { key: "Home" });
    expect(document.activeElement).toBe(berth("ethereum"));
  });

  it("pins on Enter, writes #chain-<id> without history, and Escape unpins", () => {
    const { berth } = renderHero();
    const length = window.history.length;
    fireEvent.keyDown(berth("tron"), { key: "Enter" });
    expect(berth("tron").getAttribute("aria-pressed")).toBe("true");
    expect(window.location.hash).toBe("#chain-tron");
    expect(window.history.length).toBe(length);
    expect(screen.getByRole("region", { name: "Tron" })).toBeTruthy();
    fireEvent.keyDown(berth("tron"), { key: "Escape" });
    expect(berth("tron").getAttribute("aria-pressed")).toBe("false");
    expect(window.location.hash).toBe("");
  });

  it("pins from the hash on load and on hashchange", () => {
    window.history.replaceState(null, "", "/chains/#chain-solana");
    const { berth } = renderHero();
    expect(berth("solana").getAttribute("aria-pressed")).toBe("true");
    act(() => {
      window.history.replaceState(null, "", "/chains/#chain-base");
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    expect(berth("base").getAttribute("aria-pressed")).toBe("true");
  });

  it("lights the tail barge for a pooled chain and lists it first", () => {
    window.history.replaceState(null, "", "/chains/#chain-stacks");
    const { berth } = renderHero();
    expect(berth("harbor-tail").getAttribute("aria-pressed")).toBe("true");
    const card = screen.getByRole("region", { name: "Smaller chains, pooled" });
    expect(card.textContent).toContain("Show in table");
  });

  it("draws the retained state when the snapshot is not fresh; the stamp lives in the page hero", () => {
    renderHero({ ...LIVE, _meta: { status: "stale" } });
    const hero = document.querySelector("[data-retained]") as HTMLElement;
    expect(hero.dataset.retained).toBe("true");
    expect(screen.getByRole("heading", { name: "Harbor · chains by observed stablecoin supply" })).toBeTruthy();
    expect(hero.textContent).not.toMatch(/retained/i);
    expect(hero.textContent).not.toContain("as of");
  });

  it("keeps a fresh-budget-only delay or failed refresh neutral while still drawing the retained state", () => {
    renderHero({ ...LIVE, _meta: { status: "degraded", ageSeconds: 1_801, freshBudgetSec: 1_800 } });
    expect((document.querySelector("[data-retained]") as HTMLElement).dataset.retained).toBe("true");
    expect(screen.getByRole("heading", { name: "Harbor · chains by observed stablecoin supply" })).toBeTruthy();
    cleanup();
    render(
      <HarborSelectionProvider chainIds={LIVE.chains.map((c) => c.id)}>
        <HarborHero data={LIVE} retainedAfterError />
      </HarborSelectionProvider>,
    );
    expect((document.querySelector("[data-retained]") as HTMLElement).dataset.retained).toBe("true");
    expect(screen.getByRole("heading", { name: "Harbor · chains by observed stablecoin supply" })).toBeTruthy();
  });

  it("folds the legend behind a native disclosure that keeps it in the DOM", () => {
    renderHero();
    const fold = screen.getByText("How to read the harbor").closest("details") as HTMLDetailsElement;
    expect(fold.open).toBe(false);
    expect(fold.querySelector('[aria-label="Harbor legend"]')).toBeTruthy();
  });
});
