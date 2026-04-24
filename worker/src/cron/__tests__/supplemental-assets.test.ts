import { describe, expect, it } from "vitest";
import type { StablecoinMeta } from "@shared/types/core";
import { selectSingleOnChainSupplyContract } from "../sync-stablecoins/supplemental-assets";

function makeMeta(contracts: StablecoinMeta["contracts"]): StablecoinMeta {
  return {
    id: "test-stablecoin",
    name: "Test Stablecoin",
    symbol: "TEST",
    detailProvider: "coingecko",
    contracts,
    flags: {
      pegCurrency: "USD",
      backing: "fiat-backed",
      governance: "centralized",
      yieldBearing: false,
      navToken: false,
    },
  } as StablecoinMeta;
}

describe("selectSingleOnChainSupplyContract", () => {
  it("returns one supported EVM contract", () => {
    const contract = { chain: "ethereum", address: "0x0000000000000000000000000000000000000001", decimals: 6 };

    expect(selectSingleOnChainSupplyContract(makeMeta([contract]))).toBe(contract);
  });

  it("returns one supported Solana contract", () => {
    const contract = { chain: "solana", address: "So11111111111111111111111111111111111111112", decimals: 6 };

    expect(selectSingleOnChainSupplyContract(makeMeta([contract]))).toBe(contract);
  });

  it("ignores unsupported standalone contracts", () => {
    expect(selectSingleOnChainSupplyContract(makeMeta([
      { chain: "stellar", address: "TEST.STELLAR", decimals: 7 },
      { chain: "tron", address: "TEST.TRON", decimals: 6 },
    ]))).toBeNull();
  });

  it("rejects multiple supported contracts to avoid publishing partial global supply", () => {
    expect(selectSingleOnChainSupplyContract(makeMeta([
      { chain: "ethereum", address: "0x0000000000000000000000000000000000000001", decimals: 6 },
      { chain: "bsc", address: "0x0000000000000000000000000000000000000002", decimals: 6 },
    ]))).toBeNull();
  });
});
