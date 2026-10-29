/**
 * Pinned swanUSD Monolith Lender state shared by the adapter test and the
 * corpus replay.
 *
 * Every word is the verbatim return data of one block-pinned read at Ethereum
 * block 26299913 (0x511909c46dc120a98158ce2e4448efcc536f871038d22645ba2ee24e16d0eb13,
 * 2026-10-29T17:31:59Z), captured from alchemy at 2026-10-29T18:19:44Z. Raw
 * capture: agents/swanusd/research/f/pinned-batch-26299913.json. Lane R2
 * independently derived the same balances and debt from separate pinned reads.
 */
import swanusdSource from "@shared/data/stablecoins/coins/swanusd-swan.json";
import type { StablecoinMeta } from "@shared/types/core";
import type { AdapterNetworkSpec, AdapterRpcValue } from "./reserve-adapter.test-support";

export const MONOLITH_LENDER_PIN = {
  blockNumber: 26_299_913,
  blockTimestamp: 1_793_295_119,
  blockHash: "0x511909c46dc120a98158ce2e4448efcc536f871038d22645ba2ee24e16d0eb13",
  coin: "0x9bf2b2f57a2968a0e81546ed50cbbbb7c9d6e05e",
  lender: "0x4ed5c72816abc1b67ac31ddabe31cff4a8c56a15",
  collateral: "0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0",
  psmAsset: "0xdc035d45d973e3ec169d2276ddab16f1e407384f",
  psmVault: "0xa3931d71877c0e7a3148cb7eb4463524fec27fbd",
  collateralBalance: 203_850_825_454_123_900_563n,
  collateralPrice: 2_933_735_095_033_131_387_772n,
  feedUpdatedAt: 1_793_250_227,
  stalenessThreshold: 108_000n,
  psmVaultShares: 57_608_760_096_683_371_289_431n,
  psmVaultMaxWithdraw: 64_205_640_644_318_232_649_923n,
  freePsmAssets: 64_205_193_253_000_784_236_399n,
  totalPaidDebt: 351_326_006_993_430_199_851_968n,
  totalFreeDebt: 4_561_000_000_000_000_000_000n,
  totalSupply: 420_092_200_246_430_984_088_367n,
} as const;

export const MONOLITH_LENDER_COIN = swanusdSource as unknown as StablecoinMeta;
/** Replay clock just after the pin, so the oracle still sits inside its threshold. */
export const MONOLITH_LENDER_NOW_SEC = MONOLITH_LENDER_PIN.blockTimestamp + 120;

export function word(value: bigint): string {
  return value.toString(16).padStart(64, "0");
}

export function collateralPriceWord(price: bigint, reduceOnly: boolean, allowLiquidations: boolean): string {
  return `0x${word(price)}${word(reduceOnly ? 1n : 0n)}${word(allowLiquidations ? 1n : 0n)}`;
}

export function pinnedWords(overrides: Record<string, AdapterRpcValue> = {}): Record<string, AdapterRpcValue> {
  const { lender, collateral, psmAsset, psmVault, coin } = MONOLITH_LENDER_PIN;
  const base: Record<string, AdapterRpcValue> = {
    [`ethereum:${lender}:coin()`]: MONOLITH_LENDER_PIN.coin,
    [`ethereum:${lender}:collateral()`]: MONOLITH_LENDER_PIN.collateral,
    [`ethereum:${lender}:psmAsset()`]: MONOLITH_LENDER_PIN.psmAsset,
    [`ethereum:${lender}:psmVault()`]: MONOLITH_LENDER_PIN.psmVault,
    [`ethereum:${lender}:psmAssetDecimals()`]: 18n,
    [`ethereum:${lender}:getCollateralPrice()`]: collateralPriceWord(MONOLITH_LENDER_PIN.collateralPrice, false, true),
    [`ethereum:${lender}:getFeedPrice()`]:
      `0x${word(MONOLITH_LENDER_PIN.collateralPrice)}${word(BigInt(MONOLITH_LENDER_PIN.feedUpdatedAt))}`,
    [`ethereum:${lender}:stalenessThreshold()`]: MONOLITH_LENDER_PIN.stalenessThreshold,
    [`ethereum:${lender}:getSellAmountOut(uint256)`]: 10n ** 18n,
    [`ethereum:${lender}:freePsmAssets()`]: MONOLITH_LENDER_PIN.freePsmAssets,
    [`ethereum:${lender}:totalPaidDebt()`]: MONOLITH_LENDER_PIN.totalPaidDebt,
    [`ethereum:${lender}:totalFreeDebt()`]: MONOLITH_LENDER_PIN.totalFreeDebt,
    [`ethereum:${collateral}:decimals()`]: 18n,
    [`ethereum:${collateral}:balanceOf(address)`]: MONOLITH_LENDER_PIN.collateralBalance,
    [`ethereum:${psmAsset}:decimals()`]: 18n,
    [`ethereum:${psmVault}:asset()`]: MONOLITH_LENDER_PIN.psmAsset,
    [`ethereum:${psmVault}:balanceOf(address)`]: MONOLITH_LENDER_PIN.psmVaultShares,
    [`ethereum:${psmVault}:maxWithdraw(address)`]: MONOLITH_LENDER_PIN.psmVaultMaxWithdraw,
    [`ethereum:${coin}:decimals()`]: 18n,
    [`ethereum:${coin}:totalSupply()`]: MONOLITH_LENDER_PIN.totalSupply,
  };
  for (const [key, value] of Object.entries(overrides)) base[key] = value;
  return base;
}

export function pinnedNetwork(overrides: Record<string, AdapterRpcValue> = {}): AdapterNetworkSpec {
  return {
    rpc: pinnedWords(overrides),
    block: {
      number: MONOLITH_LENDER_PIN.blockNumber,
      timestamp: MONOLITH_LENDER_PIN.blockTimestamp,
      hash: MONOLITH_LENDER_PIN.blockHash,
    },
  };
}
