import { sha256HexFromBytes } from "@shared/lib/sha256";
import { V9_CANDIDATE_POLICY_V1 } from "@shared/lib/safety-score-v9/policy";
import { sleepWithSignal, throwIfAborted } from "../abort";
import type { SupplyAttributionRejectionCode } from "@shared/lib/safety-score-v9-supply-attribution-journal";
import type { V9ExecutionWindow } from "../v9-slot-window";
import type { ChainRpcConfig } from "../chain-registry";
import {
  fetchEvmBlockHeader,
  fetchEvmBlockNumber,
  fetchEvmCodeAtBlock,
  fetchEvmMulticall3Aggregate3AtBlock,
  fetchEvmStorageAtBlock,
} from "../evm-rpc";
import {
  expectedWmDeploymentIdentity,
  reviewedDeploymentIdentityValidationError,
  reviewedDeploymentObservationTimingIssue,
  type ReviewedDeploymentSupplyObservation,
  type ReviewedDeploymentUnitPartitionV1,
} from "./supply-attribution-contract";
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
} from "./supply-observation-primitives";

const M_TOKEN_SELECTOR = "0xc3b6f939";
const MINTER_GATEWAY_SELECTOR = "0x48545a3c";
const PORTAL_SELECTOR = "0x6425666b";
const PLUME_RPC_URL = "https://rpc.plume.org";
const WM_EVM_EXTRA_RPC_URLS_BY_CHAIN: Readonly<Record<string, readonly string[]>> = {
  plume: [PLUME_RPC_URL],
  linea: ["https://rpc.linea.build"],
  hyperevm: ["https://rpc.hyperliquid.xyz/evm"],
  soneium: ["https://rpc.soneium.org"],
  citrea: ["https://rpc.mainnet.citrea.xyz"],
};

export const WM_EVM_SAFE_BLOCK_LAG_BY_CHAIN: Readonly<Record<string, number>> = {
  ethereum: 2,
  arbitrum: 96,
  base: 12,
  plume: 24,
  linea: 12,
  bsc: 30,
  hyperevm: 10,
  soneium: 12,
  plasma: 12,
  citrea: 12,
  monad: 10,
};

// Only one maturity wait; the scheduler's absolute window must still retain its
// minimum RPC/publication reserve after this wait. No extra connection fanout.
const WM_SKEW_REPAIR_MAX_WAIT_MS = 120_000;
const WM_SKEW_REPAIR_MARGIN_MS = 15_000;

export type WmReviewedDeploymentRejectionCode = ReviewedDeploymentObservationRejectionCode |
  Extract<SupplyAttributionRejectionCode, "deployment-observation-window-insufficient">;
export type WmReviewedDeploymentObservationAttempt = Extract<ReviewedDeploymentObservationAttempt, { status: "accepted" }> |
  { status: "rejected"; rejectionCode: WmReviewedDeploymentRejectionCode; failedRouteId: string | null };

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
      WM_EVM_EXTRA_RPC_URLS_BY_CHAIN[deploymentChainId],
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
    executionWindow?: V9ExecutionWindow;
  },
  dependencyOverrides: Partial<WmObserverDependencies> = {},
): Promise<WmReviewedDeploymentObservationAttempt> {
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...dependencyOverrides };
  const evmObservations = new Map<string, ReviewedDeploymentObservationResult>();
  const solanaObservations = new Map<string, ReviewedDeploymentSupplyObservation | null>();
  const observationInput = {
    assetId: "wm-m0",
    aggregateSupplyUsd: input.aggregateSupplyUsd,
    registryFingerprint: input.registryFingerprint,
    scoringClockSec: input.scoringClockSec,
    signal: input.signal,
    identityRuntime: (routeId) => expectedWmDeploymentIdentity(routeId)?.runtime ?? null,
    observeEvm: async (route) => {
      const cached = evmObservations.get(route.routeId);
      if (cached) return cached;
      const result = await observeWmEvmDeployment(
        route.routeId, route.chainId, route.contractAddress, input.scoringClockSec,
        input.chainRpcs, dependencies, input.signal,
      );
      evmObservations.set(route.routeId, result);
      return result;
    },
    observeSolana: async (route) => {
      if (solanaObservations.has(route.routeId)) return solanaObservations.get(route.routeId)!;
      const observation = await dependencies.fetchSolanaObservation(
        route.routeId, route.contractAddress, input.signal, undefined, input.chainRpcs,
      );
      solanaObservations.set(route.routeId, observation);
      return observation;
    },
    identityValidationError: reviewedDeploymentIdentityValidationError,
  } satisfies Parameters<typeof observeReviewedDeploymentUnitPartitionAttempt>[0];
  const attempt = await observeReviewedDeploymentUnitPartitionAttempt(observationInput);
  if (attempt.status !== "rejected" || attempt.rejectionCode !== "deployment-observation-skew") return attempt;
  const observations = [...evmObservations.values()].flatMap(result => result.status === "accepted" ? [result.observation] : []);
  for (const observation of solanaObservations.values()) if (observation) observations.push(observation);
  const earliest = Math.min(...observations.map(row => row.blockTimeSec));
  const latest = Math.max(...observations.map(row => row.blockTimeSec));
  const issue = reviewedDeploymentObservationTimingIssue({
    assetId: "wm-m0", clockSec: input.scoringClockSec, captureStartedAtSec: earliest,
    captureEndedAtSec: latest, observedAtSec: latest, deployments: observations,
  });
  if (issue?.code !== "cross-chain-skew") return attempt;
  const minimumTime = latest - V9_CANDIDATE_POLICY_V1.policy.semantic.supplyAttribution.observationMaxSkewSec;
  // Finalized account state cannot be fetched historically. Only a lagging EVM
  // safe head can mature into this already-captured cross-chain envelope.
  if ([...solanaObservations.values()].some(row => row && row.blockTimeSec < minimumTime)) return attempt;
  const laggingRouteIds = [...evmObservations].filter(([, result]) =>
    result.status === "accepted" && result.observation.blockTimeSec < minimumTime,
  ).map(([routeId]) => routeId);
  const requiredWaitMs = (minimumTime - earliest) * 1_000;
  throwIfAborted(input.signal);
  if (laggingRouteIds.length === 0) return attempt;
  const waitMs = Math.min(requiredWaitMs + WM_SKEW_REPAIR_MARGIN_MS, WM_SKEW_REPAIR_MAX_WAIT_MS);
  const window = input.executionWindow;
  if (requiredWaitMs > WM_SKEW_REPAIR_MAX_WAIT_MS || !window ||
    !Number.isFinite(window.deadlineMs) || !Number.isFinite(window.minimumRemainingMs) ||
    window.minimumRemainingMs < 0 || window.deadlineMs - Date.now() - waitMs < window.minimumRemainingMs) {
    return { status: "rejected", rejectionCode: "deployment-observation-window-insufficient",
      failedRouteId: attempt.failedRouteId };
  }
  await sleepWithSignal(waitMs, input.signal);
  for (const routeId of laggingRouteIds) evmObservations.delete(routeId);
  // Exactly one repair pass. Every reread revalidates the original inventory,
  // hash-pinned state and identity; unchanged siblings keep their true clocks.
  return observeReviewedDeploymentUnitPartitionAttempt(observationInput);
}

export async function observeWmReviewedDeploymentUnitPartition(
  input: {
    aggregateSupplyUsd: number;
    registryFingerprint: string;
    scoringClockSec: number;
    chainRpcs: Map<string, ChainRpcConfig>;
    signal?: AbortSignal;
    executionWindow?: V9ExecutionWindow;
  },
  dependencyOverrides: Partial<WmObserverDependencies> = {},
): Promise<ReviewedDeploymentUnitPartitionV1 | null> {
  const attempt = await observeWmReviewedDeploymentUnitPartitionAttempt(
    input,
    dependencyOverrides,
  );
  return attempt.status === "accepted" ? attempt.attribution : null;
}
