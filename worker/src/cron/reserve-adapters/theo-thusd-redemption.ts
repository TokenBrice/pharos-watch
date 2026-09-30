import type { StablecoinMeta } from "@shared/types/core";
import type { LiveReservesConfig } from "@shared/types/live-reserves";
import { FullReserveCompositionSchema } from "@shared/types/reserves";
import { parseLiveReserveAdapterParams } from "@shared/lib/live-reserve-adapters";
import { parseAbi, encodeFunctionData } from "viem/utils";
import { encodeAddressCallData, encodeBalanceOfCallData } from "../../lib/evm-selectors";
import type { AdapterContext, AdapterResult } from "./types";
import { addressObservation, boolObservation, executeEvmObservationPlan, pinnedBlockPlan, uint256Observation } from "./evm-observation-plan";
import { buildRedemptionSnapshotMetadata, decimalNumberFromBigInt, fetchOnchainMulticall3, requireOnchainInput, reserveDegradedWarning } from "./helpers";

// Verified minter source and state reviewed 2026-09-30 at Ethereum block 26088429.
const MINTER = "0x2d99ac801dc0edadd53f5688fef2317932e8696e";
const THUSD = "0xa3fe5c7596024e6811e14f029937d5bd8ae485b3";
const CASH_WALLET = "0xec417ccb6dd26868cca993a92f37217b1d4b3c2f";
const ASSETS = [
  { label: "USDC", address: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48" },
  { label: "USDT", address: "0xdac17f958d2ee523a2206206994597c13d831ec7" },
] as const;
const VERIFIED_SOURCE = `https://eth.blockscout.com/api/v2/smart-contracts/${MINTER}`;
const CONTRACT_REFERENCE = "https://docs.theo.xyz/developers/contract-reference/mint-and-redeem.md";
const ABI = parseAbi([
  "function thusd() view returns (address)",
  "function redeemDestination() view returns (address)",
  "function paused() view returns (bool)",
  "function maxRedeemPerBlock() view returns (uint256)",
  "function redeemFeeBps() view returns (uint256)",
  "function MAX_FEE_BPS() view returns (uint256)",
  "function redeemedPerBlock(uint256) view returns (uint256)",
  "function supportedAssets(address) view returns (bool)",
]);
const call = (functionName: "thusd" | "redeemDestination" | "paused" | "maxRedeemPerBlock" | "redeemFeeBps" | "MAX_FEE_BPS") =>
  encodeFunctionData({ abi: ABI, functionName });
const sixDecimals = (value: bigint) => value === 6n ? null : "reviewed six-decimal units drifted";

export async function fetchTheoThusdRedemptionReserves(
  coin: StablecoinMeta,
  config: LiveReservesConfig,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<AdapterResult> {
  parseLiveReserveAdapterParams("theo-thusd-redemption", config.params);
  const input = requireOnchainInput(config.inputs.primary, "theo-thusd-redemption");
  if (coin.id !== "thusd-theo" || input.chain !== "ethereum") {
    throw new Error("theo-thusd-redemption requires the reviewed Ethereum thUSD identity");
  }
  if (!coin.reserves?.length || !FullReserveCompositionSchema.safeParse(coin.reserves).success) {
    throw new Error("theo-thusd-redemption requires a valid full curated reserve composition");
  }
  const { observedBlock, ctx: pinnedCtx } = await pinnedBlockPlan({ chain: "ethereum", signal, ctx });
  if (!Number.isSafeInteger(observedBlock.number) || observedBlock.number < 0
    || !Number.isSafeInteger(observedBlock.timestamp) || observedBlock.timestamp <= 0) {
    throw new Error("theo-thusd-redemption invalid observation block");
  }
  const fields = [
    addressObservation({ label: "thusd", contract: MINTER, data: call("thusd"), verify: (value) => value === THUSD ? null : "thUSD identity drift" }),
    addressObservation({ label: "destination", contract: MINTER, data: call("redeemDestination"), verify: (value) => value === CASH_WALLET ? null : "cash wallet destination drift" }),
    boolObservation({ label: "paused", contract: MINTER, data: call("paused") }),
    uint256Observation({ label: "cap", contract: MINTER, data: call("maxRedeemPerBlock") }),
    uint256Observation({ label: "redeemed", contract: MINTER, data: encodeFunctionData({ abi: ABI, functionName: "redeemedPerBlock", args: [BigInt(observedBlock.number)] }) }),
    uint256Observation({ label: "fee", contract: MINTER, data: call("redeemFeeBps") }),
    uint256Observation({ label: "maxFee", contract: MINTER, data: call("MAX_FEE_BPS") }),
    uint256Observation({ label: "thusdDecimals", contract: THUSD, data: "0x313ce567", verify: sixDecimals }),
    uint256Observation({ label: "supply", contract: THUSD, data: "0x18160ddd" }),
    ...ASSETS.flatMap((asset) => [
      boolObservation({ label: `${asset.label}:supported` as const, contract: MINTER, data: encodeFunctionData({ abi: ABI, functionName: "supportedAssets", args: [asset.address] }) }),
      uint256Observation({ label: `${asset.label}:balance` as const, contract: asset.address, data: encodeBalanceOfCallData(CASH_WALLET) }),
      uint256Observation({ label: `${asset.label}:allowance` as const, contract: asset.address, data: encodeAddressCallData("0xdd62ed3e", CASH_WALLET, MINTER) }),
      uint256Observation({ label: `${asset.label}:decimals` as const, contract: asset.address, data: "0x313ce567", verify: sixDecimals }),
    ]),
  ] as const;
  const { values } = await executeEvmObservationPlan({
    adapterKey: "theo-thusd-redemption",
    fields,
    read: (calls) => fetchOnchainMulticall3({ calls: [...calls], chain: "ethereum", signal, ctx: pinnedCtx, blockNumberOrTag: observedBlock.number }),
  });
  if (values.fee > values.maxFee || values.maxFee > 10n || values.redeemed > values.cap) {
    throw new Error("theo-thusd-redemption incoherent fee or block counter");
  }
  const usd = (amount: bigint) => {
    const value = decimalNumberFromBigInt(amount, 6);
    if (!Number.isFinite(value)) throw new Error("theo-thusd-redemption non-finite amount");
    return value;
  };
  let spendableRaw = 0n;
  let balanceRaw = 0n;
  let supportedCount = 0;
  const assets = ASSETS.map((asset) => {
    // Dynamic asset labels share a descriptor union; each required field was
    // already strictly decoded by its boolean/uint observation above.
    const supported = values[`${asset.label}:supported`] as boolean;
    const balance = values[`${asset.label}:balance`] as bigint;
    const allowance = values[`${asset.label}:allowance`] as bigint;
    const spendable = supported ? (balance < allowance ? balance : allowance) : 0n;
    if (supported) supportedCount++;
    spendableRaw += spendable;
    balanceRaw += balance;
    return { ...asset, supported, status: supported ? "supported" : "unsupported", balanceUsd: usd(balance), allowanceRaw: allowance.toString(), allowanceUsd: usd(allowance), spendableUsd: usd(spendable) };
  });
  const closed = values.paused || values.cap === 0n || supportedCount === 0;
  const capacityUsd = closed ? 0 : usd(spendableRaw);
  const routeStatusReason = values.paused ? "ThUSDMinter is paused"
    : values.cap === 0n ? "ThUSDMinter configured redemption cap is zero"
      : supportedCount === 0 ? "ThUSDMinter has no supported reviewed output asset"
        : capacityUsd === 0 ? "Supported Cash Wallet assets have no allowance-limited spendable float"
          : "Observed on-chain guards are open; capacity is multi-block allowance-limited float, not an API SLA";
  return {
    slices: coin.reserves,
    warnings: closed ? [reserveDegradedWarning("theo-redemption-rail-closed", routeStatusReason)]
      : capacityUsd === 0 ? [reserveDegradedWarning("theo-redemption-buffer-empty", routeStatusReason)] : [],
    metadata: {
      freshnessMode: "not-applicable",
      ...buildRedemptionSnapshotMetadata({
        capacityUsd, capacityKind: "live-direct-bounded", freshnessKind: "same-run-onchain",
        sourceTimestamp: observedBlock.timestamp, blockNumber: observedBlock.number,
        routeStatus: closed ? "paused" : capacityUsd === 0 ? "degraded" : "open",
        routeStatusSource: "onchain", routeObserved: true, routeStatusReason,
        holderEligibility: "whitelisted-primary", settlementDelaySec: 0, minRedeemUsd: 1,
        feeBps: Number(values.fee), sourceUrls: [VERIFIED_SOURCE, CONTRACT_REFERENCE],
      }),
      details: {
        compositionScope: "Unchanged reviewed curated reserves; only redemption capacity and current fee are measured",
        reserveReview: coin.reserveReview,
        minter: MINTER, thusd: THUSD, cashWallet: CASH_WALLET, assets,
        balanceOnlyCapacityUsd: usd(balanceRaw), totalSupplyRaw: values.supply.toString(), observedThusdSupply: usd(values.supply),
        maxRedeemPerBlockThusd: usd(values.cap), redeemedThisBlockThusd: usd(values.redeemed),
        remainingThisBlockThusd: usd(values.cap - values.redeemed),
        scope: "Operator-submitted executed eligible-cohort rail; outputs valued at reviewed par; no replenishment or backend at-par quote guarantee",
      },
    },
  };
}
