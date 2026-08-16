import { sha256HexFromBytes } from "@shared/lib/sha256";
import type { ChainRpcConfig } from "./chain-registry";
import {
  fetchEvmBlockHeader,
  fetchEvmBlockNumber,
  fetchEvmCodeAtBlock,
  fetchEvmMulticall3Aggregate3AtBlock,
  fetchEvmStorageAtBlock,
} from "./evm-rpc";
import {
  DECIMALS_SELECTOR,
  TOTAL_SUPPLY_SELECTOR,
  encodeAddress,
} from "./evm-selectors";
import {
  expectedCentrifugeDeploymentIdentity,
  normalizeReviewedDeploymentAddress,
  reviewedDeploymentIdentityValidationError,
  type ReviewedDeploymentSupplyObservation,
  type ReviewedDeploymentUnitPartitionV1,
} from "./safety-score-v9-supply-attribution-contract";
import {
  decodeEvmHexBytes,
  decodeEvmUint256,
  fetchReviewedDeploymentSolanaObservation,
  observeReviewedDeploymentUnitPartitionAttempt,
  rewindEvmBlockHeaderToScoringClock,
  safetyScoreV9EvmObservationOptions,
  type SafetyScoreV9SolanaRpcFetcher,
  type ReviewedDeploymentObservationAttempt,
  type ReviewedDeploymentObservationRejectionCode,
  type ReviewedDeploymentObservationResult,
} from "./safety-score-v9-supply-observation-primitives";

const EIP1967_IMPLEMENTATION_SLOT =
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const WARDS_SELECTOR = "0xbf353dbb";
const ZERO_STORAGE_WORD = `0x${"0".repeat(64)}`;
export type CentrifugeReviewedDeploymentRejectionCode = ReviewedDeploymentObservationRejectionCode;
export type CentrifugeReviewedDeploymentObservationAttempt = ReviewedDeploymentObservationAttempt;

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

type DeploymentObservationResult = ReviewedDeploymentObservationResult;

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

  const blockHeader = await rewindEvmBlockHeaderToScoringClock({
    initialBlockNumber: headBlockNumber - identity.safeBlockLag,
    scoringClockSec,
    signal,
    fetchHeader: (blockNumber) => dependencies.fetchEvmBlockHeader(chainId, blockNumber, options),
  });
  if (blockHeader === null) {
    return rejectDeployment(routeId, "safe-block-unavailable");
  }
  const blockNumber = blockHeader.number;

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
  return observeReviewedDeploymentUnitPartitionAttempt({
    assetId: input.assetId,
    aggregateSupplyUsd: input.aggregateSupplyUsd,
    registryFingerprint: input.registryFingerprint,
    scoringClockSec: input.scoringClockSec,
    signal: input.signal,
    identityRuntime: (routeId) => expectedCentrifugeDeploymentIdentity(input.assetId, routeId)?.runtime ?? null,
    observeEvm: (route) => observeCentrifugeEvmDeployment(
      input.assetId,
      route.routeId,
      route.chainId,
      route.contractAddress,
      input.scoringClockSec,
      input.chainRpcs,
      dependencies,
      input.signal,
    ),
    observeSolana: (route) => dependencies.fetchSolanaObservation(
      input.assetId,
      route.routeId,
      route.contractAddress,
      input.signal,
    ),
    identityValidationError: (observation) => reviewedDeploymentIdentityValidationError(observation, input.assetId),
  });
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
