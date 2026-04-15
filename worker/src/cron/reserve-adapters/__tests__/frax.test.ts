import { describe, it, expect } from "vitest";
import type { StablecoinMeta } from "@shared/types/core";
import {
  adaptFraxBalanceSheet,
  adaptFraxCombinedData,
  type FraxBalanceSheetResponse,
  type FraxCombinedDataResponse,
} from "../frax";

/* ---------- v2 balance-sheet tests ---------- */

const BALANCE_SHEET_SAMPLE: FraxBalanceSheetResponse = {
  asOfTimestamp: "2026-04-04T13:03:47.000Z",
  totalAssets: 123_010_191,
  assets: [
    { tokenSymbol: "USDC", totalValueUsd: 415_981.93, category: "asset:owned:usd" },
    { tokenSymbol: "USTB", totalValueUsd: 17_676.98, category: "asset:owned:usd" },
    { tokenSymbol: "WTGXX", totalValueUsd: 51_149_947.74, category: "asset:owned:usd" },
    { tokenSymbol: "WTGXX", totalValueUsd: 65_022.57, category: "asset:owned:usd" },
    { tokenSymbol: "BUIDL", totalValueUsd: 10_000, category: "asset:owned:usd" },
    { tokenSymbol: "USTB", totalValueUsd: 45_504_345.53, category: "asset:owned:usd" },
    { tokenSymbol: "WTGXX", totalValueUsd: 8_265_342.81, category: "asset:owned:usd" },
    { tokenSymbol: "BUIDL", totalValueUsd: 15_581_870.39, category: "asset:owned:usd" },
    { tokenSymbol: "USDB", totalValueUsd: 2_000_003.70, category: "asset:owned:usd" },
  ],
};

describe("adaptFraxBalanceSheet", () => {
  it("aggregates by tokenSymbol and produces correct slices", () => {
    const result = adaptFraxBalanceSheet(BALANCE_SHEET_SAMPLE);
    expect(result.slices.length).toBe(5);

    const byName = (name: string) => result.slices.find((s) => s.name.startsWith(name));
    expect(byName("WTGXX")!.pct).toBeGreaterThan(45);
    expect(byName("USTB")!.pct).toBeGreaterThan(35);
    expect(byName("BUIDL")!.pct).toBeGreaterThan(10);
    expect(byName("USDB")!.pct).toBeGreaterThan(1);
    expect(byName("USDC")!.pct).toBeLessThan(1);
  });

  it("maps coinIds for known tokens", () => {
    const result = adaptFraxBalanceSheet(BALANCE_SHEET_SAMPLE);
    const ustb = result.slices.find((s) => s.name.startsWith("USTB"));
    const buidl = result.slices.find((s) => s.name.startsWith("BUIDL"));
    const usdc = result.slices.find((s) => s.name.startsWith("USDC"));
    expect(ustb!.coinId).toBe("ustb-superstate");
    expect(buidl!.coinId).toBe("buidl-blackrock");
    expect(usdc!.coinId).toBe("usdc-circle");
  });

  it("includes verified freshness when asOfTimestamp is present", () => {
    const result = adaptFraxBalanceSheet(BALANCE_SHEET_SAMPLE);
    expect(result.metadata?.freshnessMode).toBe("verified");
    expect(result.metadata?.sourceTimestamp).toBeGreaterThan(0);
  });

  it("falls back to unverified freshness when asOfTimestamp is missing", () => {
    const noTs = { ...BALANCE_SHEET_SAMPLE, asOfTimestamp: undefined };
    const result = adaptFraxBalanceSheet(noTs);
    expect(result.metadata?.freshnessMode).toBe("unverified");
  });

  it("warns on unknown token symbols", () => {
    const withUnknown: FraxBalanceSheetResponse = {
      ...BALANCE_SHEET_SAMPLE,
      assets: [
        ...BALANCE_SHEET_SAMPLE.assets!,
        { tokenSymbol: "XYZZY", totalValueUsd: 1_000_000, category: "asset:owned:usd" },
      ],
    };
    const result = adaptFraxBalanceSheet(withUnknown);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings![0].message).toContain("XYZZY");
    expect(result.warnings![0].effect).toBe("info");
    const unknown = result.slices.find((s) => s.name === "Unmapped Frax balance-sheet assets");
    expect(unknown!.risk).toBe("medium");
  });

  it("maps current FRAX balance-sheet symbols without degrading warnings", async () => {
    const response = await fetch("https://api.frax.finance/v2/frax/balance-sheet/latest");
    expect(response.ok).toBe(true);
    const result = adaptFraxBalanceSheet(await response.json() as FraxBalanceSheetResponse);
    expect(result.metadata?.freshnessMode).toBe("verified");
    expect((result.warnings ?? []).filter((warning) => warning.effect === "degraded")).toEqual([]);
  });

  it("throws on empty assets", () => {
    expect(() => adaptFraxBalanceSheet({ totalAssets: 0, assets: [] })).toThrow();
  });

  it("includes totalCollateralUsd in metadata", () => {
    const result = adaptFraxBalanceSheet(BALANCE_SHEET_SAMPLE);
    expect(result.metadata?.totalCollateralUsd).toBeGreaterThan(100_000_000);
  });

  it("skips non-asset categories", () => {
    const withLiability: FraxBalanceSheetResponse = {
      ...BALANCE_SHEET_SAMPLE,
      assets: [
        ...BALANCE_SHEET_SAMPLE.assets!,
        { tokenSymbol: "frxUSD", totalValueUsd: 50_000_000, category: "liability:remaining_frax_supply" },
      ],
    };
    const result = adaptFraxBalanceSheet(withLiability);
    expect(result.slices.find((s) => s.name.includes("frxUSD"))).toBeUndefined();
  });

  it("normalizes slice percentages to sum to 100", () => {
    const result = adaptFraxBalanceSheet(BALANCE_SHEET_SAMPLE);
    const sum = result.slices.reduce((a, s) => a + s.pct, 0);
    expect(sum).toBe(100);
  });
});

/* ---------- legacy combineddata tests (frax-frax) ---------- */

const COMBINED_DATA_SAMPLE: FraxCombinedDataResponse = {
  protocol: {
    collateral: {
      ratio: 0.945,
      decentralization_ratio: 0.14,
      total_dollar_value: 518_626_905,
    },
  },
};

function makeCoin(reserves?: StablecoinMeta["reserves"]): StablecoinMeta {
  return { id: "frax-frax", name: "FRAX", ticker: "FRAX", reserves } as unknown as StablecoinMeta;
}

describe("adaptFraxCombinedData", () => {
  it("returns single fallback slice when coin is omitted", () => {
    const result = adaptFraxCombinedData(COMBINED_DATA_SAMPLE);
    expect(result.slices).toHaveLength(1);
    expect(result.slices[0].pct).toBe(100);
    expect(result.slices[0].name).toContain("T-bills");
  });

  it("returns single fallback slice when coin.reserves is empty", () => {
    const result = adaptFraxCombinedData(COMBINED_DATA_SAMPLE, makeCoin([]));
    expect(result.slices).toHaveLength(1);
    expect(result.slices[0].pct).toBe(100);
  });

  it("returns curated reserves when coin has them", () => {
    const coin = makeCoin([
      { name: "USTB", pct: 50, risk: "low", coinId: "ustb-superstate" },
      { name: "BUIDL", pct: 42, risk: "low", coinId: "buidl-blackrock" },
      { name: "USCC", pct: 3, risk: "medium" },
      { name: "Other", pct: 5, risk: "low" },
    ]);
    const result = adaptFraxCombinedData(COMBINED_DATA_SAMPLE, coin);
    expect(result.slices).toHaveLength(4);
    expect(result.slices[0].coinId).toBe("ustb-superstate");
  });

  it("includes collateralization metadata", () => {
    const result = adaptFraxCombinedData(COMBINED_DATA_SAMPLE);
    expect(result.metadata?.collateralRatio).toBe(0.945);
    expect(result.metadata?.totalCollateralUsd).toBe(518_626_905);
  });
});
