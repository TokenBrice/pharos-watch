// @vitest-environment jsdom

import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { usePinnedStablecoins } from "@/hooks/use-pinned-stablecoins";
import { WATCHLIST_STORAGE_KEY, useWatchlist } from "@/hooks/use-watchlist";
import { MAX_PINNED_STABLECOINS, PINNED_STABLECOINS_STORAGE_KEY } from "@/lib/pinned-stablecoins";
import { CLIENT_ACTIVE_IDS } from "@shared/lib/stablecoins/client-registry";

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
