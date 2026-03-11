// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  readStartHereCalloutState,
  START_HERE_CALLOUT_SESSION_KEY,
} from "@/lib/start-here-callout";
import { useStartHereCallout } from "../use-start-here-callout";

function createStorageMock(): Storage {
  const store = new Map<string, string>();

  return {
    get length() {
      return store.size;
    },
    clear() {
      store.clear();
    },
    getItem(key) {
      return store.has(key) ? store.get(key)! : null;
    },
    key(index) {
      return Array.from(store.keys())[index] ?? null;
    },
    removeItem(key) {
      store.delete(key);
    },
    setItem(key, value) {
      store.set(key, value);
    },
  };
}

describe("useStartHereCallout", () => {
  beforeEach(() => {
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: createStorageMock(),
    });
    Object.defineProperty(window, "sessionStorage", {
      configurable: true,
      value: createStorageMock(),
    });
    window.localStorage.clear();
    window.sessionStorage.clear();
  });

  afterEach(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
  });

  it("shows the callout on the first homepage session and persists that exposure", async () => {
    const { result } = renderHook(() => useStartHereCallout());

    await waitFor(() => expect(result.current.isReady).toBe(true));

    expect(result.current.shouldShow).toBe(true);
    expect(readStartHereCalloutState(window.localStorage)).toEqual({
      homepageSessions: 1,
      hasOpenedStartHere: false,
    });
    expect(window.sessionStorage.getItem(START_HERE_CALLOUT_SESSION_KEY)).toBe("true");
  });

  it("does not increment the homepage session count again in the same browser session", async () => {
    const first = renderHook(() => useStartHereCallout());
    await waitFor(() => expect(first.result.current.isReady).toBe(true));
    first.unmount();

    const second = renderHook(() => useStartHereCallout());
    await waitFor(() => expect(second.result.current.isReady).toBe(true));

    expect(second.result.current.shouldShow).toBe(true);
    expect(readStartHereCalloutState(window.localStorage)).toEqual({
      homepageSessions: 1,
      hasOpenedStartHere: false,
    });
  });

  it("hides the callout once the visitor returns in a later session", async () => {
    const first = renderHook(() => useStartHereCallout());
    await waitFor(() => expect(first.result.current.isReady).toBe(true));
    first.unmount();

    window.sessionStorage.clear();

    const second = renderHook(() => useStartHereCallout());
    await waitFor(() => expect(second.result.current.isReady).toBe(true));

    expect(second.result.current.shouldShow).toBe(false);
    expect(readStartHereCalloutState(window.localStorage)).toEqual({
      homepageSessions: 2,
      hasOpenedStartHere: false,
    });
  });

  it("retires the callout immediately after the user opens Start Here", async () => {
    const { result } = renderHook(() => useStartHereCallout());
    await waitFor(() => expect(result.current.isReady).toBe(true));

    act(() => {
      result.current.retireCallout();
    });

    expect(result.current.shouldShow).toBe(false);
    expect(readStartHereCalloutState(window.localStorage)).toEqual({
      homepageSessions: 1,
      hasOpenedStartHere: true,
    });
  });
});
