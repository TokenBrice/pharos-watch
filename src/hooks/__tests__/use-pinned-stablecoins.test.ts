// @vitest-environment jsdom

import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { usePinnedStablecoins } from "@/hooks/use-pinned-stablecoins";
import { WATCHLIST_STORAGE_KEY } from "@/hooks/use-watchlist";
import { PINNED_STABLECOINS_STORAGE_KEY } from "@/lib/pinned-stablecoins";

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
});
