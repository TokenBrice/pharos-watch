import { describe, expect, it } from "vitest";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { buildStablecoinStaticMeta } from "@/lib/stablecoin-static-meta";

describe("buildStablecoinStaticMeta", () => {
  it("keeps stablecoin detail static props to the fields needed before site-data loads", () => {
    const coin = TRACKED_META_BY_ID.get("usdt-tether")!;
    const staticMeta = buildStablecoinStaticMeta(coin);

    expect(staticMeta).toEqual({
      id: coin.id,
      name: coin.name,
      symbol: coin.symbol,
      flags: coin.flags,
      hasCollateralUsage: false,
    });
    expect("contracts" in staticMeta).toBe(false);
    expect("reserves" in staticMeta).toBe(false);
    expect("links" in staticMeta).toBe(false);
  });

  it("carries server-computed detail booleans without adding large metadata", () => {
    const coin = TRACKED_META_BY_ID.get("usdc-circle")!;

    expect(buildStablecoinStaticMeta(coin, { hasCollateralUsage: true }).hasCollateralUsage).toBe(true);
  });
});
