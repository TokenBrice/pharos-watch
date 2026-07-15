import { describe, expect, it } from "vitest";
import { TRACKED_META_BY_ID, TRACKED_STABLECOINS } from "../stablecoins/registry";
import { isActiveStablecoinMeta } from "../stablecoins/status";
import { AUTO_LENDING_POOL_MAP, hasStaticYieldWorkbench } from "../yield-auto-lending";

describe("yield workbench static route policy", () => {
  it("covers every active intrinsic yield coin and curated override while excluding inactive rows", () => {
    const selected = TRACKED_STABLECOINS.filter(hasStaticYieldWorkbench);
    const selectedIds = new Set(selected.map((coin) => coin.id));

    for (const coin of TRACKED_STABLECOINS) {
      if (isActiveStablecoinMeta(coin) && coin.flags.yieldBearing === true) {
        expect(selectedIds.has(coin.id), coin.id).toBe(true);
      }
    }
    for (const id of Object.keys(AUTO_LENDING_POOL_MAP)) {
      const coin = TRACKED_META_BY_ID.get(id);
      expect(coin, id).toBeDefined();
      expect(selectedIds.has(id), id).toBe(isActiveStablecoinMeta(coin!));
    }
  });

  it("keeps the generated route family materially below the full catalog", () => {
    const activeCoins = TRACKED_STABLECOINS.filter(isActiveStablecoinMeta);
    const selected = activeCoins.filter(hasStaticYieldWorkbench);
    expect(selected.length).toBeGreaterThan(100);
    expect(selected.length).toBeLessThan(activeCoins.length / 2);
  });
});
