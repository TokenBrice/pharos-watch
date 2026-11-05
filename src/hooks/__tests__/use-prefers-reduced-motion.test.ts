// @vitest-environment jsdom
import { createElement } from "react";
import { hydrateRoot } from "react-dom/client";
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanupFrontendTest } from "@/test-utils/frontend";
import { usePrefersReducedMotion } from "../use-prefers-reduced-motion";

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

describe("usePrefersReducedMotion", () => {
  afterEach(() => {
    cleanupFrontendTest();
    localStorage.clear();
  });

  it.each([false, true])("hydrates with SSR default %s", async (ssrDefault) => {
    mockMatchMedia({ matches: true });
    const container = document.createElement("div");
    container.innerHTML = `<span>${ssrDefault ? "reduced" : "full"}</span>`;
    document.body.appendChild(container);
    const errors: unknown[] = [];

    let root: ReturnType<typeof hydrateRoot>;
    await act(async () => {
      root = hydrateRoot(container, createElement(MotionProbe, { ssrDefault }), {
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
