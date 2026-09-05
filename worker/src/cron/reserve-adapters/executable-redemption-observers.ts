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
import { parseAbi } from "viem/utils";
import type { AdapterContext } from "./types";
import { runAdapterIo } from "./concurrency";
import { normalizeEvmAddress } from "./evm";
import {
  abiObservation,
  codeIdentityChecks,
  executeEvmObservationPlan,
} from "./evm-observation-plan";
import type {
  AnyEvmObservationField,
  EvmCodeIdentity,
  EvmObservationSnapshot,
} from "./evm-observation-plan";
import { runtimeCodeHash } from "./onchain-identity";

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

interface ProxyIdentity extends EvmCodeIdentity {
  address: Hex;
  codeHash: Hex;
  implementationAddress: Hex;
  implementationCodeHash: Hex;
}

interface DirectIdentity extends EvmCodeIdentity {
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
  codeHash: async (address, blockNumber, options) =>
    runtimeCodeHash(await fetchEvmCodeAtBlock(CHAIN, address, blockNumber, options)),
  storage: (address, position, blockNumber, options) =>
    fetchEvmStorageAtBlock(CHAIN, address, position, blockNumber, options),
  multicall: (calls, blockNumber, options) =>
    fetchEvmMulticall3Aggregate3AtBlock(CHAIN, calls, blockNumber, options),
};

function fail(coinId: string, reason: string): never {
  throw new Error(`${coinId} executable redemption observer failed closed: ${reason}`);
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

function verifyExpectedAddress(coinId: string, label: string, expected: string) {
  return (value: string): null => {
    const normalized = normalizeEvmAddress(value);
    if (!normalized) fail(coinId, `${label} returned an invalid address`);
    if (normalized !== expected) fail(coinId, "live route dependency identity drift");
    return null;
  };
}

async function readStateWithPlan<Fields extends readonly AnyEvmObservationField[]>(
  coinId: string,
  stateLabel: string,
  fields: Fields,
  identities: readonly EvmCodeIdentity[],
  blockNumber: number,
  rpcOptions: EvmRpcOptions,
  client: ExecutableRedemptionReadClient,
  ctx: AdapterContext | undefined,
  signal: AbortSignal,
): Promise<EvmObservationSnapshot<Fields>> {
  const identityResult = await codeIdentityChecks(client, identities, {
    blockNumber,
    rpcOptions,
    readCode: (readClient, address, readBlock, readOptions) =>
      readClient.codeHash(address, readBlock, readOptions),
    readStorage: (readClient, address, position, readBlock, readOptions) =>
      readClient.storage(address, position, readBlock, readOptions),
    run: (label, factory) => runAdapterIo(ctx, label, factory, { signal }),
    codeLabel: (identity, kind) =>
      `${coinId}-redemption-code-${kind === "implementation" ? identity.implementationAddress : identity.address}`,
    storageLabel: (identity) => `${coinId}-redemption-implementation-${identity.address}`,
  });
  if (identityResult.status === "rejected") {
    fail(
      coinId,
      identityResult.kind === "storage"
        ? `implementation identity drift at ${identityResult.address}`
        : `code identity drift at ${identityResult.address}`,
    );
  }

  return executeEvmObservationPlan({
    adapterKey: coinId,
    fields,
    onFailure: (label) => fail(coinId, `${label} unavailable`),
    onDecodeError: (error) => {
      throw error;
    },
    read: (calls) => runAdapterIo(
      ctx,
      stateLabel,
      async () => {
        const results = await client.multicall(
          calls.map(({ label, contract, data, allowFailure }) => ({
            label,
            target: contract,
            callData: data,
            ...(allowFailure != null ? { allowFailure } : {}),
          })),
          blockNumber,
          rpcOptions,
        );
        if (!results) fail(coinId, "route state unavailable");
        return results;
      },
      { signal },
    ),
  });
}

function earnFields() {
  return [
    abiObservation({
      label: "earn-asset",
      contract: EARN.vault.address,
      abi: ERC4626_ABI,
      functionName: "asset",
      verify: verifyExpectedAddress(EARN.coinId, "asset", EARN.assetAddress),
    }),
    abiObservation({
      label: "earn-total-assets",
      contract: EARN.vault.address,
      abi: ERC4626_ABI,
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
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [EARN.vault.address],
    }),
    abiObservation({
      label: "earn-asset-decimals",
      contract: EARN.assetAddress,
      abi: ERC20_ABI,
      functionName: "decimals",
    }),
  ] as const;
}

async function observeEarn(
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

type AbiFieldOptions = {
  args?: readonly unknown[];
  verify?: (value: string) => string | null;
};

function abiField(
  label: string,
  contract: string,
  abi: readonly unknown[],
  functionName: string,
  options: AbiFieldOptions = {},
): AnyEvmObservationField {
  return abiObservation({
    label,
    contract,
    abi,
    functionName,
    ...options,
  } as never) as AnyEvmObservationField;
}

function strategyFields(label: "idle" | "dlend", strategyAddress: Hex) {
  const strategyName = label === "idle" ? "idle" : "dLEND";
  const adapterAddress = label === "idle" ? DSTAKE.idleAdapter.address : DSTAKE.dlendAdapter.address;
  return [
    abiField(`${label}-strategy-asset`, strategyAddress, STRATEGY_VAULT_ABI, "asset", {
      verify: verifyExpectedAddress(DSTAKE.coinId, `${strategyName} strategy asset`, DSTAKE.assetAddress),
    }),
    abiField(`${label}-strategy-max-withdraw`, strategyAddress, STRATEGY_VAULT_ABI, "maxWithdraw", {
      args: [DSTAKE.collateralVault.address],
    }),
    abiField(`${label}-strategy-adapter`, DSTAKE.router.address, DSTAKE_ROUTER_ABI, "strategyShareToAdapter", {
      args: [strategyAddress],
      verify: verifyExpectedAddress(DSTAKE.coinId, `${strategyName} strategy adapter`, adapterAddress),
    }),
    abiField(`${label}-strategy-healthy`, DSTAKE.router.address, DSTAKE_ROUTER_ABI, "isVaultHealthyForWithdrawals", {
      args: [strategyAddress],
    }),
  ] as const;
}

function dStakeFields() {
  return [
    abiField("dstake-asset", DSTAKE.token.address, ERC4626_ABI, "asset", {
      verify: verifyExpectedAddress(DSTAKE.coinId, "asset", DSTAKE.assetAddress),
    }),
    abiField("dstake-total-assets", DSTAKE.token.address, ERC4626_ABI, "totalAssets"),
    abiField("dstake-router", DSTAKE.token.address, DSTAKE_TOKEN_ABI, "router", {
      verify: verifyExpectedAddress(DSTAKE.coinId, "token router", DSTAKE.router.address),
    }),
    abiField("dstake-collateral-vault", DSTAKE.token.address, DSTAKE_TOKEN_ABI, "collateralVault", {
      verify: verifyExpectedAddress(DSTAKE.coinId, "token collateral vault", DSTAKE.collateralVault.address),
    }),
    abiField("router-token", DSTAKE.router.address, DSTAKE_ROUTER_ABI, "dStakeToken", {
      verify: verifyExpectedAddress(DSTAKE.coinId, "router dStakeToken", DSTAKE.token.address),
    }),
    abiField("router-collateral-vault", DSTAKE.router.address, DSTAKE_ROUTER_ABI, "collateralVault", {
      verify: verifyExpectedAddress(DSTAKE.coinId, "router collateral vault", DSTAKE.collateralVault.address),
    }),
    abiField("router-paused", DSTAKE.router.address, DSTAKE_ROUTER_ABI, "paused"),
    abiField("router-withdrawal-fee", DSTAKE.router.address, DSTAKE_ROUTER_ABI, "withdrawalFeeBps"),
    abiField("router-max-withdrawal-fee", DSTAKE.router.address, DSTAKE_ROUTER_ABI, "maxWithdrawalFeeBps"),
    abiField("router-shortfall", DSTAKE.router.address, DSTAKE_ROUTER_ABI, "currentShortfall"),
    abiField("router-active-withdrawal-vaults", DSTAKE.router.address, DSTAKE_ROUTER_ABI, "getActiveVaultsForWithdrawals"),
    ...strategyFields("idle", DSTAKE.idleStrategy.address),
    ...strategyFields("dlend", DSTAKE.dlendStrategy.address),
    abiField("dlend-pool", DSTAKE.dlendStrategy.address, STATIC_ATOKEN_ABI, "POOL", {
      verify: verifyExpectedAddress(DSTAKE.coinId, "dLEND pool", DSTAKE.dlendPoolAddress),
    }),
    abiField("dlend-atoken", DSTAKE.dlendStrategy.address, STATIC_ATOKEN_ABI, "aToken", {
      verify: verifyExpectedAddress(DSTAKE.coinId, "dLEND aToken", DSTAKE.dlendATokenAddress),
    }),
    abiField("dlend-available-liquidity", DSTAKE.assetAddress, ERC20_ABI, "balanceOf", {
      args: [DSTAKE.dlendATokenAddress],
    }),
    abiField("dstake-asset-decimals", DSTAKE.assetAddress, ERC20_ABI, "decimals"),
  ] as const;
}

async function observeDStake(
  blockNumber: number,
  blockTimestamp: number,
  rpcOptions: EvmRpcOptions,
  client: ExecutableRedemptionReadClient,
  ctx: AdapterContext | undefined,
  signal: AbortSignal,
): Promise<ExecutableRedemptionObservation> {
  const state = await readStateWithPlan(
    DSTAKE.coinId,
    "sdusd-dtrinity-redemption-state",
    dStakeFields(),
    [
      DSTAKE.token,
      DSTAKE.router,
      DSTAKE.collateralVault,
      DSTAKE.idleStrategy,
      DSTAKE.idleAdapter,
      DSTAKE.dlendStrategy,
      DSTAKE.dlendAdapter,
    ],
    blockNumber,
    rpcOptions,
    client,
    ctx,
    signal,
  );

  const activeWithdrawalVaults = state.values["router-active-withdrawal-vaults"] as readonly string[];
  if (
    !sameAddressSet(activeWithdrawalVaults, [
      DSTAKE.idleStrategy.address,
      DSTAKE.dlendStrategy.address,
    ])
  ) {
    fail(DSTAKE.coinId, "active withdrawal strategy set drift");
  }

  const idleMaxWithdrawRaw = state.values["idle-strategy-max-withdraw"] as bigint;
  const dlendMaxWithdrawRaw = state.values["dlend-strategy-max-withdraw"] as bigint;
  const dlendAvailableLiquidityRaw = state.values["dlend-available-liquidity"] as bigint;
  const totalAssetsRaw = state.values["dstake-total-assets"] as bigint;
  if (
    idleMaxWithdrawRaw < 0n ||
    dlendMaxWithdrawRaw < 0n ||
    dlendAvailableLiquidityRaw < 0n ||
    totalAssetsRaw <= 0n ||
    dlendMaxWithdrawRaw > dlendAvailableLiquidityRaw
  ) {
    fail(DSTAKE.coinId, "invalid dLEND available-liquidity/max-withdraw bound");
  }

  const currentFeeRaw = state.values["router-withdrawal-fee"] as bigint;
  const maxFeeRaw = state.values["router-max-withdrawal-fee"] as bigint;
  if (currentFeeRaw < 0n || maxFeeRaw < 0n || currentFeeRaw > maxFeeRaw || maxFeeRaw > 1_000_000n) {
    fail(DSTAKE.coinId, "invalid withdrawal fee state");
  }
  const feeBps = fixedPointFeeBpsCeil(currentFeeRaw, 1_000_000n, DSTAKE.coinId);
  const paused = state.values["router-paused"] as boolean;
  const shortfallRaw = state.values["router-shortfall"] as bigint;
  const idleHealthy = state.values["idle-strategy-healthy"] as boolean;
  const dlendHealthy = state.values["dlend-strategy-healthy"] as boolean;
  const assetDecimals = state.values["dstake-asset-decimals"] as number;
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
