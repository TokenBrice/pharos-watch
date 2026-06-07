// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useChartContainerReady } from "@/hooks/use-chart-container-ready";

type ResizeCallback = (entries: ResizeObserverEntry[]) => void;

function makeResizeEntry(
  target: Element,
  width: number,
  height: number,
): ResizeObserverEntry {
  return {
    target,
    contentRect: {
      width,
      height,
    },
  } as ResizeObserverEntry;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("useChartContainerReady", () => {
  it("uses ResizeObserver contentRect without forcing a synchronous layout read", () => {
    let callback: ResizeCallback | null = null;

    class ResizeObserverMock {
      observe = vi.fn();
      disconnect = vi.fn();

      constructor(cb: ResizeCallback) {
        callback = cb;
      }
    }

    vi.stubGlobal("ResizeObserver", ResizeObserverMock);

    const node = document.createElement("div");
    const clientWidthGetter = vi.fn(() => 320);
    const clientHeightGetter = vi.fn(() => 180);
    Object.defineProperty(node, "clientWidth", {
      configurable: true,
      get: clientWidthGetter,
    });
    Object.defineProperty(node, "clientHeight", {
      configurable: true,
      get: clientHeightGetter,
    });

    const { result } = renderHook(() => useChartContainerReady<HTMLDivElement>());

    act(() => {
      result.current.ref(node);
    });

    expect(clientWidthGetter).not.toHaveBeenCalled();
    expect(clientHeightGetter).not.toHaveBeenCalled();
    expect(result.current.ready).toBe(false);

    act(() => {
      callback?.([makeResizeEntry(node, 123.8, 45.6)]);
    });

    expect(result.current.ready).toBe(true);
    expect(result.current.width).toBe(123);
    expect(result.current.height).toBe(45);
    expect(clientWidthGetter).not.toHaveBeenCalled();
    expect(clientHeightGetter).not.toHaveBeenCalled();
  });

  it("falls back to a scheduled geometry read when ResizeObserver is unavailable", () => {
    let frame: FrameRequestCallback | null = null;
    vi.stubGlobal("ResizeObserver", undefined);
    vi.stubGlobal("requestAnimationFrame", vi.fn((cb: FrameRequestCallback) => {
      frame = cb;
      return 1;
    }));
    vi.stubGlobal("cancelAnimationFrame", vi.fn());

    const node = document.createElement("div");
    const clientWidthGetter = vi.fn(() => 240);
    const clientHeightGetter = vi.fn(() => 120);
    Object.defineProperty(node, "clientWidth", {
      configurable: true,
      get: clientWidthGetter,
    });
    Object.defineProperty(node, "clientHeight", {
      configurable: true,
      get: clientHeightGetter,
    });

    const { result } = renderHook(() => useChartContainerReady<HTMLDivElement>());

    act(() => {
      result.current.ref(node);
    });

    expect(clientWidthGetter).not.toHaveBeenCalled();
    expect(clientHeightGetter).not.toHaveBeenCalled();
    expect(result.current.ready).toBe(false);

    act(() => {
      frame?.(0);
    });

    expect(result.current.ready).toBe(true);
    expect(result.current.width).toBe(240);
    expect(result.current.height).toBe(120);
  });
});
