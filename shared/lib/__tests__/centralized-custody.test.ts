import { describe, it, expect } from "vitest";
import { computeCentralizedCustodyFraction, CENTRALIZED_CUSTODY_CRYPTO } from "@shared/lib/centralized-custody";
import type { StablecoinMeta } from "@shared/types";

const mockCoins: Pick<StablecoinMeta, "id" | "reserves" | "flags">[] = [
  {
    id: "pure-defi",
    flags: { governance: "decentralized", backing: "crypto-backed", pegCurrency: "USD", yieldBearing: false, rwa: false, navToken: false } as StablecoinMeta["flags"],
    reserves: [
      { name: "wstETH", pct: 60, risk: "low" },
      { name: "ETH", pct: 40, risk: "very-low" },
    ],
  },
  {
    id: "wbtc-heavy",
    flags: { governance: "decentralized", backing: "crypto-backed", pegCurrency: "USD", yieldBearing: false, rwa: false, navToken: false } as StablecoinMeta["flags"],
    reserves: [
      { name: "WBTC", pct: 60, risk: "medium" },
      { name: "wstETH", pct: 40, risk: "low" },
    ],
  },
  {
    id: "usdc-backed",
    flags: { governance: "centralized-dependent", backing: "crypto-backed", pegCurrency: "USD", yieldBearing: false, rwa: false, navToken: false } as StablecoinMeta["flags"],
    reserves: [
      { name: "USDC", pct: 80, risk: "low", coinId: "usdc-circle" },
      { name: "ETH", pct: 20, risk: "very-low" },
    ],
  },
  {
    id: "usdc-circle",
    flags: { governance: "centralized", backing: "rwa-backed", pegCurrency: "USD", yieldBearing: false, rwa: false, navToken: false } as StablecoinMeta["flags"],
    reserves: [
      { name: "U.S. Treasuries", pct: 75, risk: "very-low" },
      { name: "Cash", pct: 25, risk: "very-low" },
    ],
  },
  {
    id: "transitive-coin",
    flags: { governance: "decentralized", backing: "crypto-backed", pegCurrency: "USD", yieldBearing: false, rwa: false, navToken: false } as StablecoinMeta["flags"],
    reserves: [
      { name: "usdc-backed wrapper", pct: 100, risk: "low", coinId: "usdc-backed" },
    ],
  },
];

describe("computeCentralizedCustodyFraction", () => {
  it("returns 0 for pure DeFi reserves (no centralized-custody assets)", () => {
    expect(computeCentralizedCustodyFraction("pure-defi", mockCoins)).toBe(0);
  });

  it("returns direct centralized-custody crypto fraction", () => {
    expect(computeCentralizedCustodyFraction("wbtc-heavy", mockCoins)).toBeCloseTo(0.6);
  });

  it("counts CeFi stablecoins as centralized-custody", () => {
    expect(computeCentralizedCustodyFraction("usdc-backed", mockCoins)).toBeCloseTo(0.8);
  });

  it("treats CeFi-dep upstream as fully centralized-custody", () => {
    expect(computeCentralizedCustodyFraction("transitive-coin", mockCoins)).toBeCloseTo(1.0);
  });

  it("returns 0 for unknown coin ID", () => {
    expect(computeCentralizedCustodyFraction("nonexistent", mockCoins)).toBe(0);
  });

  it("handles circular dependencies without infinite recursion", () => {
    const cyclicCoins: Pick<StablecoinMeta, "id" | "reserves" | "flags">[] = [
      {
        id: "coin-a",
        flags: { governance: "decentralized", backing: "crypto-backed", pegCurrency: "USD", yieldBearing: false, rwa: false, navToken: false } as StablecoinMeta["flags"],
        reserves: [{ name: "Coin B wrapper", pct: 100, risk: "medium" as const, coinId: "coin-b" }],
      },
      {
        id: "coin-b",
        flags: { governance: "decentralized", backing: "crypto-backed", pegCurrency: "USD", yieldBearing: false, rwa: false, navToken: false } as StablecoinMeta["flags"],
        reserves: [{ name: "Coin A wrapper", pct: 100, risk: "medium" as const, coinId: "coin-a" }],
      },
    ];
    expect(computeCentralizedCustodyFraction("coin-a", cyclicCoins)).toBe(0);
  });
});

describe("CENTRALIZED_CUSTODY_CRYPTO", () => {
  it("includes WBTC, cbBTC, LBTC, SolvBTC", () => {
    expect(CENTRALIZED_CUSTODY_CRYPTO.has("WBTC")).toBe(true);
    expect(CENTRALIZED_CUSTODY_CRYPTO.has("CBBTC")).toBe(true);
    expect(CENTRALIZED_CUSTODY_CRYPTO.has("LBTC")).toBe(true);
    expect(CENTRALIZED_CUSTODY_CRYPTO.has("SOLVBTC")).toBe(true);
  });

  it("excludes tBTC (decentralized custody)", () => {
    expect(CENTRALIZED_CUSTODY_CRYPTO.has("TBTC")).toBe(false);
  });
});
