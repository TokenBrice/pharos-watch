// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useCommandPaletteHistory } from "@/hooks/use-command-palette-history";

const STORAGE_KEY = "pharos-command-palette-history";
const NOW = 1_750_000_000_000;
const HISTORY_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

function makeStoredItem(id: string, timestamp: number) {
  return { id, type: "stablecoin", label: id.toUpperCase(), href: `/stablecoin/${id}/`, timestamp };
}

describe("useCommandPaletteHistory", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
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

  it("drops stored history at or before the seven-day cutoff but keeps fresher records", () => {
    vi.useFakeTimers({ now: NOW });
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify([
      makeStoredItem("stale", NOW - HISTORY_RETENTION_MS - 1_000),
      makeStoredItem("at-cutoff", NOW - HISTORY_RETENTION_MS),
      makeStoredItem("fresh", NOW - HISTORY_RETENTION_MS + 1_000),
    ]));

    const { result } = renderHook(() => useCommandPaletteHistory());

    expect(result.current.history.map((item) => item.id)).toEqual(["fresh"]);
  });

  it("orders history newest-first and evicts entries beyond five", () => {
    vi.useFakeTimers({ now: NOW });
    const { result } = renderHook(() => useCommandPaletteHistory());

    for (const id of ["one", "two", "three", "four", "five", "six"]) {
      act(() => {
        vi.advanceTimersByTime(60_000);
        result.current.addToHistory(id, "stablecoin", id.toUpperCase(), undefined, `/stablecoin/${id}/`);
      });
    }

    expect(result.current.history).toHaveLength(5);
    expect(result.current.history.map((item) => item.id)).toEqual(["six", "five", "four", "three", "two"]);
    for (let i = 1; i < result.current.history.length; i++) {
      expect(result.current.history[i].timestamp).toBeLessThan(result.current.history[i - 1].timestamp);
    }
  });

  it("moves a re-added entry to the front with its updated fields instead of duplicating it", () => {
    vi.useFakeTimers({ now: NOW });
    const { result } = renderHook(() => useCommandPaletteHistory());

    act(() => {
      result.current.addToHistory("usdc", "stablecoin", "USD Coin", "USDC", "/stablecoin/usdc-usd-coin/");
    });
    act(() => {
      vi.advanceTimersByTime(60_000);
      result.current.addToHistory("about", "page", "About", undefined, "/about/");
    });
    act(() => {
      vi.advanceTimersByTime(60_000);
      result.current.addToHistory("usdc", "stablecoin", "USD Coin (updated)", "USDC v2", "/stablecoin/usdc-usd-coin/");
    });

    expect(result.current.history.map((item) => item.id)).toEqual(["usdc", "about"]);
    expect(result.current.history[0]).toMatchObject({
      label: "USD Coin (updated)",
      sublabel: "USDC v2",
      timestamp: NOW + 120_000,
    });
  });
});
