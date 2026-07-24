import { sha256HexFromBytes } from "@shared/lib/sha256";
import { throwIfAborted } from "./abort";
import type { ChainRpcConfig } from "./chain-registry";
import {
  fetchEvmBlockHeader,
  fetchEvmBlockNumber,
  fetchEvmCodeAtBlock,
  fetchEvmMulticall3Aggregate3AtBlock,
  fetchEvmStorageAtBlock,
  type EvmBlockHeader,
  type EvmMulticall3Result,
} from "./evm-rpc";
import { DECIMALS_SELECTOR, TOTAL_SUPPLY_SELECTOR } from "./evm-selectors";
import { fetchJsonWithRetry } from "./fetch-retry";
import {
  buildReviewedDeploymentRouteInventory,
  deriveReviewedDeploymentUnitPartition,
  expectedWmDeploymentIdentity,
  normalizeReviewedDeploymentAddress,
  reviewedDeploymentIdentityValidationError,
  reviewedDeploymentObservationTimingIssue,
  type ReviewedDeploymentSupplyObservation,
  type ReviewedDeploymentUnitPartitionV1,
} from "./safety-score-v9-supply-attribution-contract";

const EIP1967_IMPLEMENTATION_SLOT =
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const M_TOKEN_SELECTOR = "0xc3b6f939";
const MINTER_GATEWAY_SELECTOR = "0x48545a3c";
const PORTAL_SELECTOR = "0x6425666b";
const PLUME_RPC_URL = "https://rpc.plume.org";
const SOLANA_RPC_URLS = [
  "https://api.mainnet-beta.solana.com",
  "https://api.mainnet.solana.com",
  "https://solana-rpc.publicnode.com",
] as const;
const MAX_SCORING_CLOCK_REWIND_BLOCKS = 128;

export const WM_EVM_SAFE_BLOCK_LAG_BY_CHAIN: Readonly<Record<string, number>> = {
  ethereum: 2,
  arbitrum: 96,
  base: 12,
  plume: 24,
};

export type WmReviewedDeploymentRejectionCode =
  | "route-inventory-unavailable"
  | "deployment-identity-unavailable"
  | "chain-rpc-unavailable"
  | "safe-block-unavailable"
  | "deployment-state-unavailable"
  | "deployment-state-invalid"
  | "deployment-identity-mismatch"
  | "deployment-observation-skew"
  | "packet-reconciliation-failed";

export type WmReviewedDeploymentObservationAttempt =
  | {
      status: "accepted";
      attribution: ReviewedDeploymentUnitPartitionV1;
    }
  | {
      status: "rejected";
      rejectionCode: WmReviewedDeploymentRejectionCode;
      failedRouteId: string | null;
    };

interface SolanaRpcEnvelope<T> {
  result?: T;
  error?: { code?: number; message?: string };
}

interface SolanaMintAccountValue {
  owner?: string;
  data?: {
    parsed?: {
      info?: {
        decimals?: number;
        supply?: string;
        mintAuthority?: string | null;
      };
    };
  };
}

interface SolanaProgramAccountValue {
  owner?: string;
  executable?: boolean;
}

interface SolanaMultipleAccountsResult {
  context?: { slot?: number };
  value?: [SolanaMintAccountValue | null, SolanaProgramAccountValue | null];
}

interface SolanaBlockResult {
  blockhash?: string;
  blockTime?: number | null;
}

interface WmObserverDependencies {
  sha256HexFromBytes: typeof sha256HexFromBytes;
  fetchEvmBlockNumber: typeof fetchEvmBlockNumber;
  fetchEvmBlockHeader: typeof fetchEvmBlockHeader;
  fetchEvmCodeAtBlock: typeof fetchEvmCodeAtBlock;
  fetchEvmMulticall3Aggregate3AtBlock: typeof fetchEvmMulticall3Aggregate3AtBlock;
  fetchEvmStorageAtBlock: typeof fetchEvmStorageAtBlock;
  fetchSolanaObservation: (
    routeId: string,
    contractAddress: string,
    signal?: AbortSignal,
  ) => Promise<ReviewedDeploymentSupplyObservation | null>;
}

const DEFAULT_DEPENDENCIES: WmObserverDependencies = {
  sha256HexFromBytes,
  fetchEvmBlockNumber,
  fetchEvmBlockHeader,
  fetchEvmCodeAtBlock,
  fetchEvmMulticall3Aggregate3AtBlock,
  fetchEvmStorageAtBlock,
  fetchSolanaObservation: fetchSolanaWmDeploymentObservation,
};

function decodeUint256(result: EvmMulticall3Result | undefined): bigint | null {
  if (!result?.success || !/^0x[0-9a-fA-F]{64}$/.test(result.returnData)) return null;
  return BigInt(result.returnData);
}

function decodeAddressHex(value: string | undefined): string | null {
  if (!value || !/^0x[0-9a-fA-F]{64}$/.test(value)) return null;
  const address = `0x${value.slice(-40).toLowerCase()}`;
  return /^0x[0-9a-f]{40}$/.test(address) && address !== "0x0000000000000000000000000000000000000000"
    ? address
    : null;
}

function decodeAddress(result: EvmMulticall3Result | undefined): string | null {
  return result?.success ? decodeAddressHex(result.returnData) : null;
}

function decodeHexBytes(value: string): Uint8Array | null {
  const body = value.startsWith("0x") ? value.slice(2) : value;
  if (body.length === 0 || body.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(body)) return null;
  const bytes = new Uint8Array(body.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(body.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function rpcOptions(
  chainId: string,
  chainRpcs: Map<string, ChainRpcConfig>,
  signal?: AbortSignal,
) {
  return {
    chainRpcs,
    ...(chainId === "plume" ? { extraRpcUrls: [PLUME_RPC_URL] } : {}),
    signal,
    timeoutMs: 10_000,
    maxRetries: 1,
  };
}

type WmDeploymentObservationResult =
  | { status: "accepted"; observation: ReviewedDeploymentSupplyObservation }
  | {
      status: "rejected";
      rejectionCode: WmReviewedDeploymentRejectionCode;
      failedRouteId: string;
    };

function rejectDeployment(
  failedRouteId: string,
  rejectionCode: WmReviewedDeploymentRejectionCode,
): WmDeploymentObservationResult {
  return { status: "rejected", rejectionCode, failedRouteId };
}

async function observeWmEvmDeployment(
  routeId: string,
  chainId: string,
  contractAddress: string,
  scoringClockSec: number,
  chainRpcs: Map<string, ChainRpcConfig>,
  dependencies: WmObserverDependencies,
  signal?: AbortSignal,
): Promise<WmDeploymentObservationResult> {
  const identity = expectedWmDeploymentIdentity(routeId);
  if (!identity || identity.runtime !== "evm") {
    return rejectDeployment(routeId, "deployment-identity-unavailable");
  }
  if (chainId !== "plume" && !chainRpcs.has(chainId)) {
    return rejectDeployment(routeId, "chain-rpc-unavailable");
  }

  const options = rpcOptions(chainId, chainRpcs, signal);
  const headBlockNumber = await dependencies.fetchEvmBlockNumber(chainId, options);
  const safetyLag = WM_EVM_SAFE_BLOCK_LAG_BY_CHAIN[chainId];
  if (
    headBlockNumber === null ||
    !Number.isSafeInteger(safetyLag) ||
    safetyLag <= 0 ||
    headBlockNumber < safetyLag
  ) {
    return rejectDeployment(routeId, "safe-block-unavailable");
  }

  let blockNumber = headBlockNumber - safetyLag;
  let blockHeader: EvmBlockHeader | null = null;
  for (
    let rewind = 0;
    rewind <= MAX_SCORING_CLOCK_REWIND_BLOCKS && blockNumber >= 0;
    rewind += 1
  ) {
    blockHeader = await dependencies.fetchEvmBlockHeader(chainId, blockNumber, options);
    if (blockHeader === null) return rejectDeployment(routeId, "safe-block-unavailable");
    if (blockHeader.timestamp <= scoringClockSec) break;
    blockNumber -= 1;
  }
  if (blockHeader === null || blockHeader.timestamp > scoringClockSec) {
    return rejectDeployment(routeId, "safe-block-unavailable");
  }

  const controllerSelector =
    identity.controllerRead === "minter-gateway" ? MINTER_GATEWAY_SELECTOR : PORTAL_SELECTOR;
  const calls = [
    {
      label: "total-supply",
      target: contractAddress,
      callData: TOTAL_SUPPLY_SELECTOR,
      allowFailure: false,
    },
    {
      label: "decimals",
      target: contractAddress,
      callData: DECIMALS_SELECTOR,
      allowFailure: false,
    },
    {
      label: "m-token",
      target: contractAddress,
      callData: M_TOKEN_SELECTOR,
      allowFailure: false,
    },
    {
      label: "controller",
      target: identity.underlyingTokenAddress,
      callData: controllerSelector,
      allowFailure: false,
    },
  ];
  const [results, runtimeCode, implementationSlot] = await Promise.all([
    dependencies.fetchEvmMulticall3Aggregate3AtBlock(chainId, calls, blockNumber, options),
    dependencies.fetchEvmCodeAtBlock(chainId, contractAddress, blockNumber, options),
    dependencies.fetchEvmStorageAtBlock(
      chainId,
      contractAddress,
      EIP1967_IMPLEMENTATION_SLOT,
      blockNumber,
      options,
    ),
  ]);
  if (!results || results.length !== calls.length || !runtimeCode || !implementationSlot) {
    return rejectDeployment(routeId, "deployment-state-unavailable");
  }

  const totalSupplyRaw = decodeUint256(results[0]);
  const decimalsRaw = decodeUint256(results[1]);
  const underlyingTokenAddress = decodeAddress(results[2]);
  const controllerAddress = decodeAddress(results[3]);
  const implementationAddress = decodeAddressHex(implementationSlot);
  const runtimeBytes = decodeHexBytes(runtimeCode);
  if (
    totalSupplyRaw === null ||
    decimalsRaw === null ||
    decimalsRaw > 36n ||
    underlyingTokenAddress === null ||
    controllerAddress === null ||
    implementationAddress === null ||
    runtimeBytes === null
  ) {
    return rejectDeployment(routeId, "deployment-state-invalid");
  }
  const implementationCode = await dependencies.fetchEvmCodeAtBlock(
    chainId,
    implementationAddress,
    blockNumber,
    options,
  );
  const implementationBytes =
    implementationCode === null ? null : decodeHexBytes(implementationCode);
  if (implementationBytes === null) {
    return rejectDeployment(routeId, "deployment-state-unavailable");
  }

  const observation: ReviewedDeploymentSupplyObservation = {
    routeId,
    chainId,
    contractAddress: normalizeReviewedDeploymentAddress(chainId, contractAddress),
    decimals: Number(decimalsRaw),
    rawSupply: totalSupplyRaw.toString(),
    blockNumberOrSlot: blockNumber.toString(),
    blockTimeSec: blockHeader.timestamp,
    blockHash: blockHeader.hash,
    runtimeCodeSha256: dependencies.sha256HexFromBytes(runtimeBytes),
    implementationAddress,
    implementationCodeSha256:
      dependencies.sha256HexFromBytes(implementationBytes),
    underlyingTokenAddress,
    controllerAddress,
  };
  return reviewedDeploymentIdentityValidationError(observation) === null
    ? { status: "accepted", observation }
    : rejectDeployment(routeId, "deployment-identity-mismatch");
}

async function fetchSolanaRpc<T>(
  method: string,
  params: unknown[],
  signal?: AbortSignal,
): Promise<T | null> {
  for (const rpcUrl of SOLANA_RPC_URLS) {
    throwIfAborted(signal);
    const result = await fetchJsonWithRetry<SolanaRpcEnvelope<T>>(
      rpcUrl,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal,
      },
      0,
      { timeoutMs: 10_000, maxResponseBytes: 128_000 },
    );
    if (result?.response.ok && !result.body.error && result.body.result !== undefined) {
      return result.body.result;
    }
  }
  return null;
}

export type SolanaRpcFetcher = <T>(
  method: string,
  params: unknown[],
  signal?: AbortSignal,
) => Promise<T | null>;

export async function fetchSolanaWmDeploymentObservation(
  routeId: string,
  contractAddress: string,
  signal?: AbortSignal,
  rpc: SolanaRpcFetcher = fetchSolanaRpc,
): Promise<ReviewedDeploymentSupplyObservation | null> {
  const identity = expectedWmDeploymentIdentity(routeId);
  if (!identity || identity.runtime !== "solana") return null;

  const accounts = await rpc<SolanaMultipleAccountsResult>(
    "getMultipleAccounts",
    [[contractAddress, identity.controllerAddress], { commitment: "finalized", encoding: "jsonParsed" }],
    signal,
  );
  const slot = accounts?.context?.slot;
  const mint = accounts?.value?.[0];
  const controller = accounts?.value?.[1];
  const info = mint?.data?.parsed?.info;
  if (
    !Number.isSafeInteger(slot) ||
    typeof info?.supply !== "string" ||
    !/^(0|[1-9][0-9]*)$/.test(info.supply) ||
    typeof info.decimals !== "number" ||
    !Number.isInteger(info.decimals) ||
    typeof info.mintAuthority !== "string" ||
    typeof mint?.owner !== "string" ||
    controller?.executable !== true ||
    typeof controller.owner !== "string"
  ) {
    return null;
  }

  const block = await rpc<SolanaBlockResult>(
    "getBlock",
    [
      slot,
      {
        commitment: "finalized",
        transactionDetails: "none",
        rewards: false,
        maxSupportedTransactionVersion: 0,
      },
    ],
    signal,
  );
  if (
    !Number.isSafeInteger(block?.blockTime) ||
    block!.blockTime! < 0 ||
    typeof block?.blockhash !== "string" ||
    !/^[1-9A-HJ-NP-Za-km-z]{32,64}$/.test(block.blockhash)
  ) {
    return null;
  }

  return {
    routeId,
    chainId: "solana",
    contractAddress,
    decimals: info.decimals,
    rawSupply: info.supply,
    blockNumberOrSlot: slot!.toString(),
    blockTimeSec: block!.blockTime!,
    blockHash: block!.blockhash!,
    programOwner: mint!.owner!,
    mintAuthority: info.mintAuthority,
    controllerAddress: identity.controllerAddress,
    controllerProgramOwner: controller!.owner!,
  };
}

export async function observeWmReviewedDeploymentUnitPartitionAttempt(
  input: {
    aggregateSupplyUsd: number;
    registryFingerprint: string;
    scoringClockSec: number;
    chainRpcs: Map<string, ChainRpcConfig>;
    signal?: AbortSignal;
  },
  dependencyOverrides: Partial<WmObserverDependencies> = {},
): Promise<WmReviewedDeploymentObservationAttempt> {
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...dependencyOverrides };
  const inventory = buildReviewedDeploymentRouteInventory("wm-m0");
  if (!inventory) {
    return {
      status: "rejected",
      rejectionCode: "route-inventory-unavailable",
      failedRouteId: null,
    };
  }

  const observations: ReviewedDeploymentSupplyObservation[] = [];
  for (const route of inventory.routes) {
    throwIfAborted(input.signal);
    const identity = expectedWmDeploymentIdentity(route.routeId);
    if (!identity) {
      return {
        status: "rejected",
        rejectionCode: "deployment-identity-unavailable",
        failedRouteId: route.routeId,
      };
    }
    const result =
      identity.runtime === "evm"
        ? await observeWmEvmDeployment(
            route.routeId,
            route.chainId,
            route.contractAddress,
            input.scoringClockSec,
            input.chainRpcs,
            dependencies,
            input.signal,
          )
        : await dependencies
            .fetchSolanaObservation(route.routeId, route.contractAddress, input.signal)
            .then<WmDeploymentObservationResult>((observation) =>
              observation
                ? { status: "accepted", observation }
                : rejectDeployment(route.routeId, "deployment-state-unavailable"),
            );
    if (result.status === "rejected") return result;
    const identityError = reviewedDeploymentIdentityValidationError(result.observation);
    if (identityError) {
      return {
        status: "rejected",
        rejectionCode: "deployment-identity-mismatch",
        failedRouteId: route.routeId,
      };
    }
    observations.push(result.observation);
  }

  const blockTimes = observations.map((observation) => observation.blockTimeSec);
  const captureStartedAtSec = Math.min(...blockTimes);
  const captureEndedAtSec = Math.max(...blockTimes);
  const timingIssue = reviewedDeploymentObservationTimingIssue({
    clockSec: input.scoringClockSec,
    captureStartedAtSec,
    captureEndedAtSec,
    observedAtSec: captureEndedAtSec,
    deployments: observations,
  });
  if (timingIssue) {
    return {
      status: "rejected",
      rejectionCode: "deployment-observation-skew",
      failedRouteId: timingIssue.failedRouteId,
    };
  }

  const attribution = deriveReviewedDeploymentUnitPartition({
    assetId: "wm-m0",
    aggregateSupplyUsd: input.aggregateSupplyUsd,
    registryFingerprint: input.registryFingerprint,
    scoringClockSec: input.scoringClockSec,
    observations,
  });
  return attribution
    ? { status: "accepted", attribution }
    : {
        status: "rejected",
        rejectionCode: "packet-reconciliation-failed",
        failedRouteId: null,
      };
}

export async function observeWmReviewedDeploymentUnitPartition(
  input: {
    aggregateSupplyUsd: number;
    registryFingerprint: string;
    scoringClockSec: number;
    chainRpcs: Map<string, ChainRpcConfig>;
    signal?: AbortSignal;
  },
  dependencyOverrides: Partial<WmObserverDependencies> = {},
): Promise<ReviewedDeploymentUnitPartitionV1 | null> {
  const attempt = await observeWmReviewedDeploymentUnitPartitionAttempt(
    input,
    dependencyOverrides,
  );
  return attempt.status === "accepted" ? attempt.attribution : null;
}
