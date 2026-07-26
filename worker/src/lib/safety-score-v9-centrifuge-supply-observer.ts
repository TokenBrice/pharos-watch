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
import {
  DECIMALS_SELECTOR,
  TOTAL_SUPPLY_SELECTOR,
  encodeAddress,
} from "./evm-selectors";
import { fetchJsonWithRetry } from "./fetch-retry";
import {
  buildReviewedDeploymentRouteInventory,
  deriveReviewedDeploymentUnitPartition,
  expectedCentrifugeDeploymentIdentity,
  normalizeReviewedDeploymentAddress,
  reviewedDeploymentIdentityValidationError,
  reviewedDeploymentObservationTimingIssue,
  type ReviewedDeploymentSupplyObservation,
  type ReviewedDeploymentUnitPartitionV1,
} from "./safety-score-v9-supply-attribution-contract";

const EIP1967_IMPLEMENTATION_SLOT =
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const WARDS_SELECTOR = "0xbf353dbb";
const ZERO_STORAGE_WORD = `0x${"0".repeat(64)}`;
const MAX_SCORING_CLOCK_REWIND_BLOCKS = 128;
const SOLANA_RPC_URLS = [
  "https://api.mainnet-beta.solana.com",
  "https://api.mainnet.solana.com",
  "https://solana-rpc.publicnode.com",
] as const;

export type CentrifugeReviewedDeploymentRejectionCode =
  | "route-inventory-unavailable"
  | "deployment-identity-unavailable"
  | "chain-rpc-unavailable"
  | "safe-block-unavailable"
  | "deployment-state-unavailable"
  | "deployment-state-invalid"
  | "deployment-identity-mismatch"
  | "deployment-observation-skew"
  | "packet-reconciliation-failed";

export type CentrifugeReviewedDeploymentObservationAttempt =
  | {
      status: "accepted";
      attribution: ReviewedDeploymentUnitPartitionV1;
    }
  | {
      status: "rejected";
      rejectionCode: CentrifugeReviewedDeploymentRejectionCode;
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

interface SolanaControllerAccountValue {
  owner?: string;
  executable?: boolean;
}

interface SolanaMultipleAccountsResult {
  context?: { slot?: number };
  value?: [
    SolanaMintAccountValue | null,
    SolanaControllerAccountValue | null,
  ];
}

interface SolanaBlockResult {
  blockhash?: string;
  blockTime?: number | null;
}

interface CentrifugeObserverDependencies {
  sha256HexFromBytes: typeof sha256HexFromBytes;
  fetchEvmBlockNumber: typeof fetchEvmBlockNumber;
  fetchEvmBlockHeader: typeof fetchEvmBlockHeader;
  fetchEvmCodeAtBlock: typeof fetchEvmCodeAtBlock;
  fetchEvmMulticall3Aggregate3AtBlock:
    typeof fetchEvmMulticall3Aggregate3AtBlock;
  fetchEvmStorageAtBlock: typeof fetchEvmStorageAtBlock;
  fetchSolanaObservation: (
    assetId: string,
    routeId: string,
    contractAddress: string,
    signal?: AbortSignal,
  ) => Promise<ReviewedDeploymentSupplyObservation | null>;
}

const DEFAULT_DEPENDENCIES: CentrifugeObserverDependencies = {
  sha256HexFromBytes,
  fetchEvmBlockNumber,
  fetchEvmBlockHeader,
  fetchEvmCodeAtBlock,
  fetchEvmMulticall3Aggregate3AtBlock,
  fetchEvmStorageAtBlock,
  fetchSolanaObservation: fetchSolanaCentrifugeDeploymentObservation,
};

type DeploymentObservationResult =
  | { status: "accepted"; observation: ReviewedDeploymentSupplyObservation }
  | {
      status: "rejected";
      rejectionCode: CentrifugeReviewedDeploymentRejectionCode;
      failedRouteId: string;
    };

function rejectDeployment(
  failedRouteId: string,
  rejectionCode: CentrifugeReviewedDeploymentRejectionCode,
): DeploymentObservationResult {
  return { status: "rejected", rejectionCode, failedRouteId };
}

function decodeUint256(result: EvmMulticall3Result | undefined): bigint | null {
  if (!result?.success || !/^0x[0-9a-fA-F]{64}$/.test(result.returnData)) {
    return null;
  }
  return BigInt(result.returnData);
}

function decodeHexBytes(value: string): Uint8Array | null {
  const body = value.startsWith("0x") ? value.slice(2) : value;
  if (body.length === 0 || body.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(body)) {
    return null;
  }
  const bytes = new Uint8Array(body.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(
      body.slice(index * 2, index * 2 + 2),
      16,
    );
  }
  return bytes;
}

async function observeCentrifugeEvmDeployment(
  assetId: string,
  routeId: string,
  chainId: string,
  contractAddress: string,
  scoringClockSec: number,
  chainRpcs: Map<string, ChainRpcConfig>,
  dependencies: CentrifugeObserverDependencies,
  signal?: AbortSignal,
): Promise<DeploymentObservationResult> {
  const identity = expectedCentrifugeDeploymentIdentity(assetId, routeId);
  if (!identity || identity.runtime !== "evm") {
    return rejectDeployment(routeId, "deployment-identity-unavailable");
  }
  if (!chainRpcs.has(chainId) && (identity.extraRpcUrls?.length ?? 0) === 0) {
    return rejectDeployment(routeId, "chain-rpc-unavailable");
  }

  const options = {
    chainRpcs,
    ...(identity.extraRpcUrls
      ? { extraRpcUrls: [...identity.extraRpcUrls] }
      : {}),
    signal,
    timeoutMs: 10_000,
    maxRetries: 1,
  };
  const headBlockNumber = await dependencies.fetchEvmBlockNumber(
    chainId,
    options,
  );
  if (
    headBlockNumber === null ||
    !Number.isSafeInteger(identity.safeBlockLag) ||
    identity.safeBlockLag <= 0 ||
    headBlockNumber < identity.safeBlockLag
  ) {
    return rejectDeployment(routeId, "safe-block-unavailable");
  }

  let blockNumber = headBlockNumber - identity.safeBlockLag;
  let blockHeader: EvmBlockHeader | null = null;
  for (
    let rewind = 0;
    rewind <= MAX_SCORING_CLOCK_REWIND_BLOCKS && blockNumber >= 0;
    rewind += 1
  ) {
    throwIfAborted(signal);
    blockHeader = await dependencies.fetchEvmBlockHeader(
      chainId,
      blockNumber,
      options,
    );
    if (blockHeader === null) {
      return rejectDeployment(routeId, "safe-block-unavailable");
    }
    if (blockHeader.timestamp <= scoringClockSec) break;
    blockNumber -= 1;
  }
  if (blockHeader === null || blockHeader.timestamp > scoringClockSec) {
    return rejectDeployment(routeId, "safe-block-unavailable");
  }

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
      label: "spoke-ward",
      target: contractAddress,
      callData: `${WARDS_SELECTOR}${encodeAddress(
        identity.controllerAddress,
      )}` as `0x${string}`,
      allowFailure: false,
    },
  ];
  const [results, runtimeCode, implementationSlot] = await Promise.all([
    dependencies.fetchEvmMulticall3Aggregate3AtBlock(
      chainId,
      calls,
      blockNumber,
      options,
    ),
    dependencies.fetchEvmCodeAtBlock(
      chainId,
      contractAddress,
      blockNumber,
      options,
    ),
    dependencies.fetchEvmStorageAtBlock(
      chainId,
      contractAddress,
      EIP1967_IMPLEMENTATION_SLOT,
      blockNumber,
      options,
    ),
  ]);
  if (
    !results ||
    results.length !== calls.length ||
    !runtimeCode ||
    !implementationSlot
  ) {
    return rejectDeployment(routeId, "deployment-state-unavailable");
  }

  const totalSupplyRaw = decodeUint256(results[0]);
  const decimalsRaw = decodeUint256(results[1]);
  const spokeWard = decodeUint256(results[2]);
  const runtimeBytes = decodeHexBytes(runtimeCode);
  if (
    totalSupplyRaw === null ||
    decimalsRaw === null ||
    decimalsRaw > 36n ||
    spokeWard !== 1n ||
    implementationSlot.toLowerCase() !== ZERO_STORAGE_WORD ||
    runtimeBytes === null
  ) {
    return rejectDeployment(routeId, "deployment-state-invalid");
  }

  const observation: ReviewedDeploymentSupplyObservation = {
    routeId,
    chainId,
    contractAddress: normalizeReviewedDeploymentAddress(
      chainId,
      contractAddress,
    ),
    decimals: Number(decimalsRaw),
    rawSupply: totalSupplyRaw.toString(),
    blockNumberOrSlot: blockNumber.toString(),
    blockTimeSec: blockHeader.timestamp,
    blockHash: blockHeader.hash,
    runtimeCodeSha256: dependencies.sha256HexFromBytes(runtimeBytes),
    controllerAddress: identity.controllerAddress,
  };
  return reviewedDeploymentIdentityValidationError(observation, assetId) ===
    null
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
    if (
      result?.response.ok &&
      !result.body.error &&
      result.body.result !== undefined
    ) {
      return result.body.result;
    }
  }
  return null;
}

export type CentrifugeSolanaRpcFetcher = <T>(
  method: string,
  params: unknown[],
  signal?: AbortSignal,
) => Promise<T | null>;

export async function fetchSolanaCentrifugeDeploymentObservation(
  assetId: string,
  routeId: string,
  contractAddress: string,
  signal?: AbortSignal,
  rpc: CentrifugeSolanaRpcFetcher = fetchSolanaRpc,
): Promise<ReviewedDeploymentSupplyObservation | null> {
  const identity = expectedCentrifugeDeploymentIdentity(assetId, routeId);
  if (!identity || identity.runtime !== "solana") return null;

  const accounts = await rpc<SolanaMultipleAccountsResult>(
    "getMultipleAccounts",
    [
      [contractAddress, identity.controllerAddress],
      { commitment: "finalized", encoding: "jsonParsed" },
    ],
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
    controller?.executable !== false ||
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

  const observation: ReviewedDeploymentSupplyObservation = {
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
  return reviewedDeploymentIdentityValidationError(observation, assetId) ===
    null
    ? observation
    : null;
}

export async function observeCentrifugeReviewedDeploymentUnitPartitionAttempt(
  input: {
    assetId: string;
    aggregateSupplyUsd: number;
    registryFingerprint: string;
    scoringClockSec: number;
    chainRpcs: Map<string, ChainRpcConfig>;
    signal?: AbortSignal;
  },
  dependencyOverrides: Partial<CentrifugeObserverDependencies> = {},
): Promise<CentrifugeReviewedDeploymentObservationAttempt> {
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...dependencyOverrides };
  const inventory = buildReviewedDeploymentRouteInventory(input.assetId);
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
    const identity = expectedCentrifugeDeploymentIdentity(
      input.assetId,
      route.routeId,
    );
    if (!identity) {
      return {
        status: "rejected",
        rejectionCode: "deployment-identity-unavailable",
        failedRouteId: route.routeId,
      };
    }
    const result =
      identity.runtime === "evm"
        ? await observeCentrifugeEvmDeployment(
            input.assetId,
            route.routeId,
            route.chainId,
            route.contractAddress,
            input.scoringClockSec,
            input.chainRpcs,
            dependencies,
            input.signal,
          )
        : await dependencies
            .fetchSolanaObservation(
              input.assetId,
              route.routeId,
              route.contractAddress,
              input.signal,
            )
            .then<DeploymentObservationResult>((observation) =>
              observation
                ? { status: "accepted", observation }
                : rejectDeployment(
                    route.routeId,
                    "deployment-state-unavailable",
                  ),
            );
    if (result.status === "rejected") return result;
    const identityError = reviewedDeploymentIdentityValidationError(
      result.observation,
      input.assetId,
    );
    if (identityError) {
      return {
        status: "rejected",
        rejectionCode: "deployment-identity-mismatch",
        failedRouteId: route.routeId,
      };
    }
    observations.push(result.observation);
  }

  const blockTimes = observations.map(
    (observation) => observation.blockTimeSec,
  );
  const captureStartedAtSec = Math.min(...blockTimes);
  const captureEndedAtSec = Math.max(...blockTimes);
  const timingIssue = reviewedDeploymentObservationTimingIssue({
    assetId: input.assetId,
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
    assetId: input.assetId,
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

export async function observeCentrifugeReviewedDeploymentUnitPartition(
  input: {
    assetId: string;
    aggregateSupplyUsd: number;
    registryFingerprint: string;
    scoringClockSec: number;
    chainRpcs: Map<string, ChainRpcConfig>;
    signal?: AbortSignal;
  },
  dependencyOverrides: Partial<CentrifugeObserverDependencies> = {},
): Promise<ReviewedDeploymentUnitPartitionV1 | null> {
  const attempt =
    await observeCentrifugeReviewedDeploymentUnitPartitionAttempt(
      input,
      dependencyOverrides,
    );
  return attempt.status === "accepted" ? attempt.attribution : null;
}
