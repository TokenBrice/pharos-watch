import {
  getDexMeasuredExecutionProbeNotionals,
  validateDexMeasuredExecutionProfile,
  type DexMeasuredExecutionPoolBindingProof,
  type DexMeasuredExecutionRegistryBindingProof,
  type DexMeasuredExecutionStableSwapNgFactoryBindingProof,
  type DexMeasuredExecutionTarget,
} from "@shared/types/measured-execution";
import type { ChainRpcConfig } from "../../lib/chain-registry";
import { throwIfAborted } from "../../lib/abort";
import type { CronProgressReporter, CronResult } from "../../lib/cron-logger";
import { fetchEvmBlockNumber } from "../../lib/evm-rpc";
import { toErrorMessage } from "../../lib/error-utils";
import { readDexSourcePaginationState, writeDexSourcePaginationState } from "../dex-liquidity/source-pagination-state";
import { rotateFromCursor } from "../shared/cursor-rotation";
import {
  buildDexMeasuredQuoteGenerationId,
  loadLatestPublishedDexMeasuredTargets,
  publishDexMeasuredQuoteGeneration,
  pruneDexMeasuredExecutionGenerations,
  type DexMeasuredQuoteOutcome,
} from "./persistence";
import {
  buildDexMeasuredExecutionProfile,
  createDexMeasuredExecutionRpcBudget,
  type DexMeasuredRawQuotePoint,
} from "./profiles";
import { quoteQuoterV2Requests, resolveQuoterV2PoolBindings, validateQuoterV2ProfileProof } from "./quoter-v2";
import {
  getDexMeasuredExecutionDeployment,
  verifyDexMeasuredExecutionDeployment,
  type DexMeasuredExecutionDeployment,
} from "./registry";
import {
  FLUID_RESOLVER_ADAPTER_PROFILE_ID,
  getFluidResolverDeployment,
  quoteFluidResolverRequests,
  validateFluidResolverProfileProof,
  verifyFluidResolverDeployment,
  type FluidResolverDeployment,
} from "./fluid-resolver";
import {
  CURVE_CRYPTOSWAP_ADAPTER_PROFILE_ID,
  getCurveCryptoSwapShadowPolicy,
  quoteCurveCryptoSwapRequests,
  validateCurveCryptoSwapProfileProof,
  verifyCurveCryptoSwapDeployment,
  type CurveCryptoSwapPoolPolicy,
  type CurveCryptoSwapRuntimeEvidence,
} from "./curve-cryptoswap";
import {
  CURVE_STABLESWAP_ADAPTER_PROFILE_ID,
  getCurveStableSwapPolicy,
  quoteCurveStableSwapRequests,
  validateCurveStableSwapProfileProof,
  verifyCurveStableSwapDeployment,
  type CurveStableSwapPoolPolicy,
  type CurveStableSwapRuntimeEvidence,
} from "./curve-stableswap";
import {
  CURVE_STABLESWAP_NG_ADAPTER_PROFILE_ID,
  getCurveStableSwapNgPolicy,
  quoteCurveStableSwapNgRequests,
  validateCurveStableSwapNgProfileProof,
  verifyCurveStableSwapNgDeployment,
  type CurveStableSwapNgPoolPolicy,
  type CurveStableSwapNgRuntimeEvidence,
} from "./curve-stableswap-ng";

const MAX_QUOTE_CALLS = 6_400;
const MAX_RPC_REQUESTS = 800;
const RPC_ADMISSION_HEADROOM = 64;
const MAX_ADMISSION_RPC_REQUESTS = MAX_RPC_REQUESTS - RPC_ADMISSION_HEADROOM;
const CONSERVATIVE_MULTICALL_BATCH_SIZE = 8;
const MAX_ADMISSION_ROTATION_CYCLES = 2;
const MAX_RUNTIME_MS = 8 * 60 * 1_000;
const REFINEMENT_ROUNDS = 3;
const MEASURED_EXECUTION_ADMISSION_SOURCE_KEY = "measured-execution:quote-admission";

type TargetDeployment =
  | { kind: "quoter-v2"; config: DexMeasuredExecutionDeployment }
  | { kind: "fluid-resolver"; config: FluidResolverDeployment }
  | {
      kind: "curve-cryptoswap";
      config: CurveCryptoSwapPoolPolicy & { endpointAddress: `0x${string}` };
    }
  | {
      kind: "curve-stableswap";
      config: CurveStableSwapPoolPolicy & { endpointAddress: `0x${string}` };
    }
  | {
      kind: "curve-stableswap-ng";
      config: CurveStableSwapNgPoolPolicy & { endpointAddress: `0x${string}` };
    };

interface TargetQuoteState {
  target: DexMeasuredExecutionTarget;
  deployment: TargetDeployment | null;
  blockNumber: number | null;
  blockObservedAt: number | null;
  endpointCodeHash: `0x${string}` | null;
  curveRuntimeEvidence: CurveCryptoSwapRuntimeEvidence | null;
  curveStableSwapRuntimeEvidence: CurveStableSwapRuntimeEvidence | null;
  curveStableSwapNgRuntimeEvidence: CurveStableSwapNgRuntimeEvidence | null;
  poolBindingProof: DexMeasuredExecutionPoolBindingProof | null;
  registryBindingProof: DexMeasuredExecutionRegistryBindingProof | null;
  stableSwapNgFactoryBindingProof: DexMeasuredExecutionStableSwapNgFactoryBindingProof | null;
  points: DexMeasuredRawQuotePoint[];
  failedReason: string | null;
  stopped: boolean;
  bracket: { lowerPassingUsd: number; upperFailingUsd: number } | null;
}

async function runWithConcurrency<T>(
  values: readonly T[],
  concurrency: number,
  run: (value: T) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, async () => {
      while (cursor < values.length) {
        const index = cursor++;
        await run(values[index]!);
      }
    }),
  );
}

function deploymentForTarget(target: DexMeasuredExecutionTarget): TargetDeployment | null {
  if (target.adapterProfileId === FLUID_RESOLVER_ADAPTER_PROFILE_ID) {
    const deployment = getFluidResolverDeployment(target.chain);
    return deployment ? { kind: "fluid-resolver", config: deployment } : null;
  }
  if (target.adapterProfileId === CURVE_CRYPTOSWAP_ADAPTER_PROFILE_ID) {
    const prefix = `${target.chain.trim().toLowerCase()}:`;
    if (!target.poolId.toLowerCase().startsWith(prefix)) return null;
    const endpointAddress = target.poolId.slice(prefix.length).toLowerCase();
    const policy = getCurveCryptoSwapShadowPolicy(target.chain, endpointAddress);
    return policy?.scoreEligible && policy.mode === "active"
      ? { kind: "curve-cryptoswap", config: { ...policy, endpointAddress: policy.poolAddress } }
      : null;
  }
  if (target.adapterProfileId === CURVE_STABLESWAP_ADAPTER_PROFILE_ID) {
    const prefix = `${target.chain.trim().toLowerCase()}:`;
    if (!target.poolId.toLowerCase().startsWith(prefix)) return null;
    const endpointAddress = target.poolId.slice(prefix.length).toLowerCase();
    const policy = getCurveStableSwapPolicy(target.chain, endpointAddress);
    return policy?.scoreEligible && policy.mode === "active"
      ? { kind: "curve-stableswap", config: { ...policy, endpointAddress: policy.poolAddress } }
      : null;
  }
  if (target.adapterProfileId === CURVE_STABLESWAP_NG_ADAPTER_PROFILE_ID) {
    const prefix = `${target.chain.trim().toLowerCase()}:`;
    if (!target.poolId.toLowerCase().startsWith(prefix)) return null;
    const endpointAddress = target.poolId.slice(prefix.length).toLowerCase();
    const policy = getCurveStableSwapNgPolicy(target.chain, endpointAddress);
    return policy?.scoreEligible && policy.mode === "active"
      ? { kind: "curve-stableswap-ng", config: { ...policy, endpointAddress: policy.poolAddress } }
      : null;
  }
  const deployment = getDexMeasuredExecutionDeployment(target.adapterProfileId, target.chain);
  return deployment ? { kind: "quoter-v2", config: deployment } : null;
}

function countAdmissionBatches<T>(
  values: readonly T[],
  groupKey: (value: T) => string,
): number {
  const counts = new Map<string, number>();
  for (const value of values) {
    const key = groupKey(value);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.values()].reduce(
    (sum, count) => sum + Math.ceil(count / CONSERVATIVE_MULTICALL_BATCH_SIZE),
    0,
  );
}

export function estimateAdmissionCohortRpcRequests(
  targets: readonly DexMeasuredExecutionTarget[],
  refinementRounds = REFINEMENT_ROUNDS,
): number {
  const executable = targets.flatMap((target) => {
    const deployment = deploymentForTarget(target);
    return deployment ? [{ target, deployment }] : [];
  });
  const quoterRows = executable.filter((row) => row.deployment.kind === "quoter-v2");
  const quoteGroupKey = (row: typeof executable[number]) =>
    `${row.target.chain}:${row.deployment.kind}`;
  let estimatedRequests = countAdmissionBatches(
    quoterRows,
    (row) => {
      const deployment = row.deployment;
      return deployment.kind === "quoter-v2"
        ? `${row.target.chain}:${deployment.config.adapterProfileId}:${deployment.config.factoryAddress}`
        : `${row.target.chain}:unsupported`;
    },
  );

  const probeNotionals = [...new Set(
    executable.flatMap((row) => getDexMeasuredExecutionProbeNotionals(row.target.retainedTvlUsd)),
  )];
  for (const notional of probeNotionals) {
    estimatedRequests += countAdmissionBatches(
      executable.filter((row) =>
        getDexMeasuredExecutionProbeNotionals(row.target.retainedTvlUsd).includes(notional),
      ),
      quoteGroupKey,
    );
  }
  estimatedRequests += refinementRounds * countAdmissionBatches(executable, quoteGroupKey);
  // Quoter inner reverts receive serialized confirmation; reserve one per target.
  estimatedRequests += quoterRows.length;
  return estimatedRequests;
}

export function admitTargetsWithinBudget(
  targets: readonly DexMeasuredExecutionTarget[],
  options: { cursor?: string | null; maxEstimatedRpcRequests?: number; refinementRounds?: number } = {},
): {
  admitted: Set<string>;
  deferred: Set<string>;
  oversized: Set<string>;
  oversizedCoinIds: string[];
  estimatedRpcRequests: number;
  nextCursor: string | null;
} {
  const byCoin = new Map<string, DexMeasuredExecutionTarget[]>();
  for (const target of targets) {
    const rows = byCoin.get(target.stablecoinId) ?? [];
    rows.push(target);
    byCoin.set(target.stablecoinId, rows);
  }
  const ranked = [...byCoin].sort((left, right) => {
    const leftTvl = left[1].reduce((sum, target) => sum + target.retainedTvlUsd, 0);
    const rightTvl = right[1].reduce((sum, target) => sum + target.retainedTvlUsd, 0);
    return rightTvl - leftTvl || left[0].localeCompare(right[0]);
  });
  const rotated = rotateFromCursor(ranked, options.cursor, ([stablecoinId]) => stablecoinId, {
    startAfterCursor: true,
  }).items;
  const admitted = new Set<string>();
  const deferred = new Set<string>();
  const oversized = new Set<string>();
  const oversizedCoinIds: string[] = [];
  const maxEstimatedRpcRequests = options.maxEstimatedRpcRequests ?? MAX_ADMISSION_RPC_REQUESTS;
  let estimatedRpcRequests = 0;
  const admittedTargets: DexMeasuredExecutionTarget[] = [];
  let nextCursor = options.cursor ?? null;
  let cursorFrozen = false;
  for (const [stablecoinId, coinTargets] of rotated) {
    const refinementRounds = options.refinementRounds ?? REFINEMENT_ROUNDS;
    const coinEstimatedRpcRequests = estimateAdmissionCohortRpcRequests(
      coinTargets,
      refinementRounds,
    );
    if (coinEstimatedRpcRequests > maxEstimatedRpcRequests) {
      oversizedCoinIds.push(stablecoinId);
      for (const target of coinTargets) {
        deferred.add(target.targetId);
        oversized.add(target.targetId);
      }
      continue;
    }
    const candidateEstimatedRpcRequests = estimateAdmissionCohortRpcRequests(
      [...admittedTargets, ...coinTargets],
      refinementRounds,
    );
    if (candidateEstimatedRpcRequests > maxEstimatedRpcRequests) {
      cursorFrozen = true;
      for (const target of coinTargets) deferred.add(target.targetId);
      continue;
    }
    estimatedRpcRequests = candidateEstimatedRpcRequests;
    admittedTargets.push(...coinTargets);
    for (const target of coinTargets) admitted.add(target.targetId);
    if (!cursorFrozen) nextCursor = stablecoinId;
  }
  return { admitted, deferred, oversized, oversizedCoinIds, estimatedRpcRequests, nextCursor };
}

export function estimateAdmissionRotationCycles(
  targets: readonly DexMeasuredExecutionTarget[],
  options: { cursor?: string | null; maxEstimatedRpcRequests?: number; refinementRounds?: number } = {},
): number | null {
  if (targets.length === 0) return 0;
  const uncovered = new Set(targets.map((target) => target.targetId));
  const seenCursors = new Set<string>();
  let cursor = options.cursor ?? null;
  const maximumCycles = new Set(targets.map((target) => target.stablecoinId)).size + 1;

  for (let cycle = 1; cycle <= maximumCycles; cycle++) {
    const cursorKey = cursor ?? "<start>";
    if (seenCursors.has(cursorKey)) return null;
    seenCursors.add(cursorKey);
    const admission = admitTargetsWithinBudget(targets, {
      ...options,
      cursor,
    });
    for (const targetId of admission.oversized) uncovered.delete(targetId);
    for (const targetId of admission.admitted) uncovered.delete(targetId);
    if (uncovered.size === 0) return cycle;
    cursor = admission.nextCursor;
  }
  return null;
}

export function resolveMeasuredExecutionCronStatus(input: {
  attemptedFailureCount: number;
  deferredCount: number;
  admissionRotationCycles: number | null;
  cursorWriteStatus: "not-needed" | "written" | "missing-table" | "write-failed";
}): "ok" | "degraded" {
  return (
    input.attemptedFailureCount > 0 ||
    input.admissionRotationCycles === null ||
    input.admissionRotationCycles > MAX_ADMISSION_ROTATION_CYCLES ||
    input.cursorWriteStatus === "write-failed" ||
    (input.deferredCount > 0 && input.cursorWriteStatus !== "written")
  )
    ? "degraded"
    : "ok";
}

export function hasCompleteDexMeasuredQuoteProgress(input: {
  target: DexMeasuredExecutionTarget;
  points: readonly Pick<DexMeasuredRawQuotePoint, "inputUsd">[];
  stopped: boolean;
}): boolean {
  if (input.points.length === 0) return false;
  if (input.stopped) return true;
  return getDexMeasuredExecutionProbeNotionals(input.target.retainedTvlUsd).every((notional) =>
    input.points.some((point) => Math.abs(point.inputUsd - notional) <= 0.02),
  );
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
    state.failedReason = outcome.failureReason ?? "quote-failed";
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

export async function syncDexMeasuredExecution(
  db: D1Database,
  chainRpcs: Map<string, ChainRpcConfig>,
  signal?: AbortSignal,
  reportProgress?: CronProgressReporter,
): Promise<CronResult> {
  const startedAtMs = Date.now();
  const startedAt = Math.floor(startedAtMs / 1_000);
  const rpcBudget = createDexMeasuredExecutionRpcBudget({
    maxRequests: MAX_RPC_REQUESTS,
    deadlineMs: startedAtMs + MAX_RUNTIME_MS,
  });
  const targetGeneration = await loadLatestPublishedDexMeasuredTargets(db, signal);
  if (!targetGeneration || targetGeneration.targets.length === 0) {
    return {
      status: "degraded",
      itemCount: 0,
      metadata: JSON.stringify({ reason: "target-generation-missing" }),
      productivity: { productive: false, reason: "target-generation-missing" },
    };
  }

  const quoteGenerationId = buildDexMeasuredQuoteGenerationId(startedAt);
  const admissionState = await readDexSourcePaginationState(
    db,
    MEASURED_EXECUTION_ADMISSION_SOURCE_KEY,
    "sync-cl-exit-depth",
  );
  const admissionCursor = admissionState.cursor?.trim() || null;
  const {
    admitted,
    deferred,
    oversized,
    oversizedCoinIds,
    estimatedRpcRequests,
    nextCursor,
  } = admitTargetsWithinBudget(targetGeneration.targets, {
    cursor: admissionCursor,
  });
  const admissionRotationCycles = estimateAdmissionRotationCycles(targetGeneration.targets, {
    cursor: admissionCursor,
  });
  const budgetDeferredCount = deferred.size - oversized.size;
  const states = targetGeneration.targets.map<TargetQuoteState>((target) => ({
    target,
    deployment: deploymentForTarget(target),
    blockNumber: null,
    blockObservedAt: null,
    endpointCodeHash: null,
    curveRuntimeEvidence: null,
    curveStableSwapRuntimeEvidence: null,
    curveStableSwapNgRuntimeEvidence: null,
    poolBindingProof: null,
    registryBindingProof: null,
    stableSwapNgFactoryBindingProof: null,
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
  await runWithConcurrency([...chainStates], 3, async ([chain, rows]) => {
    if (!rpcBudget.canRequestChain(chain)) {
      markBudgetStop(rows, rpcBudget.stopReason);
      return;
    }
    const blockObservedAt = Math.floor(Date.now() / 1_000);
    const blockNumber = await fetchEvmBlockNumber(chain, {
      chainRpcs,
      signal,
      timeoutMs: 15_000,
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
      } else if (deployment.kind === "fluid-resolver") {
        const verified = await verifyFluidResolverDeployment({
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
      } else {
        const verified = await verifyCurveStableSwapNgDeployment({
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
          state.curveStableSwapNgRuntimeEvidence = verified.runtimeEvidence;
          state.stableSwapNgFactoryBindingProof = verified.factoryBindingProof;
        }
      }
      if (rpcBudget.stopReason) {
        markBudgetStop(deploymentRows, rpcBudget.stopReason);
        break;
      }
    }
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
  await runWithConcurrency([...quoterStatesByChain.values()], 3, async (rows) => {
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
        (state.deployment.kind !== "curve-stableswap" || state.registryBindingProof != null) &&
        (
          state.deployment.kind !== "curve-stableswap-ng" ||
          state.stableSwapNgFactoryBindingProof != null
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
    await runWithConcurrency([...byChain.values()], 3, async (chainRequests) => {
      const byAdapter = new Map<TargetDeployment["kind"], typeof chainRequests>();
      for (const request of chainRequests) {
        const kind = request.state.deployment!.kind;
        const rows = byAdapter.get(kind) ?? [];
        rows.push(request);
        byAdapter.set(kind, rows);
      }
      for (const [kind, adapterRequests] of byAdapter) {
        throwIfAborted(signal);
        if (kind === "quoter-v2") {
          const outcomes = await quoteQuoterV2Requests({
            requests: adapterRequests.map(({ state, inputUsd }) => ({
              target: state.target,
              inputUsd,
              endpointAddress: state.deployment!.config.endpointAddress,
            })),
            blockNumber: adapterRequests[0]!.state.blockNumber!,
            chainRpcs,
            signal,
            rpcBudget,
          });
          outcomes.forEach((outcome, index) =>
            applyQuoteOutcome(adapterRequests[index]!.state, outcome),
          );
        } else if (kind === "fluid-resolver") {
          const outcomes = await quoteFluidResolverRequests({
            requests: adapterRequests.map(({ state, inputUsd }) => ({
              target: state.target,
              inputUsd,
              blockNumber: state.blockNumber!,
              endpointAddress: state.deployment!.config.endpointAddress,
            })),
            chainRpcs,
            signal,
            rpcBudget,
            deploymentVerified: true,
          });
          outcomes.forEach((outcome, index) =>
            applyQuoteOutcome(adapterRequests[index]!.state, outcome),
          );
        } else if (kind === "curve-cryptoswap") {
          const outcomes = await quoteCurveCryptoSwapRequests({
            requests: adapterRequests.map(({ state, inputUsd }) => ({
              target: state.target,
              inputUsd,
              blockNumber: state.blockNumber!,
              endpointAddress: state.deployment!.config.endpointAddress,
              runtimeEvidence: state.curveRuntimeEvidence ?? undefined,
            })),
            chainRpcs,
            signal,
            rpcBudget,
          });
          outcomes.forEach((outcome, index) =>
            applyQuoteOutcome(adapterRequests[index]!.state, outcome),
          );
        } else if (kind === "curve-stableswap") {
          const outcomes = await quoteCurveStableSwapRequests({
            requests: adapterRequests.map(({ state, inputUsd }) => ({
              target: state.target,
              inputUsd,
              blockNumber: state.blockNumber!,
              blockObservedAt: state.blockObservedAt!,
              endpointAddress: state.deployment!.config.endpointAddress,
              runtimeEvidence: state.curveStableSwapRuntimeEvidence ?? undefined,
            })),
            chainRpcs,
            signal,
            rpcBudget,
          });
          outcomes.forEach((outcome, index) =>
            applyQuoteOutcome(adapterRequests[index]!.state, outcome),
          );
        } else {
          const outcomes = await quoteCurveStableSwapNgRequests({
            requests: adapterRequests.map(({ state, inputUsd }) => ({
              target: state.target,
              inputUsd,
              blockNumber: state.blockNumber!,
              blockObservedAt: state.blockObservedAt!,
              endpointAddress: state.deployment!.config.endpointAddress,
              runtimeEvidence: state.curveStableSwapNgRuntimeEvidence ?? undefined,
            })),
            chainRpcs,
            signal,
            rpcBudget,
          });
          outcomes.forEach((outcome, index) =>
            applyQuoteOutcome(adapterRequests[index]!.state, outcome),
          );
        }
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
  for (let round = 0; round < REFINEMENT_ROUNDS; round++) {
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
      const adapterIssues =
        state.deployment.kind === "quoter-v2"
          ? validateQuoterV2ProfileProof(profile)
          : state.deployment.kind === "fluid-resolver"
            ? validateFluidResolverProfileProof(profile)
            : state.deployment.kind === "curve-cryptoswap"
              ? validateCurveCryptoSwapProfileProof(profile)
              : state.deployment.kind === "curve-stableswap"
                ? validateCurveStableSwapProfileProof(profile)
                : validateCurveStableSwapNgProfileProof(profile);
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
  const publication = await publishDexMeasuredQuoteGeneration({
    db,
    targetGeneration,
    outcomes,
    quotedAt: publishedAt,
    generationId: quoteGenerationId,
    signal,
  });
  let cursorWriteStatus: "not-needed" | "written" | "missing-table" | "write-failed" = "not-needed";
  if (budgetDeferredCount > 0 && nextCursor) {
    const cursorWrite = await writeDexSourcePaginationState({
      db,
      sourceKey: MEASURED_EXECUTION_ADMISSION_SOURCE_KEY,
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
  await pruneDexMeasuredExecutionGenerations(db, publishedAt, signal);
  const attemptedFailureCount = outcomes.filter(
    (outcome) => outcome.status === "failed" && outcome.failureReason !== "budget-deferred",
  ).length;
  const quoteFailureCount = Math.max(0, attemptedFailureCount - oversized.size);
  const metadata = {
    targetGenerationId: targetGeneration.generationId,
    quoteGenerationId: publication.generationId,
    targetCount: targetGeneration.targets.length,
    measuredCount: publication.measuredCount,
    failedCount: publication.failedCount,
    attemptedFailureCount,
    deferredCount: deferred.size,
    budgetDeferredCount,
    admissionEstimatedRpcRequests: estimatedRpcRequests,
    admissionRpcRequestLimit: MAX_ADMISSION_RPC_REQUESTS,
    admissionRotationCycles,
    admissionCursor,
    nextAdmissionCursor: nextCursor,
    cursorWriteStatus,
    oversizedCoinIds,
    degradedReasons: [
      ...(quoteFailureCount > 0 ? ["quote-failures"] : []),
      ...(oversizedCoinIds.length > 0 ? ["admission-coin-group-oversized"] : []),
      ...(cursorWriteStatus === "write-failed" ? ["admission-cursor-write-failed"] : []),
      ...(budgetDeferredCount > 0 && cursorWriteStatus !== "written"
        ? ["admission-cursor-not-persisted"]
        : []),
      ...(admissionRotationCycles === null || admissionRotationCycles > MAX_ADMISSION_ROTATION_CYCLES
        ? ["admission-rotation-exceeds-freshness"]
        : []),
    ],
    quoteCallCount,
    rpcRequestCount: rpcBudget.requestsUsed,
    runtimeBudgetStopReason: rpcBudget.stopReason,
    openChainCircuits: rpcBudget.openChains,
    failuresByReason: outcomes.reduce<Record<string, number>>((counts, outcome) => {
      if (outcome.status === "failed") {
        const reason = outcome.failureReason ?? "unknown";
        counts[reason] = (counts[reason] ?? 0) + 1;
      }
      return counts;
    }, {}),
  };
  return {
    status: resolveMeasuredExecutionCronStatus({
      attemptedFailureCount,
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
