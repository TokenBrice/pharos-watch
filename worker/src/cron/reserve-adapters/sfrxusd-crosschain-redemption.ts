import {
  REDEMPTION_EXIT_CURVE_REQUESTS_USD as COST_REQUESTS_USD,
} from "@shared/lib/exit-route-capacity-point";
import type { LiveReserveAdapterParamsByKey } from "@shared/lib/live-reserve-adapters";
import {
  SfrxusdCrosschainV9RouteStateSchema,
  raw18ToNumber,
  type SfrxusdCrosschainRouteRejectionCode,
  type SfrxusdCrosschainV9RouteAttempt,
  type SfrxusdRouteBlock,
} from "../../lib/sfrxusd-crosschain-redemption-route";
import type {
  EvmBlockHeader,
  EvmMulticall3Call,
  EvmMulticall3Result,
  EvmRpcOptions,
} from "../../lib/evm-rpc";
import {
  fetchEvmBlockHeader,
  fetchEvmCodeAtBlock,
  fetchEvmMulticall3Aggregate3AtBlock,
  fetchEvmStorageAtBlock,
  MULTICALL3_ADDRESS,
} from "../../lib/evm-rpc";
import { rethrowIfAborted } from "../../lib/abort";
import { parseAbi } from "viem/utils";
import type { AdapterContext } from "./types";
import { runAdapterIo } from "./concurrency";
import { normalizeEvmAddress } from "./evm";
import { runtimeCodeHash } from "./onchain-identity";
import {
  abiObservation, codeIdentityChecks, customObservation, executeEvmObservationPlan,
  type AnyEvmObservationField, type EvmCodeIdentity,
} from "./evm-observation-plan";

type Erc4626Params = LiveReserveAdapterParamsByKey["erc4626-single-asset"];
type Hex = `0x${string}`;
type SfrxusdRouteParams = Extract<
  NonNullable<Erc4626Params["redemptionLiquidity"]>,
  { source: "fraxtal-hop-withdrawable" }
>;

const ETHEREUM = "ethereum";
const FRAXTAL = "fraxtal";
const BLOCK_FUTURE_SKEW_SEC = 60;
const RPC_DEADLINE_MS = 25_000;
const ETHEREUM_LAYERZERO_EID = 30_101;
const FRAXTAL_LAYERZERO_EID = 30_255;
const E18 = 10n ** 18n;
const BPS = 10_000;
const OFT_DECIMAL_CONVERSION_RATE = 10n ** 12n;

const ROUTE_ABI = parseAbi([
  "function paused() view returns (bool)",
  "function fraxtalHop() view returns (bytes32)",
  "function EID() view returns (uint32)",
  "function frxUsdOft() view returns (address)",
  "function sfrxUsdOft() view returns (address)",
  "function quoteHop() view returns (uint256)",
  "function quote(address oft,bytes32 to,uint256 amount) view returns ((uint256 nativeFee,uint256 lzTokenFee))",
  "function quote(address oft,uint32 dstEid,bytes32 to,uint256 amount) view returns ((uint256 nativeFee,uint256 lzTokenFee))",
  "function token() view returns (address)",
  "function decimalConversionRate() view returns (uint256)",
  "function asset() view returns (address)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
  "function convertToAssets(uint256 shares) view returns (uint256)",
  "function aggregator() view returns (address)",
  "function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)",
  "function fraxtalERC4626MintRedeemer() view returns (address)",
  "function frxUsdLockbox() view returns (address)",
  "function sfrxUsdLockbox() view returns (address)",
  "function remoteHop(uint32 eid) view returns (bytes32)",
  "function underlyingTkn() view returns (address)",
  "function vaultTkn() view returns (address)",
  "function priceFeedUnderlying() view returns (address)",
  "function priceFeedVault() view returns (address)",
  "function fee() view returns (uint256)",
  "function oracleTimeTolerance() view returns (uint256)",
  "function lastVaultTknOracleRead() view returns (uint256)",
  "function getLatestUnderlyingPriceE18() view returns (int256)",
  "function getLatestVaultTknPriceE18() view returns (int256)",
  "function getVaultTknPriceStoredE18() view returns (uint256)",
  "function totalAssets() view returns (uint256)",
  "function mdwrComboView() view returns (uint256,uint256,uint256,uint256)",
  "function previewRedeem(uint256 shares) view returns (uint256)",
  "function balanceOf(address account) view returns (uint256)",
  "function getEthBalance(address account) view returns (uint256)",
]);

interface MessagingFee {
  nativeFee: bigint;
  lzTokenFee: bigint;
}

interface IdentityManifest {
  role:
    | "ethereum-sfrxusd"
    | "ethereum-remote-hop"
    | "ethereum-frxusd-oft"
    | "ethereum-sfrxusd-oft"
    | "ethereum-eth-usd-feed"
    | "ethereum-eth-usd-aggregator"
    | "fraxtal-hop"
    | "fraxtal-mint-redeemer"
    | "fraxtal-frxusd-lockbox"
    | "fraxtal-sfrxusd-lockbox"
    | "fraxtal-vault-oracle";
  chain: "ethereum" | "fraxtal";
  address: string;
  expectedRuntimeCodeHash: string;
  implementationAddress?: string;
  expectedImplementationRuntimeCodeHash?: string;
}

export interface SfrxusdCrosschainRouteReadClient {
  blockHeader(
    chain: string,
    options: EvmRpcOptions,
  ): Promise<EvmBlockHeader | null>;
  code(
    chain: string,
    address: string,
    blockNumber: number,
    options: EvmRpcOptions,
  ): Promise<Hex | null>;
  storage(
    chain: string,
    address: string,
    slot: string,
    blockNumber: number,
    options: EvmRpcOptions,
  ): Promise<Hex | null>;
  multicall(
    chain: string,
    calls: readonly EvmMulticall3Call[],
    blockNumber: number,
    options: EvmRpcOptions,
  ): Promise<EvmMulticall3Result[] | null>;
}

const DEFAULT_CLIENT: SfrxusdCrosschainRouteReadClient = {
  blockHeader: (chain, options) =>
    fetchEvmBlockHeader(chain, "finalized", options),
  code: (chain, address, blockNumber, options) =>
    fetchEvmCodeAtBlock(chain, address, blockNumber, options),
  storage: (chain, address, slot, blockNumber, options) =>
    fetchEvmStorageAtBlock(chain, address, slot, blockNumber, options),
  multicall: (chain, calls, blockNumber, options) =>
    fetchEvmMulticall3Aggregate3AtBlock(
      chain,
      calls,
      blockNumber,
      options,
    ),
};

function rejected(
  attemptedAtSec: number,
  rejectionCode: SfrxusdCrosschainRouteRejectionCode,
  blocks: {
    ethereumBlock?: SfrxusdRouteBlock;
    fraxtalBlock?: SfrxusdRouteBlock;
  } = {},
): SfrxusdCrosschainV9RouteAttempt {
  return { status: "rejected", attemptedAtSec, rejectionCode, ...blocks };
}

type RouteObservationValue<Function extends string> =
  Function extends "quote" ? MessagingFee :
  Function extends "latestRoundData" ? readonly [bigint, bigint, bigint, bigint, bigint] :
  unknown;

function routeObservation<const Label extends string, const Function extends string>(
  label: Label,
  contract: string,
  functionName: Function,
  args?: readonly unknown[],
) {
  const field = abiObservation({ label, contract, abi: ROUTE_ABI, functionName, args, optional: true });
  return customObservation({
    ...field,
    decode: (raw, observedLabel): RouteObservationValue<Function> | null => {
      try {
        const value = field.decode(raw, observedLabel);
        if (functionName === "latestRoundData" &&
          (!Array.isArray(value) || value.length !== 5 || value.some((entry) => typeof entry !== "bigint"))) {
          return null;
        }
        if (functionName === "quote" &&
          (value == null || typeof value !== "object" ||
            !("nativeFee" in value) || !("lzTokenFee" in value) ||
            typeof value.nativeFee !== "bigint" || typeof value.lzTokenFee !== "bigint")) {
          return null;
        }
        return (typeof value === "string" && /^0x[0-9a-f]{40}$/i.test(value)
          ? normalizeEvmAddress(value) : value) as RouteObservationValue<Function>;
      } catch {
        return null;
      }
    },
  });
}

async function observeRouteWave<const Fields extends readonly AnyEvmObservationField[]>(
  client: SfrxusdCrosschainRouteReadClient,
  chain: string,
  fields: Fields,
  blockNumber: number,
  options: EvmRpcOptions,
) {
  const results = await client.multicall(chain, fields.map((field) => ({
    label: field.label, target: field.contract, callData: field.data, allowFailure: field.allowFailure,
  })), blockNumber, options);
  if (!results) return null;
  const snapshot = await executeEvmObservationPlan({
    adapterKey: "sfrxusd-crosschain-redemption",
    fields,
    // A missing/reverted field remains nullable so protocol checks retain their
    // specific rejection codes and priority instead of a transport-wide failure.
    read: async () => fields.map((field) => results.find((result) => result.label === field.label)
      ?? { label: field.label, success: false, returnData: "0x" as const }),
  });
  return snapshot.values;
}

function normalizeExpectedAddress(address: string): string | null {
  return normalizeEvmAddress(address);
}

function addressAsBytes32(address: string): Hex | null {
  const normalized = normalizeExpectedAddress(address);
  return normalized ? (`0x${normalized.slice(2).padStart(64, "0")}` as Hex) : null;
}

function toRouteBlock(
  chain: "ethereum" | "fraxtal",
  header: EvmBlockHeader,
): SfrxusdRouteBlock {
  return {
    chain,
    finalityTag: "finalized",
    blockNumber: header.number,
    blockTimestamp: header.timestamp,
    blockHash: header.hash.toLowerCase(),
  };
}

function isBlockCurrent(
  block: SfrxusdRouteBlock,
  attemptedAtSec: number,
  maxAgeSec: number,
): boolean {
  return (
    block.blockTimestamp >= attemptedAtSec - maxAgeSec &&
    block.blockTimestamp <= attemptedAtSec + BLOCK_FUTURE_SKEW_SEC
  );
}

function divCeil(numerator: bigint, denominator: bigint): bigint {
  return numerator / denominator + (numerator % denominator === 0n ? 0n : 1n);
}

function relativeDeviationBps(left: bigint, right: bigint): number {
  if (left <= 0n || right <= 0n) return Number.POSITIVE_INFINITY;
  const difference = left > right ? left - right : right - left;
  return Number((difference * 10_000_000n) / right) / 1_000;
}

function identityManifest(
  params: SfrxusdRouteParams,
  sfrxUsdProxyAddress: string,
): IdentityManifest[] {
  return [
    {
      role: "ethereum-sfrxusd",
      chain: "ethereum",
      address: sfrxUsdProxyAddress,
      expectedRuntimeCodeHash: params.expectedEthereumSfrxUsdProxyCodeHash,
      implementationAddress:
        params.expectedEthereumSfrxUsdImplementationAddress,
      expectedImplementationRuntimeCodeHash:
        params.expectedEthereumSfrxUsdImplementationCodeHash,
    },
    {
      role: "ethereum-remote-hop",
      chain: "ethereum",
      address: params.remoteHopAddress,
      expectedRuntimeCodeHash: params.expectedRemoteHopCodeHash,
    },
    {
      role: "ethereum-frxusd-oft",
      chain: "ethereum",
      address: params.expectedEthereumFrxUsdOftAddress,
      expectedRuntimeCodeHash: params.expectedEthereumFrxUsdOftProxyCodeHash,
      implementationAddress:
        params.expectedEthereumFrxUsdOftImplementationAddress,
      expectedImplementationRuntimeCodeHash:
        params.expectedEthereumFrxUsdOftImplementationCodeHash,
    },
    {
      role: "ethereum-sfrxusd-oft",
      chain: "ethereum",
      address: params.expectedEthereumSfrxUsdOftAddress,
      expectedRuntimeCodeHash: params.expectedEthereumSfrxUsdOftProxyCodeHash,
      implementationAddress:
        params.expectedEthereumSfrxUsdOftImplementationAddress,
      expectedImplementationRuntimeCodeHash:
        params.expectedEthereumSfrxUsdOftImplementationCodeHash,
    },
    {
      role: "ethereum-eth-usd-feed",
      chain: "ethereum",
      address: params.expectedEthUsdFeedAddress,
      expectedRuntimeCodeHash: params.expectedEthUsdFeedCodeHash,
    },
    {
      role: "ethereum-eth-usd-aggregator",
      chain: "ethereum",
      address: params.expectedEthUsdAggregatorAddress,
      expectedRuntimeCodeHash: params.expectedEthUsdAggregatorCodeHash,
    },
    {
      role: "fraxtal-hop",
      chain: "fraxtal",
      address: params.expectedFraxtalHopAddress,
      expectedRuntimeCodeHash: params.expectedFraxtalHopCodeHash,
    },
    {
      role: "fraxtal-mint-redeemer",
      chain: "fraxtal",
      address: params.mintRedeemerProxyAddress,
      expectedRuntimeCodeHash: params.expectedMintRedeemerProxyCodeHash,
      implementationAddress: params.expectedMintRedeemerImplementationAddress,
      expectedImplementationRuntimeCodeHash:
        params.expectedMintRedeemerImplementationCodeHash,
    },
    {
      role: "fraxtal-frxusd-lockbox",
      chain: "fraxtal",
      address: params.expectedFrxUsdLockboxAddress,
      expectedRuntimeCodeHash: params.expectedFrxUsdLockboxProxyCodeHash,
      implementationAddress:
        params.expectedFrxUsdLockboxImplementationAddress,
      expectedImplementationRuntimeCodeHash:
        params.expectedFrxUsdLockboxImplementationCodeHash,
    },
    {
      role: "fraxtal-sfrxusd-lockbox",
      chain: "fraxtal",
      address: params.expectedSfrxUsdLockboxAddress,
      expectedRuntimeCodeHash: params.expectedSfrxUsdLockboxProxyCodeHash,
      implementationAddress:
        params.expectedSfrxUsdLockboxImplementationAddress,
      expectedImplementationRuntimeCodeHash:
        params.expectedSfrxUsdLockboxImplementationCodeHash,
    },
    {
      role: "fraxtal-vault-oracle",
      chain: "fraxtal",
      address: params.expectedVaultOracleAddress,
      expectedRuntimeCodeHash: params.expectedVaultOracleCodeHash,
    },
  ];
}

async function verifyContractIdentities(args: {
  manifests: IdentityManifest[];
  ethereumBlock: SfrxusdRouteBlock;
  fraxtalBlock: SfrxusdRouteBlock;
  ethereumOptions: EvmRpcOptions;
  fraxtalOptions: EvmRpcOptions;
  client: SfrxusdCrosschainRouteReadClient;
  ctx?: AdapterContext;
  signal: AbortSignal;
}): Promise<
  | {
      status: "accepted";
      identities: Array<{
        role: IdentityManifest["role"];
        chain: IdentityManifest["chain"];
        address: string;
        runtimeCodeHash: string;
        implementationAddress?: string;
        implementationRuntimeCodeHash?: string;
      }>;
    }
  | {
      status: "rejected";
      rejectionCode:
        | "code-unavailable"
        | "code-drift"
        | "implementation-unavailable"
        | "implementation-drift";
    }
> {
  type Identity = EvmCodeIdentity & { manifest: IdentityManifest };
  const identities: Identity[] = args.manifests.map((manifest) => ({
    address: manifest.address,
    codeHash: manifest.expectedRuntimeCodeHash,
    ...(manifest.implementationAddress
      ? {
          implementationAddress: manifest.implementationAddress,
          ...(manifest.expectedImplementationRuntimeCodeHash
            ? { implementationCodeHash: manifest.expectedImplementationRuntimeCodeHash }
            : {}),
        }
      : {}),
    manifest,
  }));
  const identityResult = await codeIdentityChecks(args.client, identities, {
    parallel: true,
    blockNumber: (identity) =>
      identity.manifest.chain === "ethereum"
        ? args.ethereumBlock.blockNumber
        : args.fraxtalBlock.blockNumber,
    rpcOptions: (identity) =>
      identity.manifest.chain === "ethereum"
        ? args.ethereumOptions
        : args.fraxtalOptions,
    readCode: (client, address, blockNumber, rpcOptions, identity) =>
      client.code(identity.manifest.chain, address, blockNumber, rpcOptions),
    readStorage: (client, address, slot, blockNumber, rpcOptions, identity) =>
      client.storage(identity.manifest.chain, address, slot, blockNumber, rpcOptions),
    hashCode: (code) => runtimeCodeHash(code as Hex),
    run: (label, factory) => runAdapterIo(args.ctx, label, factory, { signal: args.signal }),
    codeLabel: (identity, kind) =>
      kind === "implementation"
        ? `sfrxusd-route-code:${identity.manifest.role}:implementation`
        : `sfrxusd-route-code:${identity.manifest.role}`,
    storageLabel: (identity) => `sfrxusd-route-implementation:${identity.manifest.role}`,
  });
  if (identityResult.status === "rejected") {
    return {
      status: "rejected",
      rejectionCode: identityResult.rejectionCode,
    };
  }

  return {
    status: "accepted",
    identities: args.manifests.map((manifest) => ({
      role: manifest.role,
      chain: manifest.chain,
      address: normalizeExpectedAddress(manifest.address)!,
      runtimeCodeHash: manifest.expectedRuntimeCodeHash.toLowerCase(),
      ...(manifest.implementationAddress
        ? {
            implementationAddress: normalizeExpectedAddress(
              manifest.implementationAddress,
            )!,
            implementationRuntimeCodeHash:
              manifest.expectedImplementationRuntimeCodeHash!.toLowerCase(),
          }
        : {}),
    })),
  };
}

function ethereumBaseFields(
  params: SfrxusdRouteParams,
  sfrxUsdProxyAddress: string,
) {
  const hop = params.remoteHopAddress;
  const frxOft = params.expectedEthereumFrxUsdOftAddress;
  const sfrxOft = params.expectedEthereumSfrxUsdOftAddress;
  const ethUsdFeed = params.expectedEthUsdFeedAddress;
  return [
    routeObservation("remote-paused", hop, "paused"),
    routeObservation("remote-fraxtal-hop", hop, "fraxtalHop"),
    routeObservation("remote-eid", hop, "EID"),
    routeObservation("remote-frx-oft", hop, "frxUsdOft"),
    routeObservation("remote-sfrx-oft", hop, "sfrxUsdOft"),
    routeObservation("remote-service-fee", hop, "quoteHop"),
    routeObservation("frx-oft-token", frxOft, "token"),
    routeObservation("frx-oft-conversion-rate", frxOft, "decimalConversionRate"),
    routeObservation("sfrx-oft-token", sfrxOft, "token"),
    routeObservation("sfrx-oft-conversion-rate", sfrxOft, "decimalConversionRate"),
    routeObservation("ethereum-frx-decimals", params.expectedEthereumFrxUsdAddress, "decimals"),
    routeObservation("ethereum-sfrx-decimals", sfrxUsdProxyAddress, "decimals"),
    routeObservation("ethereum-sfrx-asset", sfrxUsdProxyAddress, "asset"),
    routeObservation("ethereum-sfrx-total-supply", sfrxUsdProxyAddress, "totalSupply"),
    routeObservation("eth-usd-aggregator", ethUsdFeed, "aggregator"),
    routeObservation("eth-usd-decimals", ethUsdFeed, "decimals"),
    routeObservation("eth-usd-round", ethUsdFeed, "latestRoundData"),
  ] as const;
}

function fraxtalBaseFields(
  params: SfrxusdRouteParams,
) {
  const hop = params.expectedFraxtalHopAddress;
  const redeemer = params.mintRedeemerProxyAddress;
  const vaultOracle = params.expectedVaultOracleAddress;
  return [
    routeObservation("fraxtal-hop-paused", hop, "paused"),
    routeObservation("fraxtal-hop-redeemer", hop, "fraxtalERC4626MintRedeemer"),
    routeObservation("fraxtal-hop-frx-lockbox", hop, "frxUsdLockbox"),
    routeObservation("fraxtal-hop-sfrx-lockbox", hop, "sfrxUsdLockbox"),
    routeObservation("fraxtal-hop-remote", hop, "remoteHop", [params.expectedEthereumEid]),
    routeObservation("fraxtal-hop-native-balance", MULTICALL3_ADDRESS, "getEthBalance", [
      hop as Hex,
    ]),
    routeObservation("fraxtal-frx-lockbox-token", params.expectedFrxUsdLockboxAddress, "token"),
    routeObservation("fraxtal-frx-lockbox-conversion-rate", params.expectedFrxUsdLockboxAddress, "decimalConversionRate"),
    routeObservation("fraxtal-sfrx-lockbox-token", params.expectedSfrxUsdLockboxAddress, "token"),
    routeObservation("fraxtal-sfrx-lockbox-conversion-rate", params.expectedSfrxUsdLockboxAddress, "decimalConversionRate"),
    routeObservation("fraxtal-frx-decimals", params.expectedFraxtalFrxUsdAddress, "decimals"),
    routeObservation("fraxtal-sfrx-decimals", params.expectedFraxtalSfrxUsdAddress, "decimals"),
    routeObservation("redeemer-underlying", redeemer, "underlyingTkn"),
    routeObservation("redeemer-vault", redeemer, "vaultTkn"),
    routeObservation("redeemer-underlying-oracle", redeemer, "priceFeedUnderlying"),
    routeObservation("redeemer-vault-oracle", redeemer, "priceFeedVault"),
    routeObservation("redeemer-fee", redeemer, "fee"),
    routeObservation("redeemer-oracle-tolerance", redeemer, "oracleTimeTolerance"),
    routeObservation("redeemer-stored-price", redeemer, "getVaultTknPriceStoredE18"),
    routeObservation("redeemer-latest-vault-price", redeemer, "getLatestVaultTknPriceE18"),
    routeObservation("redeemer-latest-underlying-price", redeemer, "getLatestUnderlyingPriceE18"),
    routeObservation("redeemer-last-oracle-read", redeemer, "lastVaultTknOracleRead"),
    routeObservation("redeemer-total-assets", redeemer, "totalAssets"),
    routeObservation("redeemer-mdwr", redeemer, "mdwrComboView"),
    routeObservation("redeemer-underlying-balance", params.expectedFraxtalFrxUsdAddress, "balanceOf", [redeemer as Hex]),
    routeObservation("vault-oracle-decimals", vaultOracle, "decimals"),
    routeObservation("vault-oracle-round", vaultOracle, "latestRoundData"),
  ] as const;
}

function quoteFields(args: {
  params: SfrxusdRouteParams;
  recipient: Hex;
  inputShares: bigint[];
  previewOutputs: bigint[];
  cappedShares: bigint;
}) {
  const { params, recipient } = args;
  return {
    ethereum: args.inputShares.map((shares, index) =>
      routeObservation(`ethereum-quote:${index}`, params.remoteHopAddress, "quote", [
        params.expectedEthereumSfrxUsdOftAddress as Hex,
        recipient,
        shares,
      ]),
    ),
    fraxtal: [
      routeObservation("capacity-preview", params.mintRedeemerProxyAddress, "previewRedeem", [args.cappedShares]),
      ...args.inputShares.flatMap((shares, index) => [
        routeObservation(`preview:${index}`, params.mintRedeemerProxyAddress, "previewRedeem", [
          shares,
        ]),
        routeObservation(`fraxtal-return-quote:${index}`, params.expectedFraxtalHopAddress, "quote", [
          params.expectedFrxUsdLockboxAddress as Hex,
          params.expectedEthereumEid,
          recipient,
          args.previewOutputs[index],
        ]),
      ]),
    ],
  };
}

async function observeWithClient(
  params: SfrxusdRouteParams,
  sfrxUsdProxyAddress: string,
  signal: AbortSignal,
  ctx: AdapterContext | undefined,
  attemptedAtSec: number,
  ethereumRpcUrls: string[],
  client: SfrxusdCrosschainRouteReadClient,
): Promise<SfrxusdCrosschainV9RouteAttempt> {
  if (
    params.expectedEthereumEid !== ETHEREUM_LAYERZERO_EID ||
    params.expectedFraxtalEid !== FRAXTAL_LAYERZERO_EID
  ) {
    return rejected(attemptedAtSec, "identity-mismatch");
  }
  const ethereumOptions: EvmRpcOptions = {
    extraRpcUrls: ethereumRpcUrls,
    chainRpcs: ctx?.chainRpcs,
    signal,
    timeoutMs: 5_000,
    deadlineMs: Date.now() + RPC_DEADLINE_MS,
    maxRetries: 0,
  };
  const fraxtalOptions: EvmRpcOptions = {
    extraRpcUrls: [params.fraxtalRpcUrl],
    chainRpcs: ctx?.chainRpcs,
    signal,
    timeoutMs: 5_000,
    deadlineMs: Date.now() + RPC_DEADLINE_MS,
    maxRetries: 0,
  };

  const [ethereumHeader, fraxtalHeader] = await Promise.all([
    runAdapterIo(
      ctx,
      "sfrxusd-route-ethereum-finalized-block",
      () => client.blockHeader(ETHEREUM, ethereumOptions),
      { signal },
    ),
    runAdapterIo(
      ctx,
      "sfrxusd-route-fraxtal-finalized-block",
      () => client.blockHeader(FRAXTAL, fraxtalOptions),
      { signal },
    ),
  ]);
  if (!ethereumHeader || !fraxtalHeader) {
    return rejected(attemptedAtSec, "block-unavailable");
  }
  const ethereumBlock = toRouteBlock("ethereum", ethereumHeader);
  const fraxtalBlock = toRouteBlock("fraxtal", fraxtalHeader);
  const blocks = { ethereumBlock, fraxtalBlock };
  if (
    !isBlockCurrent(
      ethereumBlock,
      attemptedAtSec,
      params.maxFinalizedBlockAgeSec,
    ) ||
    !isBlockCurrent(
      fraxtalBlock,
      attemptedAtSec,
      params.maxFinalizedBlockAgeSec,
    )
  ) {
    return rejected(attemptedAtSec, "block-time-out-of-range", blocks);
  }
  const crossChainBlockSkewSec = Math.abs(
    ethereumBlock.blockTimestamp - fraxtalBlock.blockTimestamp,
  );
  if (crossChainBlockSkewSec > params.maxCrossChainBlockSkewSec) {
    return rejected(attemptedAtSec, "block-skew-out-of-range", blocks);
  }

  const identities = await verifyContractIdentities({
    manifests: identityManifest(params, sfrxUsdProxyAddress),
    ethereumBlock,
    fraxtalBlock,
    ethereumOptions,
    fraxtalOptions,
    client,
    ctx,
    signal,
  });
  if (identities.status === "rejected") {
    return rejected(attemptedAtSec, identities.rejectionCode, blocks);
  }

  const [ethereumState, fraxtalState] = await Promise.all([
    runAdapterIo(
      ctx,
      "sfrxusd-route-ethereum-state",
      () =>
        observeRouteWave(client, ETHEREUM, ethereumBaseFields(params, sfrxUsdProxyAddress), ethereumBlock.blockNumber, ethereumOptions),
      { signal },
    ),
    runAdapterIo(
      ctx,
      "sfrxusd-route-fraxtal-state",
      () =>
        observeRouteWave(client, FRAXTAL, fraxtalBaseFields(params), fraxtalBlock.blockNumber, fraxtalOptions),
      { signal },
    ),
  ]);
  if (!ethereumState || !fraxtalState) {
    return rejected(attemptedAtSec, "state-unavailable", blocks);
  }

  const {
    "remote-paused": remotePaused,
    "remote-fraxtal-hop": remoteFraxtalHop,
    "remote-eid": ethereumEid,
    "remote-service-fee": remoteServiceFee,
    "frx-oft-conversion-rate": frxOftConversionRate,
    "sfrx-oft-conversion-rate": sfrxOftConversionRate,
    "ethereum-frx-decimals": ethereumFrxDecimals,
    "ethereum-sfrx-decimals": ethereumSfrxDecimals,
    "ethereum-sfrx-total-supply": ethereumTotalSupply,
    "eth-usd-decimals": ethUsdDecimals,
    "remote-frx-oft": frxOft,
    "remote-sfrx-oft": sfrxOft,
    "frx-oft-token": frxOftToken,
    "sfrx-oft-token": sfrxOftToken,
    "ethereum-sfrx-asset": ethereumSfrxAsset,
    "eth-usd-aggregator": ethUsdAggregator,
    "eth-usd-round": ethUsdRound,
  } = ethereumState;
  if (
    typeof remotePaused !== "boolean" ||
    typeof remoteFraxtalHop !== "string" ||
    typeof ethereumEid !== "number" ||
    typeof remoteServiceFee !== "bigint" ||
    typeof frxOftConversionRate !== "bigint" ||
    typeof sfrxOftConversionRate !== "bigint" ||
    typeof ethereumFrxDecimals !== "number" ||
    typeof ethereumSfrxDecimals !== "number" ||
    typeof ethereumTotalSupply !== "bigint" ||
    typeof ethUsdDecimals !== "number" ||
    !ethUsdRound
  ) {
    return rejected(attemptedAtSec, "state-unavailable", blocks);
  }
  if (remotePaused) {
    return rejected(attemptedAtSec, "route-paused", blocks);
  }
  if (
    remoteFraxtalHop.toLowerCase() !==
      addressAsBytes32(params.expectedFraxtalHopAddress)?.toLowerCase() ||
    ethereumEid !== params.expectedEthereumEid ||
    frxOft !==
      normalizeExpectedAddress(params.expectedEthereumFrxUsdOftAddress) ||
    sfrxOft !==
      normalizeExpectedAddress(params.expectedEthereumSfrxUsdOftAddress) ||
    ethUsdAggregator !==
      normalizeExpectedAddress(params.expectedEthUsdAggregatorAddress)
  ) {
    return rejected(attemptedAtSec, "identity-mismatch", blocks);
  }
  if (
    frxOftToken !==
      normalizeExpectedAddress(params.expectedEthereumFrxUsdAddress) ||
    sfrxOftToken !== normalizeExpectedAddress(sfrxUsdProxyAddress) ||
    ethereumSfrxAsset !==
      normalizeExpectedAddress(params.expectedEthereumFrxUsdAddress) ||
    frxOftConversionRate !== OFT_DECIMAL_CONVERSION_RATE ||
    sfrxOftConversionRate !== OFT_DECIMAL_CONVERSION_RATE
  ) {
    return rejected(attemptedAtSec, "token-identity-invalid", blocks);
  }
  if (
    ethereumFrxDecimals !== 18 ||
    ethereumSfrxDecimals !== 18 ||
    ethUsdDecimals !== 8
  ) {
    return rejected(attemptedAtSec, "token-decimals-invalid", blocks);
  }

  const [ethRoundId, ethAnswer, , ethUpdatedAt, ethAnsweredInRound] =
    ethUsdRound;
  const ethUpdatedAtSec = Number(ethUpdatedAt);
  if (
    ethAnswer <= 0n ||
    ethAnsweredInRound < ethRoundId ||
    !Number.isSafeInteger(ethUpdatedAtSec) ||
    ethUpdatedAtSec <= 0 ||
    ethUpdatedAtSec > ethereumBlock.blockTimestamp ||
    ethereumBlock.blockTimestamp - ethUpdatedAtSec >
      params.maxEthUsdOracleAgeSec
  ) {
    return rejected(attemptedAtSec, "oracle-invalid", blocks);
  }
  const ethPriceUsd = Number(ethAnswer) / 1e8;
  if (!Number.isFinite(ethPriceUsd) || ethPriceUsd <= 0) {
    return rejected(attemptedAtSec, "oracle-invalid", blocks);
  }

  const {
    "fraxtal-hop-paused": fraxtalHopPaused,
    "fraxtal-hop-remote": hopRemote,
    "fraxtal-hop-native-balance": fraxtalHopNativeBalance,
    "fraxtal-frx-lockbox-conversion-rate": frxLockboxConversionRate,
    "fraxtal-sfrx-lockbox-conversion-rate": sfrxLockboxConversionRate,
    "fraxtal-frx-decimals": fraxtalFrxDecimals,
    "fraxtal-sfrx-decimals": fraxtalSfrxDecimals,
    "fraxtal-hop-redeemer": hopRedeemer,
    "fraxtal-hop-frx-lockbox": hopFrxLockbox,
    "fraxtal-hop-sfrx-lockbox": hopSfrxLockbox,
    "fraxtal-frx-lockbox-token": frxLockboxToken,
    "fraxtal-sfrx-lockbox-token": sfrxLockboxToken,
  } = fraxtalState;
  if (
    typeof fraxtalHopPaused !== "boolean" ||
    typeof hopRemote !== "string" ||
    typeof fraxtalHopNativeBalance !== "bigint" ||
    typeof frxLockboxConversionRate !== "bigint" ||
    typeof sfrxLockboxConversionRate !== "bigint" ||
    typeof fraxtalFrxDecimals !== "number" ||
    typeof fraxtalSfrxDecimals !== "number"
  ) {
    return rejected(attemptedAtSec, "state-unavailable", blocks);
  }
  if (fraxtalHopPaused) {
    return rejected(attemptedAtSec, "route-paused", blocks);
  }
  if (
    hopRedeemer !==
      normalizeExpectedAddress(params.mintRedeemerProxyAddress) ||
    hopFrxLockbox !==
      normalizeExpectedAddress(params.expectedFrxUsdLockboxAddress) ||
    hopSfrxLockbox !==
      normalizeExpectedAddress(params.expectedSfrxUsdLockboxAddress) ||
    hopRemote.toLowerCase() !==
      addressAsBytes32(params.remoteHopAddress)?.toLowerCase()
  ) {
    return rejected(attemptedAtSec, "identity-mismatch", blocks);
  }
  if (
    frxLockboxToken !==
      normalizeExpectedAddress(params.expectedFraxtalFrxUsdAddress) ||
    sfrxLockboxToken !==
      normalizeExpectedAddress(params.expectedFraxtalSfrxUsdAddress) ||
    frxLockboxConversionRate !== OFT_DECIMAL_CONVERSION_RATE ||
    sfrxLockboxConversionRate !== OFT_DECIMAL_CONVERSION_RATE
  ) {
    return rejected(attemptedAtSec, "token-identity-invalid", blocks);
  }
  if (fraxtalFrxDecimals !== 18 || fraxtalSfrxDecimals !== 18) {
    return rejected(attemptedAtSec, "token-decimals-invalid", blocks);
  }

  const {
    "redeemer-underlying": redeemerUnderlying, "redeemer-vault": redeemerVault,
    "redeemer-underlying-oracle": underlyingOracle, "redeemer-vault-oracle": vaultOracle,
  } = fraxtalState;
  if (
    redeemerUnderlying !==
      normalizeExpectedAddress(params.expectedFraxtalFrxUsdAddress) ||
    redeemerVault !==
      normalizeExpectedAddress(params.expectedFraxtalSfrxUsdAddress) ||
    underlyingOracle !== "0x0000000000000000000000000000000000000000" ||
    vaultOracle !==
      normalizeExpectedAddress(params.expectedVaultOracleAddress)
  ) {
    return rejected(attemptedAtSec, "token-identity-invalid", blocks);
  }

  const {
    "redeemer-fee": feeRaw,
    "redeemer-oracle-tolerance": oracleTolerance,
    "redeemer-stored-price": storedPrice,
    "redeemer-latest-vault-price": latestVaultPrice,
    "redeemer-latest-underlying-price": latestUnderlyingPrice,
    "redeemer-last-oracle-read": lastOracleRead,
    "redeemer-total-assets": totalAssets,
    "redeemer-mdwr": mdwr,
    "redeemer-underlying-balance": underlyingBalance,
    "vault-oracle-decimals": vaultOracleDecimals,
    "vault-oracle-round": vaultOracleRound,
  } = fraxtalState;
  if (
    typeof feeRaw !== "bigint" ||
    typeof oracleTolerance !== "bigint" ||
    typeof storedPrice !== "bigint" ||
    typeof latestVaultPrice !== "bigint" ||
    typeof latestUnderlyingPrice !== "bigint" ||
    typeof lastOracleRead !== "bigint" ||
    typeof totalAssets !== "bigint" ||
    !Array.isArray(mdwr) ||
    mdwr.length !== 4 ||
    mdwr.some((value) => typeof value !== "bigint") ||
    typeof underlyingBalance !== "bigint" ||
    typeof vaultOracleDecimals !== "number" ||
    !vaultOracleRound
  ) {
    return rejected(attemptedAtSec, "state-unavailable", blocks);
  }
  const feeBps = (Number(feeRaw) / 1e18) * BPS;
  if (
    feeRaw < 0n ||
    feeRaw >= E18 ||
    !Number.isFinite(feeBps) ||
    feeBps > params.maxRedemptionFeeBps
  ) {
    return rejected(attemptedAtSec, "fee-out-of-bounds", blocks);
  }
  const oracleToleranceSec = Number(oracleTolerance);
  const lastOracleReadSec = Number(lastOracleRead);
  const [
    vaultRoundId,
    vaultOracleAnswer,
    ,
    vaultOracleUpdatedAt,
    vaultAnsweredInRound,
  ] = vaultOracleRound;
  const vaultOracleUpdatedAtSec = Number(vaultOracleUpdatedAt);
  const storedToLatestDeviationBps = relativeDeviationBps(
    storedPrice,
    latestVaultPrice,
  );
  if (
    vaultOracleDecimals !== 18 ||
    latestUnderlyingPrice !== E18 ||
    latestVaultPrice <= 0n ||
    storedPrice <= 0n ||
    vaultOracleAnswer !== latestVaultPrice ||
    vaultAnsweredInRound < vaultRoundId ||
    !Number.isSafeInteger(oracleToleranceSec) ||
    oracleToleranceSec <= 0 ||
    oracleToleranceSec > params.maxOracleToleranceSec ||
    !Number.isSafeInteger(lastOracleReadSec) ||
    lastOracleReadSec <= 0 ||
    lastOracleReadSec > fraxtalBlock.blockTimestamp ||
    fraxtalBlock.blockTimestamp - lastOracleReadSec > oracleToleranceSec ||
    !Number.isSafeInteger(vaultOracleUpdatedAtSec) ||
    vaultOracleUpdatedAtSec <= 0 ||
    vaultOracleUpdatedAtSec > fraxtalBlock.blockTimestamp ||
    fraxtalBlock.blockTimestamp - vaultOracleUpdatedAtSec >
      oracleToleranceSec ||
    !Number.isFinite(storedToLatestDeviationBps) ||
    storedToLatestDeviationBps > params.maxOraclePriceDeviationBps
  ) {
    return rejected(attemptedAtSec, "oracle-invalid", blocks);
  }

  const maxWithdrawable = mdwr[2] as bigint;
  const maxRedeemable = mdwr[3] as bigint;
  if (
    ethereumTotalSupply <= 0n ||
    totalAssets <= 0n ||
    totalAssets !== underlyingBalance ||
    totalAssets !== maxWithdrawable ||
    maxRedeemable <= 0n
  ) {
    return rejected(attemptedAtSec, "capacity-invalid", blocks);
  }
  const cappedShares =
    ethereumTotalSupply < maxRedeemable
      ? ethereumTotalSupply
      : maxRedeemable;
  const ethereumSupplyState = await runAdapterIo(
    ctx,
    "sfrxusd-route-ethereum-supply-assets",
    () =>
      observeRouteWave(
        client,
        ETHEREUM,
        [routeObservation("ethereum-supply-assets", sfrxUsdProxyAddress, "convertToAssets", [ethereumTotalSupply])],
        ethereumBlock.blockNumber,
        ethereumOptions,
      ),
    { signal },
  );
  const ethereumSupplyAssets = ethereumSupplyState
    ? ethereumSupplyState["ethereum-supply-assets"]
    : null;
  if (
    typeof ethereumSupplyAssets !== "bigint" ||
    ethereumSupplyAssets <= 0n ||
    relativeDeviationBps(
      (ethereumSupplyAssets * E18) / ethereumTotalSupply,
      storedPrice,
    ) > params.maxOraclePriceDeviationBps
  ) {
    return rejected(attemptedAtSec, "capacity-invalid", blocks);
  }

  const recipient = addressAsBytes32(sfrxUsdProxyAddress);
  if (!recipient) {
    return rejected(attemptedAtSec, "identity-mismatch", blocks);
  }
  const inputShares = COST_REQUESTS_USD.map((request) =>
    divCeil(BigInt(request) * E18 * E18, storedPrice),
  );
  const previewOutputs = inputShares.map((shares) => {
    const grossOutput = (shares * storedPrice) / E18;
    return ((E18 - feeRaw) * grossOutput) / E18;
  });
  const fields = quoteFields({
    params,
    recipient,
    inputShares,
    previewOutputs,
    cappedShares,
  });
  const [ethereumQuotes, fraxtalQuotes] = await Promise.all([
    runAdapterIo(
      ctx,
      "sfrxusd-route-ethereum-quotes",
      () =>
        observeRouteWave(client, ETHEREUM, fields.ethereum, ethereumBlock.blockNumber, ethereumOptions),
      { signal },
    ),
    runAdapterIo(
      ctx,
      "sfrxusd-route-fraxtal-quotes",
      () =>
        observeRouteWave(client, FRAXTAL, fields.fraxtal, fraxtalBlock.blockNumber, fraxtalOptions),
      { signal },
    ),
  ]);
  if (!ethereumQuotes || !fraxtalQuotes) {
    return rejected(attemptedAtSec, "quote-unavailable", blocks);
  }
  const cappedPreviewOutput = fraxtalQuotes["capacity-preview"];
  if (
    typeof cappedPreviewOutput !== "bigint" ||
    cappedPreviewOutput <= 0n
  ) {
    return rejected(attemptedAtSec, "capacity-invalid", blocks);
  }
  const grossCapacityAssetsRaw = (cappedShares * storedPrice) / E18;
  const capacityUsd = raw18ToNumber(cappedPreviewOutput);
  if (
    cappedPreviewOutput > grossCapacityAssetsRaw ||
    !Number.isFinite(capacityUsd) ||
    capacityUsd <= 0
  ) {
    return rejected(attemptedAtSec, "capacity-invalid", blocks);
  }

  const protocolCostCurve = COST_REQUESTS_USD.map((request, index) => {
    const ethereumQuote = ethereumQuotes[`ethereum-quote:${index}`];
    const previewOutput = fraxtalQuotes[`preview:${index}`];
    const returnQuote = fraxtalQuotes[`fraxtal-return-quote:${index}`];
    if (
      !ethereumQuote ||
      !returnQuote ||
      typeof previewOutput !== "bigint" ||
      previewOutput !== previewOutputs[index] ||
      ethereumQuote.lzTokenFee !== 0n ||
      returnQuote.lzTokenFee !== 0n ||
      ethereumQuote.nativeFee < remoteServiceFee
    ) {
      return null;
    }
    const ethereumToFraxtalNativeFee =
      ethereumQuote.nativeFee - remoteServiceFee;
    const totalUserNativeFeeUsd =
      raw18ToNumber(ethereumQuote.nativeFee) * ethPriceUsd;
    const redemptionOutputLossUsd = Math.max(
      0,
      request - raw18ToNumber(previewOutput),
    );
    const knownProtocolCostUsd =
      totalUserNativeFeeUsd + redemptionOutputLossUsd;
    return {
      requestedNotionalUsd: request,
      inputSharesRaw: inputShares[index].toString(),
      previewOutputFrxUsdRaw: previewOutput.toString(),
      ethereumToFraxtalNativeFeeRaw:
        ethereumToFraxtalNativeFee.toString(),
      remoteHopServiceFeeRaw: remoteServiceFee.toString(),
      fraxtalToEthereumNativeFeeRaw: returnQuote.nativeFee.toString(),
      totalUserNativeFeeRaw: ethereumQuote.nativeFee.toString(),
      totalUserNativeFeeUsd,
      redemptionOutputLossUsd,
      knownProtocolCostUsd,
      knownProtocolCostBps:
        (knownProtocolCostUsd / request) * BPS,
      transactionGasUsd: null,
      allInCostBps: null,
    };
  });
  if (protocolCostCurve.some((point) => point == null)) {
    return rejected(attemptedAtSec, "quote-invalid", blocks);
  }
  if (
    protocolCostCurve.some(
      (point) =>
        BigInt(point!.fraxtalToEthereumNativeFeeRaw) >
        fraxtalHopNativeBalance,
    )
  ) {
    return rejected(
      attemptedAtSec,
      "native-funding-insufficient",
      blocks,
    );
  }

  const state = {
    kind: "sfrxusd-crosschain-v1" as const,
    routeScope: {
      chain: "ethereum" as const,
      tokenAddress: normalizeExpectedAddress(sfrxUsdProxyAddress)!,
      outputTrackedAssetId: "frxusd-frax" as const,
    },
    ethereumBlock,
    fraxtalBlock,
    crossChainBlockSkewSec,
    maxCrossChainBlockSkewSec: params.maxCrossChainBlockSkewSec,
    contractIdentities: identities.identities,
    ethUsdOracle: {
      feedAddress: normalizeExpectedAddress(params.expectedEthUsdFeedAddress)!,
      aggregatorAddress: normalizeExpectedAddress(
        params.expectedEthUsdAggregatorAddress,
      )!,
      roundId: ethRoundId.toString(),
      answeredInRound: ethAnsweredInRound.toString(),
      answerE8: ethAnswer.toString(),
      updatedAt: ethUpdatedAtSec,
      ageSec: ethereumBlock.blockTimestamp - ethUpdatedAtSec,
      maxAgeSec: params.maxEthUsdOracleAgeSec,
      priceUsd: ethPriceUsd,
    },
    vaultOracle: {
      oracleAddress: normalizeExpectedAddress(
        params.expectedVaultOracleAddress,
      )!,
      roundId: vaultRoundId.toString(),
      answeredInRound: vaultAnsweredInRound.toString(),
      answerE18: vaultOracleAnswer.toString(),
      updatedAt: vaultOracleUpdatedAtSec,
      ageSec: fraxtalBlock.blockTimestamp - vaultOracleUpdatedAtSec,
      configuredToleranceSec: oracleToleranceSec,
      storedPriceE18: storedPrice.toString(),
      storedPriceReadAt: lastOracleReadSec,
      storedPriceAgeSec:
        fraxtalBlock.blockTimestamp - lastOracleReadSec,
      storedToLatestDeviationBps,
      maxPriceDeviationBps: params.maxOraclePriceDeviationBps,
    },
    capacity: {
      ethereumTotalSupplySharesRaw: ethereumTotalSupply.toString(),
      ethereumSupplyAssetsRaw: ethereumSupplyAssets.toString(),
      mintRedeemerTotalAssetsFrxUsdRaw: totalAssets.toString(),
      mintRedeemerBalanceFrxUsdRaw: underlyingBalance.toString(),
      mintRedeemerMdwrWithdrawableFrxUsdRaw: maxWithdrawable.toString(),
      mintRedeemerMaxRedeemSharesRaw: maxRedeemable.toString(),
      cappedRedeemableSharesRaw: cappedShares.toString(),
      cappedPreviewOutputFrxUsdRaw: cappedPreviewOutput.toString(),
      vaultPriceE18: storedPrice.toString(),
      capacityUsd,
    },
    mintRedeemerFeeRaw: feeRaw.toString(),
    mintRedeemerFeeBps: feeBps,
    fraxtalHopNativeBalanceRaw: fraxtalHopNativeBalance.toString(),
    protocolCostCurve: protocolCostCurve.filter(
      (point): point is NonNullable<typeof point> => point != null,
    ),
    missingAllInCostComponents: ["ethereum-transaction-gas"] as const,
    settlementUpperBoundSec: null,
    settlementEvidence: "unbounded" as const,
    sourceUrls: params.sourceUrls,
  };
  const parsed = SfrxusdCrosschainV9RouteStateSchema.safeParse(state);
  if (!parsed.success) {
    return rejected(attemptedAtSec, "packet-invalid", blocks);
  }
  return {
    status: "accepted",
    attemptedAtSec,
    state: parsed.data,
  };
}

export async function observeSfrxusdCrosschainRedemptionRoute(
  params: SfrxusdRouteParams,
  sfrxUsdProxyAddress: string,
  signal: AbortSignal,
  ctx?: AdapterContext,
  options: {
    attemptedAtSec?: number;
    ethereumRpcUrls?: string[];
    client?: SfrxusdCrosschainRouteReadClient;
  } = {},
): Promise<SfrxusdCrosschainV9RouteAttempt> {
  const attemptedAtSec = Math.floor(
    options.attemptedAtSec ?? ctx?.nowSec ?? Date.now() / 1_000,
  );
  try {
    return await observeWithClient(
      params,
      sfrxUsdProxyAddress,
      signal,
      ctx,
      attemptedAtSec,
      options.ethereumRpcUrls ?? [],
      options.client ?? DEFAULT_CLIENT,
    );
  } catch (error) {
    rethrowIfAborted(error, signal);
    return rejected(attemptedAtSec, "rpc-unavailable");
  }
}
