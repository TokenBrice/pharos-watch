import {
  DEX_MEASURED_ADAPTER_PROFILE_IDS,
  getDexMeasuredExecutionProbeNotionals,
  validateDexMeasuredExecutionProfile,
  type DexMeasuredExecutionPoolBindingProof,
  type DexMeasuredExecutionRegistryBindingProof,
  type DexMeasuredExecutionStableSwapNgFactoryBindingProof,
  type DexMeasuredExecutionCurveCompositeProof,
  type DexMeasuredExecutionTarget,
  type DexMeasuredExecutionUniswapV4PoolProof,
} from "@shared/types/measured-execution";
import type { ChainRpcConfig } from "../../lib/chain-registry";
import { throwIfAborted } from "../../lib/abort";
import type { CronProgressReporter, CronResult } from "../../lib/cron-logger";
import { createCronResult } from "../../lib/cron-result";
import { fetchEvmBlockNumber } from "../../lib/evm-rpc";
import { toErrorMessage } from "@shared/lib/error-utils";
import { readDexSourcePaginationState, writeDexSourcePaginationState } from "../dex-liquidity/source-pagination-state";
import { mapWithConcurrency } from "../../lib/concurrency";
import {
  buildDexMeasuredQuoteGenerationId,
  buildDexShadowMeasuredQuoteGenerationId,
  loadLatestPublishedDexMeasuredTargets,
  loadLatestPublishedDexShadowMeasuredTargets,
  publishDexMeasuredQuoteGeneration,
  publishDexShadowMeasuredQuoteGeneration,
  pruneDexMeasuredExecutionGenerations,
  type DexMeasuredQuoteOutcome,
} from "./persistence";
import {
  buildDexMeasuredExecutionProfile,
  createDexMeasuredExecutionRpcBudget,
  DEX_MEASURED_EVM_REQUEST_TIMEOUT_MS,
  type DexMeasuredRawQuotePoint,
  type DexMeasuredExecutionRpcBudget,
} from "./profiles";
import { quoteQuoterV2Requests, resolveQuoterV2PoolBindings, validateQuoterV2ProfileProof } from "./quoter-v2";
import {
  DEX_EXACT_QUOTE_ADAPTER_REGISTRY,
  verifyDexMeasuredExecutionDeployment,
} from "./registry";
import {
  CURVE_CRYPTOSWAP_ADAPTER_PROFILE_ID,
  quoteCurveCryptoSwapRequests,
  validateCurveCryptoSwapProfileProof,
  verifyCurveCryptoSwapDeployment,
  type CurveCryptoSwapRuntimeEvidence,
} from "./curve-cryptoswap";
import {
  CURVE_STABLESWAP_ADAPTER_PROFILE_ID,
  quoteCurveStableSwapRequests,
  validateCurveStableSwapProfileProof,
  verifyCurveStableSwapDeployment,
  type CurveStableSwapRuntimeEvidence,
} from "./curve-stableswap";
import {
  CURVE_STABLESWAP_NG_ADAPTER_PROFILE_ID,
  quoteCurveStableSwapNgRequests,
  validateCurveStableSwapNgProfileProof,
  verifyCurveStableSwapNgDeployment,
  type CurveStableSwapNgRuntimeEvidence,
} from "./curve-stableswap-ng";
import {
  quoteCurveCompositeRequests,
  validateCurveCompositeProfileProof,
  verifyCurveCompositeDeployment,
  type CurveCompositeRuntimeEvidence,
} from "./curve-composite";
import {
  quoteUniswapV4Requests,
  resolveUniswapV4PoolBindings,
  validateUniswapV4ProfileProof,
  verifyUniswapV4Deployment,
  type UniswapV4Deployment,
  type UniswapV4RuntimeEvidence,
} from "./uniswap-v4";
import {
  MAX_ADMISSION_ROTATION_CYCLES, MAX_EXPIRING_PRIORITY_RPC_REQUESTS, MEASURED_EXECUTION_ADMISSION_RUN_METADATA,
  MEASURED_EXECUTION_ADMISSION_SOURCE_KEY, MEASURED_EXECUTION_REFINEMENT_ROUNDS,
  MEASURED_EXECUTION_RPC_REQUEST_LIMIT, SHADOW_MEASURED_EXECUTION_ADMISSION_SOURCE_KEY,
  admitTargetsWithinBudget, estimateAdmissionRotationCycles,
  hasCompleteDexMeasuredQuoteProgress, selectExpiringScoreBearingPriorityPacket,
  loadPublishedScoreBearingDexRoutes,
  resolveMeasuredExecutionCronStatus, resolveTargetDeployment, summarizeMeasuredExecutionQuoteFailures,
  type TargetDeployment,
} from "./admission";
export { isDexMeasuredExecutionTargetScoreEligible } from "./admission";

const MAX_QUOTE_CALLS = 6_400;
const MAX_RUNTIME_MS = 8 * 60 * 1_000;

interface TargetQuoteState {
  target: DexMeasuredExecutionTarget;
  deployment: TargetDeployment | null;
  blockNumber: number | null;
  blockObservedAt: number | null;
  endpointCodeHash: `0x${string}` | null;
  curveRuntimeEvidence: CurveCryptoSwapRuntimeEvidence | null;
  curveStableSwapRuntimeEvidence: CurveStableSwapRuntimeEvidence | null;
  curveStableSwapNgRuntimeEvidence: CurveStableSwapNgRuntimeEvidence | null;
  curveCompositeRuntimeEvidence: CurveCompositeRuntimeEvidence | null;
  uniswapV4RuntimeEvidence: UniswapV4RuntimeEvidence | null;
  poolBindingProof: DexMeasuredExecutionPoolBindingProof | null;
  registryBindingProof: DexMeasuredExecutionRegistryBindingProof | null;
  stableSwapNgFactoryBindingProof: DexMeasuredExecutionStableSwapNgFactoryBindingProof | null;
  curveCompositeProof: DexMeasuredExecutionCurveCompositeProof | null;
  uniswapV4PoolProof: DexMeasuredExecutionUniswapV4PoolProof | null;
  points: DexMeasuredRawQuotePoint[];
  failedReason: string | null;
  stopped: boolean;
  bracket: { lowerPassingUsd: number; upperFailingUsd: number } | null;
}

function markBudgetStop(states: readonly TargetQuoteState[], reason: string | null): void {
  if (!reason) return;
  for (const state of states) {
    if (!state.failedReason && !hasCompleteDexMeasuredQuoteProgress(state)) {
      state.failedReason = reason;
    }
  }
}

function applyQuoteOutcome(
  state: TargetQuoteState,
  outcome: { point?: DexMeasuredRawQuotePoint; failureReason?: string },
): void {
  if (!outcome.point) {
    const failureReason = outcome.failureReason?.trim();
    state.failedReason = failureReason || "quote-failed";
    return;
  }
  state.points.push(outcome.point);
  if (!outcome.point.passesCostBound) {
    state.stopped = true;
    const passing = state.points
      .filter((point) => point.passesCostBound && point.inputUsd < outcome.point!.inputUsd)
      .sort((left, right) => right.inputUsd - left.inputUsd)[0];
    state.bracket = passing ? { lowerPassingUsd: passing.inputUsd, upperFailingUsd: outcome.point.inputUsd } : null;
  }
}

interface MeasuredQuoteAdapterRequest {
  state: TargetQuoteState;
  inputUsd: number;
}

interface MeasuredQuoteAdapterContext {
  requests: readonly MeasuredQuoteAdapterRequest[];
  chainRpcs: Map<string, ChainRpcConfig>;
  signal?: AbortSignal;
  rpcBudget: DexMeasuredExecutionRpcBudget;
}

type MeasuredQuoteAdapterRunner = (input: MeasuredQuoteAdapterContext) => Promise<void>;

function applyQuoteOutcomes(
  requests: readonly MeasuredQuoteAdapterRequest[],
  outcomes: readonly { point?: DexMeasuredRawQuotePoint; failureReason?: string }[],
): void {
  for (let index = 0; index < requests.length; index += 1) {
    applyQuoteOutcome(requests[index]!.state, outcomes[index] ?? { failureReason: "quote-failed" });
  }
}

/**
 * The closed measured-execution adapter set. Each entry owns only its
 * request/proof shape; the stage keeps chain lanes and adapter groups
 * serialized exactly as before.
 */
const DEX_EXACT_QUOTE_V1_COMPATIBILITY_RUNNERS: Readonly<
  Record<
    TargetDeployment["kind"],
    {
      profileIds: readonly string[];
      quote: MeasuredQuoteAdapterRunner;
      validate: (profile: Parameters<typeof validateQuoterV2ProfileProof>[0]) => string[];
    }
  >
> = {
  "quoter-v2": {
    profileIds: DEX_EXACT_QUOTE_ADAPTER_REGISTRY.find((entry) => entry.adapterId === "evm-quoter-v2")!.profileIds,
    validate: validateQuoterV2ProfileProof,
    quote: async (input) => {
      const outcomes = await quoteQuoterV2Requests({
        requests: input.requests.map(({ state, inputUsd }) => ({
          target: state.target,
          inputUsd,
          endpointAddress: state.deployment!.config.endpointAddress,
        })),
        blockNumber: input.requests[0]!.state.blockNumber!,
        chainRpcs: input.chainRpcs,
        signal: input.signal,
        rpcBudget: input.rpcBudget,
      });
      applyQuoteOutcomes(input.requests, outcomes);
    },
  },
  "uniswap-v4": {
    profileIds: DEX_EXACT_QUOTE_ADAPTER_REGISTRY.find((entry) => entry.adapterId === "evm-uniswap-v4")!.profileIds,
    validate: validateUniswapV4ProfileProof,
    quote: async (input) => {
      const outcomes = await quoteUniswapV4Requests({
        requests: input.requests.map(({ state, inputUsd }) => ({
          target: state.target,
          inputUsd,
          endpointAddress: state.deployment!.config.endpointAddress,
        })),
        blockNumber: input.requests[0]!.state.blockNumber!,
        chainRpcs: input.chainRpcs,
        signal: input.signal,
        rpcBudget: input.rpcBudget,
      });
      applyQuoteOutcomes(input.requests, outcomes);
    },
  },
  "curve-cryptoswap": {
    profileIds: [CURVE_CRYPTOSWAP_ADAPTER_PROFILE_ID],
    validate: validateCurveCryptoSwapProfileProof,
    quote: async (input) => {
      const outcomes = await quoteCurveCryptoSwapRequests({
        requests: input.requests.map(({ state, inputUsd }) => ({
          target: state.target,
          inputUsd,
          blockNumber: state.blockNumber!,
          endpointAddress: state.deployment!.config.endpointAddress,
          runtimeEvidence: state.curveRuntimeEvidence ?? undefined,
        })),
        chainRpcs: input.chainRpcs,
        signal: input.signal,
        rpcBudget: input.rpcBudget,
      });
      applyQuoteOutcomes(input.requests, outcomes);
    },
  },
  "curve-stableswap": {
    profileIds: [CURVE_STABLESWAP_ADAPTER_PROFILE_ID],
    validate: validateCurveStableSwapProfileProof,
    quote: async (input) => {
      const outcomes = await quoteCurveStableSwapRequests({
        requests: input.requests.map(({ state, inputUsd }) => ({
          target: state.target,
          inputUsd,
          blockNumber: state.blockNumber!,
          blockObservedAt: state.blockObservedAt!,
          endpointAddress: state.deployment!.config.endpointAddress,
          runtimeEvidence: state.curveStableSwapRuntimeEvidence ?? undefined,
        })),
        chainRpcs: input.chainRpcs,
        signal: input.signal,
        rpcBudget: input.rpcBudget,
      });
      applyQuoteOutcomes(input.requests, outcomes);
    },
  },
  "curve-stableswap-ng": {
    profileIds: [CURVE_STABLESWAP_NG_ADAPTER_PROFILE_ID],
    validate: validateCurveStableSwapNgProfileProof,
    quote: async (input) => {
      const outcomes = await quoteCurveStableSwapNgRequests({
        requests: input.requests.map(({ state, inputUsd }) => ({
          target: state.target,
          inputUsd,
          blockNumber: state.blockNumber!,
          blockObservedAt: state.blockObservedAt!,
          endpointAddress: state.deployment!.config.endpointAddress,
          runtimeEvidence: state.curveStableSwapNgRuntimeEvidence ?? undefined,
        })),
        chainRpcs: input.chainRpcs,
        signal: input.signal,
        rpcBudget: input.rpcBudget,
      });
      applyQuoteOutcomes(input.requests, outcomes);
    },
  },
  "curve-composite": {
    profileIds: [
      DEX_MEASURED_ADAPTER_PROFILE_IDS.curveRateBearing,
      DEX_MEASURED_ADAPTER_PROFILE_IDS.curveMetapool,
    ],
    validate: validateCurveCompositeProfileProof,
    quote: async (input) => {
      const outcomes = await quoteCurveCompositeRequests({
        requests: input.requests.map(({ state, inputUsd }) => ({
          target: state.target,
          inputUsd,
          blockNumber: state.blockNumber!,
          blockObservedAt: state.blockObservedAt!,
          endpointAddress: state.deployment!.config.endpointAddress,
          runtimeEvidence: state.curveCompositeRuntimeEvidence ?? undefined,
        })),
        chainRpcs: input.chainRpcs,
        signal: input.signal,
        rpcBudget: input.rpcBudget,
      });
      applyQuoteOutcomes(input.requests, outcomes);
    },
  },
};

async function syncDexMeasuredExecutionLane(
  db: D1Database,
  chainRpcs: Map<string, ChainRpcConfig>,
  signal?: AbortSignal,
  reportProgress?: CronProgressReporter,
  lane: "active" | "shadow" = "active",
): Promise<CronResult> {
  const startedAtMs = Date.now();
  const startedAt = Math.floor(startedAtMs / 1_000);
  const rpcBudget = createDexMeasuredExecutionRpcBudget({
    maxRequests: MEASURED_EXECUTION_RPC_REQUEST_LIMIT,
    deadlineMs: startedAtMs + MAX_RUNTIME_MS,
  });
  const targetGeneration = lane === "shadow"
    ? await loadLatestPublishedDexShadowMeasuredTargets(db, signal)
    : await loadLatestPublishedDexMeasuredTargets(db, signal);
  if (!targetGeneration || targetGeneration.targets.length === 0) {
    return createCronResult({
      status: "degraded",
      itemCount: 0,
      metadata: {
        reason: "target-generation-missing",
      },
      productivity: { productive: false, reason: "target-generation-missing" },
    });
  }

  const scoreBearingRoutes = lane === "active"
    ? await loadPublishedScoreBearingDexRoutes(db, signal)
    : null;
  if (lane === "active" && scoreBearingRoutes === null) {
    return createCronResult({
      status: "degraded",
      itemCount: 0,
      metadata: {
        reason: "score-bearing-route-load-failed",
      },
      productivity: { productive: false, reason: "score-bearing-route-load-failed" },
    });
  }
  const quoteGenerationId = lane === "shadow"
    ? buildDexShadowMeasuredQuoteGenerationId(startedAt)
    : buildDexMeasuredQuoteGenerationId(startedAt);
  const expiringPriority = lane === "active" && scoreBearingRoutes
    ? selectExpiringScoreBearingPriorityPacket(targetGeneration.targets, scoreBearingRoutes)
    : null;
  const priorityTargetIds = new Set(expiringPriority?.targetIds ?? []);
  const admissionState = await readDexSourcePaginationState(
    db,
    lane === "shadow" ? SHADOW_MEASURED_EXECUTION_ADMISSION_SOURCE_KEY : MEASURED_EXECUTION_ADMISSION_SOURCE_KEY,
    "sync-cl-exit-depth",
  );
  const admissionCursor = admissionState.cursor?.trim() || null;
  const {
    admitted,
    deferred,
    oversized,
    priorityAdmitted,
    oversizedCoinIds,
    estimatedRpcRequests,
    estimatedSetupRpcRequests,
    estimatedQuoteRpcRequests,
    nextCursor,
  } = admitTargetsWithinBudget(targetGeneration.targets, {
    cursor: admissionCursor,
    priorityTargetIds,
    priorityMaxEstimatedRpcRequests: MAX_EXPIRING_PRIORITY_RPC_REQUESTS,
  });
  const admissionRotationCycles = estimateAdmissionRotationCycles(targetGeneration.targets, {
    cursor: admissionCursor,
    priorityTargetIds,
    priorityMaxEstimatedRpcRequests: MAX_EXPIRING_PRIORITY_RPC_REQUESTS,
  });
  const budgetDeferredCount = deferred.size - oversized.size;
  const orderedTargets = targetGeneration.targets
    .map((target, index) => ({
      target,
      index,
      priority: priorityAdmitted.has(target.targetId),
    }))
    .sort(
      (left, right) =>
        Number(right.priority) - Number(left.priority) ||
        left.index - right.index,
    )
    .map((row) => row.target);
  const states = orderedTargets.map<TargetQuoteState>((target) => ({
    target,
    deployment: resolveTargetDeployment(target),
    blockNumber: null,
    blockObservedAt: null,
    endpointCodeHash: null,
    curveRuntimeEvidence: null,
    curveStableSwapRuntimeEvidence: null,
    curveStableSwapNgRuntimeEvidence: null,
    curveCompositeRuntimeEvidence: null,
    uniswapV4RuntimeEvidence: null,
    poolBindingProof: null,
    registryBindingProof: null,
    stableSwapNgFactoryBindingProof: null,
    curveCompositeProof: null,
    uniswapV4PoolProof: null,
    points: [],
    failedReason: oversized.has(target.targetId)
      ? "admission-coin-group-oversized"
      : deferred.has(target.targetId)
        ? "budget-deferred"
        : null,
    stopped: false,
    bracket: null,
  }));
  for (const state of states) {
    if (admitted.has(state.target.targetId) && !state.deployment) {
      state.failedReason = "unsupported-deployment";
    }
  }

  const chainStates = new Map<string, TargetQuoteState[]>();
  for (const state of states) {
    if (state.failedReason || !state.deployment) continue;
    const rows = chainStates.get(state.target.chain) ?? [];
    rows.push(state);
    chainStates.set(state.target.chain, rows);
  }
  await mapWithConcurrency([...chainStates], 3, async ([chain, rows]) => {
    if (!rpcBudget.canRequestChain(chain)) {
      markBudgetStop(rows, rpcBudget.stopReason);
      return;
    }
    const blockObservedAt = Math.floor(Date.now() / 1_000);
    const blockNumber = await fetchEvmBlockNumber(chain, {
      chainRpcs,
      signal,
      timeoutMs: DEX_MEASURED_EVM_REQUEST_TIMEOUT_MS,
      deadlineMs: rpcBudget.deadlineMs,
      beforeRequest: () => rpcBudget.tryConsume(),
      maxRetries: 0,
    });
    rpcBudget.recordChainResult(chain, blockNumber != null);
    if (rpcBudget.stopReason) {
      markBudgetStop(rows, rpcBudget.stopReason);
      return;
    }
    if (blockNumber == null) {
      for (const state of rows) state.failedReason = "block-number-unavailable";
      return;
    }
    for (const state of rows) {
      state.blockNumber = blockNumber;
      state.blockObservedAt = blockObservedAt;
    }

    const deploymentGroups = new Map<string, TargetQuoteState[]>();
    for (const state of rows) {
      const config = state.deployment!.config;
      const key = `${state.deployment!.kind}:${config.endpointAddress}`;
      const group = deploymentGroups.get(key) ?? [];
      group.push(state);
      deploymentGroups.set(key, group);
    }
    for (const deploymentRows of deploymentGroups.values()) {
      throwIfAborted(signal);
      const deployment = deploymentRows[0]!.deployment!;
      if (deployment.kind === "quoter-v2") {
        const verified = await verifyDexMeasuredExecutionDeployment({
          deployment: deployment.config,
          blockNumber,
          chainRpcs,
          signal,
          rpcBudget,
        });
        if (!verified.ok) {
          if (rpcBudget.stopReason) markBudgetStop(deploymentRows, rpcBudget.stopReason);
          else for (const state of deploymentRows) state.failedReason = verified.reason;
          continue;
        }
        for (const state of deploymentRows) state.endpointCodeHash = verified.codeHash;
      } else if (deployment.kind === "uniswap-v4") {
        const verified = await verifyUniswapV4Deployment({
          deployment: deployment.config,
          blockNumber,
          chainRpcs,
          signal,
          rpcBudget,
        });
        if (!verified.ok) {
          if (rpcBudget.stopReason) markBudgetStop(deploymentRows, rpcBudget.stopReason);
          else for (const state of deploymentRows) state.failedReason = verified.reason;
          continue;
        }
        for (const state of deploymentRows) {
          state.endpointCodeHash = verified.codeHash;
          state.uniswapV4RuntimeEvidence = verified.runtimeEvidence;
        }
      } else if (deployment.kind === "curve-cryptoswap") {
        const verified = await verifyCurveCryptoSwapDeployment({
          policy: deployment.config,
          blockNumber,
          chainRpcs,
          signal,
          rpcBudget,
        });
        if (!verified.ok) {
          if (rpcBudget.stopReason) markBudgetStop(deploymentRows, rpcBudget.stopReason);
          else for (const state of deploymentRows) state.failedReason = verified.reason;
          continue;
        }
        for (const state of deploymentRows) {
          state.endpointCodeHash = verified.codeHash;
          state.curveRuntimeEvidence = verified.runtimeEvidence;
        }
      } else if (deployment.kind === "curve-stableswap") {
        const verified = await verifyCurveStableSwapDeployment({
          policy: deployment.config,
          blockNumber,
          nowSec: startedAt,
          chainRpcs,
          signal,
          rpcBudget,
        });
        if (!verified.ok) {
          if (rpcBudget.stopReason) markBudgetStop(deploymentRows, rpcBudget.stopReason);
          else for (const state of deploymentRows) state.failedReason = verified.reason;
          continue;
        }
        for (const state of deploymentRows) {
          state.endpointCodeHash = verified.codeHash;
          state.blockObservedAt = verified.blockTimestamp;
          state.curveStableSwapRuntimeEvidence = verified.runtimeEvidence;
          state.registryBindingProof = verified.registryBindingProof;
        }
      } else if (deployment.kind === "curve-stableswap-ng") {
        const verified = await verifyCurveStableSwapNgDeployment({
          policy: deployment.config,
          nowSec: startedAt,
          chainRpcs,
          signal,
          rpcBudget,
        });
        if (!verified.ok) {
          if (rpcBudget.stopReason) markBudgetStop(deploymentRows, rpcBudget.stopReason);
          else for (const state of deploymentRows) state.failedReason = verified.reason;
          continue;
        }
        for (const state of deploymentRows) {
          state.blockNumber = verified.blockNumber;
          state.endpointCodeHash = verified.codeHash;
          state.blockObservedAt = verified.blockTimestamp;
          state.curveStableSwapNgRuntimeEvidence = verified.runtimeEvidence;
          state.stableSwapNgFactoryBindingProof = verified.factoryBindingProof;
        }
      } else {
        const verified = await verifyCurveCompositeDeployment({
          policy: deployment.config,
          nowSec: startedAt,
          chainRpcs,
          signal,
          rpcBudget,
        });
        if (!verified.ok) {
          if (rpcBudget.stopReason) markBudgetStop(deploymentRows, rpcBudget.stopReason);
          else for (const state of deploymentRows) state.failedReason = verified.reason;
          continue;
        }
        for (const state of deploymentRows) {
          state.blockNumber = verified.blockNumber;
          state.endpointCodeHash = verified.codeHash;
          state.blockObservedAt = verified.blockTimestamp;
          state.curveCompositeRuntimeEvidence = verified.runtimeEvidence;
          state.curveCompositeProof = verified.proof;
        }
      }
      if (rpcBudget.stopReason) {
        markBudgetStop(deploymentRows, rpcBudget.stopReason);
        break;
      }
    }
  });
  markBudgetStop(states, rpcBudget.stopReason);

  const uniswapV4StatesByChain = new Map<string, TargetQuoteState[]>();
  for (const state of states) {
    if (
      state.failedReason ||
      state.deployment?.kind !== "uniswap-v4" ||
      state.blockNumber == null ||
      !state.endpointCodeHash ||
      !state.uniswapV4RuntimeEvidence
    ) {
      continue;
    }
    const rows = uniswapV4StatesByChain.get(state.target.chain) ?? [];
    rows.push(state);
    uniswapV4StatesByChain.set(state.target.chain, rows);
  }
  await mapWithConcurrency([...uniswapV4StatesByChain.values()], 3, async (rows) => {
    const outcomes = await resolveUniswapV4PoolBindings({
      requests: rows.map((state) => ({
        target: state.target,
        deployment: state.deployment!.config as UniswapV4Deployment,
        runtimeEvidence: state.uniswapV4RuntimeEvidence!,
      })),
      blockNumber: rows[0]!.blockNumber!,
      chainRpcs,
      signal,
      rpcBudget,
    });
    outcomes.forEach((outcome, index) => {
      const state = rows[index]!;
      if (outcome.proof) state.uniswapV4PoolProof = outcome.proof;
      else if (rpcBudget.stopReason) markBudgetStop([state], rpcBudget.stopReason);
      else state.failedReason = outcome.failureReason ?? "v4-pool-binding-failed";
    });
  });
  markBudgetStop(states, rpcBudget.stopReason);

  const quoterStatesByChain = new Map<string, TargetQuoteState[]>();
  for (const state of states) {
    if (
      state.failedReason ||
      state.deployment?.kind !== "quoter-v2" ||
      state.blockNumber == null ||
      !state.endpointCodeHash
    )
      continue;
    const rows = quoterStatesByChain.get(state.target.chain) ?? [];
    rows.push(state);
    quoterStatesByChain.set(state.target.chain, rows);
  }
  await mapWithConcurrency([...quoterStatesByChain.values()], 3, async (rows) => {
    const rowsByFactory = new Map<string, TargetQuoteState[]>();
    for (const state of rows) {
      const deployment = state.deployment!;
      if (deployment.kind !== "quoter-v2") continue;
      const key = `${deployment.config.adapterProfileId}:${deployment.config.factoryAddress}`;
      const deploymentRows = rowsByFactory.get(key) ?? [];
      deploymentRows.push(state);
      rowsByFactory.set(key, deploymentRows);
    }
    for (const deploymentRows of rowsByFactory.values()) {
      throwIfAborted(signal);
      const deployment = deploymentRows[0]!.deployment!;
      if (deployment.kind !== "quoter-v2") continue;
      const outcomes = await resolveQuoterV2PoolBindings({
        requests: deploymentRows.map((state) => ({
          target: state.target,
          factoryAddress: deployment.config.factoryAddress,
          factoryCodeHash: deployment.config.expectedFactoryCodeHash,
        })),
        blockNumber: deploymentRows[0]!.blockNumber!,
        chainRpcs,
        signal,
        rpcBudget,
      });
      outcomes.forEach((outcome, index) => {
        const state = deploymentRows[index]!;
        if (outcome.proof) state.poolBindingProof = outcome.proof;
        else if (rpcBudget.stopReason) markBudgetStop([state], rpcBudget.stopReason);
        else state.failedReason = outcome.failureReason ?? "factory-pool-binding-failed";
      });
      if (rpcBudget.stopReason) break;
    }
  });
  markBudgetStop(states, rpcBudget.stopReason);

  let quoteCallCount = 0;
  const runStage = async (requests: Array<{ state: TargetQuoteState; inputUsd: number }>): Promise<void> => {
    if (rpcBudget.stopReason) {
      markBudgetStop(states, rpcBudget.stopReason);
      return;
    }
    const runnable = requests.filter(
      ({ state }) =>
        !state.failedReason &&
        state.deployment != null &&
        state.blockNumber != null &&
        state.endpointCodeHash != null &&
        (state.deployment.kind !== "quoter-v2" || state.poolBindingProof != null) &&
        (state.deployment.kind !== "uniswap-v4" || state.uniswapV4PoolProof != null) &&
        (state.deployment.kind !== "curve-stableswap" || state.registryBindingProof != null) &&
        (
          state.deployment.kind !== "curve-stableswap-ng" ||
          state.stableSwapNgFactoryBindingProof != null
        ) &&
        (
          state.deployment.kind !== "curve-composite" ||
          state.curveCompositeProof != null
        ),
    );
    if (runnable.length === 0) return;
    if (quoteCallCount + runnable.length > MAX_QUOTE_CALLS) {
      for (const { state } of runnable) state.failedReason = "quote-call-budget-exhausted";
      return;
    }
    quoteCallCount += runnable.length;

    const byChain = new Map<string, typeof runnable>();
    for (const request of runnable) {
      const rows = byChain.get(request.state.target.chain) ?? [];
      rows.push(request);
      byChain.set(request.state.target.chain, rows);
    }
    await mapWithConcurrency([...byChain.values()], 3, async (chainRequests) => {
      const byAdapter = new Map<TargetDeployment["kind"], typeof chainRequests>();
      for (const request of chainRequests) {
        const kind = request.state.deployment!.kind;
        const rows = byAdapter.get(kind) ?? [];
        rows.push(request);
        byAdapter.set(kind, rows);
      }
      for (const [kind, adapterRequests] of byAdapter) {
        throwIfAborted(signal);
        await DEX_EXACT_QUOTE_V1_COMPATIBILITY_RUNNERS[kind].quote({
          requests: adapterRequests,
          chainRpcs,
          signal,
          rpcBudget,
        });
        if (rpcBudget.isChainCircuitOpen(adapterRequests[0]!.state.target.chain)) {
          for (const { state } of adapterRequests) state.failedReason = "chain-circuit-open";
        }
        if (rpcBudget.stopReason) break;
      }
    });
    markBudgetStop(states, rpcBudget.stopReason);
  };

  await runStage(states.map((state) => ({ state, inputUsd: 1_000 })));
  for (const notional of [100_000, 1_000_000, 10_000_000, 25_000_000]) {
    throwIfAborted(signal);
    await runStage(
      states
        .filter(
          (state) =>
            !state.failedReason &&
            !state.stopped &&
            getDexMeasuredExecutionProbeNotionals(state.target.retainedTvlUsd).includes(notional),
        )
        .map((state) => ({ state, inputUsd: notional })),
    );
  }
  for (let round = 0; round < MEASURED_EXECUTION_REFINEMENT_ROUNDS; round++) {
    throwIfAborted(signal);
    await runStage(
      states.flatMap((state) => {
        if (state.failedReason || !state.bracket) return [];
        if (state.bracket.upperFailingUsd - state.bracket.lowerPassingUsd <= 0.02) return [];
        return [
          {
            state,
            inputUsd: (state.bracket.lowerPassingUsd + state.bracket.upperFailingUsd) / 2,
          },
        ];
      }),
    );
    for (const state of states) {
      if (!state.bracket || state.failedReason) continue;
      const latest = state.points[state.points.length - 1];
      if (!latest) continue;
      if (latest.passesCostBound) state.bracket.lowerPassingUsd = latest.inputUsd;
      else state.bracket.upperFailingUsd = latest.inputUsd;
    }
  }

  const publishedAt = Math.floor(Date.now() / 1_000);
  const outcomes: DexMeasuredQuoteOutcome[] = states.map((state) => {
    if (
      state.failedReason ||
      !state.deployment ||
      state.blockNumber == null ||
      state.blockObservedAt == null ||
      !state.endpointCodeHash
    ) {
      return {
        target: state.target,
        status: "failed",
        failureReason: state.failedReason ?? "deployment-unavailable",
        rawPayload: { adapterProfileId: state.target.adapterProfileId, targetId: state.target.targetId },
      };
    }
    try {
      const profile = buildDexMeasuredExecutionProfile({
        target: state.target,
        targetGenerationId: targetGeneration.generationId,
        quoteGenerationId,
        quotedAt: state.blockObservedAt,
        blockNumber: state.blockNumber,
        endpointAddress: state.deployment.config.endpointAddress,
        endpointCodeHash: state.endpointCodeHash,
        ...(state.poolBindingProof ? { poolBindingProof: state.poolBindingProof } : {}),
        ...(state.registryBindingProof ? { registryBindingProof: state.registryBindingProof } : {}),
        ...(state.stableSwapNgFactoryBindingProof
          ? { stableSwapNgFactoryBindingProof: state.stableSwapNgFactoryBindingProof }
          : {}),
        ...(state.curveCompositeProof
          ? { curveCompositeProof: state.curveCompositeProof }
          : {}),
        ...(state.uniswapV4PoolProof
          ? { uniswapV4PoolProof: state.uniswapV4PoolProof }
          : {}),
        points: state.points,
      });
      const genericIssues = validateDexMeasuredExecutionProfile({
        profile,
        quotedTarget: state.target,
        currentTarget: state.target,
        expectedTargetGenerationId: targetGeneration.generationId,
        expectedQuoteGenerationId: quoteGenerationId,
        nowSec: publishedAt,
      });
      const adapterIssues = DEX_EXACT_QUOTE_V1_COMPATIBILITY_RUNNERS[state.deployment.kind].validate(profile);
      if (genericIssues.length > 0 || adapterIssues.length > 0) {
        throw new Error([...genericIssues, ...adapterIssues].join(","));
      }
      return {
        target: state.target,
        status: "measured",
        profile,
        rawPayload: {
          adapterProfileId: state.target.adapterProfileId,
          targetId: state.target.targetId,
          points: state.points,
        },
      };
    } catch (error) {
      return {
        target: state.target,
        status: "failed",
        failureReason: `profile-validation:${toErrorMessage(error)}`,
        rawPayload: {
          adapterProfileId: state.target.adapterProfileId,
          targetId: state.target.targetId,
          points: state.points,
        },
      };
    }
  });

  await reportProgress?.({
    stage: "quote-publication",
    message: "Publishing measured DEX execution quotes",
    itemsDone: outcomes.length,
    itemsTotal: targetGeneration.targets.length,
    metadata: { quoteCallCount, rpcRequestCount: rpcBudget.requestsUsed },
  });
  const publication = await (lane === "shadow"
    ? publishDexShadowMeasuredQuoteGeneration({
        db,
        targetGeneration,
        outcomes,
        quotedAt: publishedAt,
        generationId: quoteGenerationId,
        signal,
      })
    : publishDexMeasuredQuoteGeneration({
        db,
        targetGeneration,
        outcomes,
        quotedAt: publishedAt,
        generationId: quoteGenerationId,
        signal,
      }));
  let cursorWriteStatus: "not-needed" | "written" | "write-failed" = "not-needed";
  if (budgetDeferredCount > 0 && nextCursor) {
    const cursorWrite = await writeDexSourcePaginationState({
      db,
      sourceKey: lane === "shadow"
        ? SHADOW_MEASURED_EXECUTION_ADMISSION_SOURCE_KEY
        : MEASURED_EXECUTION_ADMISSION_SOURCE_KEY,
      cursor: nextCursor,
      cycleStartedAt: admissionState.cycleStartedAt ?? startedAt,
      nowSec: publishedAt,
      completed: false,
      pagesFetched: admitted.size,
      diagnostics: [`deferred-targets:${deferred.size}`, `target-generation:${targetGeneration.generationId}`],
      job: "sync-cl-exit-depth",
    });
    cursorWriteStatus = cursorWrite.written
      ? "written"
      : cursorWrite.errorClass === "not-configured"
        ? "write-failed"
        : cursorWrite.errorClass;
  }
  const retention = await pruneDexMeasuredExecutionGenerations(db, publishedAt, signal);
  const failureSummary = summarizeMeasuredExecutionQuoteFailures(outcomes, oversized);
  const metadata = {
    lane,
    targetGenerationId: targetGeneration.generationId,
    quoteGenerationId: publication.generationId,
    targetCount: targetGeneration.targets.length,
    measuredCount: publication.measuredCount,
    failedCount: publication.failedCount,
    attemptedFailureCount: failureSummary.attemptedFailureCount,
    scoreEligibleAttemptedFailureCount: failureSummary.scoreEligibleAttemptedFailureCount,
    scoreEligibleDiagnosticFailureCount: failureSummary.scoreEligibleDiagnosticFailureCount,
    scoreEligibleBlockingFailureCount: failureSummary.scoreEligibleBlockingFailureCount,
    diagnosticAttemptedFailureCount: failureSummary.diagnosticAttemptedFailureCount,
    deferredCount: deferred.size,
    budgetDeferredCount,
    admissionEstimatedRpcRequests: estimatedRpcRequests,
    admissionSetupEstimatedRpcRequests: estimatedSetupRpcRequests,
    admissionQuoteEstimatedRpcRequests: estimatedQuoteRpcRequests,
    ...MEASURED_EXECUTION_ADMISSION_RUN_METADATA,
    expiringPriorityTargetIds: [...priorityAdmitted].sort(),
    expiringPriorityObservedAtSec: expiringPriority?.observedAtSec ?? null,
    expiringPriorityExpiresAtSec: expiringPriority?.expiresAtSec ?? null,
    expiringPriorityEstimatedRpcRequests:
      expiringPriority?.estimatedRpcRequests ?? 0,
    expiringPriorityRpcRequestLimit:
      MAX_EXPIRING_PRIORITY_RPC_REQUESTS,
    admissionRotationCycles,
    admissionCursor,
    nextAdmissionCursor: nextCursor,
    cursorWriteStatus,
    oversizedCoinIds,
    degradedReasons: [
      ...(failureSummary.scoreEligibleBlockingFailureCount > 0 ? ["quote-failures"] : []),
      ...(oversizedCoinIds.length > 0 ? ["admission-coin-group-oversized"] : []),
      ...(cursorWriteStatus === "write-failed" ? ["admission-cursor-write-failed"] : []),
      ...(budgetDeferredCount > 0 && cursorWriteStatus !== "written"
        ? ["admission-cursor-not-persisted"]
        : []),
      ...(admissionRotationCycles === null || admissionRotationCycles > MAX_ADMISSION_ROTATION_CYCLES
        ? ["admission-rotation-exceeds-freshness"]
        : []),
      ...(retention.error ? ["retention-cleanup-failed"] : []),
    ],
    quoteCallCount,
    rpcRequestCount: rpcBudget.requestsUsed,
    runtimeBudgetStopReason: rpcBudget.stopReason,
    openChainCircuits: rpcBudget.openChains,
    retention,
    failuresByReason: outcomes.reduce<Record<string, number>>((counts, outcome) => {
      if (outcome.status === "failed") {
        const reason = outcome.failureReason ?? "unknown";
        counts[reason] = (counts[reason] ?? 0) + 1;
      }
      return counts;
    }, {}),
  };
  return {
    status: retention.error
      ? "degraded"
      : resolveMeasuredExecutionCronStatus({
          attemptedFailureCount: failureSummary.scoreEligibleBlockingFailureCount,
          deferredCount: budgetDeferredCount,
          admissionRotationCycles,
          cursorWriteStatus,
        }),
    itemCount: publication.measuredCount,
    metadata: JSON.stringify(metadata),
    productivity: {
      productive: publication.measuredCount > 0,
      reason: publication.measuredCount > 0 ? "published-measured-execution" : "no-measured-execution",
    },
  };
}

export async function syncDexMeasuredExecution(
  db: D1Database,
  chainRpcs: Map<string, ChainRpcConfig>,
  signal?: AbortSignal,
  reportProgress?: CronProgressReporter,
): Promise<CronResult> {
  return syncDexMeasuredExecutionLane(db, chainRpcs, signal, reportProgress, "active");
}

export async function syncDexShadowMeasuredExecution(
  db: D1Database,
  chainRpcs: Map<string, ChainRpcConfig>,
  signal?: AbortSignal,
  reportProgress?: CronProgressReporter,
): Promise<CronResult> {
  return syncDexMeasuredExecutionLane(db, chainRpcs, signal, reportProgress, "shadow");
}
