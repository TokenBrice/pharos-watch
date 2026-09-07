// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { alignAnchorAfterHydration } from "@/lib/anchor-reveal";

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
