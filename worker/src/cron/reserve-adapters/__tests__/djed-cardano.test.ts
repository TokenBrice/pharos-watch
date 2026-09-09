import { describe, expect, it } from "vitest";
import { expectWarningEffect, runAdapter } from "./reserve-adapter.test-support";

// ---------------------------------------------------------------------------
// Recorded live census (probed via api.koios.rest on 2026-09-09)
// ---------------------------------------------------------------------------

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
const RATIO = RESERVE_USD / (DJED_CIRCULATING * DJED_PRICE_USD); // ≈ 3.6955

interface DjedNetworkOverrides {
  bankStock?: bigint;
  minted?: bigint;
  poolNftQuantity?: string;
  omitPoolNft?: boolean;
  adaPrice?: number;
  djedPrice?: number;
}

function djedNetwork(overrides: DjedNetworkOverrides = {}) {
  const balance = ADA_LOVELACE.toString();
  const assetList = [
    { policy_id: POLICY_ID, asset_name: DJED_NAME_HEX, quantity: (overrides.bankStock ?? DJED_BANK_STOCK).toString() },
    { policy_id: POLICY_ID, asset_name: SHEN_NAME_HEX, quantity: SHEN_BANK_STOCK.toString() },
  ];
  if (!overrides.omitPoolNft) {
    assetList.push({
      policy_id: POLICY_ID,
      asset_name: POOL_NFT_NAME_HEX,
      quantity: overrides.poolNftQuantity ?? "1",
    });
  }
  return {
    json: {
      [`${KOIOS}/tip`]: [TIP],
      [`${KOIOS}/address_info`]: [
        {
          address: BANK_ADDRESS,
          balance,
          script_address: true,
          utxo_set: [
            {
              tx_hash: "1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b",
              tx_index: 0,
              value: balance,
              block_height: TIP.block_no,
              block_time: TIP.block_time,
              asset_list: assetList,
            },
          ],
        },
      ],
      [`${KOIOS}/asset_info`]: [
        {
          policy_id: POLICY_ID,
          asset_name: DJED_NAME_HEX,
          total_supply: (overrides.minted ?? DJED_MINTED).toString(),
          mint_cnt: 1,
          burn_cnt: 0,
        },
        {
          policy_id: POLICY_ID,
          asset_name: SHEN_NAME_HEX,
          total_supply: SHEN_MINTED.toString(),
          mint_cnt: 1,
          burn_cnt: 0,
        },
      ],
      "https://coins.llama.fi/prices/current/coingecko:cardano,coingecko:djed": {
        coins: {
          "coingecko:cardano": { price: overrides.adaPrice ?? ADA_PRICE_USD, timestamp: TIP.block_time, confidence: 0.99 },
          "coingecko:djed": { price: overrides.djedPrice ?? DJED_PRICE_USD, timestamp: TIP.block_time, confidence: 0.99 },
        },
      },
    },
  };
}

function runDjed(overrides: DjedNetworkOverrides = {}) {
  return runAdapter("djed-cardano", "djed-coti", {
    network: djedNetwork(overrides),
    nowSec: TIP.block_time,
  });
}

// ---------------------------------------------------------------------------
// djed-cardano binding through the real catalog config
// ---------------------------------------------------------------------------

describe("djed-cardano", () => {
  it("publishes the recorded bank census with a market-valued collateralization ratio", async () => {
    const { result } = await runDjed();

    expect(result.slices).toEqual([
      expect.objectContaining({
        sourceKey: "djed-cardano:ada",
        pct: 100,
        risk: "high",
        assetClass: "cryptoasset",
      }),
    ]);
    expect(result.metadata?.totalReserveQuantity).toBeCloseTo(25_034_263.75, 4);
    expect(result.metadata?.totalReserveUsd).toBeCloseTo(RESERVE_USD, 2);
    expect(result.metadata?.supplyTokens).toBeCloseTo(DJED_CIRCULATING, 6);
    expect(result.metadata?.totalLiabilitiesUsd).toBeCloseTo(DJED_CIRCULATING * DJED_PRICE_USD, 4);
    expect(result.metadata?.collateralizationRatio).toBeCloseTo(RATIO, 3);
    expect(result.metadata?.observedBlock).toEqual({
      chain: "cardano",
      number: TIP.block_no,
      timestamp: TIP.block_time,
    });
    expect(result.metadata?.details).toMatchObject({
      bankAddress: BANK_ADDRESS,
      djedBankStockUnits: Number(DJED_BANK_STOCK) / 1e6,
      djedMintedUnits: 1_000_000_000_000,
      adaPriceUsd: ADA_PRICE_USD,
      tipBlockNo: TIP.block_no,
    });
    expect(result.warnings).toBeUndefined();
  });

  it("fails closed when the bank holds no pool-NFT identity marker", async () => {
    await expect(runDjed({ omitPoolNft: true })).rejects.toThrow(/DjedStableCoinNFT/);
  });

  it("fails closed when the pool-NFT marker quantity is not exactly one", async () => {
    await expect(runDjed({ poolNftQuantity: "2" })).rejects.toThrow(/DjedStableCoinNFT/);
  });

  it("fails closed when no live ADA price is available", async () => {
    await expect(runDjed({ adaPrice: 0 })).rejects.toThrow(/ADA\/USD/);
  });

  it("fails closed when no live DJED price is available", async () => {
    await expect(runDjed({ djedPrice: 0 })).rejects.toThrow(/DJED\/USD/);
  });

  it("degrades but still publishes the ratio when the bank is undercollateralized", async () => {
    const { result } = await runDjed({ adaPrice: 0.001 });

    expect(result.metadata?.collateralizationRatio).toBeLessThan(1);
    expectWarningEffect(result, "reserve-undercollateralized", "degraded");
  });

  it("flags extraneous bank assets as info without valuing them", async () => {
    const network = djedNetwork();
    const row = network.json[`${KOIOS}/address_info`] as Array<{ utxo_set: Array<{ asset_list: Array<Record<string, string>> }> }>;
    row[0]!.utxo_set[0]!.asset_list.push({ policy_id: "ab12".repeat(28), asset_name: "4a756e6b", quantity: "77" });

    const { result } = await runAdapter("djed-cardano", "djed-coti", {
      network,
      nowSec: TIP.block_time,
    });
    expectWarningEffect(result, "extraneous-bank-assets", "info");
    expect(result.metadata?.totalReserveQuantity).toBeCloseTo(25_034_263.75, 4);
  });
});
