// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import { useCommandPaletteHistory } from "@/hooks/use-command-palette-history";

describe("useCommandPaletteHistory", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("keeps the same snapshot reference across rerenders when storage is unchanged", () => {
    const { result, rerender } = renderHook(() => useCommandPaletteHistory());
    const initialHistory = result.current.history;

    rerender();

    expect(result.current.history).toBe(initialHistory);
  });

  it("writes and clears recent history through the localStorage-backed store", () => {
    const { result } = renderHook(() => useCommandPaletteHistory());

    act(() => {
      result.current.addToHistory(
        "usdt-tether",
        "stablecoin",
        "Tether",
        "USDT",
        "/stablecoin/usdt-tether/",
      );
    });

    expect(result.current.history).toHaveLength(1);
    expect(result.current.history[0]).toMatchObject({
      id: "usdt-tether",
      type: "stablecoin",
      label: "Tether",
      sublabel: "USDT",
      href: "/stablecoin/usdt-tether/",
    });

    act(() => {
      result.current.clearHistory();
    });

    expect(result.current.history).toEqual([]);
    expect(window.localStorage.getItem("pharos-command-palette-history")).toBeNull();
  });
});
