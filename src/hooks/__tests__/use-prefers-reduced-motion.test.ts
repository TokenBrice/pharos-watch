// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanupFrontendTest, installMatchMediaMock } from "@/test-utils/frontend";
import { usePrefersReducedMotion } from "../use-prefers-reduced-motion";

function removeMatchMedia() {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: undefined,
  });
}

describe("usePrefersReducedMotion", () => {
  afterEach(() => {
    cleanupFrontendTest();
  });

  it("reads the browser reduced-motion preference", () => {
    installMatchMediaMock(true);

    const { result } = renderHook(() => usePrefersReducedMotion());

    expect(result.current).toBe(true);
  });

  it("re-reads the browser reduced-motion preference on rerender", () => {
    // Real MediaQueryList objects mutate `matches` before the shared
    // motion-preference store notifies; the derived snapshot re-reads the live
    // browser value.
    const mediaState = { matches: false };
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

    const { result, rerender } = renderHook(() => usePrefersReducedMotion());

    expect(result.current).toBe(false);

    act(() => {
      mediaState.matches = true;
      rerender();
    });

    expect(result.current).toBe(true);
  });

  it("does not add per-hook media query listeners across rerenders", () => {
    const addEventListener = vi.fn();
    const removeEventListener = vi.fn();
    const mediaQueryList = {
      matches: false,
      media: "(prefers-reduced-motion: reduce)",
      onchange: null,
      addEventListener,
      removeEventListener,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    };
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      writable: true,
      value: vi.fn().mockReturnValue(mediaQueryList),
    });

    const { rerender, unmount } = renderHook(({ ssrDefault }) => usePrefersReducedMotion({ ssrDefault }), {
      initialProps: { ssrDefault: false },
    });

    rerender({ ssrDefault: false });
    rerender({ ssrDefault: true });
    unmount();

    expect(addEventListener).not.toHaveBeenCalled();
    expect(removeEventListener).not.toHaveBeenCalled();
  });

  it("defaults to false when matchMedia is unavailable unless overridden", () => {
    removeMatchMedia();

    const { result } = renderHook(() => usePrefersReducedMotion());

    expect(result.current).toBe(false);
  });

  it("uses the caller-provided default when matchMedia is unavailable", () => {
    removeMatchMedia();

    const { result } = renderHook(() => usePrefersReducedMotion({ ssrDefault: true }));

    expect(result.current).toBe(true);
  });
});
