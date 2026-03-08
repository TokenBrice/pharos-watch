// @vitest-environment jsdom
import { renderHook, act } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { useCountUp } from "../use-count-up";

// Mock matchMedia for reduced-motion tests
function mockReducedMotion(prefers: boolean) {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: query === "(prefers-reduced-motion: reduce)" ? prefers : false,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  });
}

describe("useCountUp", () => {
  beforeEach(() => {
    mockReducedMotion(false);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns the target value after animation completes", () => {
    const { result } = renderHook(() => useCountUp(100));
    // Fast-forward past animation duration
    act(() => {
      vi.advanceTimersByTime(700);
    });
    expect(result.current).toBe("100");
  });

  it("returns formatted value with prefix and suffix", () => {
    const { result } = renderHook(() =>
      useCountUp(42.5, { prefix: "$", suffix: "B", decimals: 1 }),
    );
    act(() => {
      vi.advanceTimersByTime(700);
    });
    expect(result.current).toBe("$42.5B");
  });

  it("returns final value immediately when reduced motion is preferred", () => {
    mockReducedMotion(true);
    const { result } = renderHook(() => useCountUp(100));
    // No timer advance needed — should be immediate
    expect(result.current).toBe("100");
  });

  it("starts at 0 initially", () => {
    const { result } = renderHook(() => useCountUp(100));
    expect(result.current).toBe("0");
  });

  it("handles zero target", () => {
    const { result } = renderHook(() => useCountUp(0));
    expect(result.current).toBe("0");
  });

  it("handles negative target", () => {
    const { result } = renderHook(() =>
      useCountUp(-50, { prefix: "", decimals: 0 }),
    );
    act(() => {
      vi.advanceTimersByTime(700);
    });
    expect(result.current).toBe("-50");
  });

  it("animates from previous to new target on value change", () => {
    const { result, rerender } = renderHook(
      ({ target }) => useCountUp(target),
      { initialProps: { target: 100 } },
    );
    act(() => {
      vi.advanceTimersByTime(700);
    });
    expect(result.current).toBe("100");

    rerender({ target: 200 });
    act(() => {
      vi.advanceTimersByTime(700);
    });
    expect(result.current).toBe("200");
  });
});
