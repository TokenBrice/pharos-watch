// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoExpand } from "../use-auto-expand";

afterEach(cleanup);

describe("useAutoExpand", () => {
  it("stays closed and unbadged while the signal cannot be evaluated yet", () => {
    const { result, rerender } = renderHook(({ signal }) => useAutoExpand(signal), {
      initialProps: { signal: null as boolean | null },
    });

    expect(result.current.isOpen).toBe(false);
    expect(result.current.hasNewSignal).toBe(false);

    rerender({ signal: false });
    expect(result.current.isOpen).toBe(false);
    expect(result.current.hasNewSignal).toBe(false);
  });

  it("auto-opens on the first definite positive evaluation", () => {
    const { result } = renderHook(() => useAutoExpand(true));

    expect(result.current.isOpen).toBe(true);
    expect(result.current.hasNewSignal).toBe(false);
  });

  it("badges a late-arriving signal instead of forcing the section open", () => {
    const { result, rerender } = renderHook(({ signal }) => useAutoExpand(signal), {
      initialProps: { signal: false as boolean | null },
    });

    rerender({ signal: true });
    expect(result.current.isOpen).toBe(false);
    expect(result.current.hasNewSignal).toBe(true);

    act(() => result.current.setIsOpen(true));
    expect(result.current.isOpen).toBe(true);
    expect(result.current.hasNewSignal).toBe(false);
  });

  it("respects an operator collapse and badges while the signal stays active", () => {
    const { result, rerender } = renderHook(({ signal }) => useAutoExpand(signal), {
      initialProps: { signal: true as boolean | null },
    });

    expect(result.current.isOpen).toBe(true);
    act(() => result.current.setIsOpen(false));

    rerender({ signal: true });
    expect(result.current.isOpen).toBe(false);
    expect(result.current.hasNewSignal).toBe(true);
  });

  it("auto-opens when the first evaluable signal arrives late and stays open on recovery", () => {
    const { result, rerender } = renderHook(({ signal }) => useAutoExpand(signal), {
      initialProps: { signal: null as boolean | null },
    });
    rerender({ signal: true });
    expect(result.current.isOpen).toBe(true);
    expect(result.current.hasNewSignal).toBe(false);
    rerender({ signal: false });
    expect(result.current.isOpen).toBe(true);
    expect(result.current.hasNewSignal).toBe(false);
  });

  it("clears a collapsed badge without resetting the first-evaluation history through null", () => {
    const { result, rerender } = renderHook(({ signal }) => useAutoExpand(signal), {
      initialProps: { signal: false as boolean | null },
    });
    rerender({ signal: true });
    expect(result.current.hasNewSignal).toBe(true);
    rerender({ signal: false });
    expect(result.current.hasNewSignal).toBe(false);
    rerender({ signal: null });
    rerender({ signal: true });
    expect(result.current.isOpen).toBe(false);
    expect(result.current.hasNewSignal).toBe(true);
  });
});
