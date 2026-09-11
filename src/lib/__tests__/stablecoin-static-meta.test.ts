import { describe, expect, it } from "vitest";
import { makeStablecoinMeta } from "@shared/test-utils/stablecoin";
import { buildStablecoinStaticMeta } from "@/lib/stablecoin-static-meta";

describe("buildStablecoinStaticMeta", () => {
  it("keeps stablecoin detail static props to the fields needed before site-data loads", () => {
    const coin = makeStablecoinMeta({
      contracts: [{ chain: "ethereum", address: "0x1", decimals: 6 }],
      reserves: [{ name: "Cash", pct: 100, risk: "very-low" }],
      links: [{ label: "Website", url: "https://example.com" }],
    });
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
    const coin = makeStablecoinMeta();

    expect(buildStablecoinStaticMeta(coin, { hasCollateralUsage: true }).hasCollateralUsage).toBe(true);
  });
});
