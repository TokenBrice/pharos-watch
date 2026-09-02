import { sha256HexFromBytes } from "@shared/lib/sha256";
import type { ChainRpcConfig } from "./chain-registry";
import {
  fetchEvmBlockHeader,
  fetchEvmBlockNumber,
  fetchEvmCodeAtBlock,
  fetchEvmMulticall3Aggregate3AtBlock,
  fetchEvmStorageAtBlock,
} from "./evm-rpc";
import { encodeAddress } from "./evm-selectors";
import {
  expectedCentrifugeDeploymentIdentity,
  reviewedDeploymentIdentityValidationError,
  type ReviewedDeploymentSupplyObservation,
  type ReviewedDeploymentUnitPartitionV1,
} from "./safety-score-v9-supply-attribution-contract";
import {
  decodeEvmUint256,
  fetchReviewedDeploymentSolanaObservation,
  observeReviewedEvmDeployment,
  observeReviewedDeploymentUnitPartitionAttempt,
  type ReviewedDeploymentEvmObserverDependencies,
  type SafetyScoreV9SolanaRpcFetcher,
  type ReviewedDeploymentObservationAttempt,
  type ReviewedDeploymentObservationRejectionCode,
  type ReviewedDeploymentObservationResult,
} from "./safety-score-v9-supply-observation-primitives";

const WARDS_SELECTOR = "0xbf353dbb";
const ZERO_STORAGE_WORD = `0x${"0".repeat(64)}`;
export type CentrifugeReviewedDeploymentRejectionCode = ReviewedDeploymentObservationRejectionCode;
export type CentrifugeReviewedDeploymentObservationAttempt = ReviewedDeploymentObservationAttempt;

interface CentrifugeObserverDependencies extends ReviewedDeploymentEvmObserverDependencies {
  fetchSolanaObservation: (
    assetId: string,
    routeId: string,
    contractAddress: string,
    signal?: AbortSignal,
    rpc?: CentrifugeSolanaRpcFetcher,
    chainRpcs?: Map<string, ChainRpcConfig>,
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

async function observeCentrifugeEvmDeployment(
  assetId: string,
  routeId: string,
  chainId: string,
  contractAddress: string,
  scoringClockSec: number,
  chainRpcs: Map<string, ChainRpcConfig>,
  dependencies: CentrifugeObserverDependencies,
  signal?: AbortSignal,
): Promise<ReviewedDeploymentObservationResult> {
  return observeReviewedEvmDeployment({
    routeId,
    chainId,
    contractAddress,
    scoringClockSec,
    chainRpcs,
    dependencies,
    signal,
    identity: (deploymentRouteId) => {
      const identity = expectedCentrifugeDeploymentIdentity(assetId, deploymentRouteId);
      return identity?.runtime === "evm" ? identity : undefined;
    },
    safeBlockLag: (identity) => identity.safeBlockLag,
    extraRpcUrls: (identity) => identity.extraRpcUrls,
    protocolCalls: (identity) => [{
      label: "spoke-ward", target: contractAddress,
      callData: `${WARDS_SELECTOR}${encodeAddress(identity.controllerAddress)}` as `0x${string}`,
      allowFailure: false,
    }],
    decodeProtocolObservation: ({ identity, results, implementationSlot }) =>
      decodeEvmUint256(results[2]) !== 1n ||
      implementationSlot.toLowerCase() !== ZERO_STORAGE_WORD
        ? { status: "rejected", rejectionCode: "deployment-state-invalid" }
        : { status: "accepted",
            observation: { controllerAddress: identity.controllerAddress } },
    identityValidationError: (observation) =>
      reviewedDeploymentIdentityValidationError(observation, assetId),
  });
}

export type CentrifugeSolanaRpcFetcher = SafetyScoreV9SolanaRpcFetcher;

export async function fetchSolanaCentrifugeDeploymentObservation(
  assetId: string,
  routeId: string,
  contractAddress: string,
  signal?: AbortSignal,
  rpc?: CentrifugeSolanaRpcFetcher,
  chainRpcs?: Map<string, ChainRpcConfig>,
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
      chainRpcs,
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
      undefined,
      input.chainRpcs,
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
