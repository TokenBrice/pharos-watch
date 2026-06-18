// @vitest-environment jsdom

import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useWatchlist, WATCHLIST_STORAGE_KEY } from "@/hooks/use-watchlist";

const LEGACY_PINNED_STORAGE_KEY = "pharos-pinned-stablecoins";
const LEGACY_YIELD_STORAGE_KEY = "pharos:yield-watchlist:v1";

describe("useWatchlist", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("hydrates with an empty list and flips isHydrated", async () => {
    const { result } = renderHook(() => useWatchlist());

    await waitFor(() => expect(result.current.isHydrated).toBe(true));
    await waitFor(() => expect(result.current.ids).toEqual([]));
  });

  it("adds, checks, removes, and toggles ids", async () => {
    const { result } = renderHook(() => useWatchlist());
    await waitFor(() => expect(result.current.isHydrated).toBe(true));

    act(() => result.current.add("usdc-circle"));
    expect(result.current.has("usdc-circle")).toBe(true);

    act(() => result.current.toggle("usdc-circle"));
    expect(result.current.has("usdc-circle")).toBe(false);

    act(() => result.current.toggle("usdt-tether"));
    expect(result.current.has("usdt-tether")).toBe(true);

    act(() => result.current.remove("usdt-tether"));
    expect(result.current.has("usdt-tether")).toBe(false);
  });

  it("persists changes to localStorage", async () => {
    const { result } = renderHook(() => useWatchlist());
    await waitFor(() => expect(result.current.isHydrated).toBe(true));

    act(() => {
      result.current.add("usdc-circle");
      result.current.add("dai-mkr");
    });

    await waitFor(() => {
      const stored = JSON.parse(window.localStorage.getItem(WATCHLIST_STORAGE_KEY) ?? "null");
      expect(Array.isArray(stored)).toBe(true);
      expect(stored).toContain("usdc-circle");
      expect(stored).toContain("dai-mkr");
    });
  });

  it("reads existing legacy yield watchlist from storage and dedupes", async () => {
    window.localStorage.setItem(
      LEGACY_YIELD_STORAGE_KEY,
      JSON.stringify(["usdc-circle", "usdc-circle", "dai-mkr"]),
    );

    const { result } = renderHook(() => useWatchlist());

    await waitFor(() => expect(result.current.isHydrated).toBe(true));
    await waitFor(() => expect([...result.current.idSet].sort()).toEqual(["dai-mkr", "usdc-circle"]));
  });

  it("keeps legacy watchlist keys when canonical migration storage write fails", async () => {
    const pinned = ["usdc-circle"];
    const yieldList = ["dai-mkr"];
    window.localStorage.setItem(LEGACY_PINNED_STORAGE_KEY, JSON.stringify(pinned));
    window.localStorage.setItem(LEGACY_YIELD_STORAGE_KEY, JSON.stringify(yieldList));

    const originalSetItem = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(function setItem(this: Storage, key, value) {
      if (key === WATCHLIST_STORAGE_KEY) {
        throw new DOMException("Quota exceeded", "QuotaExceededError");
      }
      return Reflect.apply(originalSetItem, this, [key, value]);
    });

    const { result } = renderHook(() => useWatchlist());

    await waitFor(() => expect(result.current.isHydrated).toBe(true));
    await waitFor(() => expect([...result.current.idSet].sort()).toEqual(["dai-mkr", "usdc-circle"]));
    expect(window.localStorage.getItem(WATCHLIST_STORAGE_KEY)).toBeNull();
    expect(JSON.parse(window.localStorage.getItem(LEGACY_PINNED_STORAGE_KEY) ?? "null")).toEqual(pinned);
    expect(JSON.parse(window.localStorage.getItem(LEGACY_YIELD_STORAGE_KEY) ?? "null")).toEqual(yieldList);
  });

  it("ignores malformed stored values", async () => {
    window.localStorage.setItem(LEGACY_YIELD_STORAGE_KEY, '{"not":"an array"}');

    const { result } = renderHook(() => useWatchlist());
    await waitFor(() => expect(result.current.isHydrated).toBe(true));
    await waitFor(() => expect(result.current.ids).toEqual([]));
  });

  it("clears the list", async () => {
    const { result } = renderHook(() => useWatchlist());
    await waitFor(() => expect(result.current.isHydrated).toBe(true));

    act(() => {
      result.current.add("a");
      result.current.add("b");
    });
    expect(result.current.count).toBe(2);

    act(() => result.current.clear());
    expect(result.current.count).toBe(0);
  });
});
