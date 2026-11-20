import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { computeCollateralQualityFromReserves } from "@shared/lib/report-card-policy";
import { describe, it, expect } from "vitest";

import {
  adaptFraxBalanceSheet,
  adaptFraxFpiCollateral,
  fetchFraxFpiCollateralReserves,
  type FraxBalanceSheetResponse,
  type FraxFpiCollateralResponse,
} from "../frax";
import { installAdapterNetwork, runAdapter } from "./reserve-adapter.test-support";
import { BALANCE_SHEET_ENDPOINT, BALANCE_SHEET_SAMPLE, FERRY_ROWS } from "./frax.test-support";


const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const FRAX_BALANCE_SHEET_FIXTURE = JSON.parse(
  readFileSync(join(FIXTURES_DIR, "frax-balance-sheet.json"), "utf8"),
) as FraxBalanceSheetResponse;
const FPI_COLLATERAL_ENDPOINT = "https://api.frax.finance/v2/fpifpis/fpi-collateral";

describe("adaptFraxBalanceSheet", () => {
  it.each([
    ["ethereum", "missing"], ["polygon_zkevm", "missing"],
    ["ethereum", "address"], ["polygon_zkevm", "tokenAddress"], ["ethereum", "duplicate"],
    ["ethereum", "unvalued"], ["polygon_zkevm", "unvalued"],
    ["ethereum", "unmeasured"], ["polygon_zkevm", "zero-quantity"],
    ["polygon_zkevm", "misvalued"], ["polygon_zkevm", "missing-price"], [null, "zero"], [null, "priced"],
  ])("checks the Ferry census on %s (%s)", (failedChain, fault) => {
    const usd = 5546.479073608646;
    const priced = fault === "misvalued" || fault === "missing-price" || fault === "priced";
    const ferryRows = FERRY_ROWS.flatMap<NonNullable<FraxBalanceSheetResponse["assets"]>[number]>(row => {
      if (row.chain === "polygon_zkevm" && priced) {
        return [{ ...row, tokenQuantity: 5603.41599996, tokenQuantityE18: "5603415999960000000000", totalValueUsd: fault === "misvalued" ? 1 : usd }];
      }
      if (row.chain !== failedChain) return [row];
      if (fault === "missing") return [];
      if (fault === "duplicate") return [row, row];
      if (fault === "unvalued") return [{ ...row, tokenQuantity: 5603.41599996 }];
      if (fault === "unmeasured") return [{ ...row, tokenQuantity: undefined }];
      if (fault === "zero-quantity") return [{ ...row, totalValueUsd: 1 }];
      return [{ ...row, [fault]: "0x0000000000000000000000000000000000000001" }];
    });
    const tokenPriceUsd = priced && fault !== "missing-price" ? { FRAX: 0.98983889 } : undefined;
    const result = adaptFraxBalanceSheet({
      tokenPriceUsd, totalAssets: priced ? 100 + usd : 100, assets: [
        { tokenSymbol: "USDC", totalValueUsd: 100, category: "asset:owned:usd" }, ...ferryRows,
      ],
    }, "frax-frax");
    if (failedChain) {
      expect(result.warnings ?? []).toContainEqual(expect.objectContaining({
        code: "asset-coverage-incomplete", effect: "fatal", message: expect.stringContaining(failedChain),
      }));
    } else {
      expect(result.warnings).toBeUndefined();
      if (fault === "zero") expect(result.slices.map(row => row.pct)).toEqual([100]);
    }
  });

  it.each(["intact", "misvalued", "missing", "duplicate", "false-zero", "true-zero"])("checks the Arbitrum Ferry row (%s)", (fault) => {
    const zero = fault === "false-zero" || fault === "true-zero";
    const row = {
      chain: "arbitrum", address: "0x5a9bef8cea603aac78a523fb245c1a9264d50706",
      tokenAddress: "0x17fc002b466eec40dae837fc4be5c67993ddbd6f", tokenSymbol: "FRAX",
      description: "FraxFerry - FRAX arbitrum->ethereum", category: "asset:owned:frax",
      tokenQuantity: zero ? 0 : 405293.77540004,
      tokenQuantityE18: fault === "true-zero" ? "0" : "405293775400040000000000",
      totalValueUsd: zero ? 0 : fault === "misvalued" ? 1 : 401208.1385442403,
    };
    const result = adaptFraxBalanceSheet({
      totalAssets: 262_006_930.872, tokenPriceUsd: { FRAX: 0.98991932 }, assets: [
        { tokenSymbol: "USDC", category: "asset:owned:usd", totalValueUsd: 262_006_930.872 - (zero ? 0 : 401208.1385442403) },
        ...FERRY_ROWS.filter(asset => asset.chain !== "arbitrum"),
        ...Array.from({ length: fault === "missing" ? 0 : fault === "duplicate" ? 2 : 1 }, () => row),
      ],
    }, "frax-frax", TRACKED_META_BY_ID.get("frax-frax")!.contracts);
    if (fault !== "intact" && fault !== "true-zero") {
      expect(result.warnings ?? []).toContainEqual(expect.objectContaining({
        code: "asset-coverage-incomplete", effect: "fatal", message: expect.stringContaining("arbitrum"),
      }));
    } else expect(result.warnings?.some(warning => warning.effect === "fatal")).toBeFalsy();
  });

  it.each([
    { description: "ERROR: reserve read failed", tokenQuantity: 1, totalValueUsd: 1 },
    { tokenQuantity: -0.0001, totalValueUsd: 0 },
  ])("rejects an issuer error on a non-Ferry frxUSD row (%j)", (fault) => {
    const result = adaptFraxBalanceSheet({ totalAssets: 100, assets: [
      { tokenSymbol: "USDC", totalValueUsd: 100, category: "asset:owned:usd" },
      { tokenSymbol: "frxUSD", chain: "ethereum", category: "asset:owned:usd", ...fault },
    ] }, "frxusd-frax");
    expect(result.warnings).toContainEqual(expect.objectContaining({
      code: "asset-coverage-incomplete", effect: "fatal", message: "Frax balance-sheet asset read failed on ethereum",
    }));
  });

  it.each([false, true])("reconciles the Legacy FRAX leg of LP #548162 (false zero: %s)", (falseZero) => {
    const result = adaptFraxBalanceSheet({
      totalAssets: 1_000_000, tokenPriceUsd: { FRAX: 0.98991932 }, assets: [
        ...FERRY_ROWS,
        { tokenSymbol: "USDC", totalValueUsd: 10_080.68, category: "asset:owned:usd" },
        { chain: "ethereum", address: "0xb1748c79709f4ba2dd82834b8c82d4a505003f27",
          tokenAddress: "0x853d955acef822db058eb8505911ed77f175b99e", tokenSymbol: "FRAX",
          description: "Quantity of FRAX in UniV3 LP #548162 frxETH/FRAX", category: "asset:owned:frax_volatile",
          tokenQuantity: falseZero ? 0 : 1_000_000, tokenQuantityE18: "999999999999999999999964",
          totalValueUsd: falseZero ? 0 : 989_919.32 },
      ],
    }, "frax-frax", TRACKED_META_BY_ID.get("frax-frax")!.contracts);
    expect(result.warnings?.some(warning => warning.code === "asset-coverage-incomplete" && warning.effect === "fatal") ?? false)
      .toBe(falseZero);
  });

  it("gives the same FRAX reserve book equal live and curated collateral-drift scores", () => {
    const meta = TRACKED_META_BY_ID.get("frax-frax")!;
    const ownIndexes = new Set(meta.reserveReview!.nonLinkDispositions!.filter(row => row.ownLiability).map(row => row.reserveIndex));
    const own = meta.reserves!.filter((_, index) => ownIndexes.has(index));
    const { slices } = adaptFraxBalanceSheet({
      totalAssets: 100, tokenPriceUsd: { FRAX: 1, sFRAX: 1, LFRAX: 1 }, assets: [
        ...FERRY_ROWS,
        ...own.map(row => {
          const [, chain, tokenAddress] = row.sourceKey!.split(":");
          return { chain, tokenAddress, tokenSymbol: "FRAX", category: "asset:owned:frax",
            tokenQuantity: row.pct, tokenQuantityE18: row.pct.toFixed(18).replace(".", ""), totalValueUsd: row.pct };
        }),
      ],
    }, meta.id, meta.contracts);
    const liveByKey = new Map(slices.filter(row => row.selfReferential).map(row => [row.sourceKey, row]));
    expect(liveByKey.size).toBe(13);
    const liveBook = meta.reserves!.map((row, index) => ownIndexes.has(index) ? liveByKey.get(row.sourceKey)! : row);
    expect(own.map(row => row.risk)).toEqual(own.map(row => liveByKey.get(row.sourceKey)!.risk));
    expect(computeCollateralQualityFromReserves(liveBook)).toBe(computeCollateralQualityFromReserves(meta.reserves!));
  });

  it("splits the issuer's mixed FRAX ticker by verified chain and token", () => {
    const legacy = "0x853d955acef822db058eb8505911ed77f175b99e";
    const frxusd = "0xfc00000000000000000000000000000000000001";
    const rows = [
      ["ethereum", legacy.toUpperCase().replace("0X", "0x"), 60, "frxUSD"],
      ["fraxtal", frxusd, 30, "FRAX"],
      ["ethereum", frxusd, 10, "FRAX"],
    ] as const;
    const result = adaptFraxBalanceSheet({ totalAssets: 100, assets: rows.map(([chain, tokenAddress, totalValueUsd, tokenSymbol]) =>
      ({ chain, tokenAddress, totalValueUsd, tokenSymbol, category: "asset:owned:frax" })) },
    "frax-frax", TRACKED_META_BY_ID.get("frax-frax")!.contracts);
    expect(result.slices.map(({ sourceKey, pct, selfReferential }) => [sourceKey, pct, selfReferential])).toEqual([
      [`frax-balance-sheet:ethereum:${legacy}`, 60, true],
      ["frax-balance-sheet:frxusd", 30, undefined],
      ["frax-balance-sheet:frax", 10, undefined],
    ]);
  });

  it.each([true, false])("preserves Solana mint case when matching a registry deployment (%s)", (exact) => {
    const deployments = TRACKED_META_BY_ID.get("frax-frax")!.contracts!;
    const mint = deployments.find(row => row.chain === "solana")!.address;
    const result = adaptFraxBalanceSheet({ totalAssets: 100, assets: [{
      chain: "solana", tokenAddress: exact ? mint : `f${mint.slice(1)}`,
      totalValueUsd: 100, tokenSymbol: "FRAX", category: "asset:owned:frax",
    }] }, "frax-frax", deployments);
    expect(result.slices[0]?.selfReferential).toBe(exact ? true : undefined);
  });

  it.each([
    ["missing address", { tokenAddress: undefined }],
    ["missing chain", { chain: undefined }],
    ["invalid address", { tokenAddress: "invalid" }],
  ] as const)(
    "withholds the retained Convex FRAX/USDe leg with %s", (_name, fault) => {
      const result = adaptFraxBalanceSheet({ totalAssets: 261_892_727.7221, tokenPriceUsd: { FRAX: 0.98977746 }, assets: [
        ...FERRY_ROWS,
        { tokenSymbol: "USDC", totalValueUsd: 235_439_287.51179385, category: "asset:owned:usd" },
        { chain: "ethereum", address: "0xb1748c79709f4ba2dd82834b8c82d4a505003f27",
          tokenAddress: "0x853d955acef822db058eb8505911ed77f175b99e", tokenSymbol: "FRAX",
          description: "FRAX staked in Convex FRAX/USDe", category: "asset:owned:frax_usd",
          tokenQuantity: 26_726_654.50505021, tokenQuantityE18: "26726654505050208452707927",
          totalValueUsd: 26_453_440.210306153, ...fault },
      ] }, "frax-frax", TRACKED_META_BY_ID.get("frax-frax")!.contracts);
      expect(result.warnings ?? []).toContainEqual(expect.objectContaining({
        code: "asset-coverage-incomplete", effect: "fatal",
      }));
      expect(result.slices.some(row => row.sourceKey === "frax-balance-sheet:frax")).toBe(false);
    },
  );

  it("retains saved positive dust and the source USDS ratio without display rounding", () => {
    const payload = JSON.parse(readFileSync(join(FIXTURES_DIR, "frax-precision-2026-09-29.json"), "utf8")) as FraxBalanceSheetResponse;
    const result = adaptFraxBalanceSheet(payload);
    for (const symbol of ["USDS", "USDC", "FPI", "AUSD"]) {
      const usd = payload.assets!.filter((asset) => asset.tokenSymbol === symbol && asset.category?.startsWith("asset:"))
        .reduce((sum, asset) => sum + asset.totalValueUsd, 0);
      expect(result.slices.find((slice) => slice.sourceKey === `frax-balance-sheet:${symbol.toLowerCase()}`)?.pct)
        .toBe(usd / payload.totalAssets! * 100);
    }
    const tiny = structuredClone(payload);
    tiny.assets = tiny.assets!.filter((asset) => asset.tokenSymbol !== "USDC");
    tiny.assets.push({ tokenSymbol: "USDC", totalValueUsd: 1e-6, category: "asset:owned:usd" });
    const tinySlice = adaptFraxBalanceSheet(tiny).slices.find((slice) => slice.sourceKey === "frax-balance-sheet:usdc");
    expect(tinySlice?.pct).toBe(1e-6 / tiny.totalAssets! * 100);
    expect(tinySlice?.depType).toBe("collateral");
  });

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
        totalAssets: 100, tokenPriceUsd: { FRAX: 1 },
        assets: [
          ...FERRY_ROWS,
          { chain: "ethereum", tokenAddress: "0x853d955acef822db058eb8505911ed77f175b99e",
            tokenSymbol: "FRAX", tokenQuantity: 40, tokenQuantityE18: "40000000000000000000",
            totalValueUsd: 40, category: "asset:owned:usd" },
          { tokenSymbol: "USDC", totalValueUsd: 60, category: "asset:owned:usd" },
        ],
      },
      "frax-frax",
      TRACKED_META_BY_ID.get("frax-frax")!.contracts,
    );

    const own = result.slices.find(slice => slice.selfReferential);
    expect(own).toMatchObject({ name: "Self-referential claim (Legacy FRAX (ethereum))", pct: 40 });
    expect(own?.coinId).toBeUndefined();
    expect(result.slices.find((slice) => slice.name.startsWith("USDC"))?.coinId).toBe("usdc-circle");
    // The subject coin's own 40% is not exit capacity; only the 60% USDC is.
    expect(result.metadata?.redemption?.capacityUsd).toBe(60);
  });

  it("does not count the subject coin's own rows as redeemable capacity", () => {
    const result = adaptFraxBalanceSheet(
      {
        totalAssets: 100,
        assets: [
          { tokenSymbol: "FRAX", totalValueUsd: 40, category: "asset:owned:usd" },
          { tokenSymbol: "FRAX", totalValueUsd: 10, category: "asset:lent:frax" },
          { tokenSymbol: "USDC", totalValueUsd: 30, category: "asset:owned:usd" },
          { tokenSymbol: "USDS", totalValueUsd: 20, category: "asset:owned:usd" },
        ],
      },
      "frax-frax",
    );

    expect(result.metadata?.redemption?.capacityUsd).toBe(50);
    expect(result.metadata?.totalCollateralUsd).toBe(100);
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


});


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

  it.each([false, true])("nets signed contra entries without inflating capacity (inconsistent sign: %s)", async (mismatch) => {
    const legacy = { chain: "ethereum", tokenAddress: "0x853d955acef822db058eb8505911ed77f175b99e", tokenSymbol: "FRAX" };
    const { result } = await runAdapter("frax-balance-sheet", "frax-frax", {
      network: { json: { [BALANCE_SHEET_ENDPOINT]: {
        asOfTimestamp: BALANCE_SHEET_SAMPLE.asOfTimestamp,
        totalAssets: 110, tokenPriceUsd: { FRAX: 1 },
        assets: [
          { tokenSymbol: "USDC", totalValueUsd: 120, category: "asset:owned:usd" },
          { tokenSymbol: "USDC", totalValueUsd: -20, category: "asset:contra" },
          { ...legacy, tokenQuantity: 30, tokenQuantityE18: "30000000000000000000", totalValueUsd: 30, category: "asset:owned:frax" },
          { ...legacy, tokenQuantity: -20, tokenQuantityE18: mismatch ? "20000000000000000000" : "-20000000000000000000",
            totalValueUsd: -20, category: "asset:contra" },
          { tokenSymbol: "SDL", totalValueUsd: 0, category: "asset:owned:usd" },
          ...FERRY_ROWS,
        ],
      } } },
      nowSec: 1_775_307_827,
    });
    expect(result.metadata).toMatchObject({ totalCollateralUsd: 110, redemption: { capacityUsd: 100 } });
    expect(result.slices).toEqual([
      expect.objectContaining({ coinId: "usdc-circle", pct: 100 / 110 * 100 }),
      expect.objectContaining({ selfReferential: true, pct: 10 / 110 * 100 }),
    ]);
    expect(result.warnings?.some(warning => warning.effect === "fatal") ?? false).toBe(mismatch);
  });

  it("admits rounding tolerance without publishing capacity above the headline", () => {
    const result = adaptFraxBalanceSheet({
      totalAssets: 100,
      assets: [{ tokenSymbol: "USDC", totalValueUsd: 100.5, category: "asset:owned:usd" }],
    });
    expect(result.metadata?.totalCollateralUsd).toBe(100);
    expect(result.metadata?.redemption?.capacityUsd).toBeUndefined();
  });

  it.each([null, undefined, "broken", -1])(
    "withholds unavailable FPI books and preserves independent liabilities (%s)", async (value) => {
      const { result, report } = await runAdapter("frax-fpi-collateral", "fpi-frax", {
        network: { code: { "0x2397321b301b80a1c0911d6f9ed4b6033d43cf51": "0x" }, json: { [FPI_COLLATERAL_ENDPOINT]: {
          ...FPI_COLLATERAL_SAMPLE,
          assets: [...FPI_COLLATERAL_SAMPLE.assets!, { tokenSymbol: "sfrxUSD", valueUsd: value }],
        } } },
        nowSec: FPI_COLLATERAL_SAMPLE.updatedAtTimestampSec!,
        validate: false,
      });
      expect(result.metadata).toMatchObject({
        compositionComplete: false, unavailableAssetCount: 1,
        knownCollateralUsd: 5_200_000, totalLiabilitiesUsd: 8_000_000,
      });
      expect(result.metadata?.totalCollateralUsd).toBeUndefined();
      expect(result.metadata?.collateralizationRatio).toBeUndefined();
      expect(result.metadata?.redemption?.capacityUsd).toBeUndefined();
      expect(result.slices).toEqual([]);
      expect(report.valid).toBe(false);
      expect(result.warnings).toContainEqual(expect.objectContaining({ code: "asset-coverage-incomplete", effect: "fatal" }));
    },
  );

  it.each([null, undefined, "broken", -1])(
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
    expect(result.slices.reduce((sum, slice) => sum + slice.pct, 0)).toBeCloseTo(100, 10);
    expect(result.warnings?.some((warning) => warning.effect === "fatal")).not.toBe(true);
  });

  describe("issuer row without a USD value", () => {
    const SFRXUSD = "0xfc00000000000000000000000000000000000008";
    const SFRXUSD_PRICE_URL = `https://coins.llama.fi/prices/current/fraxtal:${SFRXUSD}`;
    const runWithUnpricedSfrxusd = (
      balanceRaw: bigint | null,
      quoteOverrides: { timestamp?: number; confidence?: number } = {},
    ) =>
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
              ...quoteOverrides,
            } } },
          },
        },
        params: { fraxtalRpcUrl: "https://rpc.frax.com" },
        nowSec: FPI_COLLATERAL_SAMPLE.updatedAtTimestampSec!,
        validate: false,
      });

    it("admits an immaterial dust balance as informational unpriced exposure and keeps valued capacity", async () => {
      const { result, report } = await runWithUnpricedSfrxusd(80_000_000_000_000_000n);

      expect(report.valid).toBe(true);
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

    it("withholds the whole book when the unpriced row estimate is material", async () => {
      const { result, report } = await runWithUnpricedSfrxusd(1_000_000n * 10n ** 18n);

      expect(result.slices).toEqual([]);
      expect(report.valid).toBe(false);
      expect(result.warnings).toContainEqual(expect.objectContaining({ code: "asset-coverage-incomplete", effect: "fatal" }));
      expect(result.warnings?.some((warning) => warning.code === "asset-value-unavailable")).toBe(false);
      expect(result.metadata).toMatchObject({ compositionComplete: false, knownCollateralUsd: 5_200_000 });
      expect(result.metadata?.totalCollateralUsd).toBeUndefined();
      expect(result.metadata?.redemption?.capacityUsd).toBeUndefined();
    });

    it.each([
      { timestamp: 1, confidence: 0.99 },
      { timestamp: undefined, confidence: 0.99 },
      { timestamp: FPI_COLLATERAL_SAMPLE.updatedAtTimestampSec, confidence: 0.79 },
      { timestamp: FPI_COLLATERAL_SAMPLE.updatedAtTimestampSec! + 86400, confidence: 0.99 },
    ])("keeps unqualified quote estimates unavailable (case $#)", async (quoteOverrides) => {
      for (const balance of [80_000_000_000_000_000n, 1_000_000n * 10n ** 18n]) {
        const { result, report } = await runWithUnpricedSfrxusd(balance, quoteOverrides);
        expect(result.slices).toEqual([]);
        expect(report.valid).toBe(false);
        expect(result.warnings).toContainEqual(expect.objectContaining({ code: "asset-coverage-incomplete", effect: "fatal" }));
        expect(result.metadata).toMatchObject({ compositionComplete: false, unavailableAssetLabels: ["sfrxUSD"] });
        expect(result.metadata?.totalCollateralUsd).toBeUndefined();
        expect(result.metadata?.redemption?.capacityUsd).toBeUndefined();
      }
    });

    it("admits an observed zero balance without requiring a quote", async () => {
      const { result, report } = await runWithUnpricedSfrxusd(0n);
      expect(report.valid).toBe(true);
      expect(result.metadata).toMatchObject({
        compositionComplete: true, unavailableAssetCount: 0,
        totalCollateralUsd: 5_200_000, redemption: { capacityUsd: 5_000_000 },
      });
      expect(result.slices.reduce((sum, slice) => sum + slice.pct, 0)).toBeCloseTo(100, 10);
      expect(result.warnings?.some((warning) => warning.code === "asset-value-unavailable")).not.toBe(true);
      expect(result.metadata).not.toHaveProperty("unpricedCollateralUsd");
      expect(result.metadata).not.toHaveProperty("unpricedAssetLabels");
    });

    it("fails closed when the balance cannot be read", async () => {
      const { result, report } = await runWithUnpricedSfrxusd(null);

      expect(result.slices).toEqual([]);
      expect(report.valid).toBe(false);
      expect(result.warnings).toContainEqual(expect.objectContaining({ code: "asset-coverage-incomplete", effect: "fatal" }));
      expect(result.metadata).toMatchObject({ compositionComplete: false, unavailableAssetLabels: ["sfrxUSD"] });
      expect(result.metadata?.redemption?.capacityUsd).toBeUndefined();
    });
  });
});
