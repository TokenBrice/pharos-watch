import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import {
  adaptFraxBalanceSheet,
  type FraxBalanceSheetResponse,
} from "../frax";

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const FRAX_BALANCE_SHEET_FIXTURE = JSON.parse(
  readFileSync(join(FIXTURES_DIR, "frax-balance-sheet.json"), "utf8"),
) as FraxBalanceSheetResponse;

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
    expect(result.metadata?.redemption).toMatchObject({
      capacityUsd: expect.any(Number),
      capacityKind: "live-proxy-validated",
      freshnessKind: "verified-source-timestamp",
      routeStatus: "unknown",
    });
    expect(result.metadata?.immediateRedeemableRatio).toBeUndefined();
    expect(result.metadata?.redemption?.capacityRatioOfSupply).toBeUndefined();
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

  it("maps current frxUSD balance-sheet symbols from recorded fixture without degrading warnings", () => {
    const result = adaptFraxBalanceSheet(FRAX_BALANCE_SHEET_FIXTURE);
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

  it("accepts a numeric millisecond asOfTimestamp payload", () => {
    const msPayload: FraxBalanceSheetResponse = {
      ...BALANCE_SHEET_SAMPLE,
      // 2026-04-04T13:03:47Z in ms
      asOfTimestamp: 1775653427000 as unknown as string,
    };
    const result = adaptFraxBalanceSheet(msPayload);
    expect(result.metadata?.freshnessMode).toBe("verified");
    expect(result.metadata?.sourceTimestamp).toBe(1775653427);
  });
});

