import type { EvmRpcOptions } from "../../lib/evm-rpc";
import type { AdapterContext } from "./types";
import { fail, readStateWithPlan, type ExecutableRedemptionReadClient, type ExecutableRedemptionObservation } from "./executable-redemption-read-client";
import { parseAbi } from "viem/utils";
import { erc20Abi, erc4626Abi } from "./executable-redemption-abis";
import { runAdapterIo } from "./concurrency";
import { implementationAddressFromSlot } from "./onchain-identity";
import { type ProxyIdentity, type DirectIdentity, verifyExpectedAddress, abiField } from "./executable-redemption-observer-helpers";

export const NOON_SUSN_VAULT_ABI = parseAbi([
  "function paused() view returns (bool)",
]);
export const NOON_SUSN_WITHDRAWAL_HANDLER_ABI = parseAbi([
  "function usn() view returns (address)",
  "function withdrawPeriod() view returns (uint256)",
]);

// Noon sUSN exits through a holder-initiated request/claim rail: a vault
// withdraw moves USN to the WithdrawalHandler with a timestamp, and
// claimWithdrawal pays after the handler's withdrawPeriod. The vault exposes
// no getter for its handler pointer (StakingVaultStorage.withdrawalHandler
// sits one slot above the namespaced base
// keccak256("StakingVault.storage.location")), so the pointer is read from
// storage and pinned every run: setWithdrawalHandler must fail closed here,
// not silently redirect the settlement-bound read to a retired contract.
// Runtime identity reviewed 2026-10-05 at block 26,122,649. Blockscout's
// verified StakingVaultOFTUpgradeableHyperlane bytecode matches the RPC code;
// its holder request/claim path and namespaced handler slot are unchanged.
const NOON_SUSN = {
  coinId: "susn-noon",
  vault: {
    address: "0xe24a3dc889621612422a64e6388927901608b91d",
    codeHash: "0xb108840d91ea6f26d83fc692d0ac870fe1e895debcd9e67c1d7d4317296a88e6",
    implementationAddress: "0xef2ea4250b7ce4d0aa9ca70607ecef278c6eab15",
    implementationCodeHash: "0x643389431d29e62e04a7bc4c324f7b1af4561453d3758f46f456b7f39cb63440",
  } satisfies ProxyIdentity,
  withdrawalHandler: {
    address: "0x0dabc0d9b270c9b0c4c77aaceaa712b56d0f9178",
    codeHash: "0x48f64f2a52f543354cd46deeb67405df9544289012d18bd9b48920d44d0a4c13",
  } satisfies DirectIdentity,
  withdrawalHandlerStorageSlot:
    "0xeb35582a09ab498623cb7b45bfdff1ae6ef9e826b054d3e2fb0481e4d27a9fce",
  // The handler admin since 2026-08-04: a 48h-min-delay GenericTimelock owned
  // by the 3-of-6 Noon Safe. setWithdrawPeriod is unbounded and applies
  // retroactively to in-flight requests, so the live value is re-read each run.
  withdrawalHandlerTimelockAddress: "0x36857ef0b10a61a68d58c29ee256990fa9699722",
  assetAddress: "0xda67b4284609d2d48e5d10cfac411572727dc1ed",
  assetDecimals: 18,
  sourceUrls: [
    "https://docs.noon.capital/2.-usdusn-and-usdsusn/mint-and-redeem.md",
    "https://etherscan.io/address/0xe24a3dc889621612422a64e6388927901608b91d#readContract",
    "https://etherscan.io/address/0x0dabc0d9b270c9b0c4c77aaceaa712b56d0f9178#readContract",
    "https://eth.blockscout.com/api/v2/smart-contracts/0xef2ea4250b7ce4d0aa9ca70607ecef278c6eab15",
    "https://etherscan.io/address/0x36857ef0b10a61a68d58c29ee256990fa9699722#readContract",
  ],
} as const;

function susnNoonFields() {
  return [
    abiField("susn-asset", NOON_SUSN.vault.address, erc4626Abi, "asset", {
      verify: verifyExpectedAddress(NOON_SUSN.coinId, "asset", NOON_SUSN.assetAddress),
    }),
    abiField("susn-total-assets", NOON_SUSN.vault.address, erc4626Abi, "totalAssets"),
    abiField("susn-vault-paused", NOON_SUSN.vault.address, NOON_SUSN_VAULT_ABI, "paused"),
    abiField("susn-idle-usn", NOON_SUSN.assetAddress, erc20Abi, "balanceOf", {
      args: [NOON_SUSN.vault.address],
    }),
    abiField("susn-asset-decimals", NOON_SUSN.assetAddress, erc20Abi, "decimals"),
    abiField("handler-usn", NOON_SUSN.withdrawalHandler.address, NOON_SUSN_WITHDRAWAL_HANDLER_ABI, "usn", {
      verify: verifyExpectedAddress(NOON_SUSN.coinId, "handler usn", NOON_SUSN.assetAddress),
    }),
    abiField(
      "handler-withdraw-period",
      NOON_SUSN.withdrawalHandler.address,
      NOON_SUSN_WITHDRAWAL_HANDLER_ABI,
      "withdrawPeriod",
    ),
  ] as const;
}

export async function observeSusnNoon(
  blockNumber: number,
  blockTimestamp: number,
  rpcOptions: EvmRpcOptions,
  client: ExecutableRedemptionReadClient,
  ctx: AdapterContext | undefined,
  signal: AbortSignal,
): Promise<ExecutableRedemptionObservation> {
  const handlerPointerWord = await runAdapterIo(
    ctx,
    "susn-noon-redemption-withdrawal-handler",
    () =>
      client.storage(
        NOON_SUSN.vault.address,
        NOON_SUSN.withdrawalHandlerStorageSlot,
        blockNumber,
        rpcOptions,
      ),
    { signal },
  );
  const handlerAddress = implementationAddressFromSlot(handlerPointerWord);
  if (handlerAddress == null || handlerAddress !== NOON_SUSN.withdrawalHandler.address) {
    fail(NOON_SUSN.coinId, "vault withdrawal-handler pointer is unreadable or drifted");
  }

  const state = await readStateWithPlan(
    NOON_SUSN.coinId,
    "susn-noon-redemption-state",
    susnNoonFields(),
    [NOON_SUSN.vault, NOON_SUSN.withdrawalHandler],
    blockNumber,
    rpcOptions,
    client,
    ctx,
    signal,
  );
  const assetDecimals = state.values["susn-asset-decimals"] as number;
  const totalAssetsRaw = state.values["susn-total-assets"] as bigint;
  const idleUsnRaw = state.values["susn-idle-usn"] as bigint;
  const withdrawPeriodRaw = state.values["handler-withdraw-period"] as bigint;
  const vaultPaused = state.values["susn-vault-paused"] as boolean;
  if (assetDecimals !== NOON_SUSN.assetDecimals) {
    fail(NOON_SUSN.coinId, "USN decimals drift");
  }
  if (totalAssetsRaw <= 0n || idleUsnRaw < 0n) {
    fail(NOON_SUSN.coinId, "invalid vault idle-USN or totalAssets state");
  }
  // setWithdrawPeriod has no on-chain min/max and applies retroactively to
  // in-flight requests; a value outside the safe integer range leaves the
  // completion bound unknown, so the read fails closed instead of publishing.
  if (withdrawPeriodRaw < 0n || withdrawPeriodRaw > BigInt(Number.MAX_SAFE_INTEGER)) {
    fail(NOON_SUSN.coinId, "withdrawPeriod is outside the supported range");
  }
  const settlementDelaySec = Number(withdrawPeriodRaw);
  const boundedIdleRaw = idleUsnRaw > totalAssetsRaw ? totalAssetsRaw : idleUsnRaw;
  const routeStatus = vaultPaused ? "paused" : boundedIdleRaw > 0n ? "open" : "degraded";
  return {
    // Held idle USN backs every exit, but the rail settles only after the
    // live withdrawPeriod, so the capacity is a bounded live read, not an
    // immediate same-notional one.
    capacityRaw: routeStatus === "open" ? boundedIdleRaw : 0n,
    capacitySource: "noon-susn-withdrawal-handler-idle-usn",
    capacityState: routeStatus === "paused" ? "closed" : "measured",
    outputAssetKeys: ["usn-noon"],
    settlementDelaySec,
    underlyingDecimals: NOON_SUSN.assetDecimals,
    capacityKind: "live-direct-bounded",
    freshnessKind: "same-run-onchain",
    routeStatusSource: "onchain",
    routeStatus,
    routeStatusReason: routeStatus === "open"
      ? "Noon sUSN unstake requests are open onchain; the holder-initiated request/claim rail settles after the WithdrawalHandler's live withdrawPeriod"
      : routeStatus === "paused"
        ? "Noon vault pause blocks new sUSN unstake requests onchain"
        : "Noon sUSN vault holds no idle USN backing for new unstake requests",
    feeBps: 0,
    holderEligibility: "any-holder",
    blockNumber,
    sourceTimestamp: blockTimestamp,
    sourceUrls: [...NOON_SUSN.sourceUrls],
    diagnostics: {
      outputAssetAddress: NOON_SUSN.assetAddress,
      vaultAddress: NOON_SUSN.vault.address,
      vaultImplementationAddress: NOON_SUSN.vault.implementationAddress,
      withdrawalHandlerAddress: handlerAddress,
      withdrawalHandlerTimelockAddress: NOON_SUSN.withdrawalHandlerTimelockAddress,
      withdrawPeriodSec: settlementDelaySec,
      vaultPaused,
      totalAssetsRaw: totalAssetsRaw.toString(),
      idleUnderlyingBalanceRaw: idleUsnRaw.toString(),
    },
  };
}
