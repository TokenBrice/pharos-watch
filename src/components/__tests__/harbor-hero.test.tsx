// @vitest-environment jsdom

import { useEffect } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildHarborScene, HARBOR_CARGO_HEX, type HarborSceneInput } from "@shared/lib/harbor-scene";
import { CHART_PALETTE, CHART_SLATE, CHART_SLATE_SOFT } from "@/lib/chart-colors";
import { buildHarborGeometry } from "@shared/lib/harbor-scene-geometry";
import { HARBOR_LIVE } from "@shared/lib/__tests__/harbor-scene.test-support";
import { HarborHero } from "../harbor/harbor-hero";
import { HarborSceneSvg } from "../harbor/harbor-scene";
import { HarborSelectionProvider, useHarborSelection } from "../harbor/harbor-selection-context";

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

function RevealProbe({ onReveal }: { onReveal: (chainId: string) => void }) {
  const { registerRevealRow } = useHarborSelection();
  useEffect(() => registerRevealRow(onReveal), [registerRevealRow, onReveal]);
  return null;
}

function renderHero(data: HarborSceneInput = LIVE, onShowInTable = vi.fn()) {
  render(
    <HarborSelectionProvider chainIds={data.chains.map((c) => c.id)}>
      <HarborHero data={data} />
      <RevealProbe onReveal={onShowInTable} />
    </HarborSelectionProvider>,
  );
  const berth = (id: string) => document.getElementById(`berth-${id}`) as HTMLElement;
  return { berth, onShowInTable };
}

describe("HarborHero keyboard and pin contract", () => {
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

  it("reveals the leaderboard row from the card", () => {
    const { berth, onShowInTable } = renderHero();
    fireEvent.click(berth("bsc"));
    fireEvent.click(screen.getByRole("button", { name: "Show in table ↓" }));
    expect(onShowInTable).toHaveBeenCalledWith("bsc");
  });

  it("draws the retained state and stamp when the snapshot is not fresh", () => {
    renderHero({ ...LIVE, _meta: { status: "stale" } });
    const hero = document.querySelector("[data-retained]") as HTMLElement;
    expect(hero.dataset.retained).toBe("true");
    expect(hero.textContent).toContain("Retained · as of");
    expect(hero.textContent).toMatch(/Retained · as of \w+ \d+, \d{4} at \d{2}:\d{2}/);
  });

  it("removes the old night scene: no star sky, no draft label, no auto-sweep timer", () => {
    vi.useFakeTimers();
    const { berth } = renderHero();
    act(() => vi.advanceTimersByTime(30_000));
    expect(document.body.textContent).not.toContain("DOMINANCE DRAFT");
    expect(document.querySelectorAll("[aria-pressed='true']")).toHaveLength(0);
    expect(berth("ethereum").getAttribute("tabindex")).toBe("0");
    vi.useRealTimers();
  });
});

describe("HarborSceneSvg markup", () => {
  it("renders the fixture server-side with one berth button per vessel", () => {
    const scene = buildHarborScene(LIVE);
    const markup = renderToStaticMarkup(
      <HarborSceneSvg scene={scene} geometry={buildHarborGeometry(scene, "wide")} litId={null} pinnedId={null} focusId="ethereum" label="Harbor" />,
    );
    expect(markup.match(/role="button"/g)).toHaveLength(scene.vessels.length);
    expect(markup).not.toMatch(/NaN|undefined/);
  });
});

describe("harbor cargo palette", () => {
  it("uses named chart palette slots, not ad-hoc hues", () => {
    expect(CHART_PALETTE).toContain(HARBOR_CARGO_HEX.usdt);
    expect(CHART_PALETTE).toContain(HARBOR_CARGO_HEX.usdc);
    expect(HARBOR_CARGO_HEX.other).toBe(CHART_SLATE);
    expect(HARBOR_CARGO_HEX.pool).toBe(CHART_SLATE_SOFT);
  });
});
