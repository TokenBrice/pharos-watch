import type {
  EvmMulticall3Call,
  EvmMulticall3Result,
  EvmRpcOptions,
} from "../../lib/evm-rpc";
import {
  fetchEvmBlockNumber,
  fetchEvmBlockTimestamp,
  fetchEvmCodeAtBlock,
  fetchEvmMulticall3Aggregate3AtBlock,
  fetchEvmStorageAtBlock,
} from "../../lib/evm-rpc";
import {
  decodeFunctionResult,
  encodeFunctionData,
  keccak256,
  parseAbi,
} from "viem/utils";
import type { AdapterContext } from "./types";
import { runAdapterIo } from "./concurrency";
import { normalizeEvmAddress } from "./evm";
import {
  EIP1967_IMPLEMENTATION_SLOT,
  implementationAddressFromSlot,
  multicallResultByLabel,
} from "./onchain-identity";
import { throwIfAborted } from "../../lib/abort";

type Hex = `0x${string}`;

const CHAIN = "ethereum";
const RPC_DEADLINE_MS = 10_000;
const BLOCK_MAX_AGE_SEC = 10 * 60;
const BLOCK_FUTURE_SKEW_SEC = 60;
const OBSERVATION_BLOCK_LAG = 2;

const ERC20_ABI = parseAbi([
  "function balanceOf(address account) view returns (uint256)",
  "function decimals() view returns (uint8)",
]);
const ERC4626_ABI = parseAbi([
  "function asset() view returns (address)",
  "function totalAssets() view returns (uint256)",
]);
const EARN_VAULT_ABI = parseAbi([
  "function vaultValidator() view returns (address)",
  "function protocolConfig() view returns (address)",
  "function pauseStatus() view returns (bool depositsPaused, bool withdrawalsPaused, bool privilegedOperationsPaused)",
  "function getPendingWithdrawalsLength() view returns (uint256)",
  "function minWithdrawableShares() view returns (uint256)",
]);
const EARN_VALIDATOR_ABI = parseAbi([
  "function withdrawalFee(address vault) view returns (uint256 permanentFeePercentage, uint256 timeBasedFeePercentage, uint256 balanceThreshold)",
  "function depositAllowListCount(address vault) view returns (uint256)",
]);
const EARN_PROTOCOL_CONFIG_ABI = parseAbi([
  "function getProtocolPauseStatus() view returns (bool)",
]);
const DSTAKE_TOKEN_ABI = parseAbi([
  "function router() view returns (address)",
  "function collateralVault() view returns (address)",
]);
const DSTAKE_ROUTER_ABI = parseAbi([
  "function dStakeToken() view returns (address)",
  "function collateralVault() view returns (address)",
  "function paused() view returns (bool)",
  "function withdrawalFeeBps() view returns (uint256)",
  "function maxWithdrawalFeeBps() view returns (uint256)",
  "function currentShortfall() view returns (uint256)",
  "function getActiveVaultsForWithdrawals() view returns (address[])",
  "function strategyShareToAdapter(address strategyShare) view returns (address)",
  "function isVaultHealthyForWithdrawals(address strategyShare) view returns (bool)",
]);
const STRATEGY_VAULT_ABI = parseAbi([
  "function asset() view returns (address)",
  "function maxWithdraw(address owner) view returns (uint256)",
]);
const STATIC_ATOKEN_ABI = parseAbi([
  "function POOL() view returns (address)",
  "function aToken() view returns (address)",
]);

interface ProxyIdentity {
  address: Hex;
  codeHash: Hex;
  implementationAddress: Hex;
  implementationCodeHash: Hex;
}

interface DirectIdentity {
  address: Hex;
  codeHash: Hex;
}

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

const DSTAKE = {
  coinId: "sdusd-dtrinity",
  token: {
    address: "0x7cb20517776636ed76b68edb3d99dcce356abf02",
    codeHash: "0xe5e3693157141608a301682c8c228c0277eac7efc0b98b57f874ca49752b5fd8",
    implementationAddress: "0x9c278036c3c4529472751502dfc71bb1f0a3bfd4",
    implementationCodeHash: "0xf3d6aec9f278be5b2140dcca59bfd109bd57bdf4d928e11d2a7b3863bb1b796d",
  } satisfies ProxyIdentity,
  router: {
    address: "0xdd26c236ec95d03ddf3cb67b7f54864719e9be5a",
    codeHash: "0x08f865940e3532d14604ba5fdc7560fd35c59dde586a5e5322ae4312be5a9d03",
  } satisfies DirectIdentity,
  collateralVault: {
    address: "0x4acbcfa29fb085097c5f31783403ef7a7930f6fe",
    codeHash: "0x9bef4196d31f6ccf89b74f147be85e8a24c19085d59776a48301d3cb06e1def9",
  } satisfies DirectIdentity,
  idleStrategy: {
    address: "0x78a4dad0ac32c80da6ef60a366b1c035145380bc",
    codeHash: "0x1dc234de62c077e81b3af54e4c4c6feeef6922213147e4c0b865be07f63f57a8",
  } satisfies DirectIdentity,
  idleAdapter: {
    address: "0xefd794e2d8024f3c25aa343588dd6d4481b5db7c",
    codeHash: "0x0620eb4be11008952dd737925d15743ec443bed53cf163e5f8244d9e80fe999b",
  } satisfies DirectIdentity,
  dlendStrategy: {
    address: "0x576dd487bacfa6e7afd1e3ea03da0763f732d4c9",
    codeHash: "0xe448349ec1a422118e4244e737f124d1f5e65ccf696a8eecfe48fc8008e082e2",
  } satisfies DirectIdentity,
  dlendAdapter: {
    address: "0x1a5bb485c58a86c193b823d0ea031b68813e100f",
    codeHash: "0x958bacf03625c8460aa5b3f30ba4fb4610b47a6c8580e257c2e108c53a1787c4",
  } satisfies DirectIdentity,
  assetAddress: "0x07fff99e1664d9b116fbc158c0e99785f81ca236",
  assetDecimals: 18,
  dlendPoolAddress: "0x6598dad18bda89a0e58a1f427c8cebc0de90f153",
  dlendATokenAddress: "0x5cc741931d01cb1adde193222dfb1ad75930fd60",
  sourceUrls: [
    "https://docs.dtrinity.org/protocol-components/sdusd",
    "https://docs.dtrinity.org/security/addresses",
    "https://github.com/dtrinity/ethereum-solidity-contracts/blob/d3103f8807a0abb23277b79dc136d002b57a6687/contracts/vaults/dstake/DStakeRouterV2.sol",
  ],
} as const;

export interface ExecutableRedemptionReadClient {
  blockNumber(options: EvmRpcOptions): Promise<number | null>;
  blockTimestamp(blockNumber: number, options: EvmRpcOptions): Promise<number | null>;
  codeHash(address: string, blockNumber: number, options: EvmRpcOptions): Promise<string | null>;
  storage(
    address: string,
    position: string,
    blockNumber: number,
    options: EvmRpcOptions,
  ): Promise<Hex | null>;
  multicall(
    calls: readonly EvmMulticall3Call[],
    blockNumber: number,
    options: EvmRpcOptions,
  ): Promise<EvmMulticall3Result[] | null>;
}

export interface ExecutableRedemptionObservation {
  capacityRaw: bigint;
  capacitySource:
    | "eearn-operator-batched-no-immediate-capacity"
    | "dtrinity-dlend-max-withdraw";
  settlementBoundUnproven?: true;
  underlyingDecimals: number;
  capacityKind: "live-direct-bounded";
  freshnessKind: "same-run-onchain";
  routeStatusSource: "onchain";
  routeStatus: "open" | "paused" | "degraded";
  routeStatusReason: string;
  feeBps: number;
  holderEligibility: "any-holder";
  blockNumber: number;
  sourceTimestamp: number;
  sourceUrls: string[];
  diagnostics: Record<string, unknown>;
}

interface ObserverOptions {
  client?: ExecutableRedemptionReadClient;
  nowSec?: number;
  extraRpcUrls?: string[];
}

export function getStableObservationBlockNumber(
  latestBlockNumber: number | null,
): number | null {
  if (
    latestBlockNumber == null ||
    !Number.isSafeInteger(latestBlockNumber) ||
    latestBlockNumber <= OBSERVATION_BLOCK_LAG
  ) {
    return null;
  }
  return latestBlockNumber - OBSERVATION_BLOCK_LAG;
}

const DEFAULT_CLIENT: ExecutableRedemptionReadClient = {
  blockNumber: async (options) =>
    getStableObservationBlockNumber(await fetchEvmBlockNumber(CHAIN, options)),
  blockTimestamp: (blockNumber, options) =>
    fetchEvmBlockTimestamp(CHAIN, blockNumber, options),
  codeHash: async (address, blockNumber, options) => {
    const code = await fetchEvmCodeAtBlock(CHAIN, address, blockNumber, options);
    return code ? keccak256(code).toLowerCase() : null;
  },
  storage: (address, position, blockNumber, options) =>
    fetchEvmStorageAtBlock(CHAIN, address, position, blockNumber, options),
  multicall: (calls, blockNumber, options) =>
    fetchEvmMulticall3Aggregate3AtBlock(CHAIN, calls, blockNumber, options),
};

function fail(coinId: string, reason: string): never {
  throw new Error(`${coinId} executable redemption observer failed closed: ${reason}`);
}

function resultData(
  coinId: string,
  results: readonly EvmMulticall3Result[],
  label: string,
): Hex {
  const data = multicallResultByLabel(results, label);
  if (!data) {
    fail(coinId, `${label} unavailable`);
  }
  return data;
}

function normalizedAddress(coinId: string, value: unknown, label: string): string {
  const normalized = normalizeEvmAddress(typeof value === "string" ? value : undefined);
  if (!normalized) fail(coinId, `${label} returned an invalid address`);
  return normalized;
}

function sameAddressSet(actual: readonly string[], expected: readonly string[]): boolean {
  if (actual.length !== expected.length) return false;
  const normalizedActual = actual
    .map((address) => normalizeEvmAddress(address))
    .filter((address): address is `0x${string}` => address != null)
    .sort();
  const normalizedExpected = [...expected].map((address) => address.toLowerCase()).sort();
  return (
    normalizedActual.length === normalizedExpected.length &&
    normalizedActual.every((address, index) => address === normalizedExpected[index])
  );
}

function fixedPointFeeBpsCeil(rawFee: bigint, scale: bigint, coinId: string): number {
  if (rawFee < 0n || rawFee > scale) fail(coinId, "fee is outside the supported 0-100% range");
  const bps = (rawFee * 10_000n + scale - 1n) / scale;
  if (bps > 10_000n) fail(coinId, "fee bps exceeds 100%");
  return Number(bps);
}

async function verifyDirectIdentity(
  coinId: string,
  identity: DirectIdentity,
  blockNumber: number,
  rpcOptions: EvmRpcOptions,
  client: ExecutableRedemptionReadClient,
  ctx: AdapterContext | undefined,
  signal: AbortSignal,
): Promise<void> {
  const codeHash = await runAdapterIo(
    ctx,
    `${coinId}-redemption-code-${identity.address}`,
    () => client.codeHash(identity.address, blockNumber, rpcOptions),
    { signal },
  );
  if (codeHash?.toLowerCase() !== identity.codeHash) {
    fail(coinId, `code identity drift at ${identity.address}`);
  }
}

async function verifyProxyIdentity(
  coinId: string,
  identity: ProxyIdentity,
  blockNumber: number,
  rpcOptions: EvmRpcOptions,
  client: ExecutableRedemptionReadClient,
  ctx: AdapterContext | undefined,
  signal: AbortSignal,
): Promise<void> {
  await verifyDirectIdentity(coinId, identity, blockNumber, rpcOptions, client, ctx, signal);
  const implementationWord = await runAdapterIo(
    ctx,
    `${coinId}-redemption-implementation-${identity.address}`,
    () =>
      client.storage(
        identity.address,
        EIP1967_IMPLEMENTATION_SLOT,
        blockNumber,
        rpcOptions,
      ),
    { signal },
  );
  if (implementationAddressFromSlot(implementationWord) !== identity.implementationAddress) {
    fail(coinId, `implementation identity drift at ${identity.address}`);
  }
  await verifyDirectIdentity(
    coinId,
    {
      address: identity.implementationAddress,
      codeHash: identity.implementationCodeHash,
    },
    blockNumber,
    rpcOptions,
    client,
    ctx,
    signal,
  );
}

function earnCalls(): EvmMulticall3Call[] {
  return [
    {
      label: "earn-asset",
      target: EARN.vault.address,
      callData: encodeFunctionData({ abi: ERC4626_ABI, functionName: "asset" }),
      allowFailure: false,
    },
    {
      label: "earn-total-assets",
      target: EARN.vault.address,
      callData: encodeFunctionData({ abi: ERC4626_ABI, functionName: "totalAssets" }),
      allowFailure: false,
    },
    {
      label: "earn-validator",
      target: EARN.vault.address,
      callData: encodeFunctionData({ abi: EARN_VAULT_ABI, functionName: "vaultValidator" }),
      allowFailure: false,
    },
    {
      label: "earn-protocol-config",
      target: EARN.vault.address,
      callData: encodeFunctionData({ abi: EARN_VAULT_ABI, functionName: "protocolConfig" }),
      allowFailure: false,
    },
    {
      label: "earn-pause-status",
      target: EARN.vault.address,
      callData: encodeFunctionData({ abi: EARN_VAULT_ABI, functionName: "pauseStatus" }),
      allowFailure: false,
    },
    {
      label: "earn-pending-withdrawals",
      target: EARN.vault.address,
      callData: encodeFunctionData({
        abi: EARN_VAULT_ABI,
        functionName: "getPendingWithdrawalsLength",
      }),
      allowFailure: false,
    },
    {
      label: "earn-min-withdrawable-shares",
      target: EARN.vault.address,
      callData: encodeFunctionData({
        abi: EARN_VAULT_ABI,
        functionName: "minWithdrawableShares",
      }),
      allowFailure: false,
    },
    {
      label: "earn-withdrawal-fee",
      target: EARN.validator.address,
      callData: encodeFunctionData({
        abi: EARN_VALIDATOR_ABI,
        functionName: "withdrawalFee",
        args: [EARN.vault.address],
      }),
      allowFailure: false,
    },
    {
      label: "earn-deposit-allow-list-count",
      target: EARN.validator.address,
      callData: encodeFunctionData({
        abi: EARN_VALIDATOR_ABI,
        functionName: "depositAllowListCount",
        args: [EARN.vault.address],
      }),
      allowFailure: false,
    },
    {
      label: "earn-protocol-paused",
      target: EARN.protocolConfig.address,
      callData: encodeFunctionData({
        abi: EARN_PROTOCOL_CONFIG_ABI,
        functionName: "getProtocolPauseStatus",
      }),
      allowFailure: false,
    },
    {
      label: "earn-idle-usdc",
      target: EARN.assetAddress,
      callData: encodeFunctionData({
        abi: ERC20_ABI,
        functionName: "balanceOf",
        args: [EARN.vault.address],
      }),
      allowFailure: false,
    },
    {
      label: "earn-asset-decimals",
      target: EARN.assetAddress,
      callData: encodeFunctionData({ abi: ERC20_ABI, functionName: "decimals" }),
      allowFailure: false,
    },
  ];
}

async function observeEarn(
  blockNumber: number,
  blockTimestamp: number,
  rpcOptions: EvmRpcOptions,
  client: ExecutableRedemptionReadClient,
  ctx: AdapterContext | undefined,
  signal: AbortSignal,
): Promise<ExecutableRedemptionObservation> {
  await verifyProxyIdentity(
    EARN.coinId,
    EARN.vault,
    blockNumber,
    rpcOptions,
    client,
    ctx,
    signal,
  );
  await verifyProxyIdentity(
    EARN.coinId,
    EARN.validator,
    blockNumber,
    rpcOptions,
    client,
    ctx,
    signal,
  );
  await verifyProxyIdentity(
    EARN.coinId,
    EARN.protocolConfig,
    blockNumber,
    rpcOptions,
    client,
    ctx,
    signal,
  );

  const results = await runAdapterIo(
    ctx,
    "eearn-redemption-state",
    () => client.multicall(earnCalls(), blockNumber, rpcOptions),
    { signal },
  );
  if (!results) fail(EARN.coinId, "route state unavailable");

  const assetAddress = normalizedAddress(
    EARN.coinId,
    decodeFunctionResult({
      abi: ERC4626_ABI,
      functionName: "asset",
      data: resultData(EARN.coinId, results, "earn-asset"),
    }),
    "asset",
  );
  const validatorAddress = normalizedAddress(
    EARN.coinId,
    decodeFunctionResult({
      abi: EARN_VAULT_ABI,
      functionName: "vaultValidator",
      data: resultData(EARN.coinId, results, "earn-validator"),
    }),
    "vaultValidator",
  );
  const protocolConfigAddress = normalizedAddress(
    EARN.coinId,
    decodeFunctionResult({
      abi: EARN_VAULT_ABI,
      functionName: "protocolConfig",
      data: resultData(EARN.coinId, results, "earn-protocol-config"),
    }),
    "protocolConfig",
  );
  if (
    assetAddress !== EARN.assetAddress ||
    validatorAddress !== EARN.validator.address ||
    protocolConfigAddress !== EARN.protocolConfig.address
  ) {
    fail(EARN.coinId, "live route dependency identity drift");
  }

  const pauseStatus = decodeFunctionResult({
    abi: EARN_VAULT_ABI,
    functionName: "pauseStatus",
    data: resultData(EARN.coinId, results, "earn-pause-status"),
  }) as readonly [boolean, boolean, boolean];
  const protocolPaused = decodeFunctionResult({
    abi: EARN_PROTOCOL_CONFIG_ABI,
    functionName: "getProtocolPauseStatus",
    data: resultData(EARN.coinId, results, "earn-protocol-paused"),
  });
  const feeParts = decodeFunctionResult({
    abi: EARN_VALIDATOR_ABI,
    functionName: "withdrawalFee",
    data: resultData(EARN.coinId, results, "earn-withdrawal-fee"),
  }) as readonly [bigint, bigint, bigint];
  const totalFeeRaw = feeParts[0] + feeParts[1];
  const feeBps = fixedPointFeeBpsCeil(totalFeeRaw, 10n ** 18n, EARN.coinId);
  const assetDecimals = decodeFunctionResult({
    abi: ERC20_ABI,
    functionName: "decimals",
    data: resultData(EARN.coinId, results, "earn-asset-decimals"),
  });
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
      pendingWithdrawals: (
        decodeFunctionResult({
          abi: EARN_VAULT_ABI,
          functionName: "getPendingWithdrawalsLength",
          data: resultData(EARN.coinId, results, "earn-pending-withdrawals"),
        }) as bigint
      ).toString(),
      minWithdrawableSharesRaw: (
        decodeFunctionResult({
          abi: EARN_VAULT_ABI,
          functionName: "minWithdrawableShares",
          data: resultData(EARN.coinId, results, "earn-min-withdrawable-shares"),
        }) as bigint
      ).toString(),
      depositAllowListCount: (
        decodeFunctionResult({
          abi: EARN_VALIDATOR_ABI,
          functionName: "depositAllowListCount",
          data: resultData(EARN.coinId, results, "earn-deposit-allow-list-count"),
        }) as bigint
      ).toString(),
      totalAssetsRaw: (
        decodeFunctionResult({
          abi: ERC4626_ABI,
          functionName: "totalAssets",
          data: resultData(EARN.coinId, results, "earn-total-assets"),
        }) as bigint
      ).toString(),
      idleUnderlyingBalanceRaw: (
        decodeFunctionResult({
          abi: ERC20_ABI,
          functionName: "balanceOf",
          data: resultData(EARN.coinId, results, "earn-idle-usdc"),
        }) as bigint
      ).toString(),
      idleUnderlyingUsedAsCapacity: false,
    },
  };
}

function dStakeCalls(): EvmMulticall3Call[] {
  return [
    {
      label: "dstake-asset",
      target: DSTAKE.token.address,
      callData: encodeFunctionData({ abi: ERC4626_ABI, functionName: "asset" }),
      allowFailure: false,
    },
    {
      label: "dstake-total-assets",
      target: DSTAKE.token.address,
      callData: encodeFunctionData({ abi: ERC4626_ABI, functionName: "totalAssets" }),
      allowFailure: false,
    },
    {
      label: "dstake-router",
      target: DSTAKE.token.address,
      callData: encodeFunctionData({ abi: DSTAKE_TOKEN_ABI, functionName: "router" }),
      allowFailure: false,
    },
    {
      label: "dstake-collateral-vault",
      target: DSTAKE.token.address,
      callData: encodeFunctionData({
        abi: DSTAKE_TOKEN_ABI,
        functionName: "collateralVault",
      }),
      allowFailure: false,
    },
    {
      label: "router-token",
      target: DSTAKE.router.address,
      callData: encodeFunctionData({ abi: DSTAKE_ROUTER_ABI, functionName: "dStakeToken" }),
      allowFailure: false,
    },
    {
      label: "router-collateral-vault",
      target: DSTAKE.router.address,
      callData: encodeFunctionData({
        abi: DSTAKE_ROUTER_ABI,
        functionName: "collateralVault",
      }),
      allowFailure: false,
    },
    {
      label: "router-paused",
      target: DSTAKE.router.address,
      callData: encodeFunctionData({ abi: DSTAKE_ROUTER_ABI, functionName: "paused" }),
      allowFailure: false,
    },
    {
      label: "router-withdrawal-fee",
      target: DSTAKE.router.address,
      callData: encodeFunctionData({
        abi: DSTAKE_ROUTER_ABI,
        functionName: "withdrawalFeeBps",
      }),
      allowFailure: false,
    },
    {
      label: "router-max-withdrawal-fee",
      target: DSTAKE.router.address,
      callData: encodeFunctionData({
        abi: DSTAKE_ROUTER_ABI,
        functionName: "maxWithdrawalFeeBps",
      }),
      allowFailure: false,
    },
    {
      label: "router-shortfall",
      target: DSTAKE.router.address,
      callData: encodeFunctionData({
        abi: DSTAKE_ROUTER_ABI,
        functionName: "currentShortfall",
      }),
      allowFailure: false,
    },
    {
      label: "router-active-withdrawal-vaults",
      target: DSTAKE.router.address,
      callData: encodeFunctionData({
        abi: DSTAKE_ROUTER_ABI,
        functionName: "getActiveVaultsForWithdrawals",
      }),
      allowFailure: false,
    },
    ...([
      ["idle", DSTAKE.idleStrategy.address],
      ["dlend", DSTAKE.dlendStrategy.address],
    ] as const).flatMap(([label, strategyAddress]) => [
      {
        label: `${label}-strategy-asset`,
        target: strategyAddress,
        callData: encodeFunctionData({ abi: STRATEGY_VAULT_ABI, functionName: "asset" }),
        allowFailure: false,
      },
      {
        label: `${label}-strategy-max-withdraw`,
        target: strategyAddress,
        callData: encodeFunctionData({
          abi: STRATEGY_VAULT_ABI,
          functionName: "maxWithdraw",
          args: [DSTAKE.collateralVault.address],
        }),
        allowFailure: false,
      },
      {
        label: `${label}-strategy-adapter`,
        target: DSTAKE.router.address,
        callData: encodeFunctionData({
          abi: DSTAKE_ROUTER_ABI,
          functionName: "strategyShareToAdapter",
          args: [strategyAddress],
        }),
        allowFailure: false,
      },
      {
        label: `${label}-strategy-healthy`,
        target: DSTAKE.router.address,
        callData: encodeFunctionData({
          abi: DSTAKE_ROUTER_ABI,
          functionName: "isVaultHealthyForWithdrawals",
          args: [strategyAddress],
        }),
        allowFailure: false,
      },
    ]),
    {
      label: "dlend-pool",
      target: DSTAKE.dlendStrategy.address,
      callData: encodeFunctionData({ abi: STATIC_ATOKEN_ABI, functionName: "POOL" }),
      allowFailure: false,
    },
    {
      label: "dlend-atoken",
      target: DSTAKE.dlendStrategy.address,
      callData: encodeFunctionData({ abi: STATIC_ATOKEN_ABI, functionName: "aToken" }),
      allowFailure: false,
    },
    {
      label: "dlend-available-liquidity",
      target: DSTAKE.assetAddress,
      callData: encodeFunctionData({
        abi: ERC20_ABI,
        functionName: "balanceOf",
        args: [DSTAKE.dlendATokenAddress],
      }),
      allowFailure: false,
    },
    {
      label: "dstake-asset-decimals",
      target: DSTAKE.assetAddress,
      callData: encodeFunctionData({ abi: ERC20_ABI, functionName: "decimals" }),
      allowFailure: false,
    },
  ];
}

async function observeDStake(
  blockNumber: number,
  blockTimestamp: number,
  rpcOptions: EvmRpcOptions,
  client: ExecutableRedemptionReadClient,
  ctx: AdapterContext | undefined,
  signal: AbortSignal,
): Promise<ExecutableRedemptionObservation> {
  await verifyProxyIdentity(
    DSTAKE.coinId,
    DSTAKE.token,
    blockNumber,
    rpcOptions,
    client,
    ctx,
    signal,
  );
  for (const identity of [
    DSTAKE.router,
    DSTAKE.collateralVault,
    DSTAKE.idleStrategy,
    DSTAKE.idleAdapter,
    DSTAKE.dlendStrategy,
    DSTAKE.dlendAdapter,
  ]) {
    throwIfAborted(signal);
    await verifyDirectIdentity(
      DSTAKE.coinId,
      identity,
      blockNumber,
      rpcOptions,
      client,
      ctx,
      signal,
    );
  }

  const results = await runAdapterIo(
    ctx,
    "sdusd-dtrinity-redemption-state",
    () => client.multicall(dStakeCalls(), blockNumber, rpcOptions),
    { signal },
  );
  if (!results) fail(DSTAKE.coinId, "route state unavailable");

  const addresses = {
    asset: normalizedAddress(
      DSTAKE.coinId,
      decodeFunctionResult({
        abi: ERC4626_ABI,
        functionName: "asset",
        data: resultData(DSTAKE.coinId, results, "dstake-asset"),
      }),
      "asset",
    ),
    tokenRouter: normalizedAddress(
      DSTAKE.coinId,
      decodeFunctionResult({
        abi: DSTAKE_TOKEN_ABI,
        functionName: "router",
        data: resultData(DSTAKE.coinId, results, "dstake-router"),
      }),
      "token router",
    ),
    tokenCollateralVault: normalizedAddress(
      DSTAKE.coinId,
      decodeFunctionResult({
        abi: DSTAKE_TOKEN_ABI,
        functionName: "collateralVault",
        data: resultData(DSTAKE.coinId, results, "dstake-collateral-vault"),
      }),
      "token collateral vault",
    ),
    routerToken: normalizedAddress(
      DSTAKE.coinId,
      decodeFunctionResult({
        abi: DSTAKE_ROUTER_ABI,
        functionName: "dStakeToken",
        data: resultData(DSTAKE.coinId, results, "router-token"),
      }),
      "router dStakeToken",
    ),
    routerCollateralVault: normalizedAddress(
      DSTAKE.coinId,
      decodeFunctionResult({
        abi: DSTAKE_ROUTER_ABI,
        functionName: "collateralVault",
        data: resultData(DSTAKE.coinId, results, "router-collateral-vault"),
      }),
      "router collateral vault",
    ),
    idleAsset: normalizedAddress(
      DSTAKE.coinId,
      decodeFunctionResult({
        abi: STRATEGY_VAULT_ABI,
        functionName: "asset",
        data: resultData(DSTAKE.coinId, results, "idle-strategy-asset"),
      }),
      "idle strategy asset",
    ),
    dlendAsset: normalizedAddress(
      DSTAKE.coinId,
      decodeFunctionResult({
        abi: STRATEGY_VAULT_ABI,
        functionName: "asset",
        data: resultData(DSTAKE.coinId, results, "dlend-strategy-asset"),
      }),
      "dLEND strategy asset",
    ),
    idleAdapter: normalizedAddress(
      DSTAKE.coinId,
      decodeFunctionResult({
        abi: DSTAKE_ROUTER_ABI,
        functionName: "strategyShareToAdapter",
        data: resultData(DSTAKE.coinId, results, "idle-strategy-adapter"),
      }),
      "idle strategy adapter",
    ),
    dlendAdapter: normalizedAddress(
      DSTAKE.coinId,
      decodeFunctionResult({
        abi: DSTAKE_ROUTER_ABI,
        functionName: "strategyShareToAdapter",
        data: resultData(DSTAKE.coinId, results, "dlend-strategy-adapter"),
      }),
      "dLEND strategy adapter",
    ),
    dlendPool: normalizedAddress(
      DSTAKE.coinId,
      decodeFunctionResult({
        abi: STATIC_ATOKEN_ABI,
        functionName: "POOL",
        data: resultData(DSTAKE.coinId, results, "dlend-pool"),
      }),
      "dLEND pool",
    ),
    dlendAToken: normalizedAddress(
      DSTAKE.coinId,
      decodeFunctionResult({
        abi: STATIC_ATOKEN_ABI,
        functionName: "aToken",
        data: resultData(DSTAKE.coinId, results, "dlend-atoken"),
      }),
      "dLEND aToken",
    ),
  };
  if (
    addresses.asset !== DSTAKE.assetAddress ||
    addresses.tokenRouter !== DSTAKE.router.address ||
    addresses.tokenCollateralVault !== DSTAKE.collateralVault.address ||
    addresses.routerToken !== DSTAKE.token.address ||
    addresses.routerCollateralVault !== DSTAKE.collateralVault.address ||
    addresses.idleAsset !== DSTAKE.assetAddress ||
    addresses.dlendAsset !== DSTAKE.assetAddress ||
    addresses.idleAdapter !== DSTAKE.idleAdapter.address ||
    addresses.dlendAdapter !== DSTAKE.dlendAdapter.address ||
    addresses.dlendPool !== DSTAKE.dlendPoolAddress ||
    addresses.dlendAToken !== DSTAKE.dlendATokenAddress
  ) {
    fail(DSTAKE.coinId, "live route dependency identity drift");
  }

  const activeWithdrawalVaults = decodeFunctionResult({
    abi: DSTAKE_ROUTER_ABI,
    functionName: "getActiveVaultsForWithdrawals",
    data: resultData(DSTAKE.coinId, results, "router-active-withdrawal-vaults"),
  }) as readonly string[];
  if (
    !sameAddressSet(activeWithdrawalVaults, [
      DSTAKE.idleStrategy.address,
      DSTAKE.dlendStrategy.address,
    ])
  ) {
    fail(DSTAKE.coinId, "active withdrawal strategy set drift");
  }

  const idleMaxWithdrawRaw = decodeFunctionResult({
    abi: STRATEGY_VAULT_ABI,
    functionName: "maxWithdraw",
    data: resultData(DSTAKE.coinId, results, "idle-strategy-max-withdraw"),
  }) as bigint;
  const dlendMaxWithdrawRaw = decodeFunctionResult({
    abi: STRATEGY_VAULT_ABI,
    functionName: "maxWithdraw",
    data: resultData(DSTAKE.coinId, results, "dlend-strategy-max-withdraw"),
  }) as bigint;
  const dlendAvailableLiquidityRaw = decodeFunctionResult({
    abi: ERC20_ABI,
    functionName: "balanceOf",
    data: resultData(DSTAKE.coinId, results, "dlend-available-liquidity"),
  }) as bigint;
  const totalAssetsRaw = decodeFunctionResult({
    abi: ERC4626_ABI,
    functionName: "totalAssets",
    data: resultData(DSTAKE.coinId, results, "dstake-total-assets"),
  }) as bigint;
  if (
    idleMaxWithdrawRaw < 0n ||
    dlendMaxWithdrawRaw < 0n ||
    dlendAvailableLiquidityRaw < 0n ||
    totalAssetsRaw <= 0n ||
    dlendMaxWithdrawRaw > dlendAvailableLiquidityRaw
  ) {
    fail(DSTAKE.coinId, "invalid dLEND available-liquidity/max-withdraw bound");
  }

  const currentFeeRaw = decodeFunctionResult({
    abi: DSTAKE_ROUTER_ABI,
    functionName: "withdrawalFeeBps",
    data: resultData(DSTAKE.coinId, results, "router-withdrawal-fee"),
  }) as bigint;
  const maxFeeRaw = decodeFunctionResult({
    abi: DSTAKE_ROUTER_ABI,
    functionName: "maxWithdrawalFeeBps",
    data: resultData(DSTAKE.coinId, results, "router-max-withdrawal-fee"),
  }) as bigint;
  if (currentFeeRaw < 0n || maxFeeRaw < 0n || currentFeeRaw > maxFeeRaw || maxFeeRaw > 1_000_000n) {
    fail(DSTAKE.coinId, "invalid withdrawal fee state");
  }
  const feeBps = fixedPointFeeBpsCeil(currentFeeRaw, 1_000_000n, DSTAKE.coinId);
  const paused = decodeFunctionResult({
    abi: DSTAKE_ROUTER_ABI,
    functionName: "paused",
    data: resultData(DSTAKE.coinId, results, "router-paused"),
  });
  const shortfallRaw = decodeFunctionResult({
    abi: DSTAKE_ROUTER_ABI,
    functionName: "currentShortfall",
    data: resultData(DSTAKE.coinId, results, "router-shortfall"),
  }) as bigint;
  const idleHealthy = decodeFunctionResult({
    abi: DSTAKE_ROUTER_ABI,
    functionName: "isVaultHealthyForWithdrawals",
    data: resultData(DSTAKE.coinId, results, "idle-strategy-healthy"),
  });
  const dlendHealthy = decodeFunctionResult({
    abi: DSTAKE_ROUTER_ABI,
    functionName: "isVaultHealthyForWithdrawals",
    data: resultData(DSTAKE.coinId, results, "dlend-strategy-healthy"),
  });
  const assetDecimals = decodeFunctionResult({
    abi: ERC20_ABI,
    functionName: "decimals",
    data: resultData(DSTAKE.coinId, results, "dstake-asset-decimals"),
  });
  if (assetDecimals !== DSTAKE.assetDecimals || shortfallRaw < 0n) {
    fail(DSTAKE.coinId, "invalid dSTAKE asset or shortfall state");
  }

  const rawBound =
    idleMaxWithdrawRaw > dlendMaxWithdrawRaw
      ? idleMaxWithdrawRaw
      : dlendMaxWithdrawRaw;
  const cappedBound = rawBound > totalAssetsRaw ? totalAssetsRaw : rawBound;
  const routeOpen =
    paused === false &&
    shortfallRaw === 0n &&
    idleHealthy === true &&
    dlendHealthy === true &&
    cappedBound > 0n;
  return {
    capacityRaw: routeOpen ? cappedBound : 0n,
    capacitySource: "dtrinity-dlend-max-withdraw",
    underlyingDecimals: DSTAKE.assetDecimals,
    capacityKind: "live-direct-bounded",
    freshnessKind: "same-run-onchain",
    routeStatusSource: "onchain",
    routeStatus: routeOpen
      ? "open"
      : paused === true
        ? "paused"
        : "degraded",
    routeStatusReason: routeOpen
      ? "dTRINITY sdUSD withdrawals are unpaused with zero shortfall and bounded by the live dLEND strategy maxWithdraw"
      : "dTRINITY sdUSD withdrawal state is paused, unhealthy, short, or has zero executable liquidity",
    feeBps,
    holderEligibility: "any-holder",
    blockNumber,
    sourceTimestamp: blockTimestamp,
    sourceUrls: [...DSTAKE.sourceUrls],
    diagnostics: {
      outputAssetAddress: DSTAKE.assetAddress,
      tokenAddress: DSTAKE.token.address,
      tokenImplementationAddress: DSTAKE.token.implementationAddress,
      routerAddress: DSTAKE.router.address,
      collateralVaultAddress: DSTAKE.collateralVault.address,
      activeWithdrawalVaults: activeWithdrawalVaults.map((address) => address.toLowerCase()),
      idleStrategyAddress: DSTAKE.idleStrategy.address,
      idleStrategyMaxWithdrawRaw: idleMaxWithdrawRaw.toString(),
      idleStrategyHealthy: idleHealthy,
      dlendStrategyAddress: DSTAKE.dlendStrategy.address,
      dlendStrategyMaxWithdrawRaw: dlendMaxWithdrawRaw.toString(),
      dlendStrategyHealthy: dlendHealthy,
      dlendAvailableLiquidityRaw: dlendAvailableLiquidityRaw.toString(),
      dlendPoolAddress: DSTAKE.dlendPoolAddress,
      dlendATokenAddress: DSTAKE.dlendATokenAddress,
      totalAssetsRaw: totalAssetsRaw.toString(),
      currentWithdrawalFeeRaw: currentFeeRaw.toString(),
      maxWithdrawalFeeRaw: maxFeeRaw.toString(),
      currentShortfallRaw: shortfallRaw.toString(),
      routerPaused: paused,
    },
  };
}

export async function observeExecutableRedemptionRoute(
  coinId: string,
  contractAddress: string,
  signal: AbortSignal,
  ctx?: AdapterContext,
  options: ObserverOptions = {},
): Promise<ExecutableRedemptionObservation | null> {
  if (coinId !== EARN.coinId && coinId !== DSTAKE.coinId) return null;

  const expectedContractAddress =
    coinId === EARN.coinId ? EARN.vault.address : DSTAKE.token.address;
  if (contractAddress.toLowerCase() !== expectedContractAddress) {
    fail(coinId, `tracked contract identity drift (${contractAddress})`);
  }

  const client = options.client ?? DEFAULT_CLIENT;
  // This observer reads a current chain head late in a long sequential reserve
  // run. The run-scoped context clock can be several minutes old by then, so
  // compare the block against the wall clock unless a test explicitly pins it.
  const nowSec = options.nowSec ?? Math.floor(Date.now() / 1_000);
  const rpcOptions: EvmRpcOptions = {
    chainRpcs: ctx?.chainRpcs,
    extraRpcUrls: options.extraRpcUrls,
    signal,
    timeoutMs: 3_000,
    deadlineMs: Date.now() + RPC_DEADLINE_MS,
    maxRetries: 0,
  };
  const blockNumber = await runAdapterIo(
    ctx,
    `${coinId}-redemption-block-number`,
    () => client.blockNumber(rpcOptions),
    { signal },
  );
  if (blockNumber == null) fail(coinId, "block number unavailable");
  const blockTimestamp = await runAdapterIo(
    ctx,
    `${coinId}-redemption-block-timestamp`,
    () => client.blockTimestamp(blockNumber, rpcOptions),
    { signal },
  );
  if (
    blockTimestamp == null ||
    blockTimestamp < nowSec - BLOCK_MAX_AGE_SEC ||
    blockTimestamp > nowSec + BLOCK_FUTURE_SKEW_SEC
  ) {
    fail(coinId, "block timestamp is unavailable or out of range");
  }

  return coinId === EARN.coinId
    ? observeEarn(blockNumber, blockTimestamp, rpcOptions, client, ctx, signal)
    : observeDStake(blockNumber, blockTimestamp, rpcOptions, client, ctx, signal);
}
