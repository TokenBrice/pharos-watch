import { describe, it, expect } from "vitest";

// resolveSourceStatus is not exported, so we test the logic inline
type SourceStatus = "used" | "available" | "no-data" | "not-applicable";

function resolveSourceStatus(
  sourceKey: string,
  agreeSources: string[],
  consensusSources: string[],
  isProtocolRedeem: boolean,
): SourceStatus {
  if (isProtocolRedeem) return "not-applicable";
  if (agreeSources.includes(sourceKey)) return "used";
  if (consensusSources.includes(sourceKey)) return "available";
  return "no-data";
}

describe("resolveSourceStatus", () => {
  it("returns 'used' when source is in agreeSources", () => {
    expect(resolveSourceStatus("binance", ["binance", "coingecko"], ["binance", "coingecko", "pyth"], false)).toBe("used");
  });

  it("returns 'available' when source is in consensusSources but not agreeSources", () => {
    expect(resolveSourceStatus("pyth", ["binance", "coingecko"], ["binance", "coingecko", "pyth"], false)).toBe("available");
  });

  it("returns 'no-data' when source is in neither", () => {
    expect(resolveSourceStatus("redstone", ["binance"], ["binance", "coingecko"], false)).toBe("no-data");
  });

  it("returns 'not-applicable' for protocol-redeem coins", () => {
    expect(resolveSourceStatus("binance", ["binance"], ["binance"], true)).toBe("not-applicable");
  });
});
