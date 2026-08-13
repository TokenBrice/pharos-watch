import {
  getDexMeasuredExecutionProbeNotionals,
  getDexMeasuredExecutionFreshnessMaxSec,
  validateDexMeasuredExecutionProfile,
  type DexMeasuredExecutionPoolBindingProof,
  type DexMeasuredExecutionRegistryBindingProof,
  type DexMeasuredExecutionStableSwapNgFactoryBindingProof,
  type DexMeasuredExecutionCurveCompositeProof,
  type DexMeasuredExecutionTarget,
  type DexMeasuredExecutionUniswapV4PoolProof,
} from "@shared/types/measured-execution";
import {
  DexExitRouteObservationSchema,
  MAX_DEX_EXIT_ROUTE_OBSERVATIONS,
  type DexExitRouteObservation,
} from "@shared/types/market";
import {
  canonicalExitRouteAssetKey,
  canonicalExitRouteChain,
  canonicalExitRouteScopedKey,
} from "@shared/lib/exit-route-identity";
import type { ChainRpcConfig } from "../../lib/chain-registry";
import { rethrowIfAborted, throwIfAborted } from "../../lib/abort";
import type { CronProgressReporter, CronResult } from "../../lib/cron-logger";
import { fetchEvmBlockNumber } from "../../lib/evm-rpc";
import { toErrorMessage } from "../../lib/error-utils";
import { DEX_LIQUIDITY_PUBLISHED_ROW_FILTER } from "../../lib/dex-liquidity";
import { parseJsonObject } from "../../lib/json-parse";
import { logWorkerEvent } from "../../lib/structured-log";
import { readDexSourcePaginationState, writeDexSourcePaginationState } from "../dex-liquidity/source-pagination-state";
import { rotateFromCursor } from "../shared/cursor-rotation";
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
} from "./profiles";
import { quoteQuoterV2Requests, resolveQuoterV2PoolBindings, validateQuoterV2ProfileProof } from "./quoter-v2";
import {
  getDexMeasuredExecutionDeployment,
  isDexMeasuredExecutionDeploymentScoreEligible,
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
import {
  getCurveCompositePolicy,
  isCurveCompositeAdapterProfileId,
  quoteCurveCompositeRequests,
  validateCurveCompositeProfileProof,
  verifyCurveCompositeDeployment,
  type CurveCompositePoolPolicy,
  type CurveCompositeRuntimeEvidence,
} from "./curve-composite";
import {
  UNISWAP_V4_ADAPTER_PROFILE_ID,
  getUniswapV4Deployment,
  quoteUniswapV4Requests,
  resolveUniswapV4PoolBindings,
  validateUniswapV4ProfileProof,
  verifyUniswapV4Deployment,
  type UniswapV4Deployment,
  type UniswapV4RuntimeEvidence,
} from "./uniswap-v4";

const MAX_QUOTE_CALLS = 6_400;
const MAX_RPC_REQUESTS = 1_300;
const RPC_ADMISSION_FRAGMENTATION_HEADROOM = 80;
const MAX_ADMISSION_RPC_REQUESTS = MAX_RPC_REQUESTS - RPC_ADMISSION_FRAGMENTATION_HEADROOM;
const CONSERVATIVE_MULTICALL_BATCH_SIZE = 8;
const MAX_ADMISSION_ROTATION_CYCLES = 2;
const MAX_EXPIRING_PRIORITY_RPC_REQUESTS = 20;
export const MEASURED_EXECUTION_ADMISSION_RUN_METADATA = {
  admissionRpcRequestLimit: MAX_ADMISSION_RPC_REQUESTS,
  admissionFragmentationReserveRpcRequests: RPC_ADMISSION_FRAGMENTATION_HEADROOM,
  admissionRpcHardLimit: MAX_RPC_REQUESTS,
} as const;
const MAX_RUNTIME_MS = 8 * 60 * 1_000;
const REFINEMENT_ROUNDS = 3;
const MEASURED_EXECUTION_ADMISSION_SOURCE_KEY = "measured-execution:quote-admission";
const SHADOW_MEASURED_EXECUTION_ADMISSION_SOURCE_KEY = "measured-execution:shadow-quote-admission";

type TargetDeployment =
  | { kind: "quoter-v2"; config: DexMeasuredExecutionDeployment }
  | { kind: "fluid-resolver"; config: FluidResolverDeployment }
  | { kind: "uniswap-v4"; config: UniswapV4Deployment }
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
    }
  | {
      kind: "curve-composite";
      config: CurveCompositePoolPolicy & { endpointAddress: `0x${string}` };
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

function deploymentForTarget(target: DexMeasuredExecutionTarget): TargetDeployment | null {
  if (target.adapterProfileId === UNISWAP_V4_ADAPTER_PROFILE_ID) {
    const deployment = getUniswapV4Deployment(target.chain);
    return deployment ? { kind: "uniswap-v4", config: deployment } : null;
  }
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
  if (isCurveCompositeAdapterProfileId(target.adapterProfileId)) {
    const prefix = `${target.chain.trim().toLowerCase()}:`;
    if (!target.poolId.toLowerCase().startsWith(prefix)) return null;
    const endpointAddress = target.poolId.slice(prefix.length).toLowerCase();
    const policy = getCurveCompositePolicy(target.chain, endpointAddress);
    return policy
      ? { kind: "curve-composite", config: { ...policy, endpointAddress: policy.poolAddress } }
      : null;
  }
  const deployment = getDexMeasuredExecutionDeployment(target.adapterProfileId, target.chain);
  return deployment ? { kind: "quoter-v2", config: deployment } : null;
}

export function isDexMeasuredExecutionTargetScoreEligible(target: DexMeasuredExecutionTarget): boolean {
  const deployment = deploymentForTarget(target);
  if (isDexMeasuredExecutionDeploymentScoreEligible(target.adapterProfileId, target.chain)) return true;
  switch (deployment?.kind) {
    case "curve-cryptoswap":
    case "curve-stableswap":
    case "curve-stableswap-ng":
      return deployment.config.mode === "active" && deployment.config.scoreEligible === true;
    case "uniswap-v4":
      return deployment.config.mode === "active" && deployment.config.scoreEligible === true;
    case "quoter-v2":
    case "fluid-resolver":
    case "curve-composite":
    case undefined:
      return false;
  }
}

export function isDiagnosticDexMeasuredQuoteFailure(outcome: Pick<DexMeasuredQuoteOutcome, "status" | "failureReason" | "target">): boolean {
  return (
    outcome.status === "failed" &&
    outcome.failureReason === "profile-validation:quote-price-mismatch" &&
    outcome.target.tokenOut.trackedAssetId == null
  );
}

export function summarizeMeasuredExecutionQuoteFailures(
  outcomes: readonly DexMeasuredQuoteOutcome[],
  oversizedTargetIds: ReadonlySet<string> = new Set(),
): {
  attemptedFailureCount: number;
  scoreEligibleAttemptedFailureCount: number;
  scoreEligibleDiagnosticFailureCount: number;
  scoreEligibleBlockingFailureCount: number;
  diagnosticAttemptedFailureCount: number;
} {
  const attemptedFailures = outcomes.filter(
    (outcome) => outcome.status === "failed" && outcome.failureReason !== "budget-deferred",
  );
  const scoreEligibleFailures = attemptedFailures.filter(
    (outcome) =>
      !oversizedTargetIds.has(outcome.target.targetId) &&
      isDexMeasuredExecutionTargetScoreEligible(outcome.target),
  );
  const scoreEligibleDiagnosticFailureCount = scoreEligibleFailures.filter(isDiagnosticDexMeasuredQuoteFailure).length;
  const scoreEligibleBlockingFailureCount = scoreEligibleFailures.length - scoreEligibleDiagnosticFailureCount;
  return {
    attemptedFailureCount: attemptedFailures.length,
    scoreEligibleAttemptedFailureCount: scoreEligibleFailures.length,
    scoreEligibleDiagnosticFailureCount,
    scoreEligibleBlockingFailureCount,
    diagnosticAttemptedFailureCount: Math.max(
      0,
      attemptedFailures.length - scoreEligibleFailures.length - oversizedTargetIds.size,
    ) + scoreEligibleDiagnosticFailureCount,
  };
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

function estimateDeploymentSetupRpcRequests(deployment: TargetDeployment): number {
  switch (deployment.kind) {
    case "quoter-v2":
      return 2; // Quoter and factory bytecode.
    case "fluid-resolver":
      return 1; // Resolver bytecode.
    case "uniswap-v4":
      return 4; // PoolManager, StateView, Quoter bytecode, then immutable bindings.
    case "curve-cryptoswap":
      return 10; // Pool/dependency code, dependency addresses, coins, and kill-state probe.
    case "curve-stableswap":
      return 5 + deployment.config.poolTokens.length * 2;
    case "curve-stableswap-ng":
      return 6 + deployment.config.poolTokens.length * 2;
    case "curve-composite":
      // Two pinned-header reads, three code proofs, three factory bindings,
      // one five-request branch proof, then every pool coin and execution-token
      // decimal. Derive the variable portion so wider metapools stay bounded.
      return 13 +
        deployment.config.poolTokens.length +
        deployment.config.executionTokens.length;
  }
}

export interface AdmissionRpcRequestEstimate {
  setupRpcRequests: number;
  quoteRpcRequests: number;
  totalRpcRequests: number;
}

export function estimateAdmissionCohortRpcRequestBreakdown(
  targets: readonly DexMeasuredExecutionTarget[],
  refinementRounds = REFINEMENT_ROUNDS,
): AdmissionRpcRequestEstimate {
  const executable = targets.flatMap((target) => {
    const deployment = deploymentForTarget(target);
    return deployment ? [{ target, deployment }] : [];
  });
  const chainSetupRpcRequests = new Set(
    executable.map((row) => row.target.chain.trim().toLowerCase()),
  ).size;
  const deployments = new Map<string, TargetDeployment>();
  for (const row of executable) {
    const deploymentKey = [
      row.target.chain.trim().toLowerCase(),
      row.deployment.kind,
      row.deployment.config.endpointAddress,
    ].join(":");
    if (!deployments.has(deploymentKey)) deployments.set(deploymentKey, row.deployment);
  }
  const deploymentSetupRpcRequests = [...deployments.values()].reduce(
    (sum, deployment) => sum + estimateDeploymentSetupRpcRequests(deployment),
    0,
  );
  const quoterRows = executable.filter((row) => row.deployment.kind === "quoter-v2");
  const uniswapV4Rows = executable.filter(
    (row) => row.deployment.kind === "uniswap-v4",
  );
  const quoteGroupKey = (row: typeof executable[number]) =>
    `${row.target.chain}:${row.deployment.kind}`;
  let quoteRpcRequests = countAdmissionBatches(
    quoterRows,
    (row) => {
      const deployment = row.deployment;
      return deployment.kind === "quoter-v2"
        ? `${row.target.chain}:${deployment.config.adapterProfileId}:${deployment.config.factoryAddress}`
        : `${row.target.chain}:unsupported`;
    },
  );
  quoteRpcRequests += countAdmissionBatches(
    uniswapV4Rows,
    (row) => `${row.target.chain}:uniswap-v4-pool-state`,
  );

  const probeNotionals = [...new Set(
    executable.flatMap((row) => getDexMeasuredExecutionProbeNotionals(row.target.retainedTvlUsd)),
  )];
  for (const notional of probeNotionals) {
    quoteRpcRequests += countAdmissionBatches(
      executable.filter((row) =>
        getDexMeasuredExecutionProbeNotionals(row.target.retainedTvlUsd).includes(notional),
      ),
      quoteGroupKey,
    );
  }
  quoteRpcRequests += refinementRounds * countAdmissionBatches(executable, quoteGroupKey);
  // Quoter inner reverts receive serialized confirmation; reserve one per target.
  quoteRpcRequests += quoterRows.length;
  const setupRpcRequests = chainSetupRpcRequests + deploymentSetupRpcRequests;
  return {
    setupRpcRequests,
    quoteRpcRequests,
    totalRpcRequests: setupRpcRequests + quoteRpcRequests,
  };
}

export function estimateAdmissionCohortRpcRequests(
  targets: readonly DexMeasuredExecutionTarget[],
  refinementRounds = REFINEMENT_ROUNDS,
): number {
  return estimateAdmissionCohortRpcRequestBreakdown(targets, refinementRounds).totalRpcRequests;
}

export interface PublishedScoreBearingDexRoute {
  stablecoinId: string;
  observation: DexExitRouteObservation;
}

export interface ExpiringScoreBearingPriorityPacket {
  targetIds: string[];
  observedAtSec: number;
  expiresAtSec: number;
  estimatedRpcRequests: number;
}

function publishedRouteMatchesTarget(
  row: PublishedScoreBearingDexRoute,
  target: DexMeasuredExecutionTarget,
): boolean {
  const observation = row.observation;
  if (
    row.stablecoinId !== target.stablecoinId ||
    observation.adapterProfileId !== target.adapterProfileId ||
    observation.scope.kind !== "chain-contract" ||
    canonicalExitRouteChain(observation.scope.chain) !==
      canonicalExitRouteChain(target.chain) ||
    canonicalExitRouteScopedKey(
      observation.scope.chain,
      observation.scope.contractOrPoolId,
    ) !== canonicalExitRouteScopedKey(target.chain, target.poolId)
  ) {
    return false;
  }
  const trackedOutput = target.tokenOut.trackedAssetId;
  if (
    trackedOutput &&
    observation.output.trackedAssetIds?.includes(trackedOutput)
  ) {
    return true;
  }
  return observation.output.assetKeys?.includes(
    canonicalExitRouteAssetKey(target.chain, target.tokenOut.address),
  ) ?? false;
}

/**
 * Select one bounded packet whose currently published score-bearing route is
 * closest to expiry. Identity-ambiguous observations are ignored. The legacy
 * Curve 3pool directions remain one atomic packet.
 */
export function selectExpiringScoreBearingPriorityPacket(
  targets: readonly DexMeasuredExecutionTarget[],
  publishedRoutes: readonly PublishedScoreBearingDexRoute[],
  maxEstimatedRpcRequests = MAX_EXPIRING_PRIORITY_RPC_REQUESTS,
): ExpiringScoreBearingPriorityPacket | null {
  const effectiveMaxEstimatedRpcRequests = Math.min(
    maxEstimatedRpcRequests,
    MAX_EXPIRING_PRIORITY_RPC_REQUESTS,
  );
  const matched = new Map<
    string,
    { target: DexMeasuredExecutionTarget; observedAtSec: number }
  >();
  for (const row of publishedRoutes) {
    const observation = row.observation;
    if (
      !observation.scoreEligible ||
      observation.evidenceKind !== "measured-executable-depth" ||
      !observation.adapterProfileId
    ) {
      continue;
    }
    const candidates = targets.filter((target) =>
      publishedRouteMatchesTarget(row, target),
    );
    if (candidates.length !== 1) continue;
    const target = candidates[0]!;
    const current = matched.get(target.targetId);
    if (
      current === undefined ||
      observation.observedAt < current.observedAtSec
    ) {
      matched.set(target.targetId, {
        target,
        observedAtSec: observation.observedAt,
      });
    }
  }

  const packets = new Map<
    string,
    Array<{ target: DexMeasuredExecutionTarget; observedAtSec: number }>
  >();
  for (const row of matched.values()) {
    const packetKey =
      row.target.adapterProfileId === CURVE_STABLESWAP_ADAPTER_PROFILE_ID
        ? [
            row.target.stablecoinId,
            row.target.adapterProfileId,
            canonicalExitRouteScopedKey(row.target.chain, row.target.poolId),
          ].join("\u0000")
        : row.target.targetId;
    const packet = packets.get(packetKey) ?? [];
    packet.push(row);
    packets.set(packetKey, packet);
  }

  return (
    [...packets.values()]
      .map((packet) => {
        const packetTargets = packet
          .map((row) => row.target)
          .sort((left, right) => left.targetId.localeCompare(right.targetId));
        if (
          packetTargets[0]?.adapterProfileId ===
          CURVE_STABLESWAP_ADAPTER_PROFILE_ID
        ) {
          const first = packetTargets[0];
          const poolKey = canonicalExitRouteScopedKey(
            first.chain,
            first.poolId,
          );
          const expectedTargetIds = targets
            .filter(
              (target) =>
                target.stablecoinId === first.stablecoinId &&
                target.adapterProfileId === first.adapterProfileId &&
                canonicalExitRouteScopedKey(target.chain, target.poolId) ===
                  poolKey,
            )
            .map((target) => target.targetId)
            .sort();
          if (
            expectedTargetIds.length < 2 ||
            expectedTargetIds.length !== packetTargets.length ||
            expectedTargetIds.some(
              (targetId, index) =>
                targetId !== packetTargets[index]?.targetId,
            )
          ) {
            return null;
          }
        }
        const estimatedRpcRequests =
          estimateAdmissionCohortRpcRequests(packetTargets);
        const observedAtSec = Math.min(
          ...packet.map((row) => row.observedAtSec),
        );
        const expiresAtSec = Math.min(
          ...packet.map(
            (row) =>
              row.observedAtSec +
              getDexMeasuredExecutionFreshnessMaxSec(
                row.target.adapterProfileId,
              ),
          ),
        );
        return {
          targetIds: packetTargets.map((target) => target.targetId),
          observedAtSec,
          expiresAtSec,
          estimatedRpcRequests,
        };
      })
      .filter(
        (
          packet,
        ): packet is ExpiringScoreBearingPriorityPacket => packet !== null,
      )
      .filter(
        (packet) =>
          packet.estimatedRpcRequests > 0 &&
          packet.estimatedRpcRequests <= effectiveMaxEstimatedRpcRequests,
      )
      .sort(
        (left, right) =>
          left.expiresAtSec - right.expiresAtSec ||
          left.targetIds.join("\u0000").localeCompare(
            right.targetIds.join("\u0000"),
          ),
      )[0] ?? null
  );
}

interface PublishedDexScoreDetailsRow {
  stablecoin_id: string;
  score_components_json: string;
}

async function loadExpiringScoreBearingPriorityPacket(
  db: D1Database,
  targets: readonly DexMeasuredExecutionTarget[],
  signal?: AbortSignal,
): Promise<ExpiringScoreBearingPriorityPacket | null> {
  try {
    throwIfAborted(signal);
    const result = await db
      .prepare(
        `SELECT stablecoin_id, score_components_json
           FROM dex_liquidity
          WHERE ${DEX_LIQUIDITY_PUBLISHED_ROW_FILTER}
            AND score_components_json IS NOT NULL
            AND instr(score_components_json, '"measured-executable-depth"') > 0
          ORDER BY stablecoin_id`,
      )
      .all<PublishedDexScoreDetailsRow>();
    throwIfAborted(signal);
    const publishedRoutes: PublishedScoreBearingDexRoute[] = [];
    for (const row of result.results ?? []) {
      const details = parseJsonObject(row.score_components_json);
      const observations = DexExitRouteObservationSchema.array()
        .max(MAX_DEX_EXIT_ROUTE_OBSERVATIONS)
        .safeParse(details?.exitRouteObservations);
      if (!observations.success) continue;
      for (const observation of observations.data) {
        publishedRoutes.push({
          stablecoinId: row.stablecoin_id,
          observation,
        });
      }
    }
    return selectExpiringScoreBearingPriorityPacket(
      targets,
      publishedRoutes,
    );
  } catch (error) {
    rethrowIfAborted(error, signal);
    logWorkerEvent({
      scope: "lib",
      level: "warn",
      event: "measured_execution.expiring_priority_load_failed",
      job: "sync-cl-exit-depth",
      message: "Could not load expiring score-bearing route priority",
      error,
    });
    return null;
  }
}

export function admitTargetsWithinBudget(
  targets: readonly DexMeasuredExecutionTarget[],
  options: {
    cursor?: string | null;
    maxEstimatedRpcRequests?: number;
    refinementRounds?: number;
    priorityTargetIds?: ReadonlySet<string>;
    priorityMaxEstimatedRpcRequests?: number;
  } = {},
): {
  admitted: Set<string>;
  deferred: Set<string>;
  oversized: Set<string>;
  priorityAdmitted: Set<string>;
  oversizedCoinIds: string[];
  estimatedRpcRequests: number;
  estimatedSetupRpcRequests: number;
  estimatedQuoteRpcRequests: number;
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
  const priorityAdmitted = new Set<string>();
  const oversizedCoinIds: string[] = [];
  const maxEstimatedRpcRequests = options.maxEstimatedRpcRequests ?? MAX_ADMISSION_RPC_REQUESTS;
  let estimatedRpcRequests = 0;
  let estimatedSetupRpcRequests = 0;
  let estimatedQuoteRpcRequests = 0;
  const admittedTargets: DexMeasuredExecutionTarget[] = [];
  const priorityTargets = targets.filter((target) =>
    options.priorityTargetIds?.has(target.targetId),
  );
  if (priorityTargets.length > 0) {
    const priorityEstimate = estimateAdmissionCohortRpcRequestBreakdown(
      priorityTargets,
      options.refinementRounds ?? REFINEMENT_ROUNDS,
    );
    const priorityLimit = Math.min(
      maxEstimatedRpcRequests,
      MAX_EXPIRING_PRIORITY_RPC_REQUESTS,
      options.priorityMaxEstimatedRpcRequests ??
        MAX_EXPIRING_PRIORITY_RPC_REQUESTS,
    );
    if (
      priorityEstimate.totalRpcRequests > 0 &&
      priorityEstimate.totalRpcRequests <= priorityLimit
    ) {
      admittedTargets.push(...priorityTargets);
      estimatedRpcRequests = priorityEstimate.totalRpcRequests;
      estimatedSetupRpcRequests = priorityEstimate.setupRpcRequests;
      estimatedQuoteRpcRequests = priorityEstimate.quoteRpcRequests;
      for (const target of priorityTargets) {
        admitted.add(target.targetId);
        priorityAdmitted.add(target.targetId);
      }
    }
  }
  let nextCursor = options.cursor ?? null;
  let cursorFrozen = false;
  for (const [stablecoinId, originalCoinTargets] of rotated) {
    const coinTargets = originalCoinTargets.filter(
      (target) => !priorityAdmitted.has(target.targetId),
    );
    if (coinTargets.length === 0) continue;
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
    const candidateEstimate = estimateAdmissionCohortRpcRequestBreakdown(
      [...admittedTargets, ...coinTargets],
      refinementRounds,
    );
    if (candidateEstimate.totalRpcRequests > maxEstimatedRpcRequests) {
      cursorFrozen = true;
      for (const target of coinTargets) deferred.add(target.targetId);
      continue;
    }
    estimatedRpcRequests = candidateEstimate.totalRpcRequests;
    estimatedSetupRpcRequests = candidateEstimate.setupRpcRequests;
    estimatedQuoteRpcRequests = candidateEstimate.quoteRpcRequests;
    admittedTargets.push(...coinTargets);
    for (const target of coinTargets) admitted.add(target.targetId);
    if (!cursorFrozen) nextCursor = stablecoinId;
  }
  return {
    admitted,
    deferred,
    oversized,
    priorityAdmitted,
    oversizedCoinIds,
    estimatedRpcRequests,
    estimatedSetupRpcRequests,
    estimatedQuoteRpcRequests,
    nextCursor,
  };
}

export function estimateAdmissionRotationCycles(
  targets: readonly DexMeasuredExecutionTarget[],
  options: {
    cursor?: string | null;
    maxEstimatedRpcRequests?: number;
    refinementRounds?: number;
    priorityTargetIds?: ReadonlySet<string>;
    priorityMaxEstimatedRpcRequests?: number;
  } = {},
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
    maxRequests: MAX_RPC_REQUESTS,
    deadlineMs: startedAtMs + MAX_RUNTIME_MS,
  });
  const targetGeneration = lane === "shadow"
    ? await loadLatestPublishedDexShadowMeasuredTargets(db, signal)
    : await loadLatestPublishedDexMeasuredTargets(db, signal);
  if (!targetGeneration || targetGeneration.targets.length === 0) {
    return {
      status: "degraded",
      itemCount: 0,
      metadata: JSON.stringify({ reason: "target-generation-missing" }),
      productivity: { productive: false, reason: "target-generation-missing" },
    };
  }

  const quoteGenerationId = lane === "shadow"
    ? buildDexShadowMeasuredQuoteGenerationId(startedAt)
    : buildDexMeasuredQuoteGenerationId(startedAt);
  const expiringPriority = lane === "active"
    ? await loadExpiringScoreBearingPriorityPacket(db, targetGeneration.targets, signal)
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
    deployment: deploymentForTarget(target),
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
        } else if (kind === "uniswap-v4") {
          const outcomes = await quoteUniswapV4Requests({
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
        } else if (kind === "curve-stableswap-ng") {
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
        } else {
          const outcomes = await quoteCurveCompositeRequests({
            requests: adapterRequests.map(({ state, inputUsd }) => ({
              target: state.target,
              inputUsd,
              blockNumber: state.blockNumber!,
              blockObservedAt: state.blockObservedAt!,
              endpointAddress: state.deployment!.config.endpointAddress,
              runtimeEvidence: state.curveCompositeRuntimeEvidence ?? undefined,
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
      const adapterIssues =
        state.deployment.kind === "quoter-v2"
          ? validateQuoterV2ProfileProof(profile)
          : state.deployment.kind === "fluid-resolver"
            ? validateFluidResolverProfileProof(profile)
            : state.deployment.kind === "uniswap-v4"
              ? validateUniswapV4ProfileProof(profile)
            : state.deployment.kind === "curve-cryptoswap"
              ? validateCurveCryptoSwapProfileProof(profile)
              : state.deployment.kind === "curve-stableswap"
                ? validateCurveStableSwapProfileProof(profile)
                : state.deployment.kind === "curve-stableswap-ng"
                  ? validateCurveStableSwapNgProfileProof(profile)
                  : validateCurveCompositeProfileProof(profile);
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
  let cursorWriteStatus: "not-needed" | "written" | "missing-table" | "write-failed" = "not-needed";
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
