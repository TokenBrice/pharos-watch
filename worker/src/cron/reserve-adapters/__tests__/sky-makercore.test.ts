import { describe, it, expect } from "vitest";
import { adaptSkyCollateral, listUnexpectedTokens } from "../sky-makercore";

describe("adaptSkyCollateral", () => {
  it("buckets tokens into stablecoins, eth/lsd, btc, and other", () => {
    const tokens = {
      USDC: 5_000_000,
      WETH: 2_000_000,
      WSTETH: 500_000,
      WBTC: 1_000_000,
      LINK: 500_000,
      UNI: 500_000,
    };

    const slices = adaptSkyCollateral(tokens);

    expect(slices.length).toBe(4);
    const stableSlice = slices.find((s) => s.name.includes("Stablecoins"));
    expect(stableSlice).toBeDefined();
    expect(stableSlice!.risk).toBe("low");
    expect(stableSlice!.coinId).toBe("usdc-circle");

    const ethSlice = slices.find((s) => s.name.includes("ETH"));
    expect(ethSlice).toBeDefined();
    expect(ethSlice!.risk).toBe("low");

    const btcSlice = slices.find((s) => s.name.includes("BTC"));
    expect(btcSlice).toBeDefined();
    expect(btcSlice!.risk).toBe("medium");

    const otherSlice = slices.find((s) => s.name.includes("Other"));
    expect(otherSlice).toBeDefined();
    expect(otherSlice!.risk).toBe("high");

    const total = slices.reduce((sum, s) => sum + s.pct, 0);
    expect(total).toBe(100);
  });

  it("returns empty when all values are zero", () => {
    const slices = adaptSkyCollateral({ USDC: 0, WETH: 0 });
    expect(slices).toEqual([]);
  });

  it("omits zero-value buckets", () => {
    const slices = adaptSkyCollateral({ USDC: 1_000_000, WETH: 500_000 });
    expect(slices.length).toBe(2);
    expect(slices.every((s) => s.pct > 0)).toBe(true);
  });
});

describe("listUnexpectedTokens", () => {
  it("identifies tokens not in the known set", () => {
    const tokens = { USDC: 100, WETH: 50, NEWTOKEN: 10, MYSTERY: 5 };
    const unknown = listUnexpectedTokens(tokens);
    expect(unknown).toContain("NEWTOKEN");
    expect(unknown).toContain("MYSTERY");
    expect(unknown).not.toContain("USDC");
    expect(unknown).not.toContain("WETH");
  });
});
