import { sha256HexFromBytes } from "@shared/lib/sha256";
import type { ChainRpcConfig } from "./chain-registry";
import {
  fetchEvmBlockHeader,
  fetchEvmBlockNumber,
  fetchEvmCodeAtBlock,
  fetchEvmMulticall3Aggregate3AtBlock,
  fetchEvmStorageAtBlock,
} from "./evm-rpc";
import { DECIMALS_SELECTOR, TOTAL_SUPPLY_SELECTOR } from "./evm-selectors";
import {
  expectedWmDeploymentIdentity,
  normalizeReviewedDeploymentAddress,
  reviewedDeploymentIdentityValidationError,
  type ReviewedDeploymentSupplyObservation,
  type ReviewedDeploymentUnitPartitionV1,
} from "./safety-score-v9-supply-attribution-contract";
import {
  decodeEvmAddress,
  decodeEvmAddressHex,
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

type WmDeploymentObservationResult = ReviewedDeploymentObservationResult;

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

  const blockHeader = await rewindEvmBlockHeaderToScoringClock({
    initialBlockNumber: headBlockNumber - safetyLag,
    scoringClockSec,
    signal,
    fetchHeader: (blockNumber) => dependencies.fetchEvmBlockHeader(chainId, blockNumber, options),
  });
  if (blockHeader === null) {
    return rejectDeployment(routeId, "safe-block-unavailable");
  }
  const blockNumber = blockHeader.number;

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
