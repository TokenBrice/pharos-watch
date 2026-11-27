import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { computeCollateralQualityFromReserves } from "@shared/lib/report-card-policy";
import { createTimeoutSignal } from "@shared/lib/timeout-signal";
import { describe, it, expect } from "vitest";

import {
  adaptFraxBalanceSheet,
  type FraxBalanceSheetResponse,
} from "../frax";
import { encodeBalanceOfCallData } from "../../../lib/evm-selectors";
import {
  evaluateAdapterSnapshotAdmission,
  installAdapterNetwork,
  runAdapter,
  runAdapterWithFakeTimers,
} from "./reserve-adapter.test-support";
import { BALANCE_SHEET_ENDPOINT, BALANCE_SHEET_SAMPLE, FERRY_ROWS } from "./frax.test-support";


const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const FRAX_BALANCE_SHEET_FIXTURE = JSON.parse(
  readFileSync(join(FIXTURES_DIR, "frax-balance-sheet.json"), "utf8"),
) as FraxBalanceSheetResponse;

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
      // The unverified remainder cannot publish as FRAX; it stays withheld.
      ["frax-balance-sheet:source-total-gap", 10, undefined],
    ]);
    expect(result.warnings).toContainEqual(expect.objectContaining({
      code: "asset-coverage-incomplete", effect: "fatal",
      message: expect.stringContaining("matches no verified FRAX deployment"),
    }));
  });

  it("pins frxUSD, sfrxUSD, and FPI rows on Legacy FRAX to tracked sibling deployments", () => {
    const fraxContracts = TRACKED_META_BY_ID.get("frax-frax")!.contracts;
    const solanaFrxusdMint = TRACKED_META_BY_ID.get("frxusd-frax")!.contracts!.find((row) => row.chain === "solana")!.address;
    const validRows = [
      { chain: "ethereum", tokenAddress: "0xCAcd6fd266aF91b8AeD52aCCc382b4e165586E29", tokenSymbol: "frxUSD", totalValueUsd: 20 },
      { chain: "fraxtal", tokenAddress: "0xfc00000000000000000000000000000000000001", tokenSymbol: "frxUSD", totalValueUsd: 10 },
      { chain: "stable", tokenAddress: "0x80eede496655fb9047dd39d9f418d5483ed600df", tokenSymbol: "frxUSD", totalValueUsd: 10 },
      { chain: "solana", tokenAddress: solanaFrxusdMint, tokenSymbol: "frxUSD", totalValueUsd: 10 },
      { chain: "fraxtal", tokenAddress: "0xfc00000000000000000000000000000000000001", tokenSymbol: "FRAX", totalValueUsd: 5 },
      { chain: "ethereum", tokenAddress: "0xcf62f905562626cfcdd2261162a51fd02fc9c5b6", tokenSymbol: "sfrxUSD", totalValueUsd: 10 },
      { chain: "fraxtal", tokenAddress: "0xfc00000000000000000000000000000000000008", tokenSymbol: "sfrxUSD", totalValueUsd: 10 },
      { chain: "stable", tokenAddress: "0x5bff88ca1442c2496f7e475e9e7786383bc070c0", tokenSymbol: "sfrxUSD", totalValueUsd: 5 },
      { chain: "ethereum", tokenAddress: "0x5ca135cb8527d76e932f34b5145575f9d8cbe08e", tokenSymbol: "FPI", totalValueUsd: 10 },
      { chain: "fraxtal", tokenAddress: "0xfc00000000000000000000000000000000000003", tokenSymbol: "FPI", totalValueUsd: 10 },
    ].map((row) => ({ ...row, category: "asset:owned:frax" }));
    const ok = adaptFraxBalanceSheet({ totalAssets: 100, assets: [...FERRY_ROWS, ...validRows] }, "frax-frax", fraxContracts);
    expect(ok.warnings).toBeUndefined();
    expect(ok.slices).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceKey: "frax-balance-sheet:frxusd", coinId: "frxusd-frax", pct: expect.closeTo(55, 10) }),
      expect.objectContaining({ sourceKey: "frax-balance-sheet:sfrxusd", coinId: "sfrxusd-frax", pct: 25 }),
      expect.objectContaining({ sourceKey: "frax-balance-sheet:fpi", pct: 20 }),
    ]));

    const wrongCaseSolanaFrxusdMint = `${solanaFrxusdMint[0]!.toLowerCase()}${solanaFrxusdMint.slice(1)}`;
    expect(wrongCaseSolanaFrxusdMint).not.toBe(solanaFrxusdMint);
    for (const bad of [
      { chain: "ethereum", tokenAddress: "0x1111111111111111111111111111111111111111", tokenSymbol: "frxUSD" },
      { chain: "fraxtal", tokenAddress: "0x1111111111111111111111111111111111111111", tokenSymbol: "sfrxUSD" },
      { chain: "ethereum", tokenAddress: "0x1111111111111111111111111111111111111111", tokenSymbol: "FPI" },
      { chain: "solana", tokenAddress: wrongCaseSolanaFrxusdMint, tokenSymbol: "frxUSD" },
      { chain: "ethereum", tokenAddress: "0xcf62f905562626cfcdd2261162a51fd02fc9c5b6", tokenSymbol: "frxUSD" },
      { chain: "ethereum", tokenAddress: "0x5ca135cb8527d76e932f34b5145575f9d8cbe08e", tokenSymbol: "frxUSD" },
      { chain: undefined, tokenAddress: "0xcacd6fd266af91b8aed52accc382b4e165586e29", tokenSymbol: "frxUSD" },
      { chain: "ethereum", tokenAddress: undefined, tokenSymbol: "sfrxUSD" },
      { chain: "ethereum", tokenAddress: "0x0000000000000000000000000000000000000000", tokenSymbol: "FPI" },
    ]) {
      const res = adaptFraxBalanceSheet({
        totalAssets: 100,
        assets: [
          ...FERRY_ROWS,
          { tokenSymbol: "USDC", totalValueUsd: 90, category: "asset:owned:usd" },
          { ...bad, totalValueUsd: 10, category: "asset:owned:frax" },
        ],
      }, "frax-frax", fraxContracts);
      expect(res.warnings).toContainEqual(expect.objectContaining({ code: "asset-coverage-incomplete", effect: "fatal" }));
      expect(res.slices.some((slice) => slice.sourceKey === `frax-balance-sheet:${bad.tokenSymbol.toLowerCase()}`)).toBe(false);
    }

    const injectedEmpty = adaptFraxBalanceSheet({
      totalAssets: 100,
      assets: [
        ...FERRY_ROWS,
        { tokenSymbol: "USDC", totalValueUsd: 90, category: "asset:owned:usd" },
        { chain: "fraxtal", tokenAddress: "0xfc00000000000000000000000000000000000001", tokenSymbol: "FRAX", totalValueUsd: 10, category: "asset:owned:frax" },
      ],
    }, "frax-frax", fraxContracts, { frxUSD: [] });
    expect(injectedEmpty.warnings).toContainEqual(expect.objectContaining({
      code: "asset-coverage-incomplete", effect: "fatal",
      message: expect.stringContaining("matches no verified frxUSD deployment"),
    }));
    expect(injectedEmpty.slices.some((slice) => slice.sourceKey === "frax-balance-sheet:frxusd")).toBe(false);
  });

  it.each([true, false])("preserves Solana mint case when matching a registry deployment (%s)", (exact) => {
    const deployments = TRACKED_META_BY_ID.get("frax-frax")!.contracts!;
    const mint = deployments.find(row => row.chain === "solana")!.address;
    const result = adaptFraxBalanceSheet({ totalAssets: 100, assets: [
      { chain: "solana", tokenAddress: exact ? mint : `f${mint.slice(1)}`,
        totalValueUsd: 100, tokenSymbol: "FRAX", category: "asset:owned:frax" },
      { tokenSymbol: "USDC", totalValueUsd: 1, category: "asset:owned:usd" },
    ] }, "frax-frax", deployments);
    if (exact) {
      expect(result.slices[0]?.selfReferential).toBe(true);
    } else {
      // A near-miss mint is not a verified FRAX identity: withheld, not published.
      expect(result.slices.some(row => row.sourceKey === "frax-balance-sheet:frax")).toBe(false);
      expect(result.warnings).toContainEqual(expect.objectContaining({
        code: "asset-coverage-incomplete", effect: "fatal",
        message: expect.stringContaining("matches no verified FRAX deployment"),
      }));
    }
  });

  it.each([
    ["missing address", { tokenAddress: undefined }],
    ["missing chain", { chain: undefined }],
    ["invalid address", { tokenAddress: "invalid" }],
    ["unrelated address", { tokenAddress: "0x9d39a5de30e57443bff2a8307a4256c8797a3497" }],
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
    expect(wtgxx).toMatchObject({ coinId: "wtgxx-wisdomtree", depType: "collateral" });
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

  describe("on-chain recovery of issuer-errored reviewed Ferry and Optimism LP rows", () => {
    const ETH_FRAX = "0x853d955acef822db058eb8505911ed77f175b99e";
    const ETH_ZKEVM_FERRY = "0x86e71075e55f0aad27d700017e0783458310c98a";
    const ZKEVM_FRAX = "0xff8544fed5379d9ffa8d47a74ce6b91e632ac44d";
    const ZKEVM_FERRY = "0xeabd7625056bbd2c260f90d0b08759c69d971a5b";
    const OP_HOLDER = "0x0df840dcbf1229262a4125c1fc559bd338ec9491";
    const OP_FRAX = "0x2e3d870790dc77a83dd1d18184acc7439a53f475";
    const OP_FXS = "0x67ccea5bb16181e7b4109c9c2143c24a1c2205be";
    const OP_WETH = "0x4200000000000000000000000000000000000006";
    const OP_FRAX_FXS_PAIR = "0x9456c020d3a05b159dab4557535083fba836c49a";
    const OP_FRAX_WETH_PAIR = "0xcc4dd8bc7967d46060ba3faaa8e525a35625f8b4";
    const ETH_FERRY_BAL = 7_085_774_780_020_000_000_000n;
    const ZKEVM_FERRY_BAL = 5_603_415_999_960_000_000_000n;
    const NOW = 1_775_307_827 + 600;
    const ZKEVM_URL = "https://zkevm-rpc.com";
    const ZKEVM_BLK = 33_391_890;
    const OP_BLK = 159_938_725;
    const FRAX_PX = 0.993963;
    const TOT_FERRY = 260_104_249.9764;
    const TOT_FIVE = 260_030_857.4893;
    const encodeReserves = (r0: bigint, r1: bigint, ts = 1_795_475_155n) =>
      `0x${[r0, r1, ts].map((v) => v.toString(16).padStart(64, "0")).join("")}`;

    const opKey = (c: string, m: string) => `optimism:${c}:${m}`;
    const ferryRpc = (eth: bigint | null = ETH_FERRY_BAL, zk: bigint | null = ZKEVM_FERRY_BAL) => ({
      [`ethereum:${ETH_FRAX}:balanceOf(address)`]: eth, ...(eth !== null ? { [`ethereum:${ETH_FRAX}:decimals()`]: 18 } : {}),
      [`polygon-zkevm:${ZKEVM_FRAX}:balanceOf(address)`]: zk, ...(zk !== null ? { [`polygon-zkevm:${ZKEVM_FRAX}:decimals()`]: 18 } : {}),
    });

    const erroredZkevmPairPayload = (
      totalAssets: number,
      tokenPriceUsd: FraxBalanceSheetResponse["tokenPriceUsd"] | null = { FRAX: FRAX_PX },
      asOfBlock?: Record<string, number>,
      extraAssets: NonNullable<FraxBalanceSheetResponse["assets"]> = [],
    ): FraxBalanceSheetResponse => ({
      ...(asOfBlock ? { asOfBlock } : {}), asOfTimestamp: BALANCE_SHEET_SAMPLE.asOfTimestamp,
      ...(tokenPriceUsd ? { tokenPriceUsd } : {}), totalAssets,
      assets: [
        ...FERRY_ROWS.map((row) => {
          const dir = row.chain === "ethereum" && row.address === ETH_ZKEVM_FERRY ? "ethereum->polygon_zkevm"
            : row.chain === "polygon_zkevm" && row.address === ZKEVM_FERRY ? "polygon_zkevm->ethereum" : null;
          return dir ? { ...row, tokenQuantity: -0.0001, tokenQuantityE18: "0", totalValueUsd: 0, description: `ERROR: FraxFerry - FRAX ${dir}` } : row;
        }),
        { tokenSymbol: "USDC", totalValueUsd: totalAssets - extraAssets.reduce((s, a) => s + a.totalValueUsd, 0), category: "asset:owned:usd" },
        ...extraAssets,
      ],
    });

    const opErrRow = (contractAddress: string, tokenAddress: string, tokenSymbol: string, totalValueUsd: number, suffix: string) => ({
      category: "asset:owned:unknown", chain: "optimism", address: OP_HOLDER, contractAddress, tokenAddress, tokenSymbol,
      totalValueUsd, tokenQuantity: -0.001, tokenQuantityE18: "-1000000000000000", description: `ERROR: optimism_fraxswap_v2_${suffix}`,
    });

    const fiveErrorPayload = (
      asOfBlock: Record<string, number> | undefined = { ethereum: 26_481_100, optimism: OP_BLK, polygon_zkevm: ZKEVM_BLK },
      totalAssets = TOT_FIVE,
    ): FraxBalanceSheetResponse =>
      erroredZkevmPairPayload(totalAssets, { FRAX: FRAX_PX, WETH: 1711.8647 }, asOfBlock, [
        opErrRow(OP_FRAX_FXS_PAIR, OP_FRAX, "FRAX", -0.000993963, "frax_fxs"),
        opErrRow(OP_FRAX_WETH_PAIR, OP_FRAX, "FRAX", -0.000993963, "frax_weth"),
        opErrRow(OP_FRAX_WETH_PAIR, OP_WETH, "WETH", -1.7118647, "frax_weth"),
      ]);

    const pairRpc = (pair: string, bal: bigint, sup: bigint, t1: string, r0: bigint, r1: bigint) => ({
      [opKey(pair, "balanceOf(address)")]: bal, [opKey(pair, "totalSupply()")]: sup,
      [opKey(pair, "token0()")]: OP_FRAX, [opKey(pair, "token1()")]: t1, [opKey(pair, "getReserves()")]: encodeReserves(r0, r1),
    });

    const healthyOptimismLpRpc = (overrides: Record<string, bigint | number | string | null> = {}) => ({
      ...pairRpc(OP_FRAX_FXS_PAIR, 0n, 9_352_623_463_494_157_525n, OP_FXS, 4_669_580_429_664_564_281n, 24_878_895_694_754_483_141n),
      ...pairRpc(OP_FRAX_WETH_PAIR, 829_689_952_887_420_716_591n, 833_739_173_262_077_674_253n, OP_WETH, 38_955_459_056_234_753_889_787n, 22_438_909_116_365_214_403n),
      [opKey(OP_FRAX, "decimals()")]: 18, [opKey(OP_FXS, "decimals()")]: 18, [opKey(OP_WETH, "decimals()")]: 18, ...overrides,
    });

    const runFrax = (
      payload: FraxBalanceSheetResponse,
      rpc?: Record<string, bigint | number | string | null>,
      extra?: Partial<Parameters<typeof runAdapter>[2]>,
    ) => runAdapter("frax-balance-sheet", "frax-frax", {
      network: { chains: { "polygon-zkevm": ZKEVM_URL }, json: { [BALANCE_SHEET_ENDPOINT]: payload }, ...(rpc ? { rpc } : {}) },
      nowSec: NOW, validate: false, ...extra,
    });

    const expectClean = (run: Awaited<ReturnType<typeof runFrax>>) => {
      expect(run.report.valid).toBe(true);
      expect(evaluateAdapterSnapshotAdmission(run, NOW)).toMatchObject({ eligible: true });
      expect([...(run.result.warnings ?? []), ...run.report.warnings].filter((w) => w.effect !== "info")).toEqual([]);
    };

    const expectFatalFailed = (
      warnings: Awaited<ReturnType<typeof runFrax>>["result"]["warnings"],
      code: string, pattern: RegExp | null, label?: string,
    ) => {
      expect(warnings, label).toContainEqual(expect.objectContaining({ code: "asset-coverage-incomplete", effect: "fatal" }));
      if (pattern) expect(warnings, label).toContainEqual(expect.objectContaining({ code: `${code}-failed`, effect: "info", message: expect.stringMatching(pattern) }));
      else expect(warnings?.some((w) => w.code === code), label).toBe(false);
    };

    it("recovers the zkEVM Ferry pair on-chain with verified holder calldata and admits observed zeros", async () => {
      const recoveredUsd = (7_085.77478002 + 5_603.41599996) * FRAX_PX;
      const run = await runFrax(erroredZkevmPairPayload(TOT_FERRY, { FRAX: FRAX_PX }, { polygon_zkevm: ZKEVM_BLK }), ferryRpc());
      expectClean(run);
      expect(run.result.warnings).toContainEqual(expect.objectContaining({ code: "ferry-balance-onchain-recovery", effect: "info" }));
      expect(run.network.rpcCalls.map((c) => [c.chain, c.contract, c.data])).toEqual([
        ["ethereum", ETH_FRAX, encodeBalanceOfCallData(ETH_ZKEVM_FERRY)], ["ethereum", ETH_FRAX, "0x313ce567"],
        ["polygon-zkevm", ZKEVM_FRAX, encodeBalanceOfCallData(ZKEVM_FERRY)], ["polygon-zkevm", ZKEVM_FRAX, "0x313ce567"],
      ]);
      expect(run.result.metadata).toMatchObject({
        totalCollateralUsd: expect.closeTo(TOT_FERRY + recoveredUsd, 4), recoveredFerryRowCount: 2,
        recoveredFerryCollateralUsd: expect.closeTo(recoveredUsd, 4), redemption: { capacityUsd: TOT_FERRY },
      });

      const zeroRun = await runFrax(erroredZkevmPairPayload(1_000_000, null), ferryRpc(0n, 0n));
      expect(zeroRun.report.valid).toBe(true);
      expect(zeroRun.result.metadata).toMatchObject({ totalCollateralUsd: 1_000_000, recoveredFerryRowCount: 2, recoveredFerryCollateralUsd: 0 });
    });

    it("falls back to the terminal block 33391890 pin when zkEVM RPCs fail or hang under attemptDeadlineMs", async () => {
      const zkevmUrls: string[] = [];
      const run = await runAdapterWithFakeTimers(async () => {
        const start = Date.now();
        const timeout = createTimeoutSignal({ timeoutMs: 20_000, timeoutReason: "adapter-timeout" });
        const network = installAdapterNetwork({
          chains: { "polygon-zkevm": ZKEVM_URL },
          json: { [BALANCE_SHEET_ENDPOINT]: erroredZkevmPairPayload(TOT_FERRY, { FRAX: FRAX_PX }, { polygon_zkevm: ZKEVM_BLK }) },
          rpc: { [`ethereum:${ETH_FRAX}:balanceOf(address)`]: ETH_FERRY_BAL, [`ethereum:${ETH_FRAX}:decimals()`]: 18 },
        });
        const baseImpl = network.fetchSpy.getMockImplementation()!;
        network.fetchSpy.mockImplementation((input, init) => {
          const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
          if (url.includes("zkevm")) {
            zkevmUrls.push(url);
            const sig = init?.signal ?? (input instanceof Request ? input.signal : undefined);
            return new Promise((_r, rej) => sig?.aborted ? rej(sig.reason) : sig?.addEventListener("abort", () => rej(sig.reason), { once: true }));
          }
          return baseImpl(input, init);
        });
        try {
          const res = await runAdapter("frax-balance-sheet", "frax-frax", { network, signal: timeout.signal, ctx: { attemptDeadlineMs: start + 20_000 }, nowSec: NOW, validate: false });
          expect(Date.now() - start).toBeLessThan(10_000);
          return res;
        } finally {
          network.fetchSpy.mockImplementation(baseImpl);
          timeout.dispose();
        }
      }, 20_001);

      expectClean(run);
      expect(run.result.warnings).toContainEqual(expect.objectContaining({ code: "ferry-balance-onchain-recovery-failed", effect: "info", message: expect.stringMatching(/polygon-zkevm.*rpc-unavailable/) }));
      expect(run.result.metadata).toMatchObject({ recoveredFerryRowCount: 2, pinnedHaltedChainFerryPositions: [`polygon-zkevm:${ZKEVM_FERRY}@33391890`], pinnedHaltedChainFerryVerifiedAt: "2026-11-23" });
      expect(zkevmUrls).toEqual([ZKEVM_URL, "https://polygon-zkevm.drpc.org"]);
    });

    it("fails closed when a live zkEVM read contradicts the pinned terminal block 33391890 balance", async () => {
      const { result } = await runFrax(erroredZkevmPairPayload(TOT_FERRY, { FRAX: FRAX_PX }, { polygon_zkevm: ZKEVM_BLK }), ferryRpc(ETH_FERRY_BAL, 0n));
      expectFatalFailed(result.warnings, "ferry-balance-onchain-recovery", /polygon-zkevm.*terminal-pin-mismatch/);
      expect(result.metadata).not.toHaveProperty("pinnedHaltedChainFerryPositions");
    });

    it("skips on-chain recovery with zero RPC calls when attemptDeadlineMs is too close", async () => {
      const { result, network } = await runFrax(erroredZkevmPairPayload(TOT_FERRY, { FRAX: FRAX_PX }, { polygon_zkevm: ZKEVM_BLK }), undefined, { ctx: { attemptDeadlineMs: Date.now() + 500 } });
      expect(network.requests.map((r) => r.url)).toEqual([BALANCE_SHEET_ENDPOINT]);
      expectFatalFailed(result.warnings, "ferry-balance-onchain-recovery", /deadline-exceeded/);
      expect(result.metadata).not.toHaveProperty("pinnedHaltedChainFerryPositions");
    });

    it.each([
      ["missing polygon_zkevm block", TOT_FERRY, { FRAX: FRAX_PX }, undefined, ferryRpc(ETH_FERRY_BAL, null), /polygon-zkevm.*rpc-unavailable/],
      ["advanced polygon_zkevm block", TOT_FERRY, { FRAX: FRAX_PX }, { polygon_zkevm: 33_391_891 }, ferryRpc(ETH_FERRY_BAL, null), /polygon-zkevm.*rpc-unavailable/],
      ["ethereum RPC failure", TOT_FERRY, { FRAX: FRAX_PX }, { polygon_zkevm: ZKEVM_BLK }, ferryRpc(null, ZKEVM_FERRY_BAL), /ethereum.*rpc-unavailable/],
      ["above 1% immateriality ceiling", 1_000_000, { FRAX: 1 }, undefined, ferryRpc(20_000n * 10n ** 18n, 5_000n * 10n ** 18n), null],
      ["missing FRAX price", TOT_FERRY, null, undefined, ferryRpc(), null],
    ] as const)("fails closed on %s", async (label, totalAssets, prices, asOfBlock, rpc, pattern) => {
      expectFatalFailed((await runFrax(erroredZkevmPairPayload(totalAssets, prices, asOfBlock), rpc)).result.warnings, "ferry-balance-onchain-recovery", pattern, label);
    });

    it("skips recovery with zero RPC calls when an unreviewed issuer error row is present", async () => {
      const { result, network } = await runFrax(erroredZkevmPairPayload(1_000_000, { FRAX: 1 }, { polygon_zkevm: ZKEVM_BLK }, [{
        chain: "ethereum", address: "0xb1748c79709f4ba2dd82834b8c82d4a505003f27", tokenAddress: ETH_FRAX, tokenSymbol: "FRAX",
        category: "asset:owned:frax", tokenQuantity: -0.0001, tokenQuantityE18: "0", totalValueUsd: 0, description: "ERROR: non-Ferry read failed",
      }]));
      expect(network.requests.map((r) => r.url)).toEqual([BALANCE_SHEET_ENDPOINT]);
      expect(result.warnings).toContainEqual(expect.objectContaining({ code: "asset-coverage-incomplete", effect: "fatal" }));
    });

    it("recovers the redacted five-error payload (zkEVM Ferry + Optimism Fraxswap V2 LPs) at pinned block 159938725", async () => {
      const run = await runFrax(fiveErrorPayload(), { ...ferryRpc(), ...healthyOptimismLpRpc() });
      expectClean(run);
      expect(run.result.warnings).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: "ferry-balance-onchain-recovery", effect: "info" }),
        expect.objectContaining({ code: "fraxswap-lp-onchain-recovery", effect: "info" }),
      ]));
      expect(run.network.rpcCalls.filter((c) => c.chain === "optimism").every((c) => c.block === `0x${OP_BLK.toString(16)}`)).toBe(true);
      expect(run.result.metadata).toMatchObject({ sourceTotalAssetsUsd: TOT_FIVE, recoveredFerryRowCount: 2, recoveredLpRowCount: 3 });
      expect(run.result.slices).toEqual(expect.arrayContaining([
        expect.objectContaining({ sourceKey: `frax-balance-sheet:optimism:${OP_FRAX}`, selfReferential: true, risk: "very-high" }),
        expect.objectContaining({ sourceKey: "frax-balance-sheet:weth", risk: "very-low" }),
      ]));
    });

    const OP_BLKS = { optimism: OP_BLK, polygon_zkevm: ZKEVM_BLK };
    it.each([
      ["missing asOfBlock.optimism", { polygon_zkevm: ZKEVM_BLK }, TOT_FIVE, {}, /missing-as-of-block/],
      ["Optimism RPC failure", OP_BLKS, TOT_FIVE, { [opKey(OP_FRAX_WETH_PAIR, "getReserves()")]: null }, /rpc-unavailable/],
      ["pair token mismatch", OP_BLKS, TOT_FIVE, { [opKey(OP_FRAX_WETH_PAIR, "token1()")]: "0x1111111111111111111111111111111111111111" }, /pair-token-mismatch/],
      ["positive frax_fxs LP missing partner FXS leg", OP_BLKS, TOT_FIVE, { [opKey(OP_FRAX_FXS_PAIR, "balanceOf(address)")]: 1_000_000_000_000_000_000n }, /missing-partner-leg/],
      ["combined Ferry + LP exceeds 1% ceiling", OP_BLKS, 5_000_000, {}, null],
    ] as const)("fails closed on five-error payload when %s", async (label, asOfBlock, totalAssets, lpOverrides, pattern) => {
      const { result } = await runFrax(fiveErrorPayload(asOfBlock, totalAssets), { ...ferryRpc(), ...healthyOptimismLpRpc(lpOverrides) });
      expectFatalFailed(result.warnings, "fraxswap-lp-onchain-recovery", pattern, label);
    });
  });
});
