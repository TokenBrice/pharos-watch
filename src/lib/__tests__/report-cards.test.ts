import { describe, it, expect } from "vitest";
import {
  isBlacklistable,
  computeCollateralQualityFromReserves,
} from "@shared/lib/report-cards";
import type { StablecoinMeta } from "@shared/types";

// Minimal meta helper
function makeMeta(overrides: Partial<StablecoinMeta> = {}): StablecoinMeta {
  return {
    id: "test",
    name: "Test Coin",
    symbol: "TST",
    geckoId: null,
    cmcId: null,
    llamaId: null,
    peg: "USD",
    decimals: {},
    contracts: {},
    links: {},
    flags: { governance: "centralized", backing: "rwa-backed", pegCurrency: "USD", yieldBearing: false, rwa: true, navToken: false },
    ...overrides,
  } as StablecoinMeta;
}

describe("isBlacklistable — inherited risk from reserves", () => {
  it("returns true for centralized governance (no index needed)", () => {
    const meta = makeMeta({ flags: { governance: "centralized", backing: "rwa-backed", pegCurrency: "USD", yieldBearing: false, rwa: true, navToken: false } });
    expect(isBlacklistable(meta)).toBe(true);
  });

  it("returns false for decentralized governance with no reserves", () => {
    const meta = makeMeta({ flags: { governance: "decentralized", backing: "crypto-backed", pegCurrency: "USD", yieldBearing: false, rwa: false, navToken: false } });
    expect(isBlacklistable(meta)).toBe(false);
  });

  it("returns inherited when reserves link to blacklistable coinIds", () => {
    const meta = makeMeta({
      flags: { governance: "decentralized", backing: "crypto-backed", pegCurrency: "USD", yieldBearing: false, rwa: false, navToken: false },
      reserves: [
        { name: "USDC via PSM", pct: 55, risk: "low", coinId: "usdc-circle" },
        { name: "ETH", pct: 45, risk: "medium" },
      ],
    });
    const blacklistableIds = new Set(["usdc-circle"]);
    expect(isBlacklistable(meta, blacklistableIds)).toBe("inherited");
  });

  it("does not infer inherited exposure below the strict majority threshold", () => {
    const meta = makeMeta({
      flags: { governance: "decentralized", backing: "crypto-backed", pegCurrency: "USD", yieldBearing: false, rwa: false, navToken: false },
      reserves: [
        { name: "USDC buffer", pct: 49, risk: "low", coinId: "usdc-circle" },
        { name: "ETH", pct: 51, risk: "medium" },
      ],
    });
    const blacklistableIds = new Set(["usdc-circle"]);
    expect(isBlacklistable(meta, blacklistableIds)).toBe(false);
  });

  it("counts explicit reserve-slice blacklistability even without coinId links", () => {
    const meta = makeMeta({
      flags: { governance: "decentralized", backing: "crypto-backed", pegCurrency: "USD", yieldBearing: false, rwa: false, navToken: false },
      reserves: [
        { name: "WBTC", pct: 58, risk: "medium", blacklistable: true },
        { name: "wstETH", pct: 42, risk: "low" },
      ],
    });
    expect(isBlacklistable(meta)).toBe("inherited");
  });

  it("explicit canBeBlacklisted: false needs reviewed rationale to suppress upstream reserves", () => {
    const meta = makeMeta({
      canBeBlacklisted: false,
      flags: { governance: "decentralized", backing: "crypto-backed", pegCurrency: "USD", yieldBearing: false, rwa: false, navToken: false },
      reserves: [
        { name: "USDC", pct: 100, risk: "low", coinId: "usdc-circle" },
      ],
    });
    const blacklistableIds = new Set(["usdc-circle"]);
    expect(isBlacklistable(meta, blacklistableIds)).toBe("inherited");
  });

  it("does not infer inherited exposure at exactly half of reserves", () => {
    const meta = makeMeta({
      flags: { governance: "decentralized", backing: "crypto-backed", pegCurrency: "USD", yieldBearing: false, rwa: false, navToken: false },
      reserves: [
        { name: "sDAI", pct: 50, risk: "low", coinId: "dai-makerdao" },
        { name: "ETH", pct: 50, risk: "medium" },
      ],
    });
    const blacklistableIds = new Set(["usdc-circle", "usdt-tether"]);
    expect(isBlacklistable(meta, blacklistableIds)).toBe(false);
  });

  it("does not infer inherited exposure for a minority unlabeled stablecoin slice", () => {
    const meta = makeMeta({
      flags: { governance: "decentralized", backing: "crypto-backed", pegCurrency: "USD", yieldBearing: false, rwa: false, navToken: false },
      reserves: [
        { name: "USDC (unlabelled)", pct: 30, risk: "low" },
        { name: "ETH", pct: 70, risk: "medium" },
      ],
    });
    const blacklistableIds = new Set(["usdc-circle"]);
    expect(isBlacklistable(meta, blacklistableIds)).toBe(false);
  });

  it("returns inherited for cex custody even when reserve slices are generic", () => {
    const meta = makeMeta({
      custodyModel: "cex",
      flags: { governance: "centralized-dependent", backing: "crypto-backed", pegCurrency: "USD", yieldBearing: false, rwa: false, navToken: false },
      reserves: [
        { name: "Delta-neutral basis trade", pct: 100, risk: "high" },
      ],
    });
    expect(isBlacklistable(meta)).toBe("inherited");
  });
});

describe("computeCollateralQualityFromReserves", () => {
  it("returns 0 for empty reserves array", () => {
    expect(computeCollateralQualityFromReserves([])).toBe(0);
  });

  it("returns 100 for 100% very-low risk reserves", () => {
    const reserves = [{ name: "US Treasuries", pct: 100, risk: "very-low" as const }];
    expect(computeCollateralQualityFromReserves(reserves)).toBe(100);
  });

  it("returns 5 for 100% very-high risk reserves", () => {
    const reserves = [{ name: "Algo backing", pct: 100, risk: "very-high" as const }];
    expect(computeCollateralQualityFromReserves(reserves)).toBe(5);
  });

  it("computes weighted average for mixed reserves", () => {
    const reserves = [
      { name: "Treasuries", pct: 60, risk: "very-low" as const },  // 60% * 100 = 6000
      { name: "Corporate bonds", pct: 40, risk: "medium" as const }, // 40% * 50  = 2000
    ];
    // (6000 + 2000) / 100 = 80
    expect(computeCollateralQualityFromReserves(reserves)).toBe(80);
  });

  it("handles reserves that don't sum to 100%", () => {
    const reserves = [
      { name: "USDC", pct: 30, risk: "low" as const },     // 30 * 75 = 2250
      { name: "ETH", pct: 20, risk: "high" as const },      // 20 * 25 = 500
    ];
    // totalPct = 50, weighted = 2750, result = 2750/50 = 55
    expect(computeCollateralQualityFromReserves(reserves)).toBe(55);
  });

  it("rounds to nearest integer", () => {
    const reserves = [
      { name: "Treasuries", pct: 70, risk: "very-low" as const },  // 70 * 100 = 7000
      { name: "Crypto", pct: 30, risk: "high" as const },           // 30 * 25  = 750
    ];
    // (7000 + 750) / 100 = 77.5, rounded to 78
    expect(computeCollateralQualityFromReserves(reserves)).toBe(78);
  });

  it("returns 0 when all pct values are 0", () => {
    const reserves = [{ name: "Ghost", pct: 0, risk: "very-low" as const }];
    expect(computeCollateralQualityFromReserves(reserves)).toBe(0);
  });

  it("treats unknown risk values as 0 instead of producing NaN", () => {
    const slices = [
      { name: "Good", pct: 50, risk: "low" as const },
      { name: "Bad", pct: 50, risk: "bogus" as unknown as "low" },
    ];
    const score = computeCollateralQualityFromReserves(slices);
    expect(Number.isFinite(score)).toBe(true);
    expect(score).toBe(Math.round((50 * 75 + 50 * 0) / 100)); // 38
  });

  it("returns 0 when all risk values are invalid", () => {
    const slices = [
      { name: "A", pct: 60, risk: "invalid" as unknown as "low" },
      { name: "B", pct: 40, risk: "nope" as unknown as "low" },
    ];
    expect(computeCollateralQualityFromReserves(slices)).toBe(0);
  });
});
