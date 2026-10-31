import type { ChainRpcConfig } from "../lib/chain-registry";
import type { DwellirNativeCapability } from "../lib/dwellir-native";
import type { CronResult } from "../lib/cron-logger";
import { createCronResult } from "../lib/cron-result";
import { throwIfAborted } from "../lib/abort";
import type { V9ExecutionWindow } from "../lib/v9-slot-window";
import {
  getCaches,
  prepareCacheUpsert,
} from "../lib/db-cache";
import {
  appendSupplyAttributionJournalV1,
} from "../lib/safety-score-v9/supply-attribution-journal-store";
import {
  captureSafetyScoreV9SupplyAttribution,
  supplyAttributionCaptureAdmission,
  SUPPLY_ATTRIBUTION_STALE_REFERENCE_REASON,
} from "../lib/safety-score-v9/supply-attribution-capture";
import {
  parseSafetyScoreV9SupplyAttributionSource,
  SAFETY_SCORE_V9_SUPPLY_ATTRIBUTION_SOURCE_CACHE_KEY,
  SOURCE_FIXED_INPUT_MAX_AGE_SEC,
  deploymentSupplyCensusSourceView,
  type SafetyScoreV9SupplyAttributionSource,
} from "../lib/safety-score-v9/supply-attribution-source";
import {
  createSafetyScoreV9SupplyAttributionGeneration,
  isSafetyScoreV9SupplyAttributionGenerationCompatible,
  nextSafetyScoreV9SupplyAttributionDueAtSec,
  parseSafetyScoreV9SupplyAttributionGeneration,
  SAFETY_SCORE_V9_SUPPLY_ATTRIBUTION_GENERATION_CACHE_KEY,
  serializeSafetyScoreV9SupplyAttributionGeneration,
  type SafetyScoreV9SupplyAttributionGeneration,
} from "../lib/safety-score-v9/supply-attribution-generation";

import {
  captureTupleMatchesSource, parseSafetyScoreV9CaptureControl, prepareAttributionSettlement,
  SAFETY_SCORE_V9_CAPTURE_CONTROL_CACHE_KEY, settleAttribution,
} from "../lib/safety-score-v9/capture-control";
import { batchExecute } from "../lib/d1-primitives";
import { buildResourcePressure } from "../lib/cron-resource-pressure";
import { ECONOMIC_SUPPLY_BODY_CAPS } from "../lib/safety-score-v9/economic-supply-observer";
import { safetyScoreV9SupplyAttributionExpectedAssetIds } from "../lib/safety-score-v9/supply-attribution";
import { compareCodeUnits } from "@shared/lib/compare";
import { isRecord } from "@shared/lib/type-guards";
import laneEmitterDescriptors from "@shared/data/safety-score-v9/lane-emitter-descriptors-v1.generated.json";
import {
  syncV9LaneAdminEvents,
  type LaneScreeningDescriptor,
} from "./sync-v9-lane-admin-events";
import { ACTIVE_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { SUPPLY_ATTRIBUTION_DEPLOYMENT_SUPPLY_CENSUS_BUDGET } from "@shared/lib/safety-score-v9-supply-attribution-journal";
import {
  DEPLOYMENT_SUPPLY_CENSUS_MAX_ASSETS,
  DEPLOYMENT_SUPPLY_CENSUS_MAX_DEPLOYMENTS_PER_RUN,
  deploymentSupplyCensusRequestCost,
  deploymentSupplyCensusTargets,
  observeSafetyScoreV9DeploymentSupplyCensusGeneration,
  type DeploymentSupplyCensusAssemblyDependencies,
  type DeploymentSupplyCensusCohortSelection,
  type DeploymentSupplyCensusRegistryMeta,
  type DeploymentSupplyCensusTarget,
} from "../lib/safety-score-v9/deployment-supply-census";
import { DEPLOYMENT_SUPPLY_CENSUS_EVM_BUDGET } from "../lib/safety-score-v9/deployment-supply-census-evm";
import {
  readSafetyScoreV9DeploymentSupplyCensus,
  safetyScoreV9DeploymentSupplyCensusCarry,
  writeSafetyScoreV9DeploymentSupplyCensusGeneration,
  type SafetyScoreV9DeploymentSupplyCensusCarry,
} from "../lib/safety-score-v9/deployment-supply-census-store";

function diagnosticRejectedAssetIds(
  generation: SafetyScoreV9SupplyAttributionGeneration,
): string[] {
  return generation.rejectedAssetIds.filter((assetId) => {
    const outcome = generation.outcomesById[assetId];
    return (
      outcome?.status === "rejected" &&
      outcome.rejectionCode === "transparency-stale"
    );
  });
}

function classifyRejectedAssets(generation: SafetyScoreV9SupplyAttributionGeneration) {
  const diagnostic = diagnosticRejectedAssetIds(generation);
  const progress = generation.rejectedAssetIds.filter(assetId => {
    const outcome = generation.outcomesById[assetId];
    if (outcome?.status !== "rejected" ||
      !["deployment-observation-window-insufficient", "deployment-state-unavailable"].includes(outcome.rejectionCode)) return false;
    const diagnostics = outcome.diagnostics ?? [];
    return diagnostics.some(attempt => attempt.incompleteBootstrap &&
      attempt.authenticatedCursorAdvanced && attempt.persisted) &&
      !diagnostics.some(attempt => attempt.hardEvidenceFailure);
  });
  const nonblocking = new Set([...diagnostic, ...progress]);
  return { diagnostic, progress, blocking: generation.rejectedAssetIds.filter(assetId => !nonblocking.has(assetId)) };
}

export type SafetyScoreV9DeploymentSupplyCensusShadowReason =
  | "deployment-supply-census-slot-window-unavailable"
  | "deployment-supply-census-chain-rpcs-unavailable"
  | "deployment-supply-census-window-insufficient"
  | "deployment-supply-census-generation-fresh"
  | "deployment-supply-census-cohort-empty"
  | "deployment-supply-census-projection-missing"
  | "deployment-supply-census-aborted"
  | "deployment-supply-census-capture-failed";

/**
 * Per-run journal of the shadow `deployment-supply-census-v1` lane. A failed
 * run names a machine reason and an error class; it never reports a zero or an
 * empty cohort as a measurement.
 */
export type SafetyScoreV9DeploymentSupplyCensusShadowOutcome = {
  status: "published" | "skipped" | "failed";
  reason: SafetyScoreV9DeploymentSupplyCensusShadowReason | null;
  /** Error name only; messages are not journal evidence. */
  code?: string;
  generationId: string | null;
  capturedAtSec: number | null;
  written: boolean;
  skippedBecauseNewer: boolean;
  cohortAssetIds: string[];
  /** Open census-closable gap routes per selected asset: the selection reason. */
  cohortTargets: { assetId: string; gapRoutes: number }[];
  /** Open census-closable gap routes covered by this cohort. */
  cohortGapRoutes: number;
  /** Ranked candidates the run request budget could not fit; every gap stays open. */
  requestBudgetSkippedAssetIds: string[];
  /** Deterministic request estimate for the selected cohort. */
  estimatedRequests: number;
  measuredAssetIds: string[];
  /** `census-rejected:<reason>` codes per asset, including asset-level (`routeId: null`). */
  rejectedByAssetId: Record<string, string[]>;
  /** Stored packets the store refused to serve at this clock (aged out or future-dated). */
  excluded: { assetId: string; reason: string }[];
  remainingMs: number | null;
};

export interface SafetyScoreV9DeploymentSupplyCensusShadowOptions {
  metaById?: ReadonlyMap<string, DeploymentSupplyCensusRegistryMeta>;
  /** Attribution packets already in the prepared input; production passes the run's generation. */
  supplyAttributionById?: Readonly<Record<string, { readonly model: string }>>;
  /** Replay/unit seam; production uses the readers' defaults. */
  dependencies?: DeploymentSupplyCensusAssemblyDependencies;
}

/**
 * Which assets the shadow census measures: only assets carrying open
 * census-closable gaps (unresolved `materialSupplyShare` deployments), ordered
 * by open-gap count. The cohort is deterministic and stable per preparation:
 * SA-1's store replaces the cohort wholesale, so a rotating slice would drop
 * every asset it did not measure that run. Assets whose roster exceeds the
 * per-asset cap are never targets (the assembly rejects the 65th deployment),
 * and an asset that cannot fit the remaining deployment budget is skipped
 * rather than stopping the walk.
 */
export function deploymentSupplyCensusSelection(input: {
  targets: readonly DeploymentSupplyCensusTarget[];
  maxAssets?: number;
  maxDeployments?: number;
  maxRequests?: number;
}): DeploymentSupplyCensusCohortSelection {
  const maxAssets = Math.min(
    input.maxAssets ?? SUPPLY_ATTRIBUTION_DEPLOYMENT_SUPPLY_CENSUS_BUDGET.cohortAssets,
    DEPLOYMENT_SUPPLY_CENSUS_MAX_ASSETS,
  );
  const maxDeployments = Math.min(
    input.maxDeployments ?? SUPPLY_ATTRIBUTION_DEPLOYMENT_SUPPLY_CENSUS_BUDGET.cohortDeployments,
    DEPLOYMENT_SUPPLY_CENSUS_MAX_DEPLOYMENTS_PER_RUN,
  );
  const maxRequests = Math.min(
    input.maxRequests ?? DEPLOYMENT_SUPPLY_CENSUS_EVM_BUDGET.maxEvmRequests,
    DEPLOYMENT_SUPPLY_CENSUS_EVM_BUDGET.maxEvmRequests,
  );
  const candidates = input.targets
    .filter(target => target.gapRoutes > 0)
    .sort((left, right) =>
      right.gapRoutes - left.gapRoutes ||
      // Smaller rosters first on a tie: more gap assets fit the same budget.
      left.reviewedRoutes - right.reviewedRoutes ||
      compareCodeUnits(left.assetId, right.assetId));
  const cohort: string[] = [];
  const skippedAssetIds: string[] = [];
  const chargedChains = new Set<string>();
  let deployments = 0;
  let estimatedRequests = 0;
  for (const candidate of candidates) {
    if (cohort.length >= maxAssets) break;
    if (deployments + candidate.reviewedRoutes > maxDeployments) continue;
    const newChains = (candidate.evmChains ?? []).filter(chain => !chargedChains.has(chain));
    const cost = deploymentSupplyCensusRequestCost(candidate, newChains.length);
    if (estimatedRequests + cost > maxRequests) {
      // The run budget cannot fit this asset: leave every gap route open and
      // name it in the journal instead of half-reading it after the budget
      // gate would have started rejecting requests.
      skippedAssetIds.push(candidate.assetId);
      continue;
    }
    cohort.push(candidate.assetId);
    deployments += candidate.reviewedRoutes;
    estimatedRequests += cost;
    for (const chain of newChains) chargedChains.add(chain);
  }
  return {
    assetIds: cohort.sort(compareCodeUnits),
    skippedAssetIds: skippedAssetIds.sort(compareCodeUnits),
    estimatedRequests,
  };
}

export function deploymentSupplyCensusCohort(input: {
  targets: readonly DeploymentSupplyCensusTarget[];
  maxAssets?: number;
  maxDeployments?: number;
  maxRequests?: number;
}): string[] {
  return [...deploymentSupplyCensusSelection(input).assetIds];
}

function censusShadowOutcome(
  fields: Partial<SafetyScoreV9DeploymentSupplyCensusShadowOutcome> &
    Pick<SafetyScoreV9DeploymentSupplyCensusShadowOutcome, "status" | "reason">,
): SafetyScoreV9DeploymentSupplyCensusShadowOutcome {
  return {
    generationId: null,
    capturedAtSec: null,
    written: false,
    skippedBecauseNewer: false,
    cohortAssetIds: [],
    cohortTargets: [],
    cohortGapRoutes: 0,
    requestBudgetSkippedAssetIds: [],
    estimatedRequests: 0,
    measuredAssetIds: [],
    rejectedByAssetId: {},
    excluded: [],
    remainingMs: null,
    ...fields,
  };
}

/**
 * Runs SA-5's census generation in shadow inside the supply-attribution slot.
 *
 * Shadow semantics: the generation is persisted through SA-1's store and every
 * per-asset `census-rejected:<reason>` travels in the cron metadata journal;
 * nothing is admitted to scoring here. The lane starts strictly after the
 * attribution capture settles, so the slot's outbound peak stays at three
 * connections, and it can never convert a published attribution run into an
 * error.
 */
export async function runDeploymentSupplyCensusShadow(input: {
  db: D1Database;
  fixedInput: Readonly<SafetyScoreV9SupplyAttributionSource>;
  chainRpcs?: Map<string, ChainRpcConfig>;
  signal?: AbortSignal;
  executionWindow?: V9ExecutionWindow;
  dwellirNative?: DwellirNativeCapability;
  /** Accepted attribution packets of the generation published this run. */
  supplyAttributionById?: Readonly<Record<string, { readonly model: string }>>;
  /** Out-param: the generation this run may carry into the attribution generation. */
  carry: { value: SafetyScoreV9DeploymentSupplyCensusCarry | null };
  options?: SafetyScoreV9DeploymentSupplyCensusShadowOptions;
}): Promise<SafetyScoreV9DeploymentSupplyCensusShadowOutcome> {
  if (input.signal?.aborted) {
    return censusShadowOutcome({ status: "skipped", reason: "deployment-supply-census-aborted" });
  }
  if (input.executionWindow === undefined) {
    // Bounded-work rule: a shadow read never opens a 180-second lane outside a
    // known slot deadline.
    return censusShadowOutcome({
      status: "skipped",
      reason: "deployment-supply-census-slot-window-unavailable",
    });
  }
  if (input.chainRpcs === undefined || input.chainRpcs.size === 0) {
    return censusShadowOutcome({
      status: "skipped",
      reason: "deployment-supply-census-chain-rpcs-unavailable",
    });
  }
  const remainingMs = input.executionWindow.deadlineMs - Date.now();
  if (remainingMs < SUPPLY_ATTRIBUTION_DEPLOYMENT_SUPPLY_CENSUS_BUDGET.minimumRemainingMs) {
    return censusShadowOutcome({
      status: "skipped",
      reason: "deployment-supply-census-window-insufficient",
      remainingMs,
    });
  }
  try {
    const censusSource = deploymentSupplyCensusSourceView(input.fixedInput);
    if (censusSource === null) {
      // R5: a projection-less source has no population data (aggregate, chain
      // rows, prices). Measuring the attribution allowlist instead reported
      // `cohort-empty` for a population the lane never saw.
      return censusShadowOutcome({
        status: "skipped",
        reason: "deployment-supply-census-projection-missing",
        remainingMs,
      });
    }
    const expectedCensusIdentity = {
      registryFingerprint: input.fixedInput.registryFingerprint,
      baseInputGenerationId: input.fixedInput.baseInputGenerationId,
    };
    const stored = await readSafetyScoreV9DeploymentSupplyCensus(input.db, {
      clockSec: input.fixedInput.clockSec,
      signal: input.signal,
    });
    if (stored.state === "ok" && stored.capturedAtSec !== null &&
      stored.capturedAtSec >= input.fixedInput.clockSec) {
      // One generation per fixed-input cycle: the same source cannot produce a
      // different generation, so do not spend the RPC budget again. A served
      // generation built against this exact input is still carried.
      input.carry.value = safetyScoreV9DeploymentSupplyCensusCarry({
        byId: stored.byId,
        generationId: stored.generationId,
        registryFingerprint: stored.registryFingerprint,
        sourceBaseInputGenerationId: stored.sourceBaseInputGenerationId,
        expected: expectedCensusIdentity,
      });
      return censusShadowOutcome({
        status: "skipped",
        reason: "deployment-supply-census-generation-fresh",
        generationId: stored.generationId,
        capturedAtSec: stored.capturedAtSec,
        remainingMs,
      });
    }
    const metaById = input.options?.metaById ?? ACTIVE_META_BY_ID;
    // The census covers the open gap population, not the 10-asset attribution
    // allowlist embedded in `fixedInput.activeAssetIds`; the projection carries
    // every active asset's denominator, provider chain rows and reference price.
    const targets = deploymentSupplyCensusTargets({
      assetIds: censusSource.activeAssetIds,
      metaById,
      chainCirculatingById: censusSource.chainCirculatingById,
      supplyAttributionById: input.supplyAttributionById ?? input.options?.supplyAttributionById,
    });
    const selection: DeploymentSupplyCensusCohortSelection = deploymentSupplyCensusSelection({ targets });
    const cohortAssetIds = [...selection.assetIds];
    const cohortTargets = targets
      .filter(target => cohortAssetIds.includes(target.assetId))
      .map(target => ({ assetId: target.assetId, gapRoutes: target.gapRoutes }))
      .sort((left, right) => compareCodeUnits(left.assetId, right.assetId));
    const cohortGapRoutes = cohortTargets.reduce((sum, target) => sum + target.gapRoutes, 0);
    if (cohortAssetIds.length === 0) {
      return censusShadowOutcome({
        status: "skipped",
        reason: "deployment-supply-census-cohort-empty",
        cohortTargets,
        cohortGapRoutes,
        requestBudgetSkippedAssetIds: [...selection.skippedAssetIds],
        estimatedRequests: selection.estimatedRequests,
        remainingMs,
      });
    }
    const deadlineMs = Math.min(
      Date.now() + DEPLOYMENT_SUPPLY_CENSUS_EVM_BUDGET.wallTimeoutMs,
      // The shadow lane must stop a publication reserve before the slot deadline:
      // the journal append and generation write still have to run inside it.
      input.executionWindow.deadlineMs - DEPLOYMENT_SUPPLY_CENSUS_EVM_BUDGET.publicationReserveMs,
    );
    const generation = await observeSafetyScoreV9DeploymentSupplyCensusGeneration({
      fixedInput: {
        ...input.fixedInput,
        activeAssetIds: [...censusSource.activeAssetIds],
        aggregateCirculatingById: censusSource.aggregateCirculatingById,
        chainCirculatingById: censusSource.chainCirculatingById,
        navPriceById: censusSource.navPriceById,
        pegDataById: Object.fromEntries(Object.entries(censusSource.pegReferenceById).map(
          ([assetId, reference]) => [assetId, { pegReference: reference }],
        )),
      },
      // The instant this lane actually reads the chains: pins resolve at or
      // before it, and the bound is aged by the next publication against its
      // own (later) clock. Never the prepare clock: a finalized Solana snapshot
      // cannot be rewound to it.
      observationClockSec: Math.floor(Date.now() / 1_000),
      assetIds: cohortAssetIds,
      chainRpcs: input.chainRpcs,
      dwellirNative: input.dwellirNative,
      signal: input.signal,
      deadlineMs,
      metaById,
    }, input.options?.dependencies ?? {});
    const write = await writeSafetyScoreV9DeploymentSupplyCensusGeneration(
      input.db,
      generation,
      input.signal,
    );
    // Same-cycle delivery: the generation the consumer is about to read names
    // this registry and base input, so its packets may be carried now. A
    // generation newer than this run is carried only from the store read that
    // already proved its identity.
    input.carry.value = write.written
      ? safetyScoreV9DeploymentSupplyCensusCarry({
          byId: generation.censusById,
          generationId: write.generationId,
          registryFingerprint: generation.registryFingerprint,
          sourceBaseInputGenerationId: generation.sourceBaseInputGenerationId,
          expected: expectedCensusIdentity,
        })
      : stored.state === "ok"
        ? safetyScoreV9DeploymentSupplyCensusCarry({
            byId: stored.byId,
            generationId: stored.generationId,
            registryFingerprint: stored.registryFingerprint,
            sourceBaseInputGenerationId: stored.sourceBaseInputGenerationId,
            expected: expectedCensusIdentity,
          })
        : null;
    const measuredAssetIds = Object.keys(generation.censusById)
      .filter(assetId => generation.censusById[assetId]!.conservation.conserved)
      .sort(compareCodeUnits);
    const rejectedByAssetId: Record<string, string[]> = {};
    for (const [assetId, packet] of Object.entries(generation.censusById)) {
      const codes = [...new Set(packet.rejected.map(entry => entry.code))].sort(compareCodeUnits);
      if (codes.length > 0) rejectedByAssetId[assetId] = codes;
    }
    return {
      status: "published",
      reason: null,
      generationId: write.generationId,
      capturedAtSec: write.capturedAtSec,
      written: write.written,
      skippedBecauseNewer: write.skippedBecauseNewer,
      cohortAssetIds,
      cohortTargets,
      cohortGapRoutes,
      requestBudgetSkippedAssetIds: [...selection.skippedAssetIds],
      estimatedRequests: selection.estimatedRequests,
      measuredAssetIds,
      rejectedByAssetId,
      excluded: stored.excluded.map(entry => ({ assetId: entry.assetId, reason: entry.reason })),
      remainingMs,
    };
  } catch (error) {
    if (input.signal?.aborted) {
      return censusShadowOutcome({
        status: "skipped",
        reason: "deployment-supply-census-aborted",
        remainingMs,
      });
    }
    // The attribution generation is already published and settled; a shadow
    // failure is journalled with its machine reason instead of revoking it.
    return censusShadowOutcome({
      status: "failed",
      reason: "deployment-supply-census-capture-failed",
      code: error instanceof Error ? error.name || "Error" : "Error",
      remainingMs,
    });
  }
}

export type SafetyScoreV9LaneScreeningShadowReason =
  | "lane-screening-aborted"
  | "lane-screening-slot-window-unavailable"
  | "lane-screening-window-insufficient"
  | "lane-screening-no-descriptors"
  | "lane-screening-completed"
  | "lane-screening-failed";

/**
 * Per-run journal of the hosted lane-screening phase. The phase is a serialized
 * shadow consumer of the reviewed emitter catalog: it runs after the
 * attribution generation is published, writes certificates to the IR-3b store
 * and never changes this job's status, scoring input or cache rows.
 */
export type SafetyScoreV9LaneScreeningShadowOutcome = {
  status: "published" | "skipped" | "failed";
  reason: SafetyScoreV9LaneScreeningShadowReason;
  catalog: number;
  candidates: number | null;
  attempted: number | null;
  admitted: number | null;
  failed: number | null;
  certificatesWritten: number | null;
  deadlineExhausted: boolean | null;
  remainingMs: number | null;
  code?: string;
};

export interface SafetyScoreV9LaneScreeningShadowOptions {
  /** Reviewed catalog override (tests, replays); production reads the generated artifact. */
  descriptors?: readonly LaneScreeningDescriptor[];
  /** Test seam for the producer; production uses the default implementation. */
  run?: typeof syncV9LaneAdminEvents;
}

/**
 * Match V9_EXECUTION_WINDOW_POLICY.publication's 15s settlement allowance
 * (25s admission = 10s usable + 15s reserve): two bounded 5s persistence
 * operations plus 5s cron/lease settlement, not a measured persistence p99.
 */
export const LANE_SCREENING_SETTLE_RESERVE_MS = 15_000;

/** The phase needs this much usable budget after its settlement reserve. */
const LANE_SCREENING_MINIMUM_REMAINING_MS = 60_000;

export async function runV9LaneScreeningShadowPhase(input: {
  db: D1Database;
  chainRpcs?: Map<string, ChainRpcConfig>;
  signal?: AbortSignal;
  executionWindow?: V9ExecutionWindow;
  options?: SafetyScoreV9LaneScreeningShadowOptions;
}): Promise<SafetyScoreV9LaneScreeningShadowOutcome> {
  const remainingMs = input.executionWindow === undefined
    ? null
    : input.executionWindow.deadlineMs - LANE_SCREENING_SETTLE_RESERVE_MS - Date.now();
  const base = {
    catalog: 0,
    candidates: null,
    attempted: null,
    admitted: null,
    failed: null,
    certificatesWritten: null,
    deadlineExhausted: null,
    remainingMs,
  };
  if (input.signal?.aborted) return { ...base, status: "skipped", reason: "lane-screening-aborted" };
  if (input.executionWindow === undefined) {
    return { ...base, status: "skipped", reason: "lane-screening-slot-window-unavailable" };
  }
  if (remainingMs !== null && remainingMs < LANE_SCREENING_MINIMUM_REMAINING_MS) {
    return { ...base, status: "skipped", reason: "lane-screening-window-insufficient" };
  }
  const descriptors = input.options?.descriptors
    ?? (laneEmitterDescriptors.descriptors as unknown as readonly LaneScreeningDescriptor[]);
  if (descriptors.length === 0) {
    return { ...base, status: "skipped", reason: "lane-screening-no-descriptors" };
  }
  const run = input.options?.run ?? syncV9LaneAdminEvents;
  try {
    const result = await run(input.db, input.chainRpcs ?? new Map(), input.signal, {
      descriptors,
      deadlineMs: input.executionWindow.deadlineMs - LANE_SCREENING_SETTLE_RESERVE_MS,
    });
    // CronResult serializes metadata; admit only its bounded record fields.
    const parsedMetadata: unknown = result.metadata === undefined ? {} : JSON.parse(result.metadata);
    const metadata: Record<string, unknown> = isRecord(parsedMetadata) ? parsedMetadata : {};
    const metric = (key: string): number | null =>
      typeof metadata[key] === "number" ? metadata[key] as number : null;
    return {
      status: result.status === "ok" || result.status === "degraded" ? "published" : "skipped",
      reason: "lane-screening-completed",
      catalog: metric("catalog") ?? descriptors.length,
      candidates: metric("candidates"),
      attempted: metric("attempted"),
      admitted: metric("admitted"),
      failed: metric("failed"),
      certificatesWritten: metric("certificatesWritten"),
      deadlineExhausted: typeof metadata.deadlineExhausted === "boolean" ? metadata.deadlineExhausted : null,
      remainingMs,
    };
  } catch (error) {
    // A shadow failure is journalled, never allowed to revoke the published generation.
    return {
      ...base,
      status: "failed",
      reason: "lane-screening-failed",
      code: error instanceof Error && error.name ? error.name.slice(0, 160) : "Error",
    };
  }
}

export async function syncSafetyScoreV9SupplyAttribution(
  db: D1Database,
  chainRpcs?: Map<string, ChainRpcConfig>,
  signal?: AbortSignal,
  executionWindow?: V9ExecutionWindow,
  dwellirNative?: DwellirNativeCapability,
  censusOptions?: SafetyScoreV9DeploymentSupplyCensusShadowOptions,
  laneScreeningOptions?: SafetyScoreV9LaneScreeningShadowOptions,
): Promise<CronResult> {
  const startedAtSec = Math.floor(Date.now() / 1_000);
  throwIfAborted(signal);
  const caches = await getCaches(db, [
    SAFETY_SCORE_V9_SUPPLY_ATTRIBUTION_SOURCE_CACHE_KEY,
    SAFETY_SCORE_V9_SUPPLY_ATTRIBUTION_GENERATION_CACHE_KEY,
    SAFETY_SCORE_V9_CAPTURE_CONTROL_CACHE_KEY,
  ]);
  const controlCache = caches.get(SAFETY_SCORE_V9_CAPTURE_CONTROL_CACHE_KEY);
  let control: ReturnType<typeof parseSafetyScoreV9CaptureControl> | null = null;
  let captureControlStatus: "invalid" | null = null;
  if (controlCache) {
    try {
      control = parseSafetyScoreV9CaptureControl(controlCache.value);
    } catch {
      // Settlement is bookkeeping bound to the exact capture tuple. A row that a
      // newer schema or a rolled-back Worker cannot read is inert like an absent
      // one, never a reason to withhold this run's attribution generation.
      captureControlStatus = "invalid";
    }
  }
  const sourceCache = caches.get(
    SAFETY_SCORE_V9_SUPPLY_ATTRIBUTION_SOURCE_CACHE_KEY,
  );
  if (!sourceCache) {
    return createCronResult({
      status: "degraded",
      itemCount: 0,
      metadata: { stage: "source-fixed-input", reason: "source-fixed-input-missing" },
      productivity: {
        productive: false,
        reason: "source-fixed-input-missing",
      },
    });
  }

  let fixedInput: SafetyScoreV9SupplyAttributionSource;
  try {
    fixedInput = parseSafetyScoreV9SupplyAttributionSource(sourceCache.value);
  } catch (error) {
    // A malformed payload can still identify the exact source whose request failed.
    let failedSource: unknown;
    try { failedSource = JSON.parse(sourceCache.value); } catch { failedSource = null; }
    if (control && failedSource !== null && typeof failedSource === "object" &&
      "baseInputGenerationId" in failedSource && failedSource.baseInputGenerationId === control.capture.baseInputGenerationId &&
      "sourceGeneration" in failedSource && failedSource.sourceGeneration === control.capture.sourceGeneration &&
      "clockSec" in failedSource && failedSource.clockSec === control.capture.clockSec &&
      "registryFingerprint" in failedSource && failedSource.registryFingerprint === control.capture.registryFingerprint) {
      await settleAttribution(db, control, control.capture, executionWindow?.slotStartedAtSec, "degraded", null);
    }
    return createCronResult({
      status: "degraded",
      itemCount: 0,
      metadata: {
        stage: "source-fixed-input",
        reason: "source-fixed-input-invalid",
        code:
          error instanceof Error && error.name
            ? error.name.slice(0, 160)
            : "Error",
      },
      productivity: {
        productive: false,
        reason: "source-fixed-input-invalid",
      },
    });
  }
  if (
    fixedInput.clockSec > startedAtSec ||
    startedAtSec - fixedInput.clockSec > SOURCE_FIXED_INPUT_MAX_AGE_SEC
  ) {
    await settleAttribution(db, control, fixedInput, executionWindow?.slotStartedAtSec, "degraded", null);
    return createCronResult({
      status: "degraded",
      itemCount: 0,
      metadata: {
        stage: "source-fixed-input",
        reason: "source-fixed-input-stale",
        sourceClockSec: fixedInput.clockSec,
        ageSec: startedAtSec - fixedInput.clockSec,
      },
      productivity: {
        productive: false,
        reason: "source-fixed-input-stale",
      },
    });
  }

  let priorGenerationStatus:
    | "missing"
    | "malformed"
    | "due"
    | "fresh" = "missing";
  const priorCache = caches.get(
    SAFETY_SCORE_V9_SUPPLY_ATTRIBUTION_GENERATION_CACHE_KEY,
  );
  let priorGeneration: SafetyScoreV9SupplyAttributionGeneration | null = null;
  if (priorCache) {
    try {
      priorGeneration = parseSafetyScoreV9SupplyAttributionGeneration(priorCache.value);
      priorGenerationStatus = "due";
    } catch {
      priorGenerationStatus = "malformed";
    }
  }
  if (priorGeneration &&
    isSafetyScoreV9SupplyAttributionGenerationCompatible(fixedInput, priorGeneration, startedAtSec) &&
    startedAtSec < nextSafetyScoreV9SupplyAttributionDueAtSec(priorGeneration)) {
    priorGenerationStatus = "fresh";
    if (control && captureTupleMatchesSource(control.capture, {
      baseInputGenerationId: priorGeneration.sourceBaseInputGenerationId,
      sourceGeneration: priorGeneration.sourceGeneration,
      clockSec: priorGeneration.sourceClockSec,
      registryFingerprint: priorGeneration.registryFingerprint,
    })) {
      const blocking = classifyRejectedAssets(priorGeneration).blocking.length;
      await settleAttribution(db, control, fixedInput, executionWindow?.slotStartedAtSec,
        blocking > 0 ? "degraded" : "ok", priorGeneration.generationId);
    }
    return createCronResult({
      status: "skipped_neutral",
      itemCount: priorGeneration.acceptedAssetIds.length,
      metadata: {
        reason: "supply-attribution-generation-fresh", stage: "cooldown",
        generationId: priorGeneration.generationId,
        acceptedCount: priorGeneration.acceptedAssetIds.length,
        rejectedCount: priorGeneration.rejectedAssetIds.length,
        nextDueAtSec: nextSafetyScoreV9SupplyAttributionDueAtSec(priorGeneration),
      },
      productivity: { productive: false, reason: "supply-attribution-generation-fresh" },
    });
  }

  const admission = supplyAttributionCaptureAdmission(fixedInput, Math.floor(Date.now() / 1_000));
  if (admission.deferredAssetIds.length > 0 &&
    admission.sourceStaleAssetIds.length === 0 &&
    admission.deferredAssetIds.length === safetyScoreV9SupplyAttributionExpectedAssetIds(fixedInput).length) {
    return createCronResult({
      status: "skipped_neutral", itemCount: 0,
      metadata: { stage: "capture-admission", reason: SUPPLY_ATTRIBUTION_STALE_REFERENCE_REASON,
        generationId: priorGeneration?.generationId ?? null, ...admission },
      productivity: { productive: false, reason: SUPPLY_ATTRIBUTION_STALE_REFERENCE_REASON },
    });
  }

  const resourcePressure = buildResourcePressure({
    phase: "supply-attribution-capture", bodyCapBytes: Math.max(...Object.values(ECONOMIC_SUPPLY_BODY_CAPS)),
  });
  try {
  const capture = await captureSafetyScoreV9SupplyAttribution(
    fixedInput,
    chainRpcs,
    signal,
    {
      clockMode: "wall",
      notBeforeSec: startedAtSec,
      executionWindow,
      db,
      dwellirNative,
      priorGeneration,
      deferredAssetIds: admission.deferredAssetIds,
      onBodyRead: evidence => {
        resourcePressure.observedAt = Math.floor(Date.now() / 1_000);
        resourcePressure.rejectedBodies ??= 0;
        if (evidence.intakeBytes !== null) {
          resourcePressure.intakeBytes = (resourcePressure.intakeBytes ?? 0) + evidence.intakeBytes;
          resourcePressure.intakeBasis = "actual-stream";
        }
        // Transport interruption is not evidence that the byte budget was exceeded.
        if (evidence.outcome === "rejected"
          && ((evidence.intakeBytes ?? 0) > evidence.limitBytes || (evidence.declaredBytes ?? 0) > evidence.limitBytes)) {
          resourcePressure.rejectedBodies = (resourcePressure.rejectedBodies ?? 0) + 1;
        }
        resourcePressure.guard = (resourcePressure.rejectedBodies ?? 0) > 0 ? "resource-budget-exceeded" : "within-policy";
      },
    },
  );
  throwIfAborted(signal);
  const capturedAtSec = Math.max(
    startedAtSec,
    Math.floor(Date.now() / 1_000),
    ...capture.journalRecords.map((record) => record.completedAtSec),
  );
  // Shadow census lane: starts strictly after the capture has settled, so the
  // slot's outbound peak stays at three connections (capture, then census, then
  // publication). It runs before the attribution generation is built so a
  // generation bound to this exact registry/base input is carried in the same
  // cycle (DRY-CENSUS F1); nothing is admitted to scoring here.
  const censusCarry: { value: SafetyScoreV9DeploymentSupplyCensusCarry | null } = { value: null };
  const deploymentSupplyCensus = await runDeploymentSupplyCensusShadow({
    db,
    fixedInput,
    chainRpcs,
    signal,
    executionWindow,
    dwellirNative,
    supplyAttributionById: capture.attributionById,
    carry: censusCarry,
    options: censusOptions,
  });
  const generation =
    createSafetyScoreV9SupplyAttributionGeneration({
      fixedInput,
      capture,
      capturedAtSec,
      ...(censusCarry.value === null ? {} : { deploymentSupplyCensus: censusCarry.value }),
    });

  const newJournalRecords = capture.journalRecords.filter(record =>
    record.journalId !== priorGeneration?.outcomesById[record.assetId]?.journalId);
  if (newJournalRecords.length > 0) {
    await appendSupplyAttributionJournalV1(
      db,
      newJournalRecords,
      capturedAtSec,
      signal,
    );
  }
  const { diagnostic: diagnosticRejected, progress, blocking } = classifyRejectedAssets(generation);
  const blockingRejectedAssetIds = blocking.filter(assetId => {
    const outcome = generation.outcomesById[assetId];
    return outcome.status !== "rejected" || outcome.failedRouteId !== SUPPLY_ATTRIBUTION_STALE_REFERENCE_REASON ||
      admission.sourceStaleAssetIds.includes(assetId);
  });
  const complete = blockingRejectedAssetIds.length === 0;
  const qualityReasons = [
    ...(admission.deferredAssetIds.length || Object.keys(capture.admissionById ?? {}).length
      ? [SUPPLY_ATTRIBUTION_STALE_REFERENCE_REASON] : []),
    ...(progress.length ? ["supply-attribution-bootstrap-in-progress"] : []),
    ...(diagnosticRejected.length ? ["supply-attribution-diagnostic-rejections"] : []),
  ];
  const publication = {
    key: SAFETY_SCORE_V9_SUPPLY_ATTRIBUTION_GENERATION_CACHE_KEY,
    value: serializeSafetyScoreV9SupplyAttributionGeneration(generation),
    updatedAt: startedAtSec,
  };
  const settlement = control ? prepareAttributionSettlement(db, control, fixedInput,
    executionWindow?.slotStartedAtSec, complete ? "ok" : "degraded", generation.generationId, publication) : null;
  const changes = await batchExecute(db, [
    prepareCacheUpsert(db, publication, "if-newer"),
    ...(settlement ? [settlement] : []),
  ], { chunkSize: 2, signal });
  const cacheWrite = { written: changes > 0 };
  // Hosted shadow lane screening (OP-IR §5c / OPS-CRON growth-free hosting): a
  // serialized phase after the publication write, so it can only spend the
  // slot's remaining wall budget and never delays or reorders the attribution
  // generation. It adds no connection-budget entry: it runs one JSON-RPC batch
  // at a time inside this job's declared 3-connection peak, and its outcome is
  // journalled without changing the host status or any scoring input.
  const laneScreening = await runV9LaneScreeningShadowPhase({
    db,
    chainRpcs,
    signal,
    executionWindow,
    options: laneScreeningOptions,
  });
  if (!cacheWrite.written) {
    return createCronResult({
      status: "skipped_neutral",
      itemCount: 0,
      metadata: { stage: "publication", reason: "newer-generation-present", generationId: generation.generationId, laneScreening },
      productivity: {
        productive: false,
        reason: "newer-supply-attribution-generation-present",
      },
    });
  }

  return createCronResult({
    status: complete ? "ok" : "degraded",
    itemCount: generation.acceptedAssetIds.length,
    metadata: {
      reason: complete ? "supply-attribution-generation-published" : "supply-attribution-blocking-rejections",
      stage: "published",
      generationId: generation.generationId,
      sourceBaseInputGenerationId:
        generation.sourceBaseInputGenerationId,
      sourceClockSec: generation.sourceClockSec,
      captureClockSec: generation.captureClockSec,
      capturedAtSec: generation.capturedAtSec,
      expectedCount: generation.expectedAssetIds.length,
      observedCount: generation.observedAssetIds.length,
      acceptedCount: generation.acceptedAssetIds.length,
      rejectedCount: generation.rejectedAssetIds.length,
      rejectedAssetIds: generation.rejectedAssetIds,
      diagnosticRejectedCount: diagnosticRejected.length,
      diagnosticRejectedAssetIds: diagnosticRejected,
      blockingRejectedCount: blockingRejectedAssetIds.length,
      blockingRejectedAssetIds,
      priorGenerationStatus,
      ...(captureControlStatus === null ? {} : { captureControlStatus }),
      captureAdmission: { ...admission, assets: capture.admissionById ?? {} },
      bootstrapProgressAssetIds: progress,
      captureFailureReasonsById: capture.failureReasonById ?? {},
      latencySummary: { assets: capture.performanceById ?? {} },
      resourcePressure,
      deploymentSupplyCensus,
      laneScreening,
      ...(qualityReasons.length ? { quality: {
        reason: qualityReasons[0], reasons: qualityReasons,
        sources: { bootstrapProgressAssetIds: progress, diagnosticRejectedAssetIds: diagnosticRejected, blockingRejectedAssetIds },
      } } : {}),
    },
    productivity: {
      productive: true,
      reason: complete
        ? progress.length ? "supply-attribution-generation-published-with-bootstrap-progress"
          : generation.rejectedAssetIds.length > 0
          ? "supply-attribution-generation-published-with-diagnostic-rejections"
          : "supply-attribution-generation-published"
        : "supply-attribution-generation-published-with-blocking-rejections",
    },
  });
  } catch (error) {
    // Persistence after cancellation revokes provenance; the original run still fails.
    await settleAttribution(db, control, fixedInput, executionWindow?.slotStartedAtSec, "error", null);
    throw error;
  }
}
