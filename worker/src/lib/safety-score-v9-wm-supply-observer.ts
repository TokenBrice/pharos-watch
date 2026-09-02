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
  expectedWmDeploymentIdentity,
  reviewedDeploymentIdentityValidationError,
  type ReviewedDeploymentSupplyObservation,
  type ReviewedDeploymentUnitPartitionV1,
} from "./safety-score-v9-supply-attribution-contract";
import {
  decodeEvmAddress,
  decodeEvmAddressHex,
  fetchReviewedDeploymentSolanaObservation,
  observeReviewedEvmDeployment,
  observeReviewedDeploymentUnitPartitionAttempt,
  type ReviewedDeploymentEvmObserverDependencies,
  type SafetyScoreV9SolanaRpcFetcher,
  type ReviewedDeploymentObservationAttempt,
  type ReviewedDeploymentObservationRejectionCode,
  type ReviewedDeploymentObservationResult,
} from "./safety-score-v9-supply-observation-primitives";

const M_TOKEN_SELECTOR = "0xc3b6f939";
const MINTER_GATEWAY_SELECTOR = "0x48545a3c";
const PORTAL_SELECTOR = "0x6425666b";
const PLUME_RPC_URL = "https://rpc.plume.org";

export const WM_EVM_SAFE_BLOCK_LAG_BY_CHAIN: Readonly<Record<string, number>> = {
  ethereum: 2,
  arbitrum: 96,
  base: 12,
  plume: 24,
};

export type WmReviewedDeploymentRejectionCode = ReviewedDeploymentObservationRejectionCode;
export type WmReviewedDeploymentObservationAttempt = ReviewedDeploymentObservationAttempt;

interface WmObserverDependencies extends ReviewedDeploymentEvmObserverDependencies {
  fetchSolanaObservation: (
    routeId: string,
    contractAddress: string,
    signal?: AbortSignal,
    rpc?: SolanaRpcFetcher,
    chainRpcs?: Map<string, ChainRpcConfig>,
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

async function observeWmEvmDeployment(
  routeId: string,
  chainId: string,
  contractAddress: string,
  scoringClockSec: number,
  chainRpcs: Map<string, ChainRpcConfig>,
  dependencies: WmObserverDependencies,
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
      const identity = expectedWmDeploymentIdentity(deploymentRouteId);
      return identity?.runtime === "evm" ? identity : undefined;
    },
    safeBlockLag: (_identity, deploymentChainId) =>
      WM_EVM_SAFE_BLOCK_LAG_BY_CHAIN[deploymentChainId],
    extraRpcUrls: (_identity, deploymentChainId) =>
      deploymentChainId === "plume" ? [PLUME_RPC_URL] : undefined,
    protocolCalls: (identity) => [
      {
        label: "m-token", target: contractAddress,
        callData: M_TOKEN_SELECTOR, allowFailure: false,
      },
      {
        label: "controller", target: identity.underlyingTokenAddress,
        callData: identity.controllerRead === "minter-gateway"
          ? MINTER_GATEWAY_SELECTOR
          : PORTAL_SELECTOR,
        allowFailure: false,
      },
    ],
    decodeProtocolObservation: ({ results, implementationSlot }) => {
      const underlyingTokenAddress = decodeEvmAddress(results[2]);
      const controllerAddress = decodeEvmAddress(results[3]);
      const implementationAddress = decodeEvmAddressHex(implementationSlot);
      if (
        underlyingTokenAddress === null || controllerAddress === null ||
        implementationAddress === null
      ) {
        return { status: "rejected", rejectionCode: "deployment-state-invalid" };
      }
      return { status: "accepted", implementationAddress,
        observation: { underlyingTokenAddress, controllerAddress } };
    },
    identityValidationError: reviewedDeploymentIdentityValidationError,
  });
}

export type SolanaRpcFetcher = SafetyScoreV9SolanaRpcFetcher;

export async function fetchSolanaWmDeploymentObservation(
  routeId: string,
  contractAddress: string,
  signal?: AbortSignal,
  rpc?: SolanaRpcFetcher,
  chainRpcs?: Map<string, ChainRpcConfig>,
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
      chainRpcs,
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
  return observeReviewedDeploymentUnitPartitionAttempt({
    assetId: "wm-m0",
    aggregateSupplyUsd: input.aggregateSupplyUsd,
    registryFingerprint: input.registryFingerprint,
    scoringClockSec: input.scoringClockSec,
    signal: input.signal,
    identityRuntime: (routeId) => expectedWmDeploymentIdentity(routeId)?.runtime ?? null,
    observeEvm: (route) => observeWmEvmDeployment(
      route.routeId,
      route.chainId,
      route.contractAddress,
      input.scoringClockSec,
      input.chainRpcs,
      dependencies,
      input.signal,
    ),
    observeSolana: (route) => dependencies.fetchSolanaObservation(
      route.routeId,
      route.contractAddress,
      input.signal,
      undefined,
      input.chainRpcs,
    ),
    identityValidationError: reviewedDeploymentIdentityValidationError,
  });
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
