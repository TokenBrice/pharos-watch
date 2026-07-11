import { describe, expect, it } from "vitest";
import { TRACKED_META_BY_ID, TRACKED_STABLECOINS } from "../stablecoins/registry";
import { AUTO_LENDING_POOL_MAP, hasStaticYieldWorkbench } from "../yield-auto-lending";

describe("yield workbench static route policy", () => {
  it("covers every intrinsic yield coin and curated auto-lending override", () => {
    const selected = TRACKED_STABLECOINS.filter(hasStaticYieldWorkbench);
    const selectedIds = new Set(selected.map((coin) => coin.id));

    for (const coin of TRACKED_STABLECOINS) {
      if (coin.status !== "pre-launch" && coin.flags.yieldBearing === true) {
        expect(selectedIds.has(coin.id), coin.id).toBe(true);
      }
    }
    for (const id of Object.keys(AUTO_LENDING_POOL_MAP)) {
      expect(TRACKED_META_BY_ID.has(id), id).toBe(true);
      expect(selectedIds.has(id), id).toBe(true);
    }
  });

  it("keeps the generated route family materially below the full catalog", () => {
    const activeOrFrozen = TRACKED_STABLECOINS.filter((coin) => coin.status !== "pre-launch");
    const selected = activeOrFrozen.filter(hasStaticYieldWorkbench);
    expect(selected.length).toBeGreaterThan(100);
    expect(selected.length).toBeLessThan(activeOrFrozen.length / 2);
  });
});
