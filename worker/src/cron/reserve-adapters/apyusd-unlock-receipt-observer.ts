import { parseAbi } from "viem/utils";
import type { EvmRpcOptions } from "../../lib/evm-rpc";
import type { AdapterContext } from "./types";
import { abiObservation } from "./evm-observation-plan";
import { readStateWithPlan, type ExecutableRedemptionObserverDescriptor, type ExecutableRedemptionObservation, type ExecutableRedemptionReadClient } from "./executable-redemption-observers";

const VAULT = "0x38eeb52f0771140d10c4e9a9a72349a329fe8a6a";
const RECEIPT = "0x9bf51f33955ec70f87c4b5c49441815589043237";
const ASSET = "0x98a878b1cd98131b271883b390f68d2c90674665";
const DENYLIST = "0x2c271ddf484ac0386d216eb7eb9ff02d4dc0f6aa";
const VESTING = "0x0d62b4cc02b4b51ed19ddf41d7a7979cf394c99f";
const FEE_WALLET = "0x6f93635f2a1c19b4f7f1bd9ba655f6a073c629dc";
const WAD = 10n ** 18n;
const IDENTITIES = [
  { address: VAULT, codeHash: "0x748fde5d195af5984cc16c81df36137e6599c6f50f9f5113d05994c1b90ebad7", implementationAddress: "0xfd616567ecc1607f61073951a1e822f7315bb112", implementationCodeHash: "0x7427a665f82e79f9e1e3a5592339de70bffab25517bbad2f7127549874fbf670" },
  { address: RECEIPT, codeHash: "0x76f9f10f52a301cd5472850a4ac1f5421c8bb57f126e7bd171bd9d3ae70dc30b", implementationAddress: "0x54f1c7ffe10bc392f08ae9432a7e21a6e86bb982", implementationCodeHash: "0xae89d4b99f8590a5045c314350c7e1a0a7fdd69fd1adeb11aa554d6e2edeb1eb" },
  { address: ASSET, codeHash: "0x223e499501c0b9733c0b452729d097c5e5020682697e21e64c4420b03faea60a", implementationAddress: "0xdd71fd677fde2ed2579a3c45204f41a11016ccb4", implementationCodeHash: "0x5eed11afcd838f04e11907adbb2da92f7acc0f634348cb3594fb8e0e3fb2572a" },
  { address: DENYLIST, codeHash: "0xe194cfc91965c1c791ab4d8594b646a2a42b3c01b2667baa25f7c6ac61dfb402" },
  { address: VESTING, codeHash: "0x7470c564dcec7ed1f0c3dbf405c6764425606c231e85654fce13637aa8bc2d0d" },
];
const ABI = parseAbi([
  "function asset() view returns (address)", "function receipt() view returns (address)",
  "function vault() view returns (address)", "function denyList() view returns (address)",
  "function vesting() view returns (address)", "function beneficiary() view returns (address)",
  "function paused() view returns (bool)", "function decimals() view returns (uint8)",
  "function balanceOf(address) view returns (uint256)", "function totalAssets() view returns (uint256)",
  "function totalSupply() view returns (uint256)", "function vestedAmount() view returns (uint256)",
  "function unlockingFee() view returns (uint256)", "function feeWallet() view returns (address)",
  "function contains(address) view returns (bool)",
  "function feeCurve() view returns ((uint256,uint256,uint48,uint48,uint256))",
  "function previewWithdraw(uint256) view returns (uint256)", "function previewRedeem(uint256) view returns (uint256)",
]);
function field(label: string, contract: string, functionName: string, args?: readonly unknown[]) {
  return abiObservation({ label, contract, abi: ABI, functionName, args });
}

/** New receipts are funded during withdrawal; already escrowed receipt assets are not counted again. */
export async function observeApyusdUnlockReceipt(
  blockNumber: number, blockTimestamp: number, rpcOptions: EvmRpcOptions, client: ExecutableRedemptionReadClient,
  ctx: AdapterContext | undefined, signal: AbortSignal, owner?: string,
): Promise<ExecutableRedemptionObservation> {
  if (owner != null && !/^0x[0-9a-fA-F]{40}$/.test(owner)) throw new Error("Invalid receipt holder identity");
  const { values: s } = await readStateWithPlan("apyusd-apyx", "apyusd-funded-receipt-state", [
    field("asset", VAULT, "asset"), field("receipt", VAULT, "receipt"),
    field("receipt-asset", RECEIPT, "asset"), field("receipt-vault", RECEIPT, "vault"),
    field("vault-list", VAULT, "denyList"), field("asset-list", ASSET, "denyList"),
    field("vesting", VAULT, "vesting"), field("vesting-asset", VESTING, "asset"), field("vesting-beneficiary", VESTING, "beneficiary"),
    field("vault-paused", VAULT, "paused"), field("receipt-paused", RECEIPT, "paused"), field("asset-paused", ASSET, "paused"),
    field("vault-decimals", VAULT, "decimals"), field("asset-decimals", ASSET, "decimals"),
    field("idle", ASSET, "balanceOf", [VAULT]), field("existing-escrow", ASSET, "balanceOf", [RECEIPT]),
    field("supply", VAULT, "totalSupply"), field("total-assets", VAULT, "totalAssets"), field("vested", VESTING, "vestedAmount"),
    field("vesting-physical", ASSET, "balanceOf", [VESTING]), field("vesting-denied", DENYLIST, "contains", [VESTING]),
    field("unlocking-fee", VAULT, "unlockingFee"), field("fee-curve", RECEIPT, "feeCurve"),
    field("vault-fee-wallet", VAULT, "feeWallet"), field("receipt-fee-wallet", RECEIPT, "feeWallet"),
    field("vault-denied", DENYLIST, "contains", [VAULT]), field("receipt-denied", DENYLIST, "contains", [RECEIPT]),
    field("vault-fee-wallet-denied", DENYLIST, "contains", [FEE_WALLET]), field("receipt-fee-wallet-denied", DENYLIST, "contains", [FEE_WALLET]),
    ...(owner ? [field("owner-denied", DENYLIST, "contains", [owner])] : []),
  ], IDENTITIES, blockNumber, rpcOptions, client, ctx, signal);
  for (const [key, expected] of Object.entries({ asset: ASSET, receipt: RECEIPT, "receipt-asset": ASSET, "receipt-vault": VAULT,
    "vault-list": DENYLIST, "asset-list": DENYLIST, vesting: VESTING, "vesting-asset": ASSET, "vesting-beneficiary": VAULT,
    "vault-fee-wallet": FEE_WALLET, "receipt-fee-wallet": FEE_WALLET })) {
    if ((s[key] as string).toLowerCase() !== expected) throw new Error(`apyUSD ${key} identity drift`);
  }
  if (s["vault-decimals"] !== 18 || s["asset-decimals"] !== 18) throw new Error("apyUSD decimals drift");
  const [minFee, maxFee, minDuration, maxDuration, curvature] = s["fee-curve"] as readonly [bigint, bigint, number, number, bigint];
  const upfrontFee = s["unlocking-fee"] as bigint;
  if (minFee > maxFee || maxFee > WAD / 20n || minDuration <= 0 || maxDuration <= minDuration || maxDuration > 90 * 86400 ||
      curvature < WAD / 10n || curvature > 10n * WAD || upfrontFee > WAD / 100n) throw new Error("apyUSD malformed or unsupported fee curve");
  const idle = s.idle as bigint, supply = s.supply as bigint, totalAssets = s["total-assets"] as bigint;
  if (totalAssets !== idle + (s.vested as bigint)) throw new Error("apyUSD total assets/vested accounting mismatch");
  if ((s["vesting-physical"] as bigint) < (s.vested as bigint)) throw new Error("apyUSD vested-yield delivery is underfunded");
  const adverse = ["vault-paused", "receipt-paused", "asset-paused", "vault-denied", "receipt-denied", "owner-denied",
    ...((s.vested as bigint) > 0n ? ["vesting-denied"] : []),
    ...(upfrontFee > 0n ? ["vault-fee-wallet-denied"] : []), ...(maxFee > 0n ? ["receipt-fee-wallet-denied"] : [])].find(k => s[k] === true);
  const grossForAllShares = supply * (totalAssets + 1n) / (supply + 1n);
  const grossBound = idle < grossForAllShares ? idle : grossForAllShares;
  // _feeOnRaw is CEIL; choose a conservative net for which the exact gross transfer is fundable now.
  const escrowBound = grossBound * WAD / (WAD + upfrontFee);
  const upfrontRaw = (escrowBound * upfrontFee + WAD - 1n) / WAD;
  const shares = ((escrowBound + upfrontRaw) * (supply + 1n) + totalAssets) / (totalAssets + 1n);
  if (shares > supply || escrowBound + upfrontRaw > idle || escrowBound >= 2n ** 208n) throw new Error("apyUSD newly funded receipt bound invalid");
  // Live previews guard native receipt funding/rounding independently of downstream USD/cost admission.
  // Skipping them just because all-in cost is unobserved would certify an unchecked measured/open route.
  if (!adverse && escrowBound > 0n) {
    const { values: q } = await readStateWithPlan("apyusd-apyx", "apyusd-funded-receipt-quotes", [
      field("preview-withdraw", VAULT, "previewWithdraw", [escrowBound]), field("preview-redeem", VAULT, "previewRedeem", [shares]),
    ], [], blockNumber, rpcOptions, client, ctx, signal);
    const grossRedeem = shares * (totalAssets + 1n) / (supply + 1n);
    const expectedRedeem = grossRedeem - (grossRedeem * upfrontFee + (WAD + upfrontFee) - 1n) / (WAD + upfrontFee);
    if (q["preview-withdraw"] !== shares || q["preview-redeem"] !== expectedRedeem || expectedRedeem < escrowBound) throw new Error("apyUSD receipt conversion/ceil rounding mismatch");
  }
  const receiptFeeRaw = (escrowBound * minFee + WAD - 1n) / WAD;
  const payout = escrowBound - receiptFeeRaw;
  return {
    capacityRaw: adverse ? 0n : payout, capacityState: adverse ? "closed" : "measured",
    capacitySource: "apyusd-newly-funded-unlock-receipts", underlyingDecimals: 18, capacityKind: "live-direct-bounded",
    freshnessKind: "same-run-onchain", routeStatusSource: "onchain", routeStatus: adverse ? "paused" : "open",
    routeStatusReason: adverse ?? "Funded owner-claimable receipts at the measured current fee schedule; not an atomic exit",
    settlementDelaySec: maxDuration, feeBps: Number(((upfrontFee + minFee) * 10_000n + WAD - 1n) / WAD),
    allInFeeBps: null, holderEligibility: "any-holder", outputAssetKeys: ["apxusd-apyx"], blockNumber, sourceTimestamp: blockTimestamp,
    sourceUrls: ["https://docs.apyx.fi/product-overview/apyusd-overview", "https://eth.blockscout.com/api/v2/smart-contracts/0xfd616567ecc1607f61073951a1e822f7315bb112", "https://eth.blockscout.com/api/v2/smart-contracts/0x54f1c7ffe10bc392f08ae9432a7e21a6e86bb982"],
    diagnostics: { vault: VAULT, receipt: RECEIPT, outputAssetAddress: ASSET, idleUnderlyingRaw: idle.toString(),
      existingReceiptEscrowRaw: (s["existing-escrow"] as bigint).toString(), existingEscrowIncludedInCapacity: false,
      vestedYieldRaw: (s.vested as bigint).toString(), vestedYieldUsedAsLiquidity: false, newlyEscrowedRaw: escrowBound.toString(),
      sharesBurnedRaw: shares.toString(), upfrontFeeRaw: upfrontRaw.toString(), minReceiptFeeWad: minFee.toString(), maxReceiptFeeWad: maxFee.toString(),
      minClaimDurationSec: minDuration, minFeeDurationSec: maxDuration, governanceMaxDurationSec: 90 * 86400,
      scheduleMutableForExistingReceipts: true, funding: "underlying-transferred-at-receipt-mint", operatorFinalizationRequired: false,
      settlementModel: "queued", settlementEvidence: "documented-bound", atomic300SecondCredit: false,
      ownerEligibilityVerified: owner != null, observedBlockHash: rpcOptions.stateBlockHash ?? null },
  };
}
export const APYUSD_UNLOCK_RECEIPT_OBSERVER: ExecutableRedemptionObserverDescriptor = {
  observerId: "apyusd-unlock-receipt", coinId: "apyusd-apyx", chain: "ethereum", inputContract: VAULT,
  outputAssetKeys: ["apxusd-apyx"], capacityCapability: "measured", sourceLane: "direct", observe: observeApyusdUnlockReceipt,
};
