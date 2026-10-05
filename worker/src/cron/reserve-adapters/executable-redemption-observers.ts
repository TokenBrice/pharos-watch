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
import type { Abi } from "abitype";
import {
  DSTAKE_ROUTER_ABI,
  DSTAKE_TOKEN_ABI,
  EARN_PROTOCOL_CONFIG_ABI,
  EARN_VALIDATOR_ABI,
  EARN_VAULT_ABI,
  NOON_SUSN_VAULT_ABI,
  NOON_SUSN_WITHDRAWAL_HANDLER_ABI,
  STATIC_ATOKEN_ABI,
  LIDO_EARN_VAULT_ABI,
  LIDO_EARN_QUEUE_ABI,
  LIDO_EARN_SYNC_ABI,
  LIDO_EARN_FEE_ABI,
  LIDO_EARN_ORACLE_ABI,
  LIDO_EARN_SHARES_ABI,
  erc20Abi,
  erc4626Abi,
} from "./executable-redemption-abis";
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
import { implementationAddressFromSlot, runtimeCodeHash } from "./onchain-identity";

type Hex = `0x${string}`;

const CHAIN = "ethereum";
const RPC_DEADLINE_MS = 10_000;
const BLOCK_MAX_AGE_SEC = 10 * 60;
const BLOCK_FUTURE_SKEW_SEC = 60;
const OBSERVATION_BLOCK_LAG = 2;


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

const DSTAKE = {
  coinId: "sdusd-dtrinity",
  token: {
    address: "0x7cb20517776636ed76b68edb3d99dcce356abf02",
    codeHash: "0xe5e3693157141608a301682c8c228c0277eac7efc0b98b57f874ca49752b5fd8",
    implementationAddress: "0x9c278036c3c4529472751502dfc71bb1f0a3bfd4",
    implementationCodeHash: "0xf3d6aec9f278be5b2140dcca59bfd109bd57bdf4d928e11d2a7b3863bb1b796d",
  } satisfies ProxyIdentity,
  router: {
    address: "0x6d4a26fe926e88fee41a9fddeda3b50bf98f1ddb",
    codeHash: "0xa4167490ee7ee175f6c257a2fad355a67d4061afebc6d65c381a9236e1480f4b",
  } satisfies DirectIdentity,
  collateralVault: {
    address: "0x4acbcfa29fb085097c5f31783403ef7a7930f6fe",
    codeHash: "0x9bef4196d31f6ccf89b74f147be85e8a24c19085d59776a48301d3cb06e1def9",
  } satisfies DirectIdentity,
  governanceModule: {
    address: "0x2fd26c2cbfe0674776a1ff00daa8cffefcc0c88c",
    codeHash: "0x1434e0df9c945565f750495d8981cc0771cd5a00786bc3373d18bc965c9945a9",
  } satisfies DirectIdentity,
  rebalanceModule: {
    address: "0xd15ccbe652c0c29b1d544a26f902f21dfc5b4f05",
    codeHash: "0x747c8358f0f87437ec23361620e04745b8d7e103a18a09d0a69dec933820407b",
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
    "https://etherscan.io/address/0x6d4a26fe926e88fee41a9fddeda3b50bf98f1ddb#code",
    "https://etherscan.io/address/0x2fd26c2cbfe0674776a1ff00daa8cffefcc0c88c#code",
    "https://etherscan.io/address/0xd15ccbe652c0c29b1d544a26f902f21dfc5b4f05#code",
  ],
} as const;

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
    "https://docs.noon.capital/built-for-high-yields/our-stablecoin-usn-and-susn/minting-and-redemption",
    "https://etherscan.io/address/0xe24a3dc889621612422a64e6388927901608b91d#readContract",
    "https://etherscan.io/address/0x0dabc0d9b270c9b0c4c77aaceaa712b56d0f9178#readContract",
    "https://eth.blockscout.com/api/v2/smart-contracts/0xef2ea4250b7ce4d0aa9ca70607ecef278c6eab15",
    "https://etherscan.io/address/0x36857ef0b10a61a68d58c29ee256990fa9699722#readContract",
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
    | "dtrinity-dlend-max-withdraw"
    | "noon-susn-withdrawal-handler-idle-usn"
    | "lido-earnusd-unquantified-queue";
  settlementBoundUnproven?: true;
  /** Measured settlement completion bound in seconds, read on-chain this run. */
  settlementDelaySec?: number;
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
  return (value: unknown): null => {
    const normalized = typeof value === "string" ? normalizeEvmAddress(value) : null;
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
  verify?: (value: unknown) => string | null;
};

function abiField(
  label: string,
  contract: string,
  abi: Abi,
  functionName: string,
  options: AbiFieldOptions = {},
): AnyEvmObservationField {
  return abiObservation({
    label,
    contract,
    abi,
    functionName,
    ...options,
  });
}


function dStakeFields() {
  return [
    abiField("dstake-asset", DSTAKE.token.address, erc4626Abi, "asset", {
      verify: verifyExpectedAddress(DSTAKE.coinId, "asset", DSTAKE.assetAddress),
    }),
    abiField("dstake-total-assets", DSTAKE.token.address, erc4626Abi, "totalAssets"),
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
    abiField("collateral-vault-router", DSTAKE.collateralVault.address, DSTAKE_TOKEN_ABI, "router", {
      verify: verifyExpectedAddress(DSTAKE.coinId, "collateral vault router", DSTAKE.router.address),
    }),
    abiField("router-governance-module", DSTAKE.router.address, DSTAKE_ROUTER_ABI, "governanceModule", {
      verify: verifyExpectedAddress(DSTAKE.coinId, "governance module", DSTAKE.governanceModule.address),
    }),
    abiField("router-rebalance-module", DSTAKE.router.address, DSTAKE_ROUTER_ABI, "rebalanceModule", {
      verify: verifyExpectedAddress(DSTAKE.coinId, "rebalance module", DSTAKE.rebalanceModule.address),
    }),
    abiField("router-paused", DSTAKE.router.address, DSTAKE_ROUTER_ABI, "paused"),
    abiField("router-withdrawal-fee", DSTAKE.router.address, DSTAKE_ROUTER_ABI, "withdrawalFeeBps"),
    abiField("router-max-withdrawal-fee", DSTAKE.router.address, DSTAKE_ROUTER_ABI, "maxWithdrawalFeeBps"),
    abiField("router-shortfall", DSTAKE.router.address, DSTAKE_ROUTER_ABI, "currentShortfall"),
    abiField("router-active-withdrawal-vaults", DSTAKE.router.address, DSTAKE_ROUTER_ABI, "getActiveVaultsForWithdrawals"),
    abiField("dlend-strategy-asset", DSTAKE.dlendStrategy.address, erc4626Abi, "asset", {
      verify: verifyExpectedAddress(DSTAKE.coinId, "dLEND strategy asset", DSTAKE.assetAddress),
    }),
    abiField("dlend-strategy-max-withdraw", DSTAKE.dlendStrategy.address, erc4626Abi, "maxWithdraw", {
      args: [DSTAKE.collateralVault.address],
    }),
    abiField("dlend-strategy-adapter", DSTAKE.router.address, DSTAKE_ROUTER_ABI, "strategyShareToAdapter", {
      args: [DSTAKE.dlendStrategy.address],
      verify: verifyExpectedAddress(DSTAKE.coinId, "dLEND strategy adapter", DSTAKE.dlendAdapter.address),
    }),
    abiField("dlend-strategy-healthy", DSTAKE.router.address, DSTAKE_ROUTER_ABI, "isVaultHealthyForWithdrawals", {
      args: [DSTAKE.dlendStrategy.address],
    }),
    abiField("dlend-pool", DSTAKE.dlendStrategy.address, STATIC_ATOKEN_ABI, "POOL", {
      verify: verifyExpectedAddress(DSTAKE.coinId, "dLEND pool", DSTAKE.dlendPoolAddress),
    }),
    abiField("dlend-atoken", DSTAKE.dlendStrategy.address, STATIC_ATOKEN_ABI, "aToken", {
      verify: verifyExpectedAddress(DSTAKE.coinId, "dLEND aToken", DSTAKE.dlendATokenAddress),
    }),
    abiField("dlend-available-liquidity", DSTAKE.assetAddress, erc20Abi, "balanceOf", {
      args: [DSTAKE.dlendATokenAddress],
    }),
    abiField("dstake-asset-decimals", DSTAKE.assetAddress, erc20Abi, "decimals"),
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
      DSTAKE.governanceModule,
      DSTAKE.rebalanceModule,
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
      DSTAKE.dlendStrategy.address,
    ])
  ) {
    fail(DSTAKE.coinId, "active withdrawal strategy set drift");
  }

  const dlendMaxWithdrawRaw = state.values["dlend-strategy-max-withdraw"] as bigint;
  const dlendAvailableLiquidityRaw = state.values["dlend-available-liquidity"] as bigint;
  const totalAssetsRaw = state.values["dstake-total-assets"] as bigint;
  if (
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
  const dlendHealthy = state.values["dlend-strategy-healthy"] as boolean;
  const assetDecimals = state.values["dstake-asset-decimals"] as number;
  if (assetDecimals !== DSTAKE.assetDecimals || shortfallRaw < 0n) {
    fail(DSTAKE.coinId, "invalid dSTAKE asset or shortfall state");
  }

  const cappedBound = dlendMaxWithdrawRaw > totalAssetsRaw ? totalAssetsRaw : dlendMaxWithdrawRaw;
  const routeOpen =
    paused === false &&
    shortfallRaw === 0n &&
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
      governanceModuleAddress: DSTAKE.governanceModule.address,
      rebalanceModuleAddress: DSTAKE.rebalanceModule.address,
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

async function observeSusnNoon(
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

async function observeLidoEarn(
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

export function hasExecutableRedemptionObserver(coinId: string): boolean {
  return coinId === EARN.coinId || coinId === LIDO_EARN.coinId || coinId === DSTAKE.coinId || coinId === NOON_SUSN.coinId;
}

export async function observeExecutableRedemptionRoute(
  coinId: string,
  contractAddress: string,
  signal: AbortSignal,
  ctx?: AdapterContext,
  options: ObserverOptions = {},
): Promise<ExecutableRedemptionObservation | null> {
  if (!hasExecutableRedemptionObserver(coinId)) return null;

  const expectedContractAddress =
    coinId === EARN.coinId
      ? EARN.vault.address
      : coinId === LIDO_EARN.coinId
        ? LIDO_EARN.shares.address
        : coinId === NOON_SUSN.coinId
          ? NOON_SUSN.vault.address
          : DSTAKE.token.address;
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
    : coinId === LIDO_EARN.coinId
      ? observeLidoEarn(blockNumber, blockTimestamp, rpcOptions, client, ctx, signal)
      : coinId === NOON_SUSN.coinId
        ? observeSusnNoon(blockNumber, blockTimestamp, rpcOptions, client, ctx, signal)
        : observeDStake(blockNumber, blockTimestamp, rpcOptions, client, ctx, signal);
}
