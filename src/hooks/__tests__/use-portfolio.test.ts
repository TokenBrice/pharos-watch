// @vitest-environment jsdom

import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { usePortfolio } from "../use-portfolio";

const STORAGE_KEY = "pharos:portfolio";

describe("usePortfolio", () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.history.replaceState(null, "", "/portfolio/");
  });

  it("normalizes stored holdings and writes the migrated state back", () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify([
        { coinId: "usdc-circle", amount: 0 },
        { coinId: "usdt-tether", amount: -1 },
        { coinId: "1", amount: 2 },
        { coinId: "not-a-coin", amount: 5 },
      ]),
    );

    const { result } = renderHook(() => usePortfolio());

    expect(result.current.holdings).toEqual([
      { coinId: "usdc-circle", amount: 0 },
    ]);
    expect(JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "null")).toEqual(result.current.holdings);
  });

  it("ignores invalid programmatic amounts", () => {
    const { result } = renderHook(() => usePortfolio());

    act(() => {
      result.current.addCoin("usdc-circle", 10);
      result.current.setAmount("usdc-circle", Infinity);
    });

    expect(result.current.holdings).toEqual([{ coinId: "usdc-circle", amount: 10 }]);
    expect(result.current.totalUsd).toBe(10);
  });

  it("persists clearAll for local storage portfolios", async () => {
    const { result } = renderHook(() => usePortfolio());

    act(() => {
      result.current.addCoin("usdc-circle", 10);
      result.current.clearAll();
    });

    await waitFor(() => {
      expect(window.localStorage.getItem(STORAGE_KEY)).toBe("[]");
    });
  });

  it("does not persist URL-sourced holdings to storage", () => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify([{ coinId: "usdt-tether", amount: 50 }]));
    window.history.replaceState(null, "", "/portfolio/?p=usdc-circle:0");

    const { result } = renderHook(() => usePortfolio());

    expect(result.current.isFromUrl).toBe(true);
    expect(result.current.holdings).toEqual([{ coinId: "usdc-circle", amount: 0 }]);
    expect(JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "null")).toEqual([
      { coinId: "usdt-tether", amount: 50 },
    ]);
  });

  it("seeds URL-sourced holdings from a router-supplied param without reading the location bar", () => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify([{ coinId: "usdt-tether", amount: 50 }]));
    // location bar is bare ("/portfolio/"); the param arrives from the caller.
    const { result } = renderHook(() => usePortfolio("usdc-circle:0"));

    expect(result.current.isFromUrl).toBe(true);
    expect(result.current.holdings).toEqual([{ coinId: "usdc-circle", amount: 0 }]);
  });

  it("falls back to the location bar when no router param is supplied", () => {
    window.history.replaceState(null, "", "/portfolio/?p=usdc-circle:0");
    const { result } = renderHook(() => usePortfolio());

    expect(result.current.isFromUrl).toBe(true);
    expect(result.current.holdings).toEqual([{ coinId: "usdc-circle", amount: 0 }]);
  });

  it("treats an empty router param as no shared portfolio", () => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify([{ coinId: "usdt-tether", amount: 50 }]));
    const { result } = renderHook(() => usePortfolio(""));

    expect(result.current.isFromUrl).toBe(false);
    expect(result.current.holdings).toEqual([{ coinId: "usdt-tether", amount: 50 }]);
  });

  it("builds share URLs from normalized holdings and removes p when empty", () => {
    const { result } = renderHook(() => usePortfolio());

    act(() => {
      result.current.addCoin("usdt-tether", 0);
      result.current.addCoin("usdc-circle", 20);
    });

    const shared = new URL(result.current.shareUrl());
    expect(shared.searchParams.get("p")).toBe("usdt-tether:0,usdc-circle:20");

    act(() => {
      result.current.clearAll();
    });

    expect(new URL(result.current.shareUrl()).searchParams.has("p")).toBe(false);
  });
});
