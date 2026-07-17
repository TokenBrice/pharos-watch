// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useCountUp } from "../use-count-up";
import { usePrefersReducedMotion } from "../use-prefers-reduced-motion";

vi.mock("../use-prefers-reduced-motion", () => ({
  usePrefersReducedMotion: vi.fn(() => false),
}));

const mockUsePrefersReducedMotion = vi.mocked(usePrefersReducedMotion);

type FrameCallback = (now: number) => void;

let pendingFrames: FrameCallback[];

function runFrame(now: number) {
  const callbacks = pendingFrames;
  pendingFrames = [];
  for (const callback of callbacks) callback(now);
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("useCountUp", () => {
  it("stays quiet while no real value exists", () => {
    pendingFrames = [];
    vi.stubGlobal("requestAnimationFrame", (cb: FrameCallback) => pendingFrames.push(cb));
    vi.stubGlobal("cancelAnimationFrame", () => undefined);
    mockUsePrefersReducedMotion.mockReturnValue(false);

    const { result } = renderHook(() => useCountUp(null));
    expect(result.current.value).toBeNull();
    expect(result.current.display).toBeNull();
  });

  it("jumps straight to the target for reduced-motion users", () => {
    pendingFrames = [];
    vi.stubGlobal("requestAnimationFrame", (cb: FrameCallback) => pendingFrames.push(cb));
    vi.stubGlobal("cancelAnimationFrame", () => undefined);
    mockUsePrefersReducedMotion.mockReturnValue(true);

    const { result, rerender } = renderHook(({ target }) => useCountUp(target), {
      initialProps: { target: null as number | null },
    });
    rerender({ target: 1842 });

    expect(result.current.value).toBe(1842);
    expect(result.current.display).toBe("1,842");
    expect(pendingFrames).toHaveLength(0);
  });

  it("counts up to the target and settles exactly on it", () => {
    pendingFrames = [];
    vi.stubGlobal("requestAnimationFrame", (cb: FrameCallback) => pendingFrames.push(cb));
    vi.stubGlobal("cancelAnimationFrame", () => undefined);
    mockUsePrefersReducedMotion.mockReturnValue(false);

    const { result, rerender } = renderHook(({ target }) => useCountUp(target, { durationMs: 800 }), {
      initialProps: { target: null as number | null },
    });
    rerender({ target: 1000 });

    expect(pendingFrames.length).toBeGreaterThan(0);
    // Frame timestamps must share the hook's performance.now() clock.
    const t0 = performance.now();
    act(() => runFrame(t0 + 400));
    const midway = result.current.value;
    expect(midway).not.toBeNull();
    expect(midway as number).toBeGreaterThan(0);
    expect(midway as number).toBeLessThan(1000);

    act(() => runFrame(t0 + 900));
    expect(result.current.value).toBe(1000);
    expect(result.current.display).toBe("1,000");
  });
});
