import type { EvmRpcOptions } from "../../lib/evm-rpc";
import type { AdapterContext } from "./types";
import { fail, readStateWithPlan, type ExecutableRedemptionReadClient, type ExecutableRedemptionObservation } from "./executable-redemption-read-client";
import { parseAbi } from "viem/utils";
import { erc20Abi, erc4626Abi } from "./executable-redemption-abis";
import { abiObservation } from "./evm-observation-plan";
import { type ProxyIdentity, fixedPointFeeBpsCeil, verifyExpectedAddress } from "./executable-redemption-observer-helpers";

export const EARN_VAULT_ABI = parseAbi([
  "function vaultValidator() view returns (address)",
  "function protocolConfig() view returns (address)",
  "function pauseStatus() view returns (bool depositsPaused, bool withdrawalsPaused, bool privilegedOperationsPaused)",
  "function getPendingWithdrawalsLength() view returns (uint256)",
  "function minWithdrawableShares() view returns (uint256)",
]);
export const EARN_VALIDATOR_ABI = parseAbi([
  "function withdrawalFee(address vault) view returns (uint256 permanentFeePercentage, uint256 timeBasedFeePercentage, uint256 balanceThreshold)",
  "function depositAllowListCount(address vault) view returns (uint256)",
]);
export const EARN_PROTOCOL_CONFIG_ABI = parseAbi([
  "function getProtocolPauseStatus() view returns (bool)",
]);

const EARN = {
  coinId: "eearn-ember",
  vault: {
    address: "0x9be9294722f8aad37b11a9792be2c782182cafa2",
    codeHash: "0x864cc9ad53b338b82da1f7cab85ab0b3d5c8861acb422b6fec63cf36234f36a6",
    implementationAddress: "0x9b2e2eef7ffe1b15ca8c61e65538b51ca8977c7e",
    implementationCodeHash: "0x4448a74aff5a6b95fe30cebf1187f9dc647d81413ae7e06410e7772b4b64efc4",
  } satisfies ProxyIdentity,
  validator: {
    address: "0x4c735b0989f1a7464991bcca9f0e8c661ba54465",
    codeHash: "0x864cc9ad53b338b82da1f7cab85ab0b3d5c8861acb422b6fec63cf36234f36a6",
    implementationAddress: "0x2bebb55c0ca126b0d883fb94843c0a2c13102522",
    implementationCodeHash: "0x537bb88a640ed963c5848c27bdb3ac3b7da135642908db377b4c9a362cdd61f9",
  } satisfies ProxyIdentity,
  protocolConfig: {
    address: "0x1dc4836e5a0a95105bee1899e3b6bbb1714480fb",
    codeHash: "0x864cc9ad53b338b82da1f7cab85ab0b3d5c8861acb422b6fec63cf36234f36a6",
    implementationAddress: "0x540db273e41587a748365f01f35adb095b58bfeb",
    implementationCodeHash: "0x2c629d0cdee4894f27ca680a5d168a46ae8ed829e6d5e0c424f5d3e12dc866c7",
  } satisfies ProxyIdentity,
  assetAddress: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
  assetDecimals: 6,
  sourceUrls: [
    "https://ember.so/earn/eEARN",
    "https://etherscan.io/address/0x9be9294722f8aad37b11a9792be2c782182cafa2#readContract",
    "https://eth.blockscout.com/address/0x9b2e2eef7ffe1b15ca8c61e65538b51ca8977c7e?tab=contract",
    "https://eth.blockscout.com/address/0x2bebb55c0ca126b0d883fb94843c0a2c13102522?tab=contract",
    "https://eth.blockscout.com/address/0x540db273e41587a748365f01f35adb095b58bfeb?tab=contract",
  ],
} as const;

function earnFields() {
  return [
    abiObservation({
      label: "earn-asset",
      contract: EARN.vault.address,
      abi: erc4626Abi,
      functionName: "asset",
      verify: verifyExpectedAddress(EARN.coinId, "asset", EARN.assetAddress),
    }),
    abiObservation({
      label: "earn-total-assets",
      contract: EARN.vault.address,
      abi: erc4626Abi,
      functionName: "totalAssets",
    }),
    abiObservation({
      label: "earn-validator",
      contract: EARN.vault.address,
      abi: EARN_VAULT_ABI,
      functionName: "vaultValidator",
      verify: verifyExpectedAddress(EARN.coinId, "vaultValidator", EARN.validator.address),
    }),
    abiObservation({
      label: "earn-protocol-config",
      contract: EARN.vault.address,
      abi: EARN_VAULT_ABI,
      functionName: "protocolConfig",
      verify: verifyExpectedAddress(
        EARN.coinId,
        "protocolConfig",
        EARN.protocolConfig.address,
      ),
    }),
    abiObservation({
      label: "earn-pause-status",
      contract: EARN.vault.address,
      abi: EARN_VAULT_ABI,
      functionName: "pauseStatus",
    }),
    abiObservation({
      label: "earn-pending-withdrawals",
      contract: EARN.vault.address,
      abi: EARN_VAULT_ABI,
      functionName: "getPendingWithdrawalsLength",
    }),
    abiObservation({
      label: "earn-min-withdrawable-shares",
      contract: EARN.vault.address,
      abi: EARN_VAULT_ABI,
      functionName: "minWithdrawableShares",
    }),
    abiObservation({
      label: "earn-withdrawal-fee",
      contract: EARN.validator.address,
      abi: EARN_VALIDATOR_ABI,
      functionName: "withdrawalFee",
      args: [EARN.vault.address],
    }),
    abiObservation({
      label: "earn-deposit-allow-list-count",
      contract: EARN.validator.address,
      abi: EARN_VALIDATOR_ABI,
      functionName: "depositAllowListCount",
      args: [EARN.vault.address],
    }),
    abiObservation({
      label: "earn-protocol-paused",
      contract: EARN.protocolConfig.address,
      abi: EARN_PROTOCOL_CONFIG_ABI,
      functionName: "getProtocolPauseStatus",
    }),
    abiObservation({
      label: "earn-idle-usdc",
      contract: EARN.assetAddress,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [EARN.vault.address],
    }),
    abiObservation({
      label: "earn-asset-decimals",
      contract: EARN.assetAddress,
      abi: erc20Abi,
      functionName: "decimals",
    }),
  ] as const;
}

export async function observeEarn(
  blockNumber: number,
  blockTimestamp: number,
  rpcOptions: EvmRpcOptions,
  client: ExecutableRedemptionReadClient,
  ctx: AdapterContext | undefined,
  signal: AbortSignal,
): Promise<ExecutableRedemptionObservation> {
  const state = await readStateWithPlan(
    EARN.coinId,
    "eearn-redemption-state",
    earnFields(),
    [EARN.vault, EARN.validator, EARN.protocolConfig],
    blockNumber,
    rpcOptions,
    client,
    ctx,
    signal,
  );
  const pauseStatus = state.values["earn-pause-status"] as readonly [boolean, boolean, boolean];
  const protocolPaused = state.values["earn-protocol-paused"] as boolean;
  const feeParts = state.values["earn-withdrawal-fee"] as readonly [bigint, bigint, bigint];
  const totalFeeRaw = feeParts[0] + feeParts[1];
  const feeBps = fixedPointFeeBpsCeil(totalFeeRaw, 10n ** 18n, EARN.coinId);
  const assetDecimals = state.values["earn-asset-decimals"] as number;
  if (assetDecimals !== EARN.assetDecimals) {
    fail(EARN.coinId, "USDC decimals drift");
  }

  const queueOpen =
    !pauseStatus[1] &&
    !pauseStatus[2] &&
    protocolPaused === false;
  return {
    // The zero below is not a measured capacity: requests open an
    // operator-processed queue, but no contract view or bounded SLA proves
    // completion inside the shared 300-second same-notional horizon. Downstream
    // therefore classifies an OPEN queue as an unproven-settlement-bound
    // evidence gap. A paused queue is measured adverse — the pause is the
    // fact — so the marker is withheld and the zero stays a measured zero.
    capacityRaw: 0n,
    capacitySource: "eearn-operator-batched-no-immediate-capacity",
    capacityState: queueOpen ? "unquantified" : "closed",
    outputAssetKeys: ["usdc-circle"],
    ...(queueOpen ? { settlementBoundUnproven: true as const } : {}),
    underlyingDecimals: EARN.assetDecimals,
    capacityKind: "live-direct-bounded",
    freshnessKind: "same-run-onchain",
    routeStatusSource: "onchain",
    routeStatus: queueOpen ? "open" : "paused",
    routeStatusReason: queueOpen
      ? "Ember withdrawal requests are open onchain and redeem to USDC at the vault's NAV share price, but settlement is operator-batched with no proven <=300-second completion bound"
      : "Ember withdrawal requests or privileged processing are paused onchain",
    feeBps,
    holderEligibility: "any-holder",
    blockNumber,
    sourceTimestamp: blockTimestamp,
    sourceUrls: [...EARN.sourceUrls],
    diagnostics: {
      outputAssetAddress: EARN.assetAddress,
      vaultAddress: EARN.vault.address,
      vaultImplementationAddress: EARN.vault.implementationAddress,
      validatorAddress: EARN.validator.address,
      validatorImplementationAddress: EARN.validator.implementationAddress,
      protocolConfigAddress: EARN.protocolConfig.address,
      protocolConfigImplementationAddress: EARN.protocolConfig.implementationAddress,
      depositsPaused: pauseStatus[0],
      withdrawalsPaused: pauseStatus[1],
      privilegedOperationsPaused: pauseStatus[2],
      protocolPaused,
      permanentWithdrawalFeeRaw: feeParts[0].toString(),
      timeBasedWithdrawalFeeRaw: feeParts[1].toString(),
      withdrawalFeeBalanceThresholdRaw: feeParts[2].toString(),
      pendingWithdrawals: (state.values["earn-pending-withdrawals"] as bigint).toString(),
      minWithdrawableSharesRaw: (state.values["earn-min-withdrawable-shares"] as bigint).toString(),
      depositAllowListCount: (state.values["earn-deposit-allow-list-count"] as bigint).toString(),
      totalAssetsRaw: (state.values["earn-total-assets"] as bigint).toString(),
      idleUnderlyingBalanceRaw: (state.values["earn-idle-usdc"] as bigint).toString(),
      idleUnderlyingUsedAsCapacity: false,
    },
  };
}
