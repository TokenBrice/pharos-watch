// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { alignAnchorAfterHydration, revealAnchorId, revealDeferredSectionsThroughAnchor } from "@/lib/anchor-reveal";

/** jsdom has no layout: every `offsetParent` is null unless a test says otherwise. */
function markDisplayed(element: Element | null) {
  Object.defineProperty(element, "offsetParent", { configurable: true, value: document.body });
}

describe("revealAnchorId", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("lands on the visible rail twin when the in-flow owner is display-hidden", () => {
    document.body.innerHTML =
      '<div class="xl:hidden"><section id="collateralization">In flow</section></div>' +
      '<aside><section data-anchor-twin="collateralization">Rail</section></aside>';
    expect(revealAnchorId("collateralization")?.textContent).toBe("Rail");
  });

  it("unfolds a folded evidence module and its disclosures around a nested target", () => {
    document.body.innerHTML =
      '<section data-evidence-module="tile" data-expanded="false">' +
      '<details><summary>Notes</summary><p id="mint-review-notes">Notes</p></details></section>';
    const root = document.querySelector("[data-evidence-module]")!;
    const expanded = vi.fn();
    root.addEventListener("pharos:evidence-module-expand", expanded);
    markDisplayed(document.getElementById("mint-review-notes"));

    expect(revealAnchorId("mint-review-notes")?.id).toBe("mint-review-notes");
    expect(root.getAttribute("data-expanded")).toBe("true");
    expect(expanded).toHaveBeenCalledTimes(1);
    expect(document.querySelector("details")?.open).toBe(true);
  });
});

describe("revealDeferredSectionsThroughAnchor", () => {
  afterEach(() => { document.body.innerHTML = ""; });

  it("mounts preceding islands and all target-zone islands, not later zones or other roots", () => {
    document.body.innerHTML = '<main id="dossier">' +
      '<h2 id="liquidity">Market</h2><div data-lazy-section id="market-chart"></div>' +
      '<h2 id="activity">Activity</h2><div data-lazy-section id="yield"></div>' +
      '<h2 id="history">History</h2><div data-lazy-section id="history-tabs"></div>' +
      '<h2 id="explore">Explore</h2><div data-lazy-section id="peer-links"></div>' +
      '</main><div data-lazy-section id="unrelated"></div>';
    const mounts = new Set<string>();
    document.querySelectorAll("[data-lazy-section]").forEach((node) => {
      node.addEventListener("pharos:lazy-section-reveal", () => mounts.add(node.id));
    });
    revealDeferredSectionsThroughAnchor("history", ["liquidity", "activity", "history", "explore"], document.getElementById("dossier"));
    expect([...mounts]).toEqual(["market-chart", "yield", "history-tabs"]);
    mounts.clear();
    revealDeferredSectionsThroughAnchor("missing", ["history"], document.getElementById("dossier"));
    expect(mounts.size).toBe(0);
  });
});

describe("alignAnchorAfterHydration", () => {
  const scroll = vi.fn();

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => window.setTimeout(() => callback(0), 0));
    vi.stubGlobal("cancelAnimationFrame", (id: number) => window.clearTimeout(id));
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: scroll });
    window.history.replaceState(null, "", "#depeg-history");
    document.body.innerHTML = '<details><summary>History</summary><section id="depeg-history">Incidents</section></details>';
    scroll.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    document.body.innerHTML = "";
    window.history.replaceState(null, "", window.location.pathname);
  });

  it("reveals and scrolls the initial nested target, then realigns during lazy layout changes", () => {
    const cleanup = alignAnchorAfterHydration("depeg-history");
    vi.runAllTimers();
    expect(document.querySelector("details")?.open).toBe(true);
    expect(scroll).toHaveBeenCalledTimes(5);
    expect(scroll).toHaveBeenCalledWith({ block: "start", behavior: "instant" });
    cleanup();
  });

  it.each(["wheel", "touchstart", "pointerdown", "keydown", "hashchange"])("cancels pending corrections on %s", (event) => {
    const cleanup = alignAnchorAfterHydration("depeg-history");
    vi.advanceTimersByTime(1);
    const calls = scroll.mock.calls.length;
    window.dispatchEvent(new Event(event));
    vi.runAllTimers();
    expect(scroll).toHaveBeenCalledTimes(calls);
    cleanup();
  });
});
