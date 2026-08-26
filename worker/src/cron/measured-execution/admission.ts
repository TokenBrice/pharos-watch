import { DEX_MEASURED_MAX_COST_BPS, getDexMeasuredExecutionFreshnessMaxSec,
  getDexMeasuredExecutionProbeNotionals, type DexMeasuredExecutionTarget } from "@shared/types/measured-execution";
import { DexExitRouteObservationSchema, MAX_DEX_EXIT_ROUTE_OBSERVATIONS, type DexExitRouteObservation } from "@shared/types/market";
import { canonicalExitRouteAssetKey, canonicalExitRouteChain, canonicalExitRouteScopedKey } from "@shared/lib/exit-route-identity";
import { buildMeasuredLedgerCohortKey, countMeasuredLadderCostBoundViolations,
  countMeasuredLadderMonotonicityViolations, type MeasuredLedgerRecordB } from "@shared/lib/measured-execution-ledger";
import { rethrowIfAborted, throwIfAborted } from "../../lib/abort";
import { DEX_LIQUIDITY_PUBLISHED_ROW_FILTER } from "../../lib/dex-liquidity";
import { parseJsonObject } from "../../lib/json-parse";
import { logWorkerEvent } from "../../lib/structured-log";
import { rotateFromCursor } from "../shared/cursor-rotation";
import type { DexMeasuredQuoteOutcome } from "./persistence";
import type { DexMeasuredRawQuotePoint } from "./profiles";
import { getDexMeasuredExecutionDeployment, isDexMeasuredExecutionDeploymentScoreEligible, type DexMeasuredExecutionDeployment } from "./registry";
import { CURVE_CRYPTOSWAP_ADAPTER_PROFILE_ID, getCurveCryptoSwapShadowPolicy, type CurveCryptoSwapPoolPolicy } from "./curve-cryptoswap";
import { CURVE_STABLESWAP_ADAPTER_PROFILE_ID, getCurveStableSwapPolicy, type CurveStableSwapPoolPolicy } from "./curve-stableswap";
import { CURVE_STABLESWAP_NG_ADAPTER_PROFILE_ID, getCurveStableSwapNgPolicy,
  type CurveStableSwapNgPoolPolicy } from "./curve-stableswap-ng";
import { getCurveCompositePolicy, isCurveCompositeAdapterProfileId,
  type CurveCompositePoolPolicy } from "./curve-composite";
import { UNISWAP_V4_ADAPTER_PROFILE_ID, getUniswapV4Deployment,
  type UniswapV4Deployment } from "./uniswap-v4";

export const MEASURED_EXECUTION_RPC_REQUEST_LIMIT = 1_300;
const RPC_ADMISSION_FRAGMENTATION_HEADROOM = 80;
const MAX_ADMISSION_RPC_REQUESTS = MEASURED_EXECUTION_RPC_REQUEST_LIMIT - RPC_ADMISSION_FRAGMENTATION_HEADROOM;
const CONSERVATIVE_MULTICALL_BATCH_SIZE = 8;
export const MAX_ADMISSION_ROTATION_CYCLES = 2;
export const MAX_EXPIRING_PRIORITY_RPC_REQUESTS = 20;
export const MEASURED_EXECUTION_ADMISSION_RUN_METADATA = {
  admissionRpcRequestLimit: MAX_ADMISSION_RPC_REQUESTS,
  admissionFragmentationReserveRpcRequests: RPC_ADMISSION_FRAGMENTATION_HEADROOM,
  admissionRpcHardLimit: MEASURED_EXECUTION_RPC_REQUEST_LIMIT,
} as const;
export const MEASURED_EXECUTION_REFINEMENT_ROUNDS = 3;
export const MEASURED_EXECUTION_ADMISSION_SOURCE_KEY = "measured-execution:quote-admission";
export const SHADOW_MEASURED_EXECUTION_ADMISSION_SOURCE_KEY = "measured-execution:shadow-quote-admission";

export type TargetDeployment =
  | { kind: "quoter-v2"; config: DexMeasuredExecutionDeployment }
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

export function resolveTargetDeployment(target: DexMeasuredExecutionTarget): TargetDeployment | null {
  if (target.adapterProfileId === UNISWAP_V4_ADAPTER_PROFILE_ID) {
    const deployment = getUniswapV4Deployment(target.chain);
    return deployment ? { kind: "uniswap-v4", config: deployment } : null;
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
  const deployment = resolveTargetDeployment(target);
  if (isDexMeasuredExecutionDeploymentScoreEligible(target.adapterProfileId, target.chain)) return true;
  switch (deployment?.kind) {
    case "curve-cryptoswap":
    case "curve-stableswap":
    case "curve-stableswap-ng":
      return deployment.config.mode === "active" && deployment.config.scoreEligible === true;
    case "uniswap-v4":
      return deployment.config.mode === "active" && deployment.config.scoreEligible === true;
    case "quoter-v2":
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

/**
 * Failure reasons that mean a target was never attempted this run: the
 * rotating admission budget deferred it up front, or the in-run RPC budget
 * stopped before its ladder (both `evm-quote-plan.ts` stop paths surface as
 * the two budget stop reasons on the quote state).
 */
const MEASURED_LEDGER_BUDGET_DEFERRED_REASONS: ReadonlySet<string> = new Set([
  "budget-deferred",
  "request-budget-exhausted",
  "runtime-deadline-exceeded",
]);

/**
 * Builds the durable Record B evidence ledger for one shadow quote run
 * (Liquidity Score v6 Phase 0.4). Monotonicity and cost-bound consistency are
 * computed here, at emission time, from the raw quote ladders — the staged
 * quote generations prune at three hours, so this is the only durable place
 * the ladder health of a daily shadow cycle can be recorded.
 */
export function buildMeasuredShadowQuoteLedgerRecord(input: {
  cycle: number;
  targetGenerationId: string | null;
  quoteGenerationId: string | null;
  outcomes: readonly {
    target: DexMeasuredExecutionTarget;
    status: "measured" | "failed";
    failureReason?: string;
    points?: readonly DexMeasuredRawQuotePoint[];
  }[];
}): MeasuredLedgerRecordB {
  const cohorts: MeasuredLedgerRecordB["cohorts"] = {};
  for (const outcome of input.outcomes) {
    const key = buildMeasuredLedgerCohortKey(outcome.target);
    const cohort = (cohorts[key] ??= {
      measured: 0,
      failed: 0,
      budgetDeferred: 0,
      monotonicityViolations: 0,
      costBoundViolations: 0,
    });
    if (outcome.status === "measured") {
      cohort.measured += 1;
    } else if (MEASURED_LEDGER_BUDGET_DEFERRED_REASONS.has(outcome.failureReason ?? "")) {
      cohort.budgetDeferred += 1;
    } else {
      cohort.failed += 1;
    }
    const points = outcome.points ?? [];
    if (points.length > 0) {
      cohort.monotonicityViolations += countMeasuredLadderMonotonicityViolations(points);
      cohort.costBoundViolations += countMeasuredLadderCostBoundViolations(points, DEX_MEASURED_MAX_COST_BPS);
    }
  }
  return {
    kind: "B",
    cycle: input.cycle,
    targetGenerationId: input.targetGenerationId,
    quoteGenerationId: input.quoteGenerationId,
    cohorts,
    truncatedCohorts: 0,
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
  refinementRounds = MEASURED_EXECUTION_REFINEMENT_ROUNDS,
): AdmissionRpcRequestEstimate {
  const executable = targets.flatMap((target) => {
    const deployment = resolveTargetDeployment(target);
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
  refinementRounds = MEASURED_EXECUTION_REFINEMENT_ROUNDS,
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

export async function loadExpiringScoreBearingPriorityPacket(
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
      options.refinementRounds ?? MEASURED_EXECUTION_REFINEMENT_ROUNDS,
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
    const refinementRounds = options.refinementRounds ?? MEASURED_EXECUTION_REFINEMENT_ROUNDS;
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
  cursorWriteStatus: "not-needed" | "written" | "write-failed";
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
