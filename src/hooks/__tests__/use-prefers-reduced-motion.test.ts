// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
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

  it("reads the browser reduced-motion preference once", () => {
    installMatchMediaMock(true);

    const { result } = renderHook(() => usePrefersReducedMotion());

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
