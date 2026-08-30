import type { LiveReserveAdapterParamsByKey } from "@shared/lib/live-reserve-adapters";
import {
  SfrxusdCrosschainV9RouteStateSchema,
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
import {
  decodeFunctionResult,
  encodeFunctionData,
  parseAbi,
} from "viem/utils";
import type { AdapterContext } from "./types";
import { runAdapterIo } from "./concurrency";
import { normalizeEvmAddress } from "./evm";
import { multicallResultByLabel, runtimeCodeHash } from "./onchain-identity";
import { codeIdentityChecks } from "./evm-observation-plan";
import type { EvmCodeIdentity } from "./evm-observation-plan";

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
const COST_REQUESTS_USD = [100_000, 1_000_000, 5_000_000, 25_000_000] as const;

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

function call(
  label: string,
  target: string,
  functionName: string,
  args?: readonly unknown[],
): EvmMulticall3Call {
  return {
    label,
    target,
    callData: encodeFunctionData({
      abi: ROUTE_ABI,
      functionName,
      ...(args ? { args } : {}),
    } as Parameters<typeof encodeFunctionData>[0]),
    allowFailure: false,
  };
}

function decodeResult(
  results: readonly EvmMulticall3Result[],
  label: string,
  functionName: string,
): unknown {
  const data = multicallResultByLabel(results, label);
  if (!data) return null;
  try {
    return decodeFunctionResult({
      abi: ROUTE_ABI,
      functionName,
      data,
    } as Parameters<typeof decodeFunctionResult>[0]);
  } catch {
    return null;
  }
}

/** Label and function name for one entry of a batch decode. */
type DecodeSpec<K extends string> = Record<
  K,
  readonly [label: string, functionName: string]
>;

function decodeResults<K extends string>(
  results: readonly EvmMulticall3Result[],
  spec: DecodeSpec<K>,
): Record<K, unknown> {
  const decoded = {} as Record<K, unknown>;
  for (const key of Object.keys(spec) as K[]) {
    decoded[key] = decodeResult(results, spec[key][0], spec[key][1]);
  }
  return decoded;
}

function decodeAddresses<K extends string>(
  results: readonly EvmMulticall3Result[],
  spec: DecodeSpec<K>,
): Record<K, string | null> {
  const decoded = {} as Record<K, string | null>;
  for (const key of Object.keys(spec) as K[]) {
    decoded[key] = decodeAddress(results, spec[key][0], spec[key][1]);
  }
  return decoded;
}

function decodeAddress(
  results: readonly EvmMulticall3Result[],
  label: string,
  functionName: string,
): string | null {
  const decoded = decodeResult(results, label, functionName);
  return normalizeEvmAddress(typeof decoded === "string" ? decoded : undefined);
}

function decodeRoundData(
  results: readonly EvmMulticall3Result[],
  label: string,
): readonly [bigint, bigint, bigint, bigint, bigint] | null {
  const decoded = decodeResult(results, label, "latestRoundData");
  return Array.isArray(decoded) &&
    decoded.length === 5 &&
    decoded.every((value) => typeof value === "bigint")
    ? (decoded as unknown as readonly [bigint, bigint, bigint, bigint, bigint])
    : null;
}

function decodeMessagingFee(
  results: readonly EvmMulticall3Result[],
  label: string,
): MessagingFee | null {
  const decoded = decodeResult(results, label, "quote");
  if (
    decoded == null ||
    typeof decoded !== "object" ||
    !("nativeFee" in decoded) ||
    !("lzTokenFee" in decoded) ||
    typeof decoded.nativeFee !== "bigint" ||
    typeof decoded.lzTokenFee !== "bigint"
  ) {
    return null;
  }
  return {
    nativeFee: decoded.nativeFee,
    lzTokenFee: decoded.lzTokenFee,
  };
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

function raw18ToNumber(value: bigint): number {
  return Number(value / E18) + Number(value % E18) / 1e18;
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

function ethereumBaseCalls(
  params: SfrxusdRouteParams,
  sfrxUsdProxyAddress: string,
): EvmMulticall3Call[] {
  const hop = params.remoteHopAddress;
  const frxOft = params.expectedEthereumFrxUsdOftAddress;
  const sfrxOft = params.expectedEthereumSfrxUsdOftAddress;
  const ethUsdFeed = params.expectedEthUsdFeedAddress;
  return [
    call("remote-paused", hop, "paused"),
    call("remote-fraxtal-hop", hop, "fraxtalHop"),
    call("remote-eid", hop, "EID"),
    call("remote-frx-oft", hop, "frxUsdOft"),
    call("remote-sfrx-oft", hop, "sfrxUsdOft"),
    call("remote-service-fee", hop, "quoteHop"),
    call("frx-oft-token", frxOft, "token"),
    call("frx-oft-conversion-rate", frxOft, "decimalConversionRate"),
    call("sfrx-oft-token", sfrxOft, "token"),
    call("sfrx-oft-conversion-rate", sfrxOft, "decimalConversionRate"),
    call("ethereum-frx-decimals", params.expectedEthereumFrxUsdAddress, "decimals"),
    call("ethereum-sfrx-decimals", sfrxUsdProxyAddress, "decimals"),
    call("ethereum-sfrx-asset", sfrxUsdProxyAddress, "asset"),
    call("ethereum-sfrx-total-supply", sfrxUsdProxyAddress, "totalSupply"),
    call("eth-usd-aggregator", ethUsdFeed, "aggregator"),
    call("eth-usd-decimals", ethUsdFeed, "decimals"),
    call("eth-usd-round", ethUsdFeed, "latestRoundData"),
  ];
}

function fraxtalBaseCalls(
  params: SfrxusdRouteParams,
): EvmMulticall3Call[] {
  const hop = params.expectedFraxtalHopAddress;
  const redeemer = params.mintRedeemerProxyAddress;
  const vaultOracle = params.expectedVaultOracleAddress;
  return [
    call("fraxtal-hop-paused", hop, "paused"),
    call("fraxtal-hop-redeemer", hop, "fraxtalERC4626MintRedeemer"),
    call("fraxtal-hop-frx-lockbox", hop, "frxUsdLockbox"),
    call("fraxtal-hop-sfrx-lockbox", hop, "sfrxUsdLockbox"),
    call("fraxtal-hop-remote", hop, "remoteHop", [params.expectedEthereumEid]),
    call("fraxtal-hop-native-balance", MULTICALL3_ADDRESS, "getEthBalance", [
      hop as Hex,
    ]),
    call("fraxtal-frx-lockbox-token", params.expectedFrxUsdLockboxAddress, "token"),
    call(
      "fraxtal-frx-lockbox-conversion-rate",
      params.expectedFrxUsdLockboxAddress,
      "decimalConversionRate",
    ),
    call("fraxtal-sfrx-lockbox-token", params.expectedSfrxUsdLockboxAddress, "token"),
    call(
      "fraxtal-sfrx-lockbox-conversion-rate",
      params.expectedSfrxUsdLockboxAddress,
      "decimalConversionRate",
    ),
    call("fraxtal-frx-decimals", params.expectedFraxtalFrxUsdAddress, "decimals"),
    call("fraxtal-sfrx-decimals", params.expectedFraxtalSfrxUsdAddress, "decimals"),
    call("redeemer-underlying", redeemer, "underlyingTkn"),
    call("redeemer-vault", redeemer, "vaultTkn"),
    call("redeemer-underlying-oracle", redeemer, "priceFeedUnderlying"),
    call("redeemer-vault-oracle", redeemer, "priceFeedVault"),
    call("redeemer-fee", redeemer, "fee"),
    call("redeemer-oracle-tolerance", redeemer, "oracleTimeTolerance"),
    call("redeemer-stored-price", redeemer, "getVaultTknPriceStoredE18"),
    call("redeemer-latest-vault-price", redeemer, "getLatestVaultTknPriceE18"),
    call("redeemer-latest-underlying-price", redeemer, "getLatestUnderlyingPriceE18"),
    call("redeemer-last-oracle-read", redeemer, "lastVaultTknOracleRead"),
    call("redeemer-total-assets", redeemer, "totalAssets"),
    call("redeemer-mdwr", redeemer, "mdwrComboView"),
    call(
      "redeemer-underlying-balance",
      params.expectedFraxtalFrxUsdAddress,
      "balanceOf",
      [redeemer as Hex],
    ),
    call("vault-oracle-decimals", vaultOracle, "decimals"),
    call("vault-oracle-round", vaultOracle, "latestRoundData"),
  ];
}

function quoteCalls(args: {
  params: SfrxusdRouteParams;
  recipient: Hex;
  inputShares: bigint[];
  previewOutputs: bigint[];
  cappedShares: bigint;
}): {
  ethereum: EvmMulticall3Call[];
  fraxtal: EvmMulticall3Call[];
} {
  const { params, recipient } = args;
  return {
    ethereum: args.inputShares.map((shares, index) =>
      call(`ethereum-quote:${index}`, params.remoteHopAddress, "quote", [
        params.expectedEthereumSfrxUsdOftAddress as Hex,
        recipient,
        shares,
      ]),
    ),
    fraxtal: [
      call(
        "capacity-preview",
        params.mintRedeemerProxyAddress,
        "previewRedeem",
        [args.cappedShares],
      ),
      ...args.inputShares.flatMap((shares, index) => [
        call(`preview:${index}`, params.mintRedeemerProxyAddress, "previewRedeem", [
          shares,
        ]),
        call(
          `fraxtal-return-quote:${index}`,
          params.expectedFraxtalHopAddress,
          "quote",
          [
            params.expectedFrxUsdLockboxAddress as Hex,
            params.expectedEthereumEid,
            recipient,
            args.previewOutputs[index],
          ],
        ),
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
        client.multicall(
          ETHEREUM,
          ethereumBaseCalls(params, sfrxUsdProxyAddress),
          ethereumBlock.blockNumber,
          ethereumOptions,
        ),
      { signal },
    ),
    runAdapterIo(
      ctx,
      "sfrxusd-route-fraxtal-state",
      () =>
        client.multicall(
          FRAXTAL,
          fraxtalBaseCalls(params),
          fraxtalBlock.blockNumber,
          fraxtalOptions,
        ),
      { signal },
    ),
  ]);
  if (!ethereumState || !fraxtalState) {
    return rejected(attemptedAtSec, "state-unavailable", blocks);
  }

  const {
    remotePaused,
    remoteFraxtalHop,
    ethereumEid,
    remoteServiceFee,
    frxOftConversionRate,
    sfrxOftConversionRate,
    ethereumFrxDecimals,
    ethereumSfrxDecimals,
    ethereumTotalSupply,
    ethUsdDecimals,
  } = decodeResults(ethereumState, {
    remotePaused: ["remote-paused", "paused"],
    remoteFraxtalHop: ["remote-fraxtal-hop", "fraxtalHop"],
    ethereumEid: ["remote-eid", "EID"],
    remoteServiceFee: ["remote-service-fee", "quoteHop"],
    frxOftConversionRate: ["frx-oft-conversion-rate", "decimalConversionRate"],
    sfrxOftConversionRate: ["sfrx-oft-conversion-rate", "decimalConversionRate"],
    ethereumFrxDecimals: ["ethereum-frx-decimals", "decimals"],
    ethereumSfrxDecimals: ["ethereum-sfrx-decimals", "decimals"],
    ethereumTotalSupply: ["ethereum-sfrx-total-supply", "totalSupply"],
    ethUsdDecimals: ["eth-usd-decimals", "decimals"],
  });
  const {
    frxOft,
    sfrxOft,
    frxOftToken,
    sfrxOftToken,
    ethereumSfrxAsset,
    ethUsdAggregator,
  } = decodeAddresses(ethereumState, {
    frxOft: ["remote-frx-oft", "frxUsdOft"],
    sfrxOft: ["remote-sfrx-oft", "sfrxUsdOft"],
    frxOftToken: ["frx-oft-token", "token"],
    sfrxOftToken: ["sfrx-oft-token", "token"],
    ethereumSfrxAsset: ["ethereum-sfrx-asset", "asset"],
    ethUsdAggregator: ["eth-usd-aggregator", "aggregator"],
  });
  const ethUsdRound = decodeRoundData(ethereumState, "eth-usd-round");
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
    fraxtalHopPaused,
    hopRemote,
    fraxtalHopNativeBalance,
    frxLockboxConversionRate,
    sfrxLockboxConversionRate,
    fraxtalFrxDecimals,
    fraxtalSfrxDecimals,
  } = decodeResults(fraxtalState, {
    fraxtalHopPaused: ["fraxtal-hop-paused", "paused"],
    hopRemote: ["fraxtal-hop-remote", "remoteHop"],
    fraxtalHopNativeBalance: ["fraxtal-hop-native-balance", "getEthBalance"],
    frxLockboxConversionRate: [
      "fraxtal-frx-lockbox-conversion-rate",
      "decimalConversionRate",
    ],
    sfrxLockboxConversionRate: [
      "fraxtal-sfrx-lockbox-conversion-rate",
      "decimalConversionRate",
    ],
    fraxtalFrxDecimals: ["fraxtal-frx-decimals", "decimals"],
    fraxtalSfrxDecimals: ["fraxtal-sfrx-decimals", "decimals"],
  });
  const { hopRedeemer, hopFrxLockbox, hopSfrxLockbox, frxLockboxToken, sfrxLockboxToken } =
    decodeAddresses(fraxtalState, {
      hopRedeemer: ["fraxtal-hop-redeemer", "fraxtalERC4626MintRedeemer"],
      hopFrxLockbox: ["fraxtal-hop-frx-lockbox", "frxUsdLockbox"],
      hopSfrxLockbox: ["fraxtal-hop-sfrx-lockbox", "sfrxUsdLockbox"],
      frxLockboxToken: ["fraxtal-frx-lockbox-token", "token"],
      sfrxLockboxToken: ["fraxtal-sfrx-lockbox-token", "token"],
    });
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

  const { redeemerUnderlying, redeemerVault, underlyingOracle, vaultOracle } =
    decodeAddresses(fraxtalState, {
      redeemerUnderlying: ["redeemer-underlying", "underlyingTkn"],
      redeemerVault: ["redeemer-vault", "vaultTkn"],
      underlyingOracle: ["redeemer-underlying-oracle", "priceFeedUnderlying"],
      vaultOracle: ["redeemer-vault-oracle", "priceFeedVault"],
    });
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
    feeRaw,
    oracleTolerance,
    storedPrice,
    latestVaultPrice,
    latestUnderlyingPrice,
    lastOracleRead,
    totalAssets,
    mdwr,
    underlyingBalance,
    vaultOracleDecimals,
  } = decodeResults(fraxtalState, {
    feeRaw: ["redeemer-fee", "fee"],
    oracleTolerance: ["redeemer-oracle-tolerance", "oracleTimeTolerance"],
    storedPrice: ["redeemer-stored-price", "getVaultTknPriceStoredE18"],
    latestVaultPrice: ["redeemer-latest-vault-price", "getLatestVaultTknPriceE18"],
    latestUnderlyingPrice: [
      "redeemer-latest-underlying-price",
      "getLatestUnderlyingPriceE18",
    ],
    lastOracleRead: ["redeemer-last-oracle-read", "lastVaultTknOracleRead"],
    totalAssets: ["redeemer-total-assets", "totalAssets"],
    mdwr: ["redeemer-mdwr", "mdwrComboView"],
    underlyingBalance: ["redeemer-underlying-balance", "balanceOf"],
    vaultOracleDecimals: ["vault-oracle-decimals", "decimals"],
  });
  const vaultOracleRound = decodeRoundData(
    fraxtalState,
    "vault-oracle-round",
  );
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
      client.multicall(
        ETHEREUM,
        [
          {
            label: "ethereum-supply-assets",
            target: sfrxUsdProxyAddress,
            callData: encodeFunctionData({
              abi: ROUTE_ABI,
              functionName: "convertToAssets",
              args: [ethereumTotalSupply],
            }),
            allowFailure: false,
          },
        ],
        ethereumBlock.blockNumber,
        ethereumOptions,
      ),
    { signal },
  );
  const ethereumSupplyAssets = ethereumSupplyState
    ? decodeResult(
        ethereumSupplyState,
        "ethereum-supply-assets",
        "convertToAssets",
      )
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
  const calls = quoteCalls({
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
        client.multicall(
          ETHEREUM,
          calls.ethereum,
          ethereumBlock.blockNumber,
          ethereumOptions,
        ),
      { signal },
    ),
    runAdapterIo(
      ctx,
      "sfrxusd-route-fraxtal-quotes",
      () =>
        client.multicall(
          FRAXTAL,
          calls.fraxtal,
          fraxtalBlock.blockNumber,
          fraxtalOptions,
        ),
      { signal },
    ),
  ]);
  if (!ethereumQuotes || !fraxtalQuotes) {
    return rejected(attemptedAtSec, "quote-unavailable", blocks);
  }
  const cappedPreviewOutput = decodeResult(
    fraxtalQuotes,
    "capacity-preview",
    "previewRedeem",
  );
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
    const ethereumQuote = decodeMessagingFee(
      ethereumQuotes,
      `ethereum-quote:${index}`,
    );
    const previewOutput = decodeResult(
      fraxtalQuotes,
      `preview:${index}`,
      "previewRedeem",
    );
    const returnQuote = decodeMessagingFee(
      fraxtalQuotes,
      `fraxtal-return-quote:${index}`,
    );
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
