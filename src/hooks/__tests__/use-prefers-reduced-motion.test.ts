// @vitest-environment jsdom
import { createElement } from "react";
import { hydrateRoot } from "react-dom/client";
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanupFrontendTest } from "@/test-utils/frontend";
import { usePrefersReducedMotion } from "../use-prefers-reduced-motion";

function mockMatchMedia(mediaState: { matches: boolean }) {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      get matches() {
        return mediaState.matches;
      },
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}

function MotionProbe() {
  return createElement("span", null, usePrefersReducedMotion() ? "reduced" : "full");
}

describe("usePrefersReducedMotion", () => {
  afterEach(() => {
    cleanupFrontendTest();
  });

  it("hydrates against the server snapshot when the browser prefers reduced motion", async () => {
    mockMatchMedia({ matches: true });
    const container = document.createElement("div");
    // Markup the static export renders without a window (reduced motion off).
    container.innerHTML = "<span>full</span>";
    document.body.appendChild(container);
    const recoverableErrors: unknown[] = [];

    await act(async () => {
      hydrateRoot(container, createElement(MotionProbe), {
        onRecoverableError: (error) => recoverableErrors.push(error),
      });
    });

    expect(recoverableErrors).toEqual([]);
    expect(container.textContent).toBe("reduced");
  });

  it("re-reads the browser reduced-motion preference on rerender", () => {
    // Real MediaQueryList objects mutate `matches` before the shared
    // motion-preference store notifies; the derived snapshot re-reads the live
    // browser value.
    const mediaState = { matches: false };
    mockMatchMedia(mediaState);

    const { result, rerender } = renderHook(() => usePrefersReducedMotion());

    expect(result.current).toBe(false);

    act(() => {
      mediaState.matches = true;
      rerender();
    });

    expect(result.current).toBe(true);
  });
});
