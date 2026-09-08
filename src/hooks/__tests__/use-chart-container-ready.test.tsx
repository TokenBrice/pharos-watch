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

  it("resets dimensions and disconnects observation when the ref detaches", () => {
    let callback: ResizeCallback | null = null;

    const observers: ResizeObserverMock[] = [];

    class ResizeObserverMock {
      observe = vi.fn();
      disconnect = vi.fn();

      constructor(cb: ResizeCallback) {
        callback = cb;
        observers.push(this);
      }
    }

    vi.stubGlobal("ResizeObserver", ResizeObserverMock);

    const node = document.createElement("div");

    const { result } = renderHook(() => useChartContainerReady<HTMLDivElement>());

    act(() => {
      result.current.ref(node);
    });
    act(() => {
      callback?.([makeResizeEntry(node, 320, 180)]);
    });
    expect(result.current.ready).toBe(true);

    act(() => {
      result.current.ref(null);
    });

    expect(observers[0]?.disconnect).toHaveBeenCalledTimes(1);
    expect(result.current.ready).toBe(false);
    expect(result.current.width).toBe(0);
    expect(result.current.height).toBe(0);
  });

  it("cancels the stale fallback frame and measures the replacement node", () => {
    const scheduled: FrameRequestCallback[] = [];
    const cancelledFrameIds: number[] = [];
    vi.stubGlobal("ResizeObserver", undefined);
    vi.stubGlobal("requestAnimationFrame", vi.fn((cb: FrameRequestCallback) => {
      scheduled.push(cb);
      return scheduled.length;
    }));
    vi.stubGlobal("cancelAnimationFrame", vi.fn((frameId: number) => {
      cancelledFrameIds.push(frameId);
    }));

    const nodeA = document.createElement("div");
    Object.defineProperty(nodeA, "clientWidth", { configurable: true, get: () => 100 });
    Object.defineProperty(nodeA, "clientHeight", { configurable: true, get: () => 50 });
    const nodeB = document.createElement("div");
    Object.defineProperty(nodeB, "clientWidth", { configurable: true, get: () => 200 });
    Object.defineProperty(nodeB, "clientHeight", { configurable: true, get: () => 120 });

    const { result } = renderHook(() => useChartContainerReady<HTMLDivElement>());

    act(() => {
      result.current.ref(nodeA);
    });
    act(() => {
      result.current.ref(nodeB);
    });

    expect(cancelledFrameIds).toEqual([1]);
    expect(scheduled).toHaveLength(2);

    act(() => {
      scheduled[1]?.(0);
    });

    expect(result.current.width).toBe(200);
    expect(result.current.height).toBe(120);
    expect(result.current.ready).toBe(true);
  });

  it("reports ready only once both delivered dimensions are positive", () => {
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

    const { result } = renderHook(() => useChartContainerReady<HTMLDivElement>());

    act(() => {
      result.current.ref(node);
    });

    act(() => {
      callback?.([makeResizeEntry(node, 0, 0)]);
    });
    expect(result.current.ready).toBe(false);
    expect(result.current.width).toBe(0);
    expect(result.current.height).toBe(0);

    act(() => {
      callback?.([makeResizeEntry(node, 123.8, -4)]);
    });
    expect(result.current.width).toBe(123);
    expect(result.current.height).toBe(0);
    expect(result.current.ready).toBe(false);

    act(() => {
      callback?.([makeResizeEntry(node, 123.8, 45.6)]);
    });
    expect(result.current.ready).toBe(true);
    expect(result.current.width).toBe(123);
    expect(result.current.height).toBe(45);
  });
});
