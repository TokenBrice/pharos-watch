// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanupFrontendTest, installMatchMediaMock } from "@/test-utils/frontend";
import { usePrefersReducedMotion } from "../use-prefers-reduced-motion";

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
});
