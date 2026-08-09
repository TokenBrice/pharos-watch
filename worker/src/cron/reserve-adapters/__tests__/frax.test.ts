import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { beforeEach, describe, it, expect, vi } from "vitest";

const requestMocks = vi.hoisted(() => ({
  fetchJsonAdapterInput: vi.fn(),
}));

vi.mock("../helpers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../helpers")>();
  return {
    ...actual,
    fetchJsonAdapterInput: requestMocks.fetchJsonAdapterInput,
  };
});

import {
  adaptFraxBalanceSheet,
  adaptFraxFpiCollateral,
  fetchFraxFpiCollateralReserves,
  type FraxBalanceSheetResponse,
  type FraxFpiCollateralResponse,
} from "../frax";

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const FRAX_BALANCE_SHEET_FIXTURE = JSON.parse(
  readFileSync(join(FIXTURES_DIR, "frax-balance-sheet.json"), "utf8"),
) as FraxBalanceSheetResponse;

beforeEach(() => {
  requestMocks.fetchJsonAdapterInput.mockReset();
});

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
    { tokenSymbol: "USDB", totalValueUsd: 2_000_003.7, category: "asset:owned:usd" },
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

  it("maps active coinIds while keeping pre-launch assets visible", () => {
    const result = adaptFraxBalanceSheet(BALANCE_SHEET_SAMPLE);
    const ustb = result.slices.find((s) => s.name.startsWith("USTB"));
    const wtgxx = result.slices.find((s) => s.name.startsWith("WTGXX"));
    const buidl = result.slices.find((s) => s.name.startsWith("BUIDL"));
    const usdc = result.slices.find((s) => s.name.startsWith("USDC"));
    const usdb = result.slices.find((s) => s.name.startsWith("USDB"));
    expect(ustb!.coinId).toBe("ustb-superstate");
    // wtgxx-wisdomtree is a quarantined no-supply record that can never rate,
    // so this slice is intentionally left unlinked and scores on its own
    // fund-share asset class instead.
    expect(wtgxx!.coinId).toBeUndefined();
    expect(buidl!.coinId).toBe("buidl-blackrock");
    expect(usdc!.coinId).toBe("usdc-circle");
    expect(usdb).toMatchObject({ name: "USDB (Bridge)" });
    expect(usdb!.coinId).toBeUndefined();
  });

  it("keeps subject reserves visible without emitting a self dependency", () => {
    const result = adaptFraxBalanceSheet(
      {
        totalAssets: 100,
        assets: [
          { tokenSymbol: "FRAX", totalValueUsd: 40, category: "asset:owned:usd" },
          { tokenSymbol: "USDC", totalValueUsd: 60, category: "asset:owned:usd" },
        ],
      },
      "frax-frax",
    );

    expect(result.slices.find((slice) => slice.name === "FRAX")).toMatchObject({ pct: 40 });
    expect(result.slices.find((slice) => slice.name === "FRAX")?.coinId).toBeUndefined();
    expect(result.slices.find((slice) => slice.name.startsWith("USDC"))?.coinId).toBe("usdc-circle");
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
    expect(unknown!.risk).toBe("high");
  });

  it("keeps source total-assets gaps explicit instead of renormalizing mapped rows", () => {
    const result = adaptFraxBalanceSheet({
      ...BALANCE_SHEET_SAMPLE,
      totalAssets: 200_000_000,
    });

    expect(result.slices).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "Unmapped Frax balance-sheet total-assets gap",
          risk: "high",
        }),
      ]),
    );
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "source-total-gap",
          effect: "degraded",
        }),
      ]),
    );
    expect(result.metadata).toMatchObject({
      sourceTotalAssetsUsd: 200_000_000,
      sourceTotalGapPct: expect.any(Number),
    });
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

/* ---------- v2 FPI collateral tests ---------- */

const FPI_COLLATERAL_SAMPLE: FraxFpiCollateralResponse = {
  updatedAtBlock: 25_072_838,
  updatedAtTimestampSec: 1_778_514_287,
  assets: [
    { key: "asset:fpi_comptroller:fpi_balance", tokenSymbol: "FPI", valueUsd: 3_000_000 },
    { key: "asset:fpi_comptroller:frax_balance", tokenSymbol: "FRAX", valueUsd: 4_900_000 },
    { key: "asset:fpi_comptroller:sfrax_balance", tokenSymbol: "sFRAX", valueUsd: 100_000 },
    { key: "asset:fpi_comptroller:fxs_balance", tokenSymbol: "FXS", valueUsd: 200_000 },
  ],
  liabilities: [
    { key: "liability:misc:fpi_total_supply_ethereum", tokenSymbol: "FPI", valueUsd: 6_000_000 },
    { key: "liability:misc:fpi_total_supply_fraxtal", tokenSymbol: "FPI", valueUsd: 2_000_000 },
  ],
};

describe("adaptFraxFpiCollateral", () => {
  it("publishes no route metadata when the atomic issuer payload fails", async () => {
    requestMocks.fetchJsonAdapterInput.mockRejectedValueOnce(new Error("issuer API unavailable"));
    const coin = TRACKED_META_BY_ID.get("fpi-frax");
    expect(coin?.liveReservesConfig).toBeDefined();

    let publishedResult: Awaited<ReturnType<typeof fetchFraxFpiCollateralReserves>> | null = null;
    await expect(
      fetchFraxFpiCollateralReserves(
        coin!,
        coin!.liveReservesConfig!,
        new AbortController().signal,
      ).then((result) => {
        publishedResult = result;
        return result;
      }),
    ).rejects.toThrow("issuer API unavailable");

    expect(publishedResult).toBeNull();
    expect(requestMocks.fetchJsonAdapterInput).toHaveBeenCalledTimes(1);
  });

  it("excludes self-held FPI from collateral slices and nets it against liabilities", () => {
    const result = adaptFraxFpiCollateral(FPI_COLLATERAL_SAMPLE);

    expect(result.slices.find((slice) => slice.name === "FPI")).toBeUndefined();
    expect(result.slices.find((slice) => slice.name === "FRAX")!.pct).toBeGreaterThan(90);
    expect(result.metadata).toMatchObject({
      totalCollateralUsd: 5_200_000,
      mappedCollateralUsd: 5_200_000,
      selfHeldFpiUsd: 3_000_000,
      totalLiabilitiesUsd: 8_000_000,
      netExternalLiabilitiesUsd: 5_000_000,
      collateralizationRatio: 1.04,
    });
  });

  it("uses verified freshness from updatedAtTimestampSec", () => {
    const result = adaptFraxFpiCollateral(FPI_COLLATERAL_SAMPLE);

    expect(result.metadata?.freshnessMode).toBe("verified");
    expect(result.metadata?.sourceTimestamp).toBe(1_778_514_287);
    expect(result.metadata?.redemption).toMatchObject({
      capacityUsd: 5_000_000,
      capacityKind: "live-proxy-validated",
      freshnessKind: "verified-source-timestamp",
      routeStatus: "open",
    });
  });

  it("warns and buckets non-FPI unknown collateral rows", () => {
    const result = adaptFraxFpiCollateral({
      ...FPI_COLLATERAL_SAMPLE,
      assets: [
        ...FPI_COLLATERAL_SAMPLE.assets!,
        {
          key: "asset:fpi_comptroller:some_other_lp",
          name: "Some Other Unmapped LP",
          valueUsd: 500_000,
        },
      ],
    });

    expect(result.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "unknown-token",
          message: expect.stringContaining("Some Other Unmapped LP"),
        }),
      ]),
    );
    expect(result.slices).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "Unmapped Frax FPI collateral assets",
          risk: "high",
        }),
      ]),
    );
  });

  it("maps the Fraxswap V2 FRAX/FPIS LP position by name (no tokenSymbol on the row)", () => {
    const result = adaptFraxFpiCollateral({
      ...FPI_COLLATERAL_SAMPLE,
      assets: [
        ...FPI_COLLATERAL_SAMPLE.assets!,
        {
          key: "asset:fpi_comptroller:fraxswap_v2_frax_fpis",
          name: "Fraxswap V2 FRAX/FPIS",
          valueUsd: 500_000,
        },
      ],
    });

    expect(result.warnings ?? []).toEqual(
      expect.not.arrayContaining([expect.objectContaining({ code: "unknown-token" })]),
    );
    expect(result.slices).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "Fraxswap V2 FRAX/FPIS", risk: "high" })]),
    );
  });

  it("does not treat arbitrary name-only rows as trusted token symbols", () => {
    const result = adaptFraxFpiCollateral({
      ...FPI_COLLATERAL_SAMPLE,
      assets: [
        ...FPI_COLLATERAL_SAMPLE.assets!,
        {
          key: "asset:fpi_comptroller:spoofed_frax_name",
          name: "FRAX",
          valueUsd: 500_000,
        },
      ],
    });

    expect(result.metadata).toMatchObject({
      unknownCollateralUsd: 500_000,
      immediateRedeemableUsd: 5_000_000,
    });
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "unknown-token",
          message: expect.stringContaining("FRAX"),
        }),
      ]),
    );
    expect(result.slices).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "Unmapped Frax FPI collateral assets",
          risk: "high",
        }),
      ]),
    );
  });

  it("maps stkcvxFPIFRAX by tokenSymbol", () => {
    const result = adaptFraxFpiCollateral({
      ...FPI_COLLATERAL_SAMPLE,
      assets: [
        ...FPI_COLLATERAL_SAMPLE.assets!,
        {
          key: "asset:fpi_comptroller:stkcvxfpifrax_balance",
          tokenSymbol: "stkcvxFPIFRAX",
          valueUsd: 300_000,
        },
      ],
    });

    expect(result.warnings ?? []).toEqual(
      expect.not.arrayContaining([expect.objectContaining({ code: "unknown-token" })]),
    );
    expect(result.slices).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "stkcvxFPIFRAX (staked Convex FPI/FRAX LP)",
          risk: "medium",
        }),
      ]),
    );
  });

  it("degrades when non-FPI collateral is below net external liabilities", () => {
    const result = adaptFraxFpiCollateral({
      ...FPI_COLLATERAL_SAMPLE,
      liabilities: [{ key: "liability:misc:fpi_total_supply_ethereum", tokenSymbol: "FPI", valueUsd: 10_000_000 }],
    });

    expect(result.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "undercollateralized",
          effect: "degraded",
        }),
      ]),
    );
  });

  it("throws when only self-held FPI assets are present", () => {
    expect(() =>
      adaptFraxFpiCollateral({
        assets: [{ key: "asset:fpi_comptroller:fpi_balance", tokenSymbol: "FPI", valueUsd: 3_000_000 }],
        liabilities: [],
      }),
    ).toThrow(/no positive non-FPI collateral/);
  });
});
