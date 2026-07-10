import { describe, expect, it } from "vitest";
import { initialViewFromStartParam, relaunchPayloadForView, type ViewKey } from "./use-mini-app-view";
import type { CoinInsightTarget } from "./types";

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
