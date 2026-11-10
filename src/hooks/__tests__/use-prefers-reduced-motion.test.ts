// @vitest-environment jsdom
import { createElement } from "react";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanupFrontendTest } from "@/test-utils/frontend";
import { usePrefersReducedMotion } from "../use-prefers-reduced-motion";
import { useChartShell } from "../use-chart-shell";

function mockMatchMedia(media: { matches: boolean }) {
  const listeners: (() => void)[] = [];
  vi.stubGlobal("matchMedia", () => ({
    get matches() { return media.matches; },
    addEventListener: (_: string, listener: () => void) => listeners.push(listener),
  }));
  return () => listeners.forEach((listener) => listener());
}

function MotionProbe({ ssrDefault = false }) {
  return createElement("span", null, usePrefersReducedMotion({ ssrDefault }) ? "reduced" : "full");
}

function ShellProbe() {
  return createElement("span", null, useChartShell().animProps.isAnimationActive ? "full" : "reduced");
}

describe("usePrefersReducedMotion", () => {
  beforeEach(() => {
    const restore = [document.documentElement, document.body].map((root) => {
      const value = root.dataset.motion;
      return () => { if (value === undefined) delete root.dataset.motion; else root.dataset.motion = value; };
    });
    return () => restore.forEach((fn) => fn());
  });
  afterEach(() => {
    cleanupFrontendTest();
    localStorage.clear();
  });

  it.each([[MotionProbe, false], [MotionProbe, true], [ShellProbe, true]] as const)("hydrates %s, SSR %s", async (Probe, ssrDefault) => {
    mockMatchMedia({ matches: true });
    const container = document.createElement("div");
    const probe = createElement(Probe, { ssrDefault });
    container.innerHTML = renderToString(probe);
    expect(container.textContent).toBe(ssrDefault ? "reduced" : "full");
    document.body.appendChild(container);
    const errors: unknown[] = [];

    let root: ReturnType<typeof hydrateRoot>;
    await act(async () => {
      root = hydrateRoot(container, probe, {
        onRecoverableError: (error) => errors.push(error),
      });
    });

    expect(errors).toEqual([]);
    expect(container.textContent).toBe("reduced");
    act(() => root.unmount());
    container.remove();
  });

  it.each(["system", "reduced", "full"])("gates shell motion for %s", async (preference) => {
    vi.resetModules();
    localStorage.setItem("pharos-motion-preference-v1", preference);
    const media = { matches: false };
    const notify = mockMatchMedia(media);
    const { useChartShell } = await import("../use-chart-shell");
    const { result, rerender } = renderHook(() => useChartShell());
    for (const matches of [false, true, false]) {
      act(() => { media.matches = matches; notify(); });
      rerender();
      expect(result.current.animProps.isAnimationActive).toBe(preference === "full" || (preference === "system" && !matches));
    }
    act(result.current.handleAnimationEnd);
    act(() => { media.matches = false; notify(); });
    rerender();
    expect(result.current.animProps).toEqual({ isAnimationActive: false });
  });
});
