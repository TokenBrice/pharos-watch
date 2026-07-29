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
} from "./evm-rpc";
import { DECIMALS_SELECTOR, TOTAL_SUPPLY_SELECTOR } from "./evm-selectors";
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
import {
  decodeEvmAddress,
  decodeEvmAddressHex,
  decodeEvmHexBytes,
  decodeEvmUint256,
  fetchReviewedDeploymentSolanaObservation,
  safetyScoreV9EvmObservationOptions,
  type SafetyScoreV9SolanaRpcFetcher,
} from "./safety-score-v9-supply-observation-primitives";

const EIP1967_IMPLEMENTATION_SLOT =
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const M_TOKEN_SELECTOR = "0xc3b6f939";
const MINTER_GATEWAY_SELECTOR = "0x48545a3c";
const PORTAL_SELECTOR = "0x6425666b";
const PLUME_RPC_URL = "https://rpc.plume.org";
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

function rpcOptions(
  chainId: string,
  chainRpcs: Map<string, ChainRpcConfig>,
  signal?: AbortSignal,
) {
  return safetyScoreV9EvmObservationOptions({
    chainRpcs,
    ...(chainId === "plume"
      ? { extraRpcUrls: [PLUME_RPC_URL] }
      : {}),
    signal,
  });
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

  const totalSupplyRaw = decodeEvmUint256(results[0]);
  const decimalsRaw = decodeEvmUint256(results[1]);
  const underlyingTokenAddress = decodeEvmAddress(results[2]);
  const controllerAddress = decodeEvmAddress(results[3]);
  const implementationAddress = decodeEvmAddressHex(implementationSlot);
  const runtimeBytes = decodeEvmHexBytes(runtimeCode);
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
    implementationCode === null
      ? null
      : decodeEvmHexBytes(implementationCode);
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

export type SolanaRpcFetcher = SafetyScoreV9SolanaRpcFetcher;

export async function fetchSolanaWmDeploymentObservation(
  routeId: string,
  contractAddress: string,
  signal?: AbortSignal,
  rpc?: SolanaRpcFetcher,
): Promise<ReviewedDeploymentSupplyObservation | null> {
  const identity = expectedWmDeploymentIdentity(routeId);
  if (!identity || identity.runtime !== "solana") return null;

  return fetchReviewedDeploymentSolanaObservation(
    {
      routeId,
      contractAddress,
      identity: {
        ...identity,
        controllerExecutable: true,
      },
      signal,
    },
    rpc,
  );
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
