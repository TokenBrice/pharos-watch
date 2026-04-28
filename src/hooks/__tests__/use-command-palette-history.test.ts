// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import { useCommandPaletteHistory } from "@/hooks/use-command-palette-history";

const STORAGE_KEY = "pharos-command-palette-history";

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
    expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it("reads valid array history from localStorage", () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify([
        {
          id: "about",
          type: "page",
          label: "About",
          href: "/about/",
          timestamp: Date.now(),
        },
      ]),
    );

    const { result } = renderHook(() => useCommandPaletteHistory());

    expect(result.current.history).toEqual([
      expect.objectContaining({
        id: "about",
        type: "page",
        label: "About",
        href: "/about/",
      }),
    ]);
  });

  it.each([
    ["object", { id: "about" }],
    ["null", null],
    ["primitive", "about"],
  ])("treats %s JSON as empty history", (_label, stored) => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));

    const { result } = renderHook(() => useCommandPaletteHistory());

    expect(result.current.history).toEqual([]);
  });

  it("ignores malformed items inside a valid history array", () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify([
        null,
        { id: "missing-fields" },
        {
          id: "usdc-usd-coin",
          type: "stablecoin",
          label: "USD Coin",
          sublabel: "USDC",
          href: "/stablecoin/usdc-usd-coin/",
          timestamp: Date.now(),
        },
      ]),
    );

    const { result } = renderHook(() => useCommandPaletteHistory());

    expect(result.current.history).toHaveLength(1);
    expect(result.current.history[0]).toMatchObject({
      id: "usdc-usd-coin",
      type: "stablecoin",
      label: "USD Coin",
      sublabel: "USDC",
      href: "/stablecoin/usdc-usd-coin/",
    });
  });
});
