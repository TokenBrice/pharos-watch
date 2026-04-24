// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useBrowserFullscreen } from "@/app/alt-pegs/fiat-world-atlas/use-browser-fullscreen";

type FullscreenStub = {
  enabled: boolean;
  element: Element | null;
  requestSpy: ReturnType<typeof vi.fn>;
  exitSpy: ReturnType<typeof vi.fn>;
};

function stubFullscreen(enabled: boolean): FullscreenStub {
  const requestSpy = vi.fn(() => Promise.resolve());
  const exitSpy = vi.fn(() => Promise.resolve());
  const stub: FullscreenStub = { enabled, element: null, requestSpy, exitSpy };

  Object.defineProperty(document, "fullscreenEnabled", {
    configurable: true,
    get: () => stub.enabled,
  });
  Object.defineProperty(document, "fullscreenElement", {
    configurable: true,
    get: () => stub.element,
  });
  Object.defineProperty(document, "exitFullscreen", {
    configurable: true,
    value: () => {
      exitSpy();
      stub.element = null;
      return Promise.resolve();
    },
  });

  Object.defineProperty(Element.prototype, "requestFullscreen", {
    configurable: true,
    value: function (this: Element) {
      requestSpy();
      stub.element = this;
      return Promise.resolve();
    },
  });

  return stub;
}

describe("useBrowserFullscreen", () => {
  let stub: FullscreenStub;

  beforeEach(() => {
    stub = stubFullscreen(true);
  });

  afterEach(() => {
    // @ts-expect-error reset
    delete document.fullscreenEnabled;
    // @ts-expect-error reset
    delete document.fullscreenElement;
    // @ts-expect-error reset
    delete document.exitFullscreen;
    // @ts-expect-error reset
    delete Element.prototype.requestFullscreen;
    vi.restoreAllMocks();
  });

  it("returns a usable ref object", () => {
    const { result } = renderHook(() => useBrowserFullscreen(false));
    expect(result.current).toHaveProperty("current");
  });

  it("calls requestFullscreen on the attached element when open transitions to true", async () => {
    const { result, rerender } = renderHook(({ open }) => useBrowserFullscreen(open), {
      initialProps: { open: false },
    });
    const el = document.createElement("div");
    result.current.current = el;

    await act(async () => {
      rerender({ open: true });
    });

    expect(stub.requestSpy).toHaveBeenCalledTimes(1);
  });

  it("calls exitFullscreen when open returns to false and target owns fullscreen", async () => {
    const { result, rerender } = renderHook(({ open }) => useBrowserFullscreen(open), {
      initialProps: { open: false },
    });
    const el = document.createElement("div");
    result.current.current = el;

    await act(async () => {
      rerender({ open: true });
    });
    await act(async () => {
      rerender({ open: false });
    });

    expect(stub.exitSpy).toHaveBeenCalledTimes(1);
  });

  it("is a no-op when document.fullscreenEnabled is false", async () => {
    stub.enabled = false;
    const { result, rerender } = renderHook(({ open }) => useBrowserFullscreen(open), {
      initialProps: { open: false },
    });
    const el = document.createElement("div");
    result.current.current = el;

    await act(async () => {
      rerender({ open: true });
    });

    expect(stub.requestSpy).not.toHaveBeenCalled();
  });

  it("swallows a rejected requestFullscreen promise without throwing", async () => {
    Object.defineProperty(Element.prototype, "requestFullscreen", {
      configurable: true,
      value: () => Promise.reject(new TypeError("denied")),
    });
    const { result, rerender } = renderHook(({ open }) => useBrowserFullscreen(open), {
      initialProps: { open: false },
    });
    const el = document.createElement("div");
    result.current.current = el;

    await expect(
      act(async () => {
        rerender({ open: true });
      }),
    ).resolves.not.toThrow();
  });

  it("exits fullscreen on unmount if target still owns it", async () => {
    const { result, unmount, rerender } = renderHook(({ open }) => useBrowserFullscreen(open), {
      initialProps: { open: false },
    });
    const el = document.createElement("div");
    result.current.current = el;

    await act(async () => {
      rerender({ open: true });
    });

    unmount();

    expect(stub.exitSpy).toHaveBeenCalledTimes(1);
  });
});
