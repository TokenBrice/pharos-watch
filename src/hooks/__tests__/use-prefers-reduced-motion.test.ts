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

  it("reacts to browser preference changes", () => {
    const listeners = new Set<(event: MediaQueryListEvent) => void>();
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      writable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: vi.fn((event: string, listener: (changeEvent: MediaQueryListEvent) => void) => {
          if (event === "change") listeners.add(listener);
        }),
        removeEventListener: vi.fn((event: string, listener: (changeEvent: MediaQueryListEvent) => void) => {
          if (event === "change") listeners.delete(listener);
        }),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    });

    const { result } = renderHook(() => usePrefersReducedMotion());

    expect(result.current).toBe(false);

    act(() => {
      for (const listener of listeners) {
        listener({ matches: true } as MediaQueryListEvent);
      }
    });

    expect(result.current).toBe(true);
  });

  it("defaults to false when matchMedia is unavailable unless overridden", () => {
    removeMatchMedia();

    const { result } = renderHook(() => usePrefersReducedMotion());

    expect(result.current).toBe(false);
  });

  it("uses the caller-provided default when matchMedia is unavailable", () => {
    removeMatchMedia();

    const { result } = renderHook(() =>
      usePrefersReducedMotion({ ssrDefault: true }),
    );

    expect(result.current).toBe(true);
  });
});
