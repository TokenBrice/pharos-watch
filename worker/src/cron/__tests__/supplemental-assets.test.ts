import { describe, expect, it } from "vitest";
import type { StablecoinMeta } from "@shared/types/core";
import {
  computeExcludedBalanceAdjustedSupplyRaw,
  resolveSupplementalPrice,
  selectSingleOnChainSupplyContract,
  selectSupplementalOnChainSupplyContract,
} from "../sync-stablecoins/supplemental-assets";

function makeMeta(contracts: StablecoinMeta["contracts"], id = "test-stablecoin"): StablecoinMeta {
  return {
    id,
    name: "Test Stablecoin",
    symbol: "TEST",
    detailProvider: "coingecko",
    contracts,
    flags: {
      pegCurrency: "USD",
      backing: "rwa-backed",
      governance: "centralized",
      yieldBearing: false,
      rwa: false,
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

  it("rejects mixed supported and unsupported contracts to avoid partial global supply", () => {
    expect(selectSingleOnChainSupplyContract(makeMeta([
      { chain: "tron", address: "TEST.TRON", decimals: 6 },
      { chain: "ethereum", address: "0x0000000000000000000000000000000000000001", decimals: 6 },
    ]))).toBeNull();
  });

  it("allows curated multi-chain supplemental assets to use a configured supply chain", () => {
    const ethereumContract = { chain: "ethereum", address: "0x28b3a8fb53b741a8fd78c0fb9a6b2393d896a43d", decimals: 6 };
    const avalancheContract = { chain: "avalanche", address: "0x28b3a8fb53b741a8fd78c0fb9a6b2393d896a43d", decimals: 6 };

    expect(selectSingleOnChainSupplyContract(makeMeta([
      ethereumContract,
      avalancheContract,
    ], "susdc-spark"))).toBeNull();
    expect(selectSupplementalOnChainSupplyContract(makeMeta([
      ethereumContract,
      avalancheContract,
    ], "susdc-spark"))).toBe(ethereumContract);
  });
});

describe("computeExcludedBalanceAdjustedSupplyRaw", () => {
  it("subtracts configured non-circulating balances before decimal conversion", () => {
    expect(computeExcludedBalanceAdjustedSupplyRaw(
      40_020_000n * 10n ** 18n,
      [
        19_686_793n * 10n ** 18n,
        19_780_590n * 10n ** 18n,
      ],
    )).toBe(552_617n * 10n ** 18n);
  });

  it("fails closed when excluded balances exhaust supply", () => {
    expect(computeExcludedBalanceAdjustedSupplyRaw(1_000n, [1_000n])).toBeNull();
    expect(computeExcludedBalanceAdjustedSupplyRaw(1_000n, [1_001n])).toBeNull();
  });
});

describe("resolveSupplementalPrice", () => {
  it("rejects stale supplemental CoinGecko rows with upstream timestamps", () => {
    const nowSec = Math.floor(Date.now() / 1000);

    expect(resolveSupplementalPrice(
      { coins: {} },
      {
        vcred: {
          usd: 1,
          usd_market_cap: 1_000_000,
          last_updated_at: nowSec - 60 * 60,
        },
      },
      "vcred",
    )).toBeNull();
  });

  it("preserves fresh supplemental CoinGecko upstream timestamps", () => {
    const nowSec = Math.floor(Date.now() / 1000);

    expect(resolveSupplementalPrice(
      { coins: {} },
      {
        vcred: {
          usd: 1,
          usd_market_cap: 1_000_000,
          last_updated_at: nowSec - 60,
        },
      },
      "vcred",
    )).toEqual({
      price: 1,
      source: "coingecko",
      observedAt: nowSec - 60,
      observedAtMode: "upstream",
    });
  });
});
