// @vitest-environment jsdom
import { renderHook, act } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { useEntranceSequence } from "../use-entrance-sequence";

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

describe("useEntranceSequence", () => {
  beforeEach(() => {
    mockReducedMotion(false);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts in kpi phase", () => {
    const { result } = renderHook(() => useEntranceSequence());
    expect(result.current.phase).toBe("kpi");
  });

  it("advances to complete after 400ms", () => {
    const { result } = renderHook(() => useEntranceSequence());
    act(() => {
      vi.advanceTimersByTime(400);
    });
    expect(result.current.phase).toBe("complete");
  });

  it("returns correct delay offsets for kpi group", () => {
    const { result } = renderHook(() => useEntranceSequence());
    expect(result.current.delayFor("kpi", 0)).toBe(0);
    expect(result.current.delayFor("kpi", 1)).toBe(80);
  });

  it("returns 0 delays when reduced motion is preferred", () => {
    mockReducedMotion(true);
    const { result } = renderHook(() => useEntranceSequence());
    expect(result.current.phase).toBe("complete");
    expect(result.current.delayFor("kpi", 3)).toBe(0);
  });
});
