// @vitest-environment jsdom

import { cleanup, render, screen, within } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { getActiveByArchetype } from "@shared/lib/stablecoins/by-mechanism";
import { getMechanismExplainerPath } from "@shared/lib/classification";
import { MECHANISM_MATRIX } from "@/lib/mechanism-matrix";

vi.mock("next/link", async () => {
  const { createNextLinkMock } = await import("@/test-utils/frontend");
  return createNextLinkMock();
});

import { ARCHETYPE_CONTENT } from "@/lib/mechanism-explainers";
import { ArchetypeExplainerBody } from "../explainer-shell";

const originalResizeObserver = globalThis.ResizeObserver;

beforeAll(() => {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

afterAll(() => {
  globalThis.ResizeObserver = originalResizeObserver;
});

afterEach(cleanup);

describe("ArchetypeExplainerBody representative coins", () => {
  it("does not assert that every tracked example is a live coin", () => {
    render(<ArchetypeExplainerBody content={ARCHETYPE_CONTENT["synthetic-delta-neutral"]} />);

    expect(screen.getByRole("heading", { name: "Tracked coins using this design" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Live coins using this design" })).toBeNull();
    // The list intentionally includes a frozen archive coin (USR), so the
    // heading cannot call the whole set live.
    expect(screen.getByRole("link", { name: /USR/ })).toBeTruthy();
  });

  it("omits quarantined coins from tracked examples", () => {
    render(<ArchetypeExplainerBody content={ARCHETYPE_CONTENT.tbill} />);

    expect(screen.queryByRole("link", { name: /WTGXX/ })).toBeNull();
    expect(screen.getAllByRole("link", { name: /BUIDL/ }).length).toBeGreaterThan(0);
  });

  it("strips internal scoring engine version prefixes and wires glossary terms without nesting buttons in links", () => {
    for (const archetype of ["cdp", "fiat-cash", "tbill", "rwa-credit-fund"] as const) {
      cleanup();
      const { container } = render(<ArchetypeExplainerBody content={ARCHETYPE_CONTENT[archetype]} />);
      expect(container.textContent).not.toMatch(/\bV(?:8|9|10)\b/);
      // Never nest interactive glossary buttons inside links.
      expect(container.querySelectorAll("a button").length).toBe(0);
    }

    cleanup();
    render(<ArchetypeExplainerBody content={ARCHETYPE_CONTENT.cdp} />);
    expect(screen.getAllByRole("button", { name: /overcollateralization|CDP|AMO/i }).length).toBeGreaterThan(0);
  });

  it("renders the fact strip, section scrollspy, crawler-safe tracked-coin fold, and prev/next pager", () => {
    const { container } = render(<ArchetypeExplainerBody content={ARCHETYPE_CONTENT["fiat-cash"]} />);
    const fiatCoins = getActiveByArchetype("fiat-cash");

    const summary = screen.getByRole("region", { name: "Mechanism summary" });
    expect(summary.textContent).toContain(MECHANISM_MATRIX["fiat-cash"].primaryFailureMode);
    expect(
      within(summary).getByRole("link", { name: /Filter in screener/i }).getAttribute("href"),
    ).toBe("/screener/?mechanisms=fiat-cash&lifecycle=active");

    const scrollspy = screen.getByRole("navigation", { name: "Mechanism explainer sections" });
    for (const anchor of within(scrollspy).getAllByRole("link")) {
      const targetId = anchor.getAttribute("href")?.replace(/^#/, "");
      expect(targetId).toBeTruthy();
      expect(container.querySelector(`#${targetId}`)).not.toBeNull();
    }

    const trackedSection = container.querySelector("#tracked-coins");
    expect(trackedSection).not.toBeNull();
    expect(
      within(trackedSection as HTMLElement)
        .getByRole("link", { name: /See all in the screener/i })
        .getAttribute("href"),
    ).toBe("/screener/?mechanisms=fiat-cash&lifecycle=active");
    // Large cohorts fold remaining parent coins inside a native `<details>` while keeping every coin link in HTML.
    expect(trackedSection?.querySelector("details")).not.toBeNull();
    const coinLinks = trackedSection?.querySelectorAll('a[href^="/stablecoin/"]');
    expect(coinLinks?.length).toBe(fiatCoins.length);

    const pager = screen.getByRole("navigation", { name: "Mechanism explainer pager" });
    const pagerHrefs = within(pager)
      .getAllByRole("link")
      .map((link) => link.getAttribute("href"));
    expect(pagerHrefs).toEqual([
      getMechanismExplainerPath("protocol-position"),
      getMechanismExplainerPath("tbill"),
    ]);
  });
});
