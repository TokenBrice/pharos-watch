// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { initialViewFromStartParam, relaunchPayloadForView, useMiniAppView, type ViewKey } from "./use-mini-app-view";
import type { CoinInsightTarget } from "./types";
import { baseState } from "./mini-app-test-fixtures";

afterEach(() => { cleanup(); vi.useRealTimers(); });

describe("current relaunch context", () => {
  it("relaunches the newly focused coin after the highlight expires, not the launch coin", () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useMiniAppView(baseState));
    act(() => result.current.initializeFromStartParam("coin_usdt-tether"));
    act(() => result.current.navigateToCoin("usdc-circle"));
    act(() => vi.advanceTimersByTime(2_000));
    expect(result.current.highlightedCoinId).toBeNull();
    expect(result.current.visibleCoinTarget).toBe("usdt-tether");
    expect(relaunchPayloadForView(result.current.view, result.current.coinInsightTarget, result.current.currentCoinTarget)).toBe("coin_usdc-circle");

    act(() => result.current.activateView("presets"));
    act(() => result.current.activateView("watchlist"));
    expect(result.current.visibleCoinTarget).toBeNull();
    expect(result.current.currentCoinTarget).toBeNull();
    expect(relaunchPayloadForView(result.current.view, null, result.current.currentCoinTarget)).toBe("watchlist");
  });

  it.each(["why", "coverage"] as const)("prioritizes %s insight and clears coin context through native navigation", (kind) => {
    const { result } = renderHook(() => useMiniAppView(baseState));
    act(() => result.current.initializeFromStartParam("coin_usdc-circle"));
    act(() => result.current.setCoinInsightTarget({ kind, coinId: "usdt-tether" }));
    expect(relaunchPayloadForView(result.current.view, result.current.coinInsightTarget, result.current.currentCoinTarget)).toBe(`${kind}_usdt-tether`);
    act(() => result.current.handleBack());
    expect(relaunchPayloadForView(result.current.view, result.current.coinInsightTarget, result.current.currentCoinTarget)).toBe("coin_usdc-circle");
    act(() => result.current.showSettings());
    act(() => result.current.activateView("watchlist"));
    expect(result.current.currentCoinTarget).toBeNull();
    act(() => result.current.navigateToCoin("usdc-circle"));
    act(() => result.current.handleBack());
    expect(result.current.currentCoinTarget).toBeNull();
  });
});


describe("relaunchPayloadForView", () => {
  it.each<[ViewKey, CoinInsightTarget | null, string | null, string]>([
    ["home", null, null, "home"],
    ["settings", null, null, "settings"],
    ["presets", null, null, "presets"],
    ["watchlist", null, null, "watchlist"],
    ["watchlist", null, "usdc-circle", "coin_usdc-circle"],
    ["watchlist", { kind: "why", coinId: "usdc-circle" }, null, "why_usdc-circle"],
    ["watchlist", { kind: "coverage", coinId: "usdc-circle" }, "usdc-circle", "coverage_usdc-circle"],
  ])("encodes %s view (insight %o, coin %o) as %s", (view, insight, coinId, expected) => {
    expect(relaunchPayloadForView(view, insight, coinId)).toBe(expected);
  });

  it("round-trips every payload back to the same view, coin, and insight", () => {
    const contexts: Array<{ view: ViewKey; insight: CoinInsightTarget | null; coinId: string | null }> = [
      { view: "home", insight: null, coinId: null },
      { view: "settings", insight: null, coinId: null },
      { view: "presets", insight: null, coinId: null },
      { view: "watchlist", insight: null, coinId: null },
      { view: "watchlist", insight: null, coinId: "usdt-tether" },
      { view: "watchlist", insight: { kind: "why", coinId: "usdt-tether" }, coinId: "usdt-tether" },
      { view: "watchlist", insight: { kind: "coverage", coinId: "usdt-tether" }, coinId: "usdt-tether" },
    ];
    for (const context of contexts) {
      const restored = initialViewFromStartParam(relaunchPayloadForView(context.view, context.insight, context.coinId));
      expect(restored.view).toBe(context.view);
      expect(restored.insight).toEqual(context.insight);
      if (context.view === "watchlist" && (context.insight || context.coinId)) {
        expect(restored.coinId).toBe(context.insight?.coinId ?? context.coinId);
      }
    }
  });
});
