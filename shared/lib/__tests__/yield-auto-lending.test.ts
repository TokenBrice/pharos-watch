import { describe, expect, it } from "vitest";
import { TRACKED_META_BY_ID, TRACKED_STABLECOINS } from "../stablecoins/registry";
import { isActiveStablecoinMeta } from "../stablecoins/status";
import { AUTO_LENDING_POOL_MAP, hasStaticYieldWorkbench, type StaticYieldWorkbenchCoin } from "@shared/lib/yield-auto-lending";

describe("yield workbench static route policy", () => {
  it("covers every active intrinsic yield coin and curated override while excluding inactive rows", () => {
    const selected = TRACKED_STABLECOINS.filter(hasStaticYieldWorkbench);
    const selectedIds = new Set(selected.map((coin) => coin.id));

    for (const coin of TRACKED_STABLECOINS) {
      const expected = isActiveStablecoinMeta(coin)
        && (coin.flags.yieldBearing === true || Object.hasOwn(AUTO_LENDING_POOL_MAP, coin.id));
      expect(selectedIds.has(coin.id), coin.id).toBe(expected);
    }
    for (const id of Object.keys(AUTO_LENDING_POOL_MAP)) {
      const coin = TRACKED_META_BY_ID.get(id);
      expect(coin, id).toBeDefined();
      expect(selectedIds.has(id), id).toBe(isActiveStablecoinMeta(coin!));
    }
  });

  it("selects only active intrinsic or overridden routes", () => {
    const fixtures: [StaticYieldWorkbenchCoin, boolean][] = [
      [{ id: "intrinsic-fixture", flags: { yieldBearing: true }, status: "active" }, true],
      [{ id: "plain-fixture", flags: { yieldBearing: false }, status: "active" }, false],
      [{ id: "u-united-stables", flags: { yieldBearing: false }, status: "active" }, true],
      [{ id: "intrinsic-fixture", flags: { yieldBearing: true }, status: "pre-launch" }, false],
      [{ id: "u-united-stables", flags: { yieldBearing: false }, status: "pre-launch" }, false],
    ];
    for (const [coin, expected] of fixtures) {
      expect(hasStaticYieldWorkbench(coin), `${coin.id}:${coin.status}`).toBe(expected);
    }
  });
});
