import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { describe, it, expect } from "vitest";

import {
  adaptFraxBalanceSheet,
  adaptFraxFpiCollateral,
  fetchFraxFpiCollateralReserves,
  type FraxBalanceSheetResponse,
  type FraxFpiCollateralResponse,
} from "../frax";
import { installAdapterNetwork, runAdapter } from "./reserve-adapter.test-support";


const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const FRAX_BALANCE_SHEET_FIXTURE = JSON.parse(
  readFileSync(join(FIXTURES_DIR, "frax-balance-sheet.json"), "utf8"),
) as FraxBalanceSheetResponse;
const BALANCE_SHEET_ENDPOINT = "https://api.frax.finance/v2/frax/balance-sheet/latest";
const FPI_COLLATERAL_ENDPOINT = "https://api.frax.finance/v2/fpifpis/fpi-collateral";

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
      totalAssets: BALANCE_SHEET_SAMPLE.totalAssets! + 1_000_000,
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

  it("classifies the current legacy FRAX residual symbols without collapsing them into an unknown bucket", () => {
    const result = adaptFraxBalanceSheet({
      asOfTimestamp: "2026-08-11T12:04:11.000Z",
      totalAssets: 100,
      assets: [
        { tokenSymbol: "EREBOR_USD", totalValueUsd: 40, category: "asset:owned:usd" },
        { tokenSymbol: "VELO", totalValueUsd: 20, category: "asset:owned:usd" },
        { tokenSymbol: "crvUSD", totalValueUsd: 15, category: "asset:owned:usd" },
        { tokenSymbol: "USDT", totalValueUsd: 10, category: "asset:owned:usd" },
        { tokenSymbol: "BNB", totalValueUsd: 10, category: "asset:owned:usd" },
        { tokenSymbol: "MATIC", totalValueUsd: 5, category: "asset:owned:usd" },
      ],
    });

    expect(result.warnings).toBeUndefined();
    expect(result.slices).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "EREBOR_USD (Erebor Bank frxUSD reserve account)", risk: "very-low" }),
      expect.objectContaining({ name: "VELO (locked veNFT #4976)", risk: "very-high" }),
      expect.objectContaining({ name: "sfrxUSD/scrvUSD Curve LP", risk: "medium" }),
      expect.objectContaining({ name: "USDT", coinId: "usdt-tether", risk: "low" }),
      expect.objectContaining({ name: "BNB", risk: "high" }),
      expect.objectContaining({ name: "MATIC", risk: "high" }),
    ]));
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

  it("maps current frxUSD balance-sheet symbols from recorded fixture without degrading or withholding warnings", () => {
    const result = adaptFraxBalanceSheet(FRAX_BALANCE_SHEET_FIXTURE);
    expect(result.metadata?.freshnessMode).toBe("verified");
    expect((result.warnings ?? []).filter((warning) => warning.effect !== "info")).toEqual([]);
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
    const network = installAdapterNetwork({
      json: {
        [FPI_COLLATERAL_ENDPOINT]: { status: 503, body: "issuer API unavailable" },
      },
    });
    const coin = TRACKED_META_BY_ID.get("fpi-frax");
    expect(coin?.liveReservesConfig).toBeDefined();

    await expect(
      fetchFraxFpiCollateralReserves(
        coin!,
        coin!.liveReservesConfig!,
        new AbortController().signal,
      ),
    ).rejects.toThrow(/503|Fetch failed/);
    expect(network.requests.length).toBeGreaterThan(0);
    expect(network.requests.every((request) => request.url === FPI_COLLATERAL_ENDPOINT)).toBe(true);
  });

  it("excludes self-held FPI from collateral slices and nets it against liabilities", () => {
    const result = adaptFraxFpiCollateral(FPI_COLLATERAL_SAMPLE);

    expect(result.slices.find((slice) => slice.name === "FPI")).toBeUndefined();
    expect(result.slices.find((slice) => slice.name === "FRAX")!.pct).toBeGreaterThan(90);
    expect(result.slices.find((slice) => slice.name === "FRAX")!.sourceKey).toBe("frax-fpi-collateral:frax");
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
      expect.arrayContaining([
        expect.objectContaining({
          name: "Fraxswap V2 FRAX/FPIS",
          risk: "high",
          sourceKey: "frax-fpi-collateral:ethereum:0x56695c26b3cdb528815cd22ff7b47510ab821efd",
        }),
      ]),
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
      redemption: { capacityUsd: 5_000_000 },
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

describe("frax balance-sheet fetch boundary", () => {
  // runAdapter also runs output validation, so these slices reach the sync
  // core's fatal-warning gate instead of being rejected as malformed first.
  it.each([
    { label: "an overstated row", rows: [{ tokenSymbol: "USDC", totalValueUsd: 100.51 }] },
    { label: "a duplicated row", rows: [{ tokenSymbol: "USDC", totalValueUsd: 100 }, { tokenSymbol: "USDC", totalValueUsd: 100 }] },
  ])("withholds $label above totalAssets with a fatal source-rows-exceed-total warning", async ({ rows }) => {
    const { result } = await runAdapter("frax-balance-sheet", "frax-frax", {
      network: { json: { [BALANCE_SHEET_ENDPOINT]: {
        asOfTimestamp: BALANCE_SHEET_SAMPLE.asOfTimestamp,
        totalAssets: 100,
        assets: rows.map((row) => ({ ...row, category: "asset:owned:usd" })),
      } } },
      nowSec: 1_775_307_827,
    });
    expect(result.warnings).toContainEqual(expect.objectContaining({ code: "source-rows-exceed-total", effect: "fatal" }));
    expect(result.metadata).not.toHaveProperty("sourceTotalGapPct");
  });

  it.each([
    { rows: [{ tokenSymbol: "USDC", totalValueUsd: 200 }, { tokenSymbol: "ETH", totalValueUsd: -100 }], error: /net asset is negative/ },
    { rows: [{ tokenSymbol: "USDC", totalValueUsd: 100 }, { tokenSymbol: "ETH", totalValueUsd: null }], error: /unavailable/ },
  ])("rejects invalid headline accounting", async ({ rows, error }) => {
    await expect(runAdapter("frax-balance-sheet", "frax-frax", {
      network: { json: { [BALANCE_SHEET_ENDPOINT]: {
        asOfTimestamp: BALANCE_SHEET_SAMPLE.asOfTimestamp,
        totalAssets: 100,
        assets: rows.map((row) => ({ ...row, category: "asset:owned:usd" })),
      } } },
      nowSec: 1_775_307_827,
    })).rejects.toThrow(error);
  });

  it("nets signed contra entries and accepts genuine zero without inflating capacity", async () => {
    const { result } = await runAdapter("frax-balance-sheet", "frax-frax", {
      network: { json: { [BALANCE_SHEET_ENDPOINT]: {
        asOfTimestamp: BALANCE_SHEET_SAMPLE.asOfTimestamp,
        totalAssets: 100,
        assets: [
          { tokenSymbol: "USDC", totalValueUsd: 120, category: "asset:owned:usd" },
          { tokenSymbol: "USDC", totalValueUsd: -20, category: "asset:contra" },
          { tokenSymbol: "SDL", totalValueUsd: 0, category: "asset:owned:usd" },
        ],
      } } },
      nowSec: 1_775_307_827,
    });
    expect(result.metadata).toMatchObject({ totalCollateralUsd: 100, redemption: { capacityUsd: 100 } });
    expect(result.slices).toEqual([expect.objectContaining({ coinId: "usdc-circle", pct: 100 })]);
    expect(result.warnings).toBeUndefined();
  });

  it("admits rounding tolerance without publishing capacity above the headline", () => {
    const result = adaptFraxBalanceSheet({
      totalAssets: 100,
      assets: [{ tokenSymbol: "USDC", totalValueUsd: 100.5, category: "asset:owned:usd" }],
    });
    expect(result.metadata?.totalCollateralUsd).toBe(100);
    expect(result.metadata?.redemption?.capacityUsd).toBeUndefined();
  });

  it.each([null, undefined, "broken", -1, Number.POSITIVE_INFINITY])(
    "marks unavailable FPI assets incomplete and preserves independent liabilities (%s)", async (value) => {
      const { result } = await runAdapter("frax-fpi-collateral", "fpi-frax", {
        network: { code: { "0x2397321b301b80a1c0911d6f9ed4b6033d43cf51": "0x" }, json: { [FPI_COLLATERAL_ENDPOINT]: {
          ...FPI_COLLATERAL_SAMPLE,
          assets: [...FPI_COLLATERAL_SAMPLE.assets!, { tokenSymbol: "sfrxUSD", valueUsd: value }],
        } } },
        nowSec: FPI_COLLATERAL_SAMPLE.updatedAtTimestampSec!,
      });
      expect(result.metadata).toMatchObject({
        compositionComplete: false, unavailableAssetCount: 1,
        knownCollateralUsd: 5_200_000, totalLiabilitiesUsd: 8_000_000,
      });
      expect(result.metadata?.totalCollateralUsd).toBeUndefined();
      expect(result.metadata?.collateralizationRatio).toBeUndefined();
      expect(result.metadata?.redemption?.capacityUsd).toBeUndefined();
      expect(result.warnings).toContainEqual(expect.objectContaining({ code: "asset-coverage-incomplete", effect: "degraded" }));
    },
  );

  it.each([null, undefined, "broken", -1, Number.POSITIVE_INFINITY])(
    "withholds FPI liability totals and ratio for an unreadable liability (%s)", async (value) => {
      const { result } = await runAdapter("frax-fpi-collateral", "fpi-frax", {
        network: { code: { "0x2397321b301b80a1c0911d6f9ed4b6033d43cf51": "0x" }, json: { [FPI_COLLATERAL_ENDPOINT]: {
          ...FPI_COLLATERAL_SAMPLE,
          liabilities: [...FPI_COLLATERAL_SAMPLE.liabilities!, { tokenSymbol: "FPI", valueUsd: value }],
        } } },
        nowSec: FPI_COLLATERAL_SAMPLE.updatedAtTimestampSec!,
      });
      expect(result.metadata).toMatchObject({
        compositionComplete: true, liabilityCoverageComplete: false,
        unavailableLiabilityCount: 1, totalCollateralUsd: 5_200_000,
      });
      expect(result.metadata?.totalLiabilitiesUsd).toBeUndefined();
      expect(result.metadata?.collateralizationRatio).toBeUndefined();
      expect(result.warnings).toContainEqual(expect.objectContaining({ code: "liability-coverage-incomplete", effect: "degraded" }));
    },
  );

  it("preserves FPI known-good coverage with explicit zero asset and liability rows", async () => {
    const { result } = await runAdapter("frax-fpi-collateral", "fpi-frax", {
      network: { code: { "0x2397321b301b80a1c0911d6f9ed4b6033d43cf51": "0x" }, json: { [FPI_COLLATERAL_ENDPOINT]: {
        ...FPI_COLLATERAL_SAMPLE,
        assets: [...FPI_COLLATERAL_SAMPLE.assets!, { tokenSymbol: "sfrxUSD", valueUsd: 0 }],
        liabilities: [...FPI_COLLATERAL_SAMPLE.liabilities!, { tokenSymbol: "FPI", valueUsd: 0 }],
      } } },
      nowSec: FPI_COLLATERAL_SAMPLE.updatedAtTimestampSec!,
    });
    expect(result.metadata).toMatchObject({
      compositionComplete: true, liabilityCoverageComplete: true, collateralizationRatio: 1.04,
      redemption: { capacityUsd: 5_000_000 },
    });
  });

  describe("issuer row without a USD value", () => {
    const SFRXUSD = "0xfc00000000000000000000000000000000000008";
    const SFRXUSD_PRICE_URL = `https://coins.llama.fi/prices/current/fraxtal:${SFRXUSD}`;
    const runWithUnpricedSfrxusd = (balanceRaw: bigint | null) =>
      runAdapter("frax-fpi-collateral", "fpi-frax", {
        network: {
          code: { "0x2397321b301b80a1c0911d6f9ed4b6033d43cf51": "0x" },
          rpc: { [`${SFRXUSD}:balanceOf(address)`]: balanceRaw, [`${SFRXUSD}:decimals()`]: 18 },
          json: {
            [FPI_COLLATERAL_ENDPOINT]: {
              ...FPI_COLLATERAL_SAMPLE,
              assets: [...FPI_COLLATERAL_SAMPLE.assets!, {
                key: "asset:fraxtal_fpi_comptroller:sfrxusd_balance",
                chain: "fraxtal",
                ownerAddress: "0x7fc64ffddf99cd64dc2cff86a82f3b749962cf33",
                tokenAddress: SFRXUSD,
                tokenSymbol: "sfrxUSD",
                valueUsd: null,
              }],
            },
            [SFRXUSD_PRICE_URL]: { coins: { [`fraxtal:${SFRXUSD}`]: {
              price: 1.2, timestamp: FPI_COLLATERAL_SAMPLE.updatedAtTimestampSec, confidence: 0.99,
            } } },
          },
        },
        params: { fraxtalRpcUrl: "https://rpc.frax.com" },
        nowSec: FPI_COLLATERAL_SAMPLE.updatedAtTimestampSec!,
      });

    it("admits an immaterial dust balance as informational unpriced exposure and keeps valued capacity", async () => {
      const { result, report } = await runWithUnpricedSfrxusd(80_000_000_000_000_000n);

      expect([...(result.warnings ?? []), ...report.warnings].filter((warning) => warning.effect !== "info")).toEqual([]);
      expect(result.warnings).toContainEqual(expect.objectContaining({ code: "asset-value-unavailable", effect: "info" }));
      expect(result.metadata).toMatchObject({
        compositionComplete: true,
        unavailableAssetCount: 0,
        unpricedAssetLabels: ["sfrxUSD"],
        unpricedCollateralUsd: expect.closeTo(0.096, 9),
        totalCollateralUsd: expect.closeTo(5_200_000.096, 6),
        // The Pharos-valued sfrxUSD row is exposure, never redemption capacity.
        redemption: { capacityUsd: 5_000_000 },
      });
    });

    it("fails closed and withholds capacity when the unpriced row is material", async () => {
      const { result } = await runWithUnpricedSfrxusd(1_000_000n * 10n ** 18n);

      expect(result.warnings).toContainEqual(expect.objectContaining({ code: "asset-coverage-incomplete", effect: "degraded" }));
      expect(result.warnings?.some((warning) => warning.code === "asset-value-unavailable")).toBe(false);
      expect(result.metadata).toMatchObject({ compositionComplete: false, knownCollateralUsd: 5_200_000 });
      expect(result.metadata?.totalCollateralUsd).toBeUndefined();
      expect(result.metadata?.redemption?.capacityUsd).toBeUndefined();
    });

    it("fails closed when the balance cannot be read", async () => {
      const { result } = await runWithUnpricedSfrxusd(null);

      expect(result.warnings).toContainEqual(expect.objectContaining({ code: "asset-coverage-incomplete", effect: "degraded" }));
      expect(result.metadata).toMatchObject({ compositionComplete: false, unavailableAssetLabels: ["sfrxUSD"] });
      expect(result.metadata?.redemption?.capacityUsd).toBeUndefined();
    });
  });

  it("fetches the configured balance-sheet endpoint through the shared network harness", async () => {
    const { result, network } = await runAdapter("frax-balance-sheet", "frax-frax", {
      network: { json: { [BALANCE_SHEET_ENDPOINT]: BALANCE_SHEET_SAMPLE } },
      nowSec: 1_775_307_827 + 3_600,
    });

    expect(network.requests.map((request) => request.url)).toEqual([BALANCE_SHEET_ENDPOINT]);
    expect(result.metadata).toMatchObject({
      sourceTimestamp: 1_775_307_827,
    });
    expect(result.slices).toContainEqual(expect.objectContaining({
      name: "USTB (Superstate tokenized T-bills)",
      coinId: "ustb-superstate",
    }));
  });

  it("fails closed when the configured balance-sheet response loses its asset rows", async () => {
    await expect(runAdapter("frax-balance-sheet", "frax-frax", {
      network: { json: { [BALANCE_SHEET_ENDPOINT]: { ...BALANCE_SHEET_SAMPLE, assets: [] } } },
      nowSec: 1_775_657_027,
      validate: false,
    })).rejects.toThrow("missing or empty assets");
  });
});
