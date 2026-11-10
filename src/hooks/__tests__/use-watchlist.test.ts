// @vitest-environment jsdom

import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useWatchlist, WATCHLIST_STORAGE_KEY } from "@/hooks/use-watchlist";
import { usePinnedStablecoins } from "@/hooks/use-pinned-stablecoins";
import { MAX_PINNED_STABLECOINS, PINNED_STABLECOINS_STORAGE_KEY } from "@/lib/pinned-stablecoins";
import { CLIENT_ACTIVE_IDS } from "@shared/lib/stablecoins/client-registry";

const LEGACY_PINNED_STORAGE_KEY = "pharos-pinned-stablecoins";
const LEGACY_YIELD_STORAGE_KEY = "pharos:yield-watchlist:v1";

describe("useWatchlist", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
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

  it("propagates mutations between concurrently mounted consumers", async () => {
    const first = renderHook(() => useWatchlist());
    const second = renderHook(() => useWatchlist());
    await waitFor(() => expect(first.result.current.isHydrated).toBe(true));
    await waitFor(() => expect(second.result.current.isHydrated).toBe(true));

    act(() => first.result.current.add("usdc-circle"));

    await waitFor(() => expect(second.result.current.has("usdc-circle")).toBe(true));
    expect(second.result.current.count).toBe(1);

    act(() => second.result.current.remove("usdc-circle"));
    await waitFor(() => expect(first.result.current.has("usdc-circle")).toBe(false));
    expect(first.result.current.count).toBe(0);
  });

  it("syncs every mounted consumer when another tab writes canonical storage", async () => {
    const first = renderHook(() => useWatchlist());
    const second = renderHook(() => useWatchlist());
    await waitFor(() => expect(first.result.current.isHydrated).toBe(true));
    await waitFor(() => expect(second.result.current.isHydrated).toBe(true));

    const nextValue = JSON.stringify(["dai-mkr", "usdc-circle"]);
    act(() => {
      window.localStorage.setItem(WATCHLIST_STORAGE_KEY, nextValue);
      window.dispatchEvent(new StorageEvent("storage", {
        key: WATCHLIST_STORAGE_KEY,
        newValue: nextValue,
        storageArea: window.localStorage,
      }));
    });

    await waitFor(() => expect(first.result.current.ids).toEqual(["dai-mkr", "usdc-circle"]));
    await waitFor(() => expect(second.result.current.ids).toEqual(["dai-mkr", "usdc-circle"]));
  });
});

describe("usePinnedStablecoins", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("migrates legacy pinned ids into the canonical watchlist", async () => {
    window.localStorage.setItem(
      PINNED_STABLECOINS_STORAGE_KEY,
      JSON.stringify(["usdc-circle", "usdc-circle", "dai-makerdao"]),
    );

    const { result } = renderHook(() => usePinnedStablecoins());

    await waitFor(() => expect(result.current.pinnedIds).toEqual(["usdc-circle", "dai-makerdao"]));
    expect(JSON.parse(window.localStorage.getItem(WATCHLIST_STORAGE_KEY) ?? "null")).toEqual([
      "usdc-circle",
      "dai-makerdao",
    ]);
  });

  it("writes pin toggles through the shared watchlist storage", async () => {
    const { result } = renderHook(() => usePinnedStablecoins());

    await waitFor(() => expect(result.current.pinnedIds).toEqual([]));

    act(() => result.current.togglePinned("usdt-tether"));

    await waitFor(() => {
      expect(result.current.isPinned("usdt-tether")).toBe(true);
      expect(JSON.parse(window.localStorage.getItem(WATCHLIST_STORAGE_KEY) ?? "null")).toEqual(["usdt-tether"]);
      expect(window.localStorage.getItem(PINNED_STABLECOINS_STORAGE_KEY)).toBeNull();
    });
  });

  it("promotes a hidden saved star without dropping other watchlist entries and synchronizes ordinary unstars", () => {
    const savedIds = [...CLIENT_ACTIVE_IDS].slice(0, MAX_PINNED_STABLECOINS + 1);
    const hiddenId = savedIds[MAX_PINNED_STABLECOINS];
    window.localStorage.setItem(WATCHLIST_STORAGE_KEY, JSON.stringify(savedIds));
    const pins = renderHook(() => usePinnedStablecoins());
    const workspace = renderHook(() => useWatchlist());
    expect(pins.result.current.pinnedIds).toEqual(savedIds.slice(0, MAX_PINNED_STABLECOINS));
    expect(workspace.result.current.ids).toEqual(savedIds);
    expect(pins.result.current.isPinned(hiddenId)).toBe(false);
    expect(workspace.result.current.has(hiddenId)).toBe(true);

    act(() => pins.result.current.togglePinned(hiddenId));
    expect(pins.result.current.isPinned(hiddenId)).toBe(true);
    expect(pins.result.current.pinnedIds[0]).toBe(hiddenId);
    expect(workspace.result.current.ids).toEqual([hiddenId, ...savedIds.slice(0, MAX_PINNED_STABLECOINS)]);
    expect(JSON.parse(window.localStorage.getItem(WATCHLIST_STORAGE_KEY) ?? "null")).toEqual(workspace.result.current.ids);

    act(() => pins.result.current.togglePinned(hiddenId));
    expect(pins.result.current.isPinned(hiddenId)).toBe(false);
    expect(workspace.result.current.has(hiddenId)).toBe(false);
    expect(workspace.result.current.ids).toEqual(savedIds.slice(0, MAX_PINNED_STABLECOINS));

    act(() => workspace.result.current.add(hiddenId));
    expect(pins.result.current.isPinned(hiddenId)).toBe(true);
  });
});
