// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { alignAnchorAfterHydration, revealAnchorId } from "@/lib/anchor-reveal";

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

  it("keeps the owner when it is displayed, and when no twin exists", () => {
    document.body.innerHTML =
      '<section id="jurisdiction">In flow</section><section data-anchor-twin="jurisdiction">Rail</section>';
    markDisplayed(document.getElementById("jurisdiction"));
    expect(revealAnchorId("jurisdiction")?.textContent).toBe("In flow");

    document.body.innerHTML = '<section id="custody">Only copy</section>';
    expect(revealAnchorId("custody")?.textContent).toBe("Only copy");
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

  it("stops scrolling once navigation changes the hash", () => {
    const cleanup = alignAnchorAfterHydration("depeg-history");
    vi.advanceTimersByTime(0);
    window.history.pushState(null, "", "#overview");
    vi.runAllTimers();
    expect(scroll).toHaveBeenCalledTimes(1);
    cleanup();
  });

  it("clears pending alignment on unmount", () => {
    alignAnchorAfterHydration("depeg-history")();
    vi.runAllTimers();
    expect(scroll).not.toHaveBeenCalled();
  });

  it.each(["wheel", "touchstart", "pointerdown", "keydown"])("yields to user %s input", (event) => {
    const cleanup = alignAnchorAfterHydration("depeg-history");
    vi.advanceTimersByTime(0);
    window.dispatchEvent(new Event(event));
    vi.runAllTimers();
    expect(scroll).toHaveBeenCalledTimes(1);
    cleanup();
  });
});
