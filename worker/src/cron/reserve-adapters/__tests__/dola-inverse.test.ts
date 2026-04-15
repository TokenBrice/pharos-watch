import { describe, it, expect } from "vitest";
import {
  resolveBaseSymbol,
  bucketForAsset,
  adaptFirmMarkets,
  listUnexpectedDolaAssets,
  type FirmMarket,
} from "../dola-inverse";
import { getReserveAdapter } from "../index";
import { validateAdapterOutput } from "../validate";

function makeMarket(symbol: string, totalDebt = 1_000_000): FirmMarket {
  return { name: `${symbol} Market`, underlying: { symbol }, totalDebt, borrowPaused: false };
}

describe("resolveBaseSymbol", () => {
  it("extracts asset from Yearn DOLA vault: yv-DOLA-sUSDe → sUSDe", () => {
    expect(resolveBaseSymbol(makeMarket("yv-DOLA-sUSDe"))).toBe("sUSDe");
  });

  it("extracts asset from Yearn staked DOLA vault: yv-sDOLA-scrvUSD → scrvUSD", () => {
    expect(resolveBaseSymbol(makeMarket("yv-sDOLA-scrvUSD"))).toBe("scrvUSD");
  });

  it("handles Yearn non-DOLA vault: yv-WETH → WETH", () => {
    expect(resolveBaseSymbol(makeMarket("yv-WETH"))).toBe("WETH");
  });

  it("extracts asset from Curve CLP: DOLA-sUSDe clp → sUSDe", () => {
    expect(resolveBaseSymbol(makeMarket("DOLA-sUSDe clp"))).toBe("sUSDe");
  });

  it("extracts asset from Curve LP: DOLA-wstUSR lp → wstUSR", () => {
    expect(resolveBaseSymbol(makeMarket("DOLA-wstUSR lp"))).toBe("wstUSR");
  });

  it("handles Yearn FraxPyUSD LP: yv-DOLA-FraxPyUSD lp → FraxPyUSD lp", () => {
    expect(resolveBaseSymbol(makeMarket("yv-DOLA-FraxPyUSD lp"))).toBe("FraxPyUSD lp");
  });

  it("returns plain symbol unchanged: WBTC → WBTC", () => {
    expect(resolveBaseSymbol(makeMarket("WBTC"))).toBe("WBTC");
  });

  it("returns non-DOLA prefix unchanged: INV → INV", () => {
    expect(resolveBaseSymbol(makeMarket("INV"))).toBe("INV");
  });
});

describe("bucketForAsset", () => {
  it("classifies stablecoin assets", () => {
    for (const asset of ["sUSDe", "DAI", "USDC", "PYUSD", "USR", "DOLA-FRAXBP"]) {
      expect(bucketForAsset(asset)).toBe("stablecoin");
    }
  });

  it("classifies ETH/LST assets", () => {
    for (const asset of ["WETH", "wstETH", "rETH", "weETH"]) {
      expect(bucketForAsset(asset)).toBe("eth-lst");
    }
  });

  it("classifies BTC assets", () => {
    for (const asset of ["WBTC", "cbBTC", "tBTC"]) {
      expect(bucketForAsset(asset)).toBe("btc");
    }
  });

  it("classifies governance assets", () => {
    for (const asset of ["INV", "CRV", "CVX"]) {
      expect(bucketForAsset(asset)).toBe("governance");
    }
  });

  it("classifies unknown assets as other", () => {
    expect(bucketForAsset("UNKNOWN_TOKEN")).toBe("other");
  });
});

describe("adaptFirmMarkets", () => {
  it("produces correct bucket slices from mixed collateral", () => {
    const result = adaptFirmMarkets({
      markets: [
        makeMarket("wstETH", 5_000_000),
        makeMarket("sUSDe", 3_000_000),
        makeMarket("WBTC", 2_000_000),
      ],
      timestamp: 1000,
    });

    expect(result.slices).toHaveLength(3);
    const ethSlice = result.slices.find((s) => s.name.includes("ETH"));
    const stableSlice = result.slices.find((s) => s.name.includes("Stablecoin"));
    const btcSlice = result.slices.find((s) => s.name.includes("BTC"));
    expect(ethSlice?.pct).toBe(50);
    expect(stableSlice?.pct).toBe(30);
    expect(btcSlice?.pct).toBe(20);
  });

  it("filters out zero-debt markets", () => {
    const result = adaptFirmMarkets({
      markets: [
        makeMarket("wstETH", 1_000_000),
        makeMarket("WBTC", 0),
      ],
      timestamp: 1000,
    });

    expect(result.slices).toHaveLength(1);
    expect(result.slices[0].name).toContain("ETH");
    expect(result.slices[0].pct).toBe(100);
  });

  it("includes activeMarkets in metadata", () => {
    const result = adaptFirmMarkets({
      markets: [
        makeMarket("wstETH", 1_000_000),
        makeMarket("WBTC", 0),
        makeMarket("INV", 500_000),
      ],
      timestamp: 12345,
    });

    expect(result.metadata?.activeMarkets).toBe(2);
    expect(result.metadata?.totalMarkets).toBe(3);
    expect(result.metadata?.timestamp).toBe(12345);
    expect(result.metadata?.sourceTimestamp).toBe(12345);
    expect(result.metadata?.freshnessMode).toBe("verified");
    expect(result.metadata?.redemption).toBeUndefined();
    expect(validateAdapterOutput(result, { adapter: getReserveAdapter("dola-inverse") ?? undefined }).valid).toBe(true);
  });

  it("assigns correct risk levels to each bucket", () => {
    const result = adaptFirmMarkets({
      markets: [
        makeMarket("sUSDe", 1_000_000),
        makeMarket("wstETH", 1_000_000),
        makeMarket("WBTC", 1_000_000),
        makeMarket("INV", 1_000_000),
      ],
      timestamp: 1000,
    });

    const riskByPrefix: Record<string, string> = {};
    for (const s of result.slices) {
      const prefix = s.name.split(" (")[0];
      riskByPrefix[prefix] = s.risk;
    }
    expect(riskByPrefix["Stablecoin collateral"]).toBe("low");
    expect(riskByPrefix["ETH / Liquid staking"]).toBe("low");
    expect(riskByPrefix["BTC"]).toBe("medium");
    expect(riskByPrefix["Governance tokens"]).toBe("very-high");
  });
});

describe("listUnexpectedDolaAssets", () => {
  it("returns empty array when all assets are known", () => {
    const result = listUnexpectedDolaAssets({
      markets: [makeMarket("wstETH"), makeMarket("USDC")],
      timestamp: 1000,
    });
    expect(result).toEqual([]);
  });

  it("returns unknown asset symbols", () => {
    const result = listUnexpectedDolaAssets({
      markets: [makeMarket("wstETH"), makeMarket("MAGIC_TOKEN", 500)],
      timestamp: 1000,
    });
    expect(result).toEqual(["MAGIC_TOKEN"]);
  });

  it("ignores zero-debt markets", () => {
    const result = listUnexpectedDolaAssets({
      markets: [makeMarket("MAGIC_TOKEN", 0)],
      timestamp: 1000,
    });
    expect(result).toEqual([]);
  });
});
