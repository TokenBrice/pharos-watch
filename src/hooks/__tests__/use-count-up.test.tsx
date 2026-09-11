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

/** Live frame callbacks keyed by the id requestAnimationFrame handed back. */
let frames: Map<number, FrameCallback>;
/** Shared clock for both performance.now() and frame timestamps. */
let clockNow = 0;

function installDeterministicScheduler() {
  frames = new Map();
  let nextFrameId = 1;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameCallback) => {
    const id = nextFrameId++;
    frames.set(id, callback);
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => {
    frames.delete(id);
  });
  vi.spyOn(performance, "now").mockImplementation(() => clockNow);
}

/** Runs every frame scheduled so far at `now`; frames scheduled during the run wait. */
function runFrame(now: number) {
  const pending = [...frames.values()];
  frames.clear();
  for (const callback of pending) callback(now);
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("useCountUp", () => {
  it("stays quiet while no real value exists", () => {
    installDeterministicScheduler();
    mockUsePrefersReducedMotion.mockReturnValue(false);

    const { result } = renderHook(() => useCountUp(null));
    expect(result.current.value).toBeNull();
    expect(result.current.display).toBeNull();
  });

  it("jumps straight to the target for reduced-motion users", () => {
    installDeterministicScheduler();
    mockUsePrefersReducedMotion.mockReturnValue(true);

    const { result, rerender } = renderHook(({ target }) => useCountUp(target), {
      initialProps: { target: null as number | null },
    });
    rerender({ target: 1842 });

    expect(result.current.value).toBe(1842);
    expect(result.current.display).toBe("1,842");
    expect(frames.size).toBe(0);
  });

  it("counts up to the target and settles exactly on it", () => {
    installDeterministicScheduler();
    mockUsePrefersReducedMotion.mockReturnValue(false);

    clockNow = 5_000;
    const { result, rerender } = renderHook(({ target }) => useCountUp(target, { durationMs: 800 }), {
      initialProps: { target: null as number | null },
    });
    rerender({ target: 1000 });

    expect(frames.size).toBe(1);
    // Frame timestamps share the hook's performance.now() clock, so halfway
    // through an expo-out tween of 0→1000 lands on a known value.
    act(() => runFrame(clockNow + 400));
    expect(result.current.value).toBe(968.75);

    act(() => runFrame(clockNow + 900));
    expect(result.current.value).toBe(1000);
    expect(result.current.display).toBe("1,000");
    // Completion stops scheduling instead of looping forever.
    expect(frames.size).toBe(0);
  });

  it("retargets midway from the displayed value instead of restarting from zero", () => {
    installDeterministicScheduler();
    mockUsePrefersReducedMotion.mockReturnValue(false);

    clockNow = 0;
    const { result, rerender } = renderHook(
      ({ target, durationMs }) => useCountUp(target, { durationMs }),
      { initialProps: { target: null as number | null, durationMs: 800 } },
    );
    rerender({ target: 1000, durationMs: 800 });
    act(() => runFrame(400));
    expect(result.current.value).toBe(968.75);

    rerender({ target: 2000, durationMs: 800 });

    // The stale frame was cancelled; exactly the retargeted tween remains.
    expect(frames.size).toBe(1);
    act(() => runFrame(410));
    // A restart from zero would sit near 166 here; the tween continues from 968.75.
    expect(result.current.value).toBeGreaterThan(968.75);
    expect(result.current.value).toBeLessThan(2000);

    clockNow = 1_200;
    act(() => runFrame(1_200));
    expect(result.current.value).toBe(2000);
    expect(frames.size).toBe(0);
  });

  it("drops the pending frame on unmount so no stale callback can run", () => {
    installDeterministicScheduler();
    mockUsePrefersReducedMotion.mockReturnValue(false);

    clockNow = 0;
    const { result, rerender, unmount } = renderHook(({ target }) => useCountUp(target, { durationMs: 800 }), {
      initialProps: { target: null as number | null },
    });
    rerender({ target: 1000 });
    act(() => runFrame(200));
    const midFlight = result.current.value;
    expect(midFlight).not.toBeNull();

    unmount();

    expect(frames.size).toBe(0);
    act(() => runFrame(10_000));
    // The cancelled frame must not overwrite the last displayed value.
    expect(result.current.value).toBe(midFlight);
  });

  it("settles immediately when reduced motion turns on mid-animation", () => {
    installDeterministicScheduler();
    mockUsePrefersReducedMotion.mockReturnValue(false);

    clockNow = 0;
    const { result, rerender } = renderHook(({ target }) => useCountUp(target, { durationMs: 800 }), {
      initialProps: { target: null as number | null },
    });
    rerender({ target: 1000 });
    act(() => runFrame(400));
    expect(result.current.value).toBe(968.75);

    mockUsePrefersReducedMotion.mockReturnValue(true);
    rerender({ target: 1000 });

    expect(result.current.value).toBe(1000);
    expect(frames.size).toBe(0);
    // The cancelled frame must not overwrite the settled value.
    act(() => runFrame(800));
    expect(result.current.value).toBe(1000);
  });

  it("settles immediately when the duration becomes nonpositive mid-animation", () => {
    installDeterministicScheduler();
    mockUsePrefersReducedMotion.mockReturnValue(false);

    clockNow = 0;
    const { result, rerender } = renderHook(
      ({ target, durationMs }) => useCountUp(target, { durationMs }),
      { initialProps: { target: null as number | null, durationMs: 800 } },
    );
    rerender({ target: 1000, durationMs: 800 });
    act(() => runFrame(400));
    expect(result.current.value).toBe(968.75);

    rerender({ target: 1000, durationMs: 0 });

    expect(result.current.value).toBe(1000);
    expect(frames.size).toBe(0);
  });
});
