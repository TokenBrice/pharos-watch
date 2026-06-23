// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanupFrontendTest, installMatchMediaMock } from "@/test-utils/frontend";
import { useFlashOnChange } from "../use-flash-on-change";

describe("useFlashOnChange", () => {
  beforeEach(() => {
    installMatchMediaMock(false);
    vi.useFakeTimers();
  });

  afterEach(() => {
    cleanupFrontendTest();
  });

  it("does not flash on initial mount", () => {
    const { result } = renderHook(() => useFlashOnChange(10));

    expect(result.current).toBe("");
  });

  it("flashes upward and clears after the configured duration", () => {
    const { result, rerender } = renderHook(
      ({ value }) => useFlashOnChange(value, { durationMs: 250 }),
      { initialProps: { value: 10 } },
    );

    rerender({ value: 12 });

    expect(result.current).toContain("pharos-data-fresh-up");

    act(() => {
      vi.advanceTimersByTime(250);
    });

    expect(result.current).toBe("");
  });

  it("flashes downward on numeric decreases", () => {
    const { result, rerender } = renderHook(
      ({ value }) => useFlashOnChange(value),
      { initialProps: { value: 10 } },
    );

    rerender({ value: 8 });

    expect(result.current).toContain("pharos-data-fresh-down");
  });

  it("restarts same-direction flashes on repeated numeric increases", () => {
    const { result, rerender } = renderHook(
      ({ value }) => useFlashOnChange(value, { durationMs: 250 }),
      { initialProps: { value: 10 } },
    );

    rerender({ value: 11 });
    const firstClassName = result.current;

    act(() => {
      vi.advanceTimersByTime(125);
    });
    rerender({ value: 12 });

    expect(result.current).toContain("pharos-data-fresh-up");
    expect(result.current).not.toBe(firstClassName);

    act(() => {
      vi.advanceTimersByTime(249);
    });
    expect(result.current).toContain("pharos-data-fresh-up");

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current).toBe("");
  });

  it("suppresses flashes when reduced motion is preferred", () => {
    installMatchMediaMock(true);
    const { result, rerender } = renderHook(
      ({ value }) => useFlashOnChange(value),
      { initialProps: { value: 10 } },
    );

    rerender({ value: 12 });

    expect(result.current).toBe("");
  });
});
