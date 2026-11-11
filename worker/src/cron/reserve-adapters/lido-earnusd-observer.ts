import type { EvmRpcOptions } from "../../lib/evm-rpc";
import type { AdapterContext } from "./types";
import { fail, readStateWithPlan, type ExecutableRedemptionReadClient, type ExecutableRedemptionObservation } from "./executable-redemption-read-client";
import { parseAbi } from "viem/utils";
import { erc20Abi } from "./executable-redemption-abis";
import type { AnyEvmObservationField } from "./evm-observation-plan";
import { type ProxyIdentity, fixedPointFeeBpsCeil, verifyExpectedAddress, abiField } from "./executable-redemption-observer-helpers";

const LIDO_EARN_VAULT_ABI = parseAbi([
  "function shareManager() view returns (address)",
  "function feeManager() view returns (address)",
  "function oracle() view returns (address)",
  "function hasQueue(address queue) view returns (bool)",
  "function isPausedQueue(address queue) view returns (bool)",
]);
const LIDO_EARN_QUEUE_ABI = parseAbi([
  "function asset() view returns (address)",
  "function vault() view returns (address)",
  "function getState() view returns (uint256 batchIterator, uint256 batches, uint256 demandAssets, uint256 pendingShares)",
]);
const LIDO_EARN_SYNC_ABI = parseAbi([
  "function syncRedeemParams() view returns (uint256 penaltyD6, uint32 maxAge, uint256 usage, uint256 dailyLimit, uint256 latestRequestTimestamp)",
  "function remainingDailyLimit() view returns (uint256 usage, uint256 remaining)",
  "function getLiquidAssets() view returns (uint256)",
]);
const LIDO_EARN_FEE_ABI = parseAbi([
  "function redeemFeeD6() view returns (uint24)",
]);
const LIDO_EARN_ORACLE_ABI = parseAbi([
  "function vault() view returns (address)",
  "function getReport(address asset) view returns ((uint224 priceD18, uint32 timestamp, bool isSuspicious) report)",
]);
const LIDO_EARN_SHARES_ABI = parseAbi([
  "function vault() view returns (address)",
  "function flags() view returns ((bool hasMintPause, bool hasBurnPause, bool hasTransferPause, bool hasWhitelist, bool hasTransferWhitelist, uint32 globalLockup) flags)",
]);

// Lido's modular Mellow vault is not Ember eEARN or an ERC-4626 vault.
// Exact source/runtime identities verified at Ethereum 26,122,344.
const LIDO_EARN = {
  coinId: "earnusd-lido",
  assetAddress: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
  vault: {
    address: "0x014e6da8f283c4af65b2aa0f201438680a004452",
    codeHash: "0x0e8e15f11b1c5792ac1c2f88fbdd7582231833390c1d9a3a9e8fc162a35b215f",
    implementationAddress: "0x0000000615b2771511daa693ac07be5622869e01",
    implementationCodeHash: "0x11fb0ab5367981cbb312ede4696498595a6ae4c9941ff89fb1bba2152825729e",
  } satisfies ProxyIdentity,
  queue: {
    address: "0x9e36a74fe278906a76e7615263e46a83fc40c47f",
    codeHash: "0x7cfc386711219d03876f80cf3a46b284116bad05341775129b93007df27bd120",
    implementationAddress: "0x000000000c139266ba06170ed1deaca6d11903c1",
    implementationCodeHash: "0xd434332fc5878b78e8c7f20698d7809d6fec9e2b8831282bac46a540d17fbb5d",
  } satisfies ProxyIdentity,
  sync: {
    address: "0xe0eee7e956a94bd00546d9ca07e5012f11a5059d",
    codeHash: "0x12a2e1f5c4bc6cb96cf9a5530c1ea1977e249aa6777769c6d4f81221af481fe1",
    implementationAddress: "0x0000000038801c7281284f8f68b80b679f64a074",
    implementationCodeHash: "0x37974a5ab05a2c078efc55032cd555238750b8abd7923ff232abaacb8293b344",
  } satisfies ProxyIdentity,
  fee: {
    address: "0x72fa23f40e08eb9e45953233b2dd9665e347e8dc",
    codeHash: "0xefb74284de000905b4b0cb7395e74969bdd7c69cf09358d0cd32255292795401",
    implementationAddress: "0x0000000de74e5d51651326e0a3e1aca94beaf6e1",
    implementationCodeHash: "0x7b1d70958161427202b208d7b2363bb18cc83be5347ed5db1425c1c37a4e90dd",
  } satisfies ProxyIdentity,
  oracle: {
    address: "0x827044735c9708a2cf850e7ea37eba43bc786028",
    codeHash: "0xdde18143096c956a0207a2a3391646c57dfd4681570afb5d76b0e2b4c3a69784",
    implementationAddress: "0x0000000f0d3d1c31b72368366a4049c05e291d58",
    implementationCodeHash: "0x338532a31ad88ba18f46a0a86e10e6a0303d490014046bcaf928e0e37672408e",
  } satisfies ProxyIdentity,
  shares: {
    address: "0x4ce1ac8f43e0e5bd7a346a98af777bf8fbea1981",
    codeHash: "0x59f5343659cb7fe5dd7516a1b0faf518aeb749352ff14164e0b142c641332de6",
    implementationAddress: "0x000000000c79d2b5cd58ae545afc83030233d7b6",
    implementationCodeHash: "0xaf363b1b3ce25e92f326fc51d882ec90ba98d3e43e870d6f4c4b39cd90a228d1",
  } satisfies ProxyIdentity,
} as const;

export async function observeLidoEarn(
  blockNumber: number,
  blockTimestamp: number,
  rpcOptions: EvmRpcOptions,
  client: ExecutableRedemptionReadClient,
  ctx: AdapterContext | undefined,
  signal: AbortSignal,
): Promise<ExecutableRedemptionObservation> {
  const { coinId, vault, queue, sync, fee, oracle, shares, assetAddress } = LIDO_EARN;
  const fields: AnyEvmObservationField[] = [
    abiField("lido-fee-manager", vault.address, LIDO_EARN_VAULT_ABI, "feeManager", {
      verify: verifyExpectedAddress(coinId, "fee manager", fee.address),
    }),
    abiField("lido-oracle", vault.address, LIDO_EARN_VAULT_ABI, "oracle", {
      verify: verifyExpectedAddress(coinId, "oracle", oracle.address),
    }),
    abiField("lido-share-manager", vault.address, LIDO_EARN_VAULT_ABI, "shareManager", {
      verify: verifyExpectedAddress(coinId, "share manager", shares.address),
    }),
    abiField("lido-share-vault", shares.address, LIDO_EARN_SHARES_ABI, "vault", {
      verify: verifyExpectedAddress(coinId, "share vault", vault.address),
    }),
    abiField("lido-oracle-vault", oracle.address, LIDO_EARN_ORACLE_ABI, "vault", {
      verify: verifyExpectedAddress(coinId, "oracle vault", vault.address),
    }),
    abiField("lido-flags", shares.address, LIDO_EARN_SHARES_ABI, "flags"),
    abiField("lido-fee", fee.address, LIDO_EARN_FEE_ABI, "redeemFeeD6"),
    abiField("lido-report", oracle.address, LIDO_EARN_ORACLE_ABI, "getReport", { args: [assetAddress] }),
    abiField("lido-queue-state", queue.address, LIDO_EARN_QUEUE_ABI, "getState"),
    abiField("lido-sync-params", sync.address, LIDO_EARN_SYNC_ABI, "syncRedeemParams"),
    abiField("lido-sync-limit", sync.address, LIDO_EARN_SYNC_ABI, "remainingDailyLimit"),
    abiField("lido-sync-liquid", sync.address, LIDO_EARN_SYNC_ABI, "getLiquidAssets"),
    abiField("lido-usdc-decimals", assetAddress, erc20Abi, "decimals"),
  ];
  for (const [name, identity] of [["async", queue], ["sync", sync]] as const) {
    fields.push(
      abiField(`lido-${name}-asset`, identity.address, LIDO_EARN_QUEUE_ABI, "asset", {
        verify: verifyExpectedAddress(coinId, `${name} asset`, assetAddress),
      }),
      abiField(`lido-${name}-vault`, identity.address, LIDO_EARN_QUEUE_ABI, "vault", {
        verify: verifyExpectedAddress(coinId, `${name} vault`, vault.address),
      }),
      abiField(`lido-${name}-registered`, vault.address, LIDO_EARN_VAULT_ABI, "hasQueue", {
        args: [identity.address],
        verify: (value) => value === true ? null : fail(coinId, `${name} queue removed`),
      }),
      abiField(`lido-${name}-paused`, vault.address, LIDO_EARN_VAULT_ABI, "isPausedQueue", {
        args: [identity.address],
      }),
    );
  }
  const state = await readStateWithPlan(
    coinId, "lido-earnusd-redemption-state", fields,
    [vault, queue, sync, fee, oracle, shares], blockNumber, rpcOptions, client, ctx, signal,
  );
  const values = state.values;
  if (values["lido-usdc-decimals"] !== 6) fail(coinId, "USDC decimals drift");
  const flags = values["lido-flags"] as {
    hasBurnPause: boolean; hasMintPause: boolean; globalLockup: number;
  };
  const report = values["lido-report"] as { priceD18: bigint; timestamp: number; isSuspicious: boolean };
  const [penaltyD6, maxAge] = values["lido-sync-params"] as readonly [bigint, number, bigint, bigint, bigint];
  const [usage, remainingShares] = values["lido-sync-limit"] as readonly [bigint, bigint];
  const [batchIterator, batches, demandAssets, pendingShares] =
    values["lido-queue-state"] as readonly [bigint, bigint, bigint, bigint];
  const feeD6 = BigInt(values["lido-fee"] as number);
  const feeBps = fixedPointFeeBpsCeil(feeD6, 1_000_000n, coinId);
  if (penaltyD6 > 500_000n || maxAge <= 0 || batchIterator > batches) {
    fail(coinId, "invalid queue parameters");
  }
  const holderGateOpen = !flags.hasBurnPause && !(feeD6 > 0n && flags.hasMintPause) &&
    flags.globalLockup <= blockTimestamp;
  const asyncOpen = holderGateOpen && values["lido-async-paused"] === false;
  const reportUsable = report.priceD18 > 0n && !report.isSuspicious &&
    report.timestamp <= blockTimestamp && report.timestamp + maxAge >= blockTimestamp;
  const syncLiquid = values["lido-sync-liquid"] as bigint;
  const syncOpen = holderGateOpen && values["lido-sync-paused"] === false &&
    reportUsable && remainingShares > 0n && syncLiquid > 0n;
  // These are terms/status observations only. Async pending shares and funded
  // batches are not capacity for new requests; sync liquidity/limits are not an
  // executed same-notional quote, and both rails share underlying liquidity.
  return {
    capacityRaw: 0n,
    capacitySource: "lido-earnusd-unquantified-queue",
    capacityState: "unquantified",
    outputAssetKeys: ["usdc-circle"],
    settlementBoundUnproven: true,
    underlyingDecimals: 6,
    capacityKind: "live-direct-bounded",
    freshnessKind: "same-run-onchain",
    routeStatusSource: "onchain",
    routeStatus: asyncOpen ? "open" : "paused",
    routeStatusReason: asyncOpen
      ? "Lido earnUSD USDC requests are open; oracle reporting and funded batch processing have no guaranteed completion maximum"
      : "Lido earnUSD USDC requests are blocked by the queue pause, burn/fee-credit mint pause or global holder lockup",
    feeBps,
    holderEligibility: "any-holder",
    blockNumber,
    sourceTimestamp: blockTimestamp,
    sourceUrls: [
      "https://docs.lido.fi/earn/deployment-contracts",
      "https://docs.mellow.finance/lido-earn/earnusd.md",
      ...[vault, queue, sync, fee, oracle, shares].map(
        (identity) => `https://eth.blockscout.com/api/v2/smart-contracts/${identity.implementationAddress}`,
      ),
    ],
    diagnostics: {
      outputAssetAddress: assetAddress, vaultAddress: vault.address,
      asyncQueueAddress: queue.address, syncQueueAddress: sync.address,
      batchIterator: batchIterator.toString(), batches: batches.toString(),
      demandAssetsRaw: demandAssets.toString(), pendingSharesRaw: pendingShares.toString(),
      redeemFeeD6: feeD6.toString(), syncPenaltyD6: penaltyD6.toString(),
      syncMaxPriceAgeSec: maxAge, syncUsageSharesRaw: usage.toString(),
      syncRemainingSharesRaw: remainingShares.toString(), syncLiquidAssetsRaw: syncLiquid.toString(),
      reportPriceD18: report.priceD18.toString(), reportTimestamp: report.timestamp,
      reportSuspicious: report.isSuspicious, syncReportUsable: reportUsable, syncOpen,
      asyncQueuePaused: values["lido-async-paused"], syncQueuePaused: values["lido-sync-paused"],
      burnPaused: flags.hasBurnPause, feeCreditMintPaused: flags.hasMintPause,
      globalLockupTimestamp: flags.globalLockup,
      capacityQuantified: false, settlementMaximumKnown: false,
      holderBlacklistApplies: true,
    },
  };
}
