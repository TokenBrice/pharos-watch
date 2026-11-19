import { describe, expect, it } from "vitest";
import type { StablecoinMeta } from "@shared/types/stablecoin-meta-schemas";
import { mockD1Strict } from "@shared/test-utils/mock-d1";
import { evaluateAdapterSnapshotAdmission, expectWarningEffect, runAdapter } from "./reserve-adapter.test-support";
import { MAX_FUTURE_SOURCE_TIMESTAMP_SKEW_SEC } from "@shared/lib/live-reserve-freshness";

// Recorded live census (probed via api.koios.rest on 2026-09-09)

const TIP = {
  hash: "499b2403106b31f32cfdb638fa6598bd573daabdcad6658ec84bbc2055bed75b",
  block_no: 13_919_726,
  block_time: 1_788_981_858,
};
const KOIOS = "https://api.koios.rest/api/v1";
const BANK_ADDRESS =
  "addr1z8mcpc26j64fmhhd6sv5qj5mk9xqnfxgm6k8zmk7h2rlu4qm5kjdmrpmng059yellupyvwgay2v0lz6663swmds7hp0qhxg9gt";
const POLICY_ID = "8db269c3ec630e06ae29f74bc39edd1f87c819f1056206e879a1cd61";
const DJED_NAME_HEX = "446a65644d6963726f555344";
const SHEN_NAME_HEX = "5368656e4d6963726f555344";
const POOL_NFT_NAME_HEX = "446a6564537461626c65436f696e4e4654";

const unit = (assetNameHex: string) => ({ policyId: POLICY_ID, assetNameHex, decimals: 6 });
// djed-coti is frozen: replay its archived config.
const DJED_COIN = { id: "djed-coti", name: "Djed Stablecoin", symbol: "DJED", liveReservesConfig: {
  adapter: "djed-cardano", version: 1, semantics: "collateral-mix", inputs: { primary: { kind: "http-json", url: KOIOS } },
  params: { bankAddress: BANK_ADDRESS, djedUnit: unit(DJED_NAME_HEX), shenUnit: unit(SHEN_NAME_HEX) },
} } as unknown as StablecoinMeta;

const ADA_LOVELACE = 25_034_263_750_000n; // 25,034,263.75 ADA in the bank
const DJED_MINTED = 1_000_000_000_000_000_000n; // 1e18 micro DJED
const DJED_BANK_STOCK = 999_998_532_426_573_428n; // unissued stock in the bank
const SHEN_MINTED = 10_000_000_000_000n;
const SHEN_BANK_STOCK = 5_000_000_000_000n;
const ADA_PRICE_USD = 0.21664;
const DJED_PRICE_USD = 1.0;

// minted - bank stock = 1,467,573.426572 DJED circulating.
const DJED_CIRCULATING = 1_467_573.426572;
const RESERVE_USD = 25_034_263.75 * ADA_PRICE_USD; // ≈ 5,423,422.90

interface DjedNetworkOverrides {
  bankStock?: bigint; minted?: bigint; poolNftQuantity?: string; omitPoolNft?: boolean; adaPrice?: number; djedPrice?: number;
  quoteOverrides?: Partial<Record<"ada" | "djed", { timestamp?: number; confidence?: number }>>;
}

function djedNetwork(overrides: DjedNetworkOverrides = {}) {
  const balance = ADA_LOVELACE.toString();
  const assets: Array<[string, unknown]> = [[DJED_NAME_HEX, overrides.bankStock ?? DJED_BANK_STOCK], [SHEN_NAME_HEX, SHEN_BANK_STOCK]];
  if (!overrides.omitPoolNft) assets.push([POOL_NFT_NAME_HEX, overrides.poolNftQuantity ?? "1"]);
  const assetList = assets.map(([asset_name, quantity]) => ({ policy_id: POLICY_ID, asset_name, quantity: String(quantity) }));
  return {
    json: {
      [`${KOIOS}/tip`]: [TIP],
      [`${KOIOS}/address_info`]: [{ address: BANK_ADDRESS, balance, script_address: true, utxo_set: [{
        tx_hash: `${"1a2b3c4d5e6f".repeat(5)}1a2b`, tx_index: 0, value: balance,
        block_height: TIP.block_no, block_time: TIP.block_time, asset_list: assetList,
      }] }],
      [`${KOIOS}/asset_info`]: [[DJED_NAME_HEX, overrides.minted ?? DJED_MINTED], [SHEN_NAME_HEX, SHEN_MINTED]].map(([asset_name, supply]) => ({
        policy_id: POLICY_ID, asset_name, total_supply: supply.toString(), mint_cnt: 1, burn_cnt: 0,
      })),
      "https://coins.llama.fi/prices/current/coingecko:cardano,coingecko:djed": {
        coins: Object.fromEntries((["ada", "djed"] as const).map((asset) => [asset === "ada" ? "coingecko:cardano" : "coingecko:djed", {
          price: asset === "ada" ? overrides.adaPrice ?? ADA_PRICE_USD : overrides.djedPrice ?? DJED_PRICE_USD,
          timestamp: TIP.block_time, confidence: 0.99, ...overrides.quoteOverrides?.[asset],
        }])),
      },
    },
  };
}

function runDjed(overrides: DjedNetworkOverrides = {}, db?: ReturnType<typeof mockD1Strict>, network = djedNetwork(overrides)) {
  return runAdapter("djed-cardano", DJED_COIN, { network, nowSec: TIP.block_time, ...(db ? { ctx: { db } } : {}) });
}

/** Stablecoins-cache D1 fixture carrying the DefiLlama list circulating for DJED. */
function djedCacheDb(circulating: number | null, price: number | null = 1) {
  const peggedAssets = [{ id: "djed-coti", symbol: "DJED", price, circulating: circulating === null ? {} : { peggedUSD: circulating } }];
  return mockD1Strict([{
    match: "SELECT value, updated_at FROM cache WHERE key = ?", matchBinds: ["stablecoins"],
    rows: [{ key: "stablecoins", value: JSON.stringify({ peggedAssets }), updated_at: TIP.block_time }],
  }]);
}

describe("djed-cardano", () => {
  it("publishes the bank census and market-valued supply without a coverage claim", async () => {
    const run = await runDjed();
    const { result } = run;
    expect(result.slices).toEqual([expect.objectContaining({ sourceKey: "djed-cardano:ada", pct: 100, risk: "high", assetClass: "cryptoasset" })]);
    expect(result.metadata?.totalReserveQuantity).toBeCloseTo(25_034_263.75, 4);
    expect(result.metadata?.totalReserveUsd).toBeCloseTo(RESERVE_USD, 2);
    expect(result.metadata?.supplyTokens).toBeCloseTo(DJED_CIRCULATING, 6);
    expect(result.metadata?.supplyUsd).toBeCloseTo(DJED_CIRCULATING * DJED_PRICE_USD, 4);
    expect(result.metadata?.ratioUnavailableReason).toBe("not-comparable");
    expect(result.metadata?.observedBlock).toEqual({ chain: "cardano", number: TIP.block_no, timestamp: TIP.block_time });
    expect(result.metadata?.details).toMatchObject({
      bankAddress: BANK_ADDRESS, djedBankStockUnits: Number(DJED_BANK_STOCK) / 1e6, djedMintedUnits: 1_000_000_000_000,
      adaPriceUsd: ADA_PRICE_USD, tipBlockNo: TIP.block_no,
    });
    expect(result.warnings).toBeUndefined();
    expect(evaluateAdapterSnapshotAdmission(run, TIP.block_time).eligible).toBe(true);
  });

  it.each([
    [{ omitPoolNft: true }, /DjedStableCoinNFT/], [{ poolNftQuantity: "2" }, /DjedStableCoinNFT/],
    [{ adaPrice: 0 }, /ADA\/USD/], [{ djedPrice: 0 }, /DJED\/USD/],
  ] as const)("fails closed on a missing pool-NFT identity or live price (%o)", async (overrides, error) => {
    await expect(runDjed(overrides)).rejects.toThrow(error);
  });

  describe.each(["ada", "djed"] as const)("%s valuation quality", (asset) => {
    const t = TIP.block_time;
    it.each([
      ["stale", t - 86401, 0.99], ["missing clock", undefined, 0.99], ["low confidence", t, 0.79],
      ["missing confidence", t, undefined], ["future clock", t + MAX_FUTURE_SOURCE_TIMESTAMP_SKEW_SEC + 1, 0.99],
    ])("retains %s quote degradation and rejects independent admission", async (_label, timestamp, confidence) => {
      const run = await runDjed({ quoteOverrides: { [asset]: { timestamp, confidence } } });
      expectWarningEffect(run.result, "defillama-quote-quality", "degraded");
      expect(run.result.metadata?.totalReserveUsd).toBeCloseTo(RESERVE_USD, 2);
      expect(run.result.metadata?.collateralizationRatio).toBeUndefined();
      expect(run.result.metadata?.observedBlock).toMatchObject({ timestamp: TIP.block_time });
      expect(evaluateAdapterSnapshotAdmission(run, TIP.block_time)).toMatchObject({ eligible: false, reasons: ["degraded-snapshot"] });
    });
  });

  it.each([0.75, 1, 1.2])("does not use a $%s DJED market quote for bank liabilities, coverage, or SHEN equity", async (djedPrice) => {
    const adaPrice = DJED_CIRCULATING * 0.9 / 25_034_263.75;
    const run = await runDjed({ adaPrice, djedPrice });
    const { result } = run;
    expect(result.metadata?.totalReserveUsd).toBeCloseTo(DJED_CIRCULATING * 0.9, 4);
    expect(result.metadata?.supplyUsd).toBeCloseTo(DJED_CIRCULATING * djedPrice, 4);
    for (const key of ["totalLiabilitiesUsd", "collateralizationRatio", "shareholderEquityUsd"] as const) expect(result.metadata?.[key]).toBeUndefined();
    expect(result.metadata).toMatchObject({ ratioUnavailableReason: "not-comparable", details: { coverageUnavailableReason: "protocol-oracle-unavailable" } });
    expect(result.warnings).toBeUndefined();
    expect(evaluateAdapterSnapshotAdmission(run, TIP.block_time).eligible).toBe(true);
  });

  it("flags extraneous bank assets as info, unvalued", async () => {
    const network = djedNetwork();
    const rows = network.json[`${KOIOS}/address_info`] as Array<{ utxo_set: Array<{ asset_list: object[] }> }>;
    rows[0]!.utxo_set[0]!.asset_list.push({ policy_id: "ab12".repeat(28), asset_name: "4a756e6b", quantity: "77" });
    const { result } = await runDjed({}, undefined, network);
    expectWarningEffect(result, "extraneous-bank-assets", "info");
    expect(result.metadata?.totalReserveQuantity).toBeCloseTo(25_034_263.75, 4);
  });

  it("degrades on material list supply divergence, keeping the on-chain liability", async () => {
    const { result } = await runDjed({}, djedCacheDb(4_020_000));
    expectWarningEffect(result, "djed-supply-divergence", "degraded");
    expect(result.metadata?.supplyTokens).toBeCloseTo(DJED_CIRCULATING, 6);
    expect(result.metadata?.details).toMatchObject({ listCirculatingUsd: 4_020_000, supplyDerivation: expect.stringContaining("djedMinted") });
    expect(result.metadata?.details?.supplyDivergencePct as number).toBeGreaterThan(10);
  });
  it.each([[0.8, 0.8, 0.8], [1.2, 1.2, 1.2], [1, null, 1], [1, 1, null], [1, 0, 1]] as const)(
    "reconciles list USD at DJED %s (list %sx at %s) or keeps it unavailable", async (djedPrice, units, price) => {
      const supply = units === null ? null : DJED_CIRCULATING * units;
      const { result } = await runDjed({ djedPrice }, djedCacheDb(supply, price));
      expect(result.metadata?.supplyTokens).toBeCloseTo(DJED_CIRCULATING, 6);
      if (supply && price) {
        expect(result.warnings).toBeUndefined();
        expect(result.metadata?.details?.supplyDivergencePct).toBeCloseTo(0, 6);
      } else {
        expect(result.metadata?.details).toMatchObject({ supplyReconciliationUnavailableReason: "list-supply-or-price-unavailable" });
        expect(result.metadata?.details?.supplyDivergencePct).toBeUndefined();
      }
    });

});
