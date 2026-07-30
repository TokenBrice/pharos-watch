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
import {
  DECIMALS_SELECTOR,
  TOTAL_SUPPLY_SELECTOR,
  encodeAddress,
} from "./evm-selectors";
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
import {
  decodeEvmHexBytes,
  decodeEvmUint256,
  fetchReviewedDeploymentSolanaObservation,
  safetyScoreV9EvmObservationOptions,
  type SafetyScoreV9SolanaRpcFetcher,
} from "./safety-score-v9-supply-observation-primitives";

const EIP1967_IMPLEMENTATION_SLOT =
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const WARDS_SELECTOR = "0xbf353dbb";
const ZERO_STORAGE_WORD = `0x${"0".repeat(64)}`;
const MAX_SCORING_CLOCK_REWIND_BLOCKS = 128;

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

  const options = safetyScoreV9EvmObservationOptions({
    chainRpcs,
    extraRpcUrls: identity.extraRpcUrls,
    signal,
  });
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

  const totalSupplyRaw = decodeEvmUint256(results[0]);
  const decimalsRaw = decodeEvmUint256(results[1]);
  const spokeWard = decodeEvmUint256(results[2]);
  const runtimeBytes = decodeEvmHexBytes(runtimeCode);
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

export type CentrifugeSolanaRpcFetcher = SafetyScoreV9SolanaRpcFetcher;

export async function fetchSolanaCentrifugeDeploymentObservation(
  assetId: string,
  routeId: string,
  contractAddress: string,
  signal?: AbortSignal,
  rpc?: CentrifugeSolanaRpcFetcher,
): Promise<ReviewedDeploymentSupplyObservation | null> {
  const identity = expectedCentrifugeDeploymentIdentity(assetId, routeId);
  if (!identity || identity.runtime !== "solana") return null;

  const observation = await fetchReviewedDeploymentSolanaObservation(
    {
      routeId,
      contractAddress,
      identity: {
        ...identity,
        controllerExecutable: false,
      },
      signal,
    },
    rpc,
  );
  return observation &&
    reviewedDeploymentIdentityValidationError(observation, assetId) ===
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
