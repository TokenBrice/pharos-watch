import { toErrorMessage } from "@shared/lib/error-utils";
import { deflateSync, inflateSync, strFromU8, strToU8 } from "fflate";
import { safetyScorePublicationIdentitiesMatch } from "@shared/lib/safety-score-publication";
import { V9AssetEvaluationError } from "@shared/lib/safety-score-v9/evaluate-set";
import { V9_MINIMUM_RATEABLE_ASSETS } from "@shared/types/safety-score-v9-coverage";
import type {
  V9PublicationHealth,
  V9PublicationHoldReason,
} from "@shared/types/report-cards-v9";
import type { SafetyScoreV9CurrentResponse } from "@shared/types/safety-score-v9-public";
import type { SafetyScoreV9PublicationIdentity } from "@shared/types/safety-score-publication";
import {
  normalizeSafetyScoreV9CompilerInput,
  withNormalizedV9JournalProjections,
  type SafetyScoreV9CompilerInput,
} from "./native-input";
import {
  buildSafetyScoreV9PublicationFromOwnedInput,
  type SafetyScoreV9BridgeJoinDiagnostic,
} from "./candidate";
import {
  assessV9Publication,
  expiredMeasuredExitAssetIdsFromRoutes,
  projectExpiredMeasuredExitRoutes,
  type SafetyScoreV9AcceptedPublicationBaseline,
  type V9PublicationCoverageFloor,
} from "./publication-assessment";
import {
  persistSafetyScoreV9Publication,
  persistSafetyScoreV9PublicationAttempt,
  loadSafetyScoreV9PublicationIdentityEnvelope,
} from "./publication-store";
import { loadSafetyScoreV9PublicationHealth } from "./publication-health";
import type { V9PublicationPhaseElapsedMs, V9PublicationAbortCause, V9PublicationAttempt } from "./publication-attempts";
import type { V9AssetQuarantine } from "./fact-set";
import { persistAlertSafetyV9SourceEnvelope } from "../alert-safety-source-cache";
import { loadSafetyScoreV9AcceptedBaselineState } from "./accepted-projection-readers";
import { applySafetyScoreV9GradeHysteresis } from "@shared/lib/safety-score-v9/grade-hysteresis";
import { buildSafetyScoreV9PublicationIdentity } from "../report-cards-v9-cache";
import { logWorkerEvent } from "../structured-log";
import type { SafetyScoreV9TransferMaterialityGeneration } from "./transfer-materiality";
import { buildSafetyScoreV9PublicationReplayCapture, SafetyScoreV9ReplayCaptureIdentityError, type SafetyScoreV9ReplayCaptureInput } from "./publication-replay-capture";
import type { AcceptedProjectionUnavailableReason } from "./accepted-projections";
import { journalSafetyScorePublication, type SafetyScoreJournalResult } from "./publication-journal";
import { archiveSafetyScoreCapture, type SafetyScoreCaptureArchiveResult } from "./capture-archive";
import { buildSafetyScoreV9AcceptedProjections } from "./accepted-projections";
import { materializeV9AcceptedPublication, type V9AcceptedPublicMaterializationSource, type V9PublicMaterializationResult } from "../report-cards-v9-materialization";

// Only non-scheduled callers use this bounded fallback.
const SAFETY_SCORE_V9_PUBLICATION_TIMEOUT_MS = 2 * 60_000;
// Initial headroom for up to two 5s independent operations (commit check and
// failed-attempt write) plus 5s cron settlement, not a measured persistence p99.
const SAFETY_SCORE_V9_PUBLICATION_SETTLEMENT_RESERVE_MS = 15_000;
const SAFETY_SCORE_V9_PUBLICATION_MINIMUM_BUDGET_MS = 10_000;
const SAFETY_SCORE_V9_PUBLICATION_DIAGNOSTIC_BUDGET_MS = 5_000;
const SAFETY_SCORE_V9_PUBLICATION_ATTEMPT_PREFIX =
  "safety-score-v9-publication";

type SafetyScoreV9PublicationFailureStage = Exclude<
  NonNullable<V9PublicationAttempt["failure"]>["stage"], "aborted"
>;

/**
 * Run-metadata-only sub-phase wall time (not persisted in attempt records):
 * persist splits admission/reads from the atomic acceptance write; materialize
 * splits representation staging writes from the selecting transaction.
 */
export interface SafetyScoreV9PublicationSubphaseElapsedMs {
  persistPrepare: number | null;
  persistCommit: number | null;
  materializeStage: number | null;
  materializeSelect: number | null;
}

export type SafetyScoreV9PublicMaterializationRunResult =
  | V9PublicMaterializationResult
  | { status: "failed"; publicationGenerationId: string; attempts: number; code: string; message: string }
  | { status: "skipped"; reason: "post-commit-interrupted" };

export interface RunSafetyScoreV9PublicationInput {
  db: D1Database;
  captureArchiveBucket?: R2Bucket;
  captureArchiveContext?: ExecutionContext;
  /**
   * Commit acceptance before materializing public representations. Off keeps
   * staging and selection inside the acceptance batch until every public
   * reader tolerates unselected staged rows (SAFETY_V9_DEFERRED_MATERIALIZATION).
   */
  deferPublicMaterialization?: boolean;
  /** Shard the canonical payload into chunk rows (SAFETY_V9_CHUNKED_PUBLICATION_WRITES). */
  chunkedPublicationWrites?: boolean;
  publicationDeadlineMs?: number;
  fixedInput: unknown;
  /** The production caller transfers ownership instead of pinning the decoded input across publication. */
  fixedInputOwner?: { value: Readonly<SafetyScoreV9CompilerInput> | null };
  /** Original compressed prepare-time envelope; retained without re-serialization. */
  fixedInputCacheValue?: string;
  /** The cache parser already normalized this value; avoid cloning it again on the production hot path. */
  fixedInputAlreadyNormalized?: boolean;
  /**
   * `prepareFixedInput` composes its result from the already-normalized input
   * (spreading its fields and adding the loader-validated journal projections),
   * so the runner must not re-run the full native-input normalization over it.
   * That pass re-parsed the whole base payload — three Zod passes, the DEX and
   * redemption row copies, and both payload fingerprints — for data the intake
   * parse already validated and canonicalized. With this set, only the journal
   * projections are re-validated (`withNormalizedV9JournalProjections`) and the
   * base-input identity is still asserted below.
   */
  preparedFixedInputAlreadyNormalized?: boolean;
  prepareFixedInput?: (
    fixedInput: Readonly<SafetyScoreV9CompilerInput>,
    signal: AbortSignal,
  ) => Promise<unknown>;
  signal?: AbortSignal;
  nowSec?: number;
  transferMaterialityGeneration?: SafetyScoreV9TransferMaterialityGeneration | null;
}

export type SafetyScoreV9PublicationRunResult = (
  | {
      status: "published";
      attemptId: string;
      publicationGenerationId: string;
      candidateId: string;
      outcome: "clean" | "partial";
      quarantines: readonly V9AssetQuarantine[];
      affectedAssetIds: readonly string[];
      bridgeJoinDiagnostics: readonly SafetyScoreV9BridgeJoinDiagnostic[];
      journal: SafetyScoreJournalResult;
      captureArchive: SafetyScoreCaptureArchiveResult;
      publicMaterialization: SafetyScoreV9PublicMaterializationRunResult;
      warnings: string[];
      postCommitFailure: { stage: SafetyScoreV9PublicationFailureStage; code: string; message: string } | null;
    }
  | {
      status: "held";
      attemptId: string;
      attemptedPublicationGenerationId: string;
      reasons: V9PublicationHoldReason[];
      /**
       * Observed-vs-required values for every coverage floor, so a
       * `coverage-floor-failed` hold in cron metadata shows how far below the
       * floor the attempt landed without replaying the compile.
       */
      coverageFloors: readonly V9PublicationCoverageFloor[];
      quarantines: readonly V9AssetQuarantine[];
      affectedAssetIds: readonly string[];
      bridgeJoinDiagnostics: readonly SafetyScoreV9BridgeJoinDiagnostic[];
      journal: SafetyScoreJournalResult;
      captureArchive: SafetyScoreCaptureArchiveResult;
      warnings: string[];
      postCommitFailure: { stage: SafetyScoreV9PublicationFailureStage; code: string; message: string } | null;
    }
  | {
      status: "failed";
      attemptId: string;
      stage: SafetyScoreV9PublicationFailureStage;
      code: string;
      message: string;
      journal: SafetyScoreJournalResult;
      captureArchive: SafetyScoreCaptureArchiveResult;
    }) & {
      phaseElapsedMs: V9PublicationPhaseElapsedMs;
      subphaseElapsedMs: SafetyScoreV9PublicationSubphaseElapsedMs;
      phaseTimingBasis: "workers-io-boundary-attributed";
      abortCause: V9PublicationAbortCause | null;
    };

function sameBaseInput(
  left: Readonly<SafetyScoreV9CompilerInput>,
  right: Readonly<SafetyScoreV9CompilerInput>,
): boolean {
  return (
    left.baseInputGenerationId === right.baseInputGenerationId &&
    left.sourceGeneration === right.sourceGeneration
  );
}

function takePublicationFixedInput(input: RunSafetyScoreV9PublicationInput): Readonly<SafetyScoreV9CompilerInput> {
  if (input.fixedInputOwner !== undefined) {
    const fixedInput = input.fixedInputOwner.value;
    input.fixedInputOwner.value = null;
    if (fixedInput === null) throw new Error("Safety Score v9 input ownership was already transferred");
    return fixedInput;
  }
  return input.fixedInputAlreadyNormalized
    ? input.fixedInput as SafetyScoreV9CompilerInput
    : normalizeSafetyScoreV9CompilerInput(input.fixedInput);
}

function reloadPublicationFixedInput(bytes: Uint8Array): Readonly<SafetyScoreV9CompilerInput> {
  return normalizeSafetyScoreV9CompilerInput(JSON.parse(strFromU8(inflateSync(bytes))));
}

function publicationInputReloader(fixedInput: Readonly<SafetyScoreV9CompilerInput>) {
  const bytes = deflateSync(strToU8(JSON.stringify(fixedInput)), { level: 1 });
  return () => reloadPublicationFixedInput(bytes);
}

function publicationReplayInputReloader(fixedInput: Readonly<SafetyScoreV9CompilerInput>) {
  const { baseInputGenerationId, clockSec, safetyScoreV9SupplyAttributionById, evidenceJournalById,
    supplyAttributionJournalById, pegProvenanceById, pipelineGapByAssetId } = fixedInput;
  const bytes = deflateSync(strToU8(JSON.stringify({
    baseInputGenerationId, clockSec, safetyScoreV9SupplyAttributionById, evidenceJournalById,
    supplyAttributionJournalById, pegProvenanceById, pipelineGapByAssetId,
  } satisfies SafetyScoreV9ReplayCaptureInput)), { level: 1 });
  return (): SafetyScoreV9ReplayCaptureInput => JSON.parse(strFromU8(inflateSync(bytes)));
}

async function preparePublicationInput(
  input: RunSafetyScoreV9PublicationInput,
  owner: { value: Readonly<SafetyScoreV9CompilerInput> | null },
  signal: AbortSignal,
) {
  let fixedInput = owner.value!;
  owner.value = null;
  if (input.prepareFixedInput) {
    const prepared = await input.prepareFixedInput(fixedInput, signal);
    const preparedFixedInput = input.preparedFixedInputAlreadyNormalized
      ? withNormalizedV9JournalProjections(prepared as SafetyScoreV9CompilerInput)
      : normalizeSafetyScoreV9CompilerInput(prepared);
    if (!sameBaseInput(preparedFixedInput, fixedInput)) {
      throw new Error("Safety Score v9 preparation changed the authoritative fixed input");
    }
    fixedInput = preparedFixedInput;
  }
  return {
    owner: { value: fixedInput as Readonly<SafetyScoreV9CompilerInput> | null, reload: publicationInputReloader(fixedInput) },
    replay: input.fixedInputCacheValue === undefined ? null : publicationReplayInputReloader(fixedInput),
    expiredRoutes: projectExpiredMeasuredExitRoutes(fixedInput),
    summary: {
      clockSec: fixedInput.clockSec,
      activeAssetIds: fixedInput.activeAssetIds,
      baseInputGenerationId: fixedInput.baseInputGenerationId,
      sourceGeneration: fixedInput.sourceGeneration,
      dexGenerationId: fixedInput.dexGenerationId,
      redemptionGenerationId: fixedInput.redemptionGenerationId,
      inputFreshness: fixedInput.inputFreshness,
      registryFingerprint: fixedInput.registryFingerprint,
      v9PublicationInputHealth: fixedInput.v9PublicationInputHealth,
    },
  };
}

function releasedPublicationInput(): never {
  throw new Error("Safety Score v9 compilation already completed");
}

function fallbackNowSec(): number {
  return Math.max(0, Math.floor(Date.now() / 1_000));
}

function nowSecAtLeast(minimum: number, override?: number): number {
  const value = override ?? fallbackNowSec();
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(
      "Safety Score v9 publication clock must be epoch seconds",
    );
  }
  return Math.max(minimum, value);
}

function observationCoverageFloors(
  observedCount: number,
  expectedCount: number,
  rateableCount: number,
): V9PublicationCoverageFloor[] {
  const exactCount = observedCount === expectedCount;
  return [
    {
      id: "active-result-count",
      status: exactCount ? "pass" : "fail",
      observed: observedCount,
      required: `= ${expectedCount}`,
      detail: exactCount
        ? "The V9 publication contains one result for every active asset"
        : "The V9 publication result count does not match the active registry",
    },
    {
      id: "minimum-rateable-assets",
      status:
        rateableCount >= V9_MINIMUM_RATEABLE_ASSETS
          ? "pass"
          : "fail",
      observed: rateableCount,
      required: `>= ${V9_MINIMUM_RATEABLE_ASSETS}`,
      detail:
        rateableCount >= V9_MINIMUM_RATEABLE_ASSETS
          ? "The V9 publication meets the active-asset rateability floor"
          : "The V9 publication is below the active-asset rateability floor",
    },
  ];
}

function safeFailure(
  error: unknown,
  stage: SafetyScoreV9PublicationFailureStage,
): { code: string; message: string } {
  if (error instanceof SafetyScoreV9AcceptedBaselineProjectionError) {
    return { code: error.code, message: error.message };
  }
  const name = error instanceof Error && error.name ? error.name : "Error";
  const assetAndField =
    error instanceof V9AssetEvaluationError
      ? `-${error.assetId}-${error.fieldPath ?? "unknown-field"}`
      : "";
  const rawMessage = toErrorMessage(error);
  return {
    code: `safety-score-v9-publication-${stage}-${name}${assetAndField}`
      .replace(/[^A-Za-z0-9._:-]/gu, "-")
      .slice(0, 160),
    message: (
      rawMessage.trim() || "Safety Score v9 publication attempt failed"
    ).slice(0, 500),
  };
}

export function getSafetyScoreV9PublicationBudgetMs(
  nowMs: number,
  inheritedDeadlineMs?: number,
): number {
  // The fallback bounds non-scheduled callers; it is not a scheduled ceiling.
  const availableMs = inheritedDeadlineMs === undefined
    ? SAFETY_SCORE_V9_PUBLICATION_TIMEOUT_MS
    : inheritedDeadlineMs - nowMs - SAFETY_SCORE_V9_PUBLICATION_SETTLEMENT_RESERVE_MS;
  // Refuse late admission instead of extending a caller's absolute deadline.
  return availableMs >= SAFETY_SCORE_V9_PUBLICATION_MINIMUM_BUDGET_MS
    ? Math.floor(availableMs) : 0;
}

async function withIndependentPublicationBudget<T>(
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const signal = AbortSignal.timeout(SAFETY_SCORE_V9_PUBLICATION_DIAGNOSTIC_BUDGET_MS);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    operation(signal).then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", onAbort);
    });
  });
}

function heldPublicationHealth(args: {
  attemptedAtSec: number;
  reasons: V9PublicationHoldReason[];
  acceptedPublication: SafetyScoreV9AcceptedPublicationBaseline | null;
  previousHealth: V9PublicationHealth | null;
}): V9PublicationHealth {
  return {
    schemaVersion: 2,
    status: "held",
    acceptedPublicationGenerationId:
      args.acceptedPublication?.publicationGenerationId ??
      args.previousHealth?.acceptedPublicationGenerationId ??
      null,
    acceptedAtSec:
      args.acceptedPublication?.publishedAtSec ??
      args.previousHealth?.acceptedAtSec ??
      null,
    attemptedAtSec: args.attemptedAtSec,
    heldSinceSec:
      args.previousHealth?.status === "held"
        ? args.previousHealth.heldSinceSec
        : args.attemptedAtSec,
    reasons: args.reasons,
  };
}

class SafetyScoreV9AcceptedBaselineProjectionError extends Error {
  readonly code: string;

  constructor(reason: AcceptedProjectionUnavailableReason) {
    const suffix = reason === "projection-missing" ? "missing"
      : reason === "read-failed" ? "read-failed"
      : reason === "publication-mismatch" || reason === "health-mismatch" ? "publication-mismatch"
      : "invalid";
    super(`Accepted Safety Score v9 baseline projection unavailable: ${reason}`);
    this.name = "SafetyScoreV9AcceptedBaselineProjectionError";
    this.code = `safety-score-v9-accepted-baseline-projection-${suffix}`;
  }
}

function publicationAttempt(args: {
  attemptedAtSec: number;
  outcome: V9PublicationAttempt["outcome"];
  publicationGenerationId: string | null;
  quarantines: readonly V9AssetQuarantine[];
  affectedAssetIds: readonly string[];
  failure?: V9PublicationAttempt["failure"];
}): V9PublicationAttempt {
  return {
    schemaVersion: 1,
    attemptedAtSec: args.attemptedAtSec,
    outcome: args.outcome,
    publicationGenerationId: args.publicationGenerationId,
    quarantines: [...args.quarantines],
    affectedAssetIds: [...args.affectedAssetIds],
    ...(args.failure ? { failure: args.failure } : {}),
  };
}

async function persistFailedPublicationAttempt(args: {
  db: D1Database;
  attemptedAtSec: number;
  failure: NonNullable<V9PublicationAttempt["failure"]>;
}): Promise<void> {
  try {
    await withIndependentPublicationBudget((signal) => persistSafetyScoreV9PublicationAttempt(args.db, {
      publicationAttempt: publicationAttempt({
        attemptedAtSec: args.attemptedAtSec,
        outcome: "failed",
        publicationGenerationId: null,
        quarantines: [],
        affectedAssetIds: [],
        failure: args.failure,
      }),
      publicationClockSec: args.attemptedAtSec,
      signal,
    }));
  } catch (error) {
    logWorkerEvent({
      scope: "lib",
      level: "warn",
      event: "safety_score_v9_failed_attempt_persist_failed",
      job: "compute-safety-score-v9",
      message: "Safety Score V9 failed attempt metadata could not be persisted",
      metadata: {
        attemptedAtSec: args.attemptedAtSec,
        stage: args.failure.stage,
        code: safeFailure(error, "publication-write").code,
        message: safeFailure(error, "publication-write").message,
      },
    });
  }
}

function logPublicationGenerationDeltas(
  candidate: SafetyScoreV9CurrentResponse,
  accepted: SafetyScoreV9AcceptedPublicationBaseline | null,
): void {
  if (accepted === null) return;
  const acceptedById = new Map(accepted.cards.map((card) => [card.id, card]));
  const primaryRouteChurn: Array<Record<string, unknown>> = [];
  const capacityChanges: Array<Record<string, unknown>> = [];
  const pillarChanges: Array<Record<string, unknown>> = [];
  for (const card of candidate.cards) {
    const prior = acceptedById.get(card.id);
    if (
      prior === undefined ||
      !("breakdowns" in card) ||
      card.breakdowns === null ||
      prior.pillarScores === null
    ) {
      continue;
    }
    const candidatePrimary = card.breakdowns.exit.primaryRoute?.key ?? null;
    const acceptedPrimary = prior.primaryRouteKey;
    const candidateCapacity =
      card.breakdowns.exit.primaryRoute?.capacity?.executableUsd ?? null;
    const acceptedCapacity = prior.primaryRouteCapacityUsd;
    if (
      candidatePrimary !== acceptedPrimary &&
      primaryRouteChurn.length < 20
    ) {
      primaryRouteChurn.push({
        assetId: card.id,
        acceptedPrimary,
        candidatePrimary,
        exitScoreDelta:
          card.breakdowns.exit.publishedScore === null || prior.pillarScores.exit === null
            ? null : card.breakdowns.exit.publishedScore - prior.pillarScores.exit,
      });
    }
    if (
      candidateCapacity !== acceptedCapacity &&
      capacityChanges.length < 20
    ) {
      capacityChanges.push({
        assetId: card.id,
        acceptedCapacityUsd: acceptedCapacity,
        candidateCapacityUsd: candidateCapacity,
        deltaUsd:
          candidateCapacity === null || acceptedCapacity === null
            ? null
            : candidateCapacity - acceptedCapacity,
      });
    }
    for (const pillar of ["backing", "exit", "control"] as const) {
      const currentScore = card.breakdowns[pillar].publishedScore;
      const priorScore = prior.pillarScores[pillar];
      const delta = currentScore === null || priorScore === null ? null : currentScore - priorScore;
      if (delta !== null && Math.abs(delta) >= 1 && pillarChanges.length < 20) {
        pillarChanges.push({ assetId: card.id, pillar, delta });
      }
    }
  }
  if (
    primaryRouteChurn.length === 0 &&
    capacityChanges.length === 0 &&
    pillarChanges.length === 0
  ) return;
  logWorkerEvent({
    scope: "lib",
    level:
      primaryRouteChurn.some(
        (item) =>
          typeof item.exitScoreDelta === "number" &&
          Math.abs(item.exitScoreDelta) >= 10,
      ) ||
      capacityChanges.some((item) => {
        const acceptedCapacity = item.acceptedCapacityUsd;
        const candidateCapacity = item.candidateCapacityUsd;
        return (
          typeof acceptedCapacity === "number" &&
          acceptedCapacity >= 100_000 &&
          typeof candidateCapacity === "number" &&
          candidateCapacity <= acceptedCapacity * 0.5
        );
      })
        ? "warn"
        : "info",
    event: "safety_score_v9_generation_delta",
    job: "compute-safety-score-v9",
    message: "Safety Score V9 route or pillar state changed between accepted generations",
    metadata: {
      acceptedPublicationGenerationId: accepted.publicationGenerationId,
      candidatePublicationGenerationId: candidate.publicationGenerationId,
      primaryRouteChurn,
      capacityChanges,
      pillarChanges,
    },
  });
}

/**
 * Best-effort post-acceptance materialization. Acceptance is already durable;
 * a failure leaves readers on the previously selected generation and is retried
 * once in-run, then by the next accepted publication or a reader repair after
 * the lag budget.
 */
async function materializeAcceptedPublication(
  db: D1Database,
  source: V9AcceptedPublicMaterializationSource,
  signal: AbortSignal,
  timing: SafetyScoreV9PublicationSubphaseElapsedMs,
): Promise<SafetyScoreV9PublicMaterializationRunResult> {
  const maxAttempts = 2;
  for (let attempt = 1; ; attempt++) {
    try {
      return await materializeV9AcceptedPublication(db, source, signal, timing);
    } catch (error) {
      if (attempt < maxAttempts && !signal.aborted) continue;
      const failure = safeFailure(error, "publication-write");
      logWorkerEvent({
        scope: "lib", level: "warn", event: "safety_score_v9_public_materialization_failed",
        job: "compute-safety-score-v9", message: "Accepted publication retained; public representations not yet materialized",
        metadata: { publicationGenerationId: source.publication.publicationGenerationId, attempts: attempt, ...failure },
      });
      return {
        status: "failed", publicationGenerationId: source.publication.publicationGenerationId,
        attempts: attempt, code: failure.code.replace("publication-write", "public-materialization"), message: failure.message,
      };
    }
  }
}

export async function runSafetyScoreV9Publication(
  input: RunSafetyScoreV9PublicationInput,
): Promise<SafetyScoreV9PublicationRunResult> {
  let stage: SafetyScoreV9PublicationFailureStage = "base-input";
  let attemptedAtSec = fallbackNowSec();
  let attemptId = `${SAFETY_SCORE_V9_PUBLICATION_ATTEMPT_PREFIX}:${attemptedAtSec}`;
  const startedAtMs = Date.now();
  const budgetMs = getSafetyScoreV9PublicationBudgetMs(startedAtMs, input.publicationDeadlineMs);
  const publicationDeadlineMs = startedAtMs + budgetMs;
  const timeoutSignal = AbortSignal.timeout(budgetMs);
  const publicationSignal = input.signal ? AbortSignal.any([input.signal, timeoutSignal]) : timeoutSignal;
  // Production Workers clocks advance at I/O boundaries, not during pure CPU
  // work. These deltas are attribution hints, not CPU-phase measurements.
  const phaseElapsedMs: V9PublicationPhaseElapsedMs = {
    enrichment: null, baselineLoad: null, compile: null, assess: null,
    serialize: null, persist: null, journal: null, archive: null,
  };
  const subphaseElapsedMs: SafetyScoreV9PublicationSubphaseElapsedMs = {
    persistPrepare: null, persistCommit: null, materializeStage: null, materializeSelect: null,
  };
  let activePhase: keyof V9PublicationPhaseElapsedMs | null = null;
  let phaseStartedAtMs = startedAtMs;
  let committed = false;
  let pendingPublished: Extract<SafetyScoreV9PublicationRunResult, { status: "published" }> | null = null;
  let pendingIdentity: SafetyScoreV9PublicationIdentity | null = null;
  let pendingClockSec: number | null = null;
  const finishPhase = () => {
    if (activePhase !== null) {
      phaseElapsedMs[activePhase] = Math.max(0, Date.now() - phaseStartedAtMs);
      activePhase = null;
    }
  };
  const abortCause = (): V9PublicationAbortCause | null => {
    const source = publicationSignal.aborted
      ? input.signal?.aborted && publicationSignal.reason === input.signal.reason ? "caller" : "publication-deadline"
      : Date.now() >= publicationDeadlineMs ? "publication-deadline" : null;
    if (source === null) return null;
    const reason: unknown = source === "caller" ? input.signal?.reason : timeoutSignal.reason;
    return {
      source,
      name: (reason instanceof Error ? reason.name : source === "caller" ? "AbortError" : "TimeoutError").slice(0, 80),
      message: (reason === undefined ? "Publication deadline exhausted" : toErrorMessage(reason)).slice(0, 500),
    };
  };
  const beginPhase = (nextStage: SafetyScoreV9PublicationFailureStage, phase: keyof V9PublicationPhaseElapsedMs) => {
    finishPhase();
    // Check while the previous stage is still active: a synchronous compile
    // overrun must remain a compile failure, not be attributed to assessment.
    if (publicationSignal.aborted) throw publicationSignal.reason;
    if (Date.now() >= publicationDeadlineMs) throw new DOMException("Publication deadline exhausted", "TimeoutError");
    stage = nextStage;
    activePhase = phase;
    phaseStartedAtMs = Date.now();
  };

  try {
    if (publicationSignal.aborted) throw publicationSignal.reason;
    if (budgetMs === 0) throw new DOMException("Insufficient publication window after settlement reserve", "TimeoutError");
    if (
      input.nowSec !== undefined &&
      (!Number.isInteger(input.nowSec) || input.nowSec < 0)
    ) {
      throw new Error(
        "Safety Score v9 publication clock must be epoch seconds",
      );
    }
    const fixedInputOwner = { value: takePublicationFixedInput(input) as Readonly<SafetyScoreV9CompilerInput> | null };
    attemptedAtSec = nowSecAtLeast(fixedInputOwner.value!.clockSec, input.nowSec);
    attemptId = `${SAFETY_SCORE_V9_PUBLICATION_ATTEMPT_PREFIX}:${attemptedAtSec}`;

    beginPhase("v9-enrichment", "enrichment");
    const preparedInput = await preparePublicationInput(input, fixedInputOwner, publicationSignal);
    const fixedInput = preparedInput.summary;

    beginPhase("publication-gate", "baselineLoad");
    const acceptedState = await loadSafetyScoreV9AcceptedBaselineState(input.db, publicationSignal);
    if (acceptedState.kind === "unavailable") {
      throw new SafetyScoreV9AcceptedBaselineProjectionError(acceptedState.reason);
    }
    const acceptedPublication = acceptedState.kind === "accepted" ? acceptedState.projection.baseline : null;
    const previousHealth = acceptedState.health;

    beginPhase("compile", "compile");
    const pipeline = buildSafetyScoreV9PublicationFromOwnedInput({
      fixedInputOwner: preparedInput.owner,
      publishedAtSec: fixedInput.clockSec,
      transferMaterialityGeneration: input.transferMaterialityGeneration ?? null,
    });
    preparedInput.owner.reload = releasedPublicationInput;
    // Grade hysteresis (10.26) is applied before assessment and journaling so
    // every consumer sees the grade that will actually be published.
    const publication = applySafetyScoreV9GradeHysteresis(pipeline.candidate, acceptedPublication);
    const coverageFloors = observationCoverageFloors(
      publication.cards.length,
      fixedInput.activeAssetIds.length,
      publication.completeness.ratedCount,
    );

    beginPhase("assess", "assess");
    let assessment;
    try {
      logPublicationGenerationDeltas(publication, acceptedPublication);
      assessment = assessV9Publication({
        inputHealth: fixedInput.v9PublicationInputHealth,
        expiredMeasuredExitAssetIds: expiredMeasuredExitAssetIdsFromRoutes(preparedInput.expiredRoutes, publication, acceptedPublication),
        candidate: publication,
        acceptedPublication,
        coverageFloors,
        quarantinedAssetIds: pipeline.quarantines.map(
          (quarantine) => quarantine.assetId,
        ),
        quarantineAffectedAssetIds:
          pipeline.quarantineAffectedAssetIds,
      });
    } catch (error) {
      assessment = {
        decision: "hold" as const,
        reasons: [
          {
            code: "assessment-failed" as const,
            detail: safeFailure(error, "publication-gate").message.slice(
              0,
              240,
            ),
          },
        ],
        affectedAssetIds: pipeline.quarantineAffectedAssetIds,
      };
    }

    if (assessment.decision === "hold") {
      beginPhase("publication-write", "persist");
      await persistSafetyScoreV9Publication(input.db, {
        publicationHealth: heldPublicationHealth({
          attemptedAtSec: fixedInput.clockSec,
          reasons: assessment.reasons,
          acceptedPublication,
          previousHealth,
        }),
        publicationAttempt: publicationAttempt({
          attemptedAtSec: fixedInput.clockSec,
          outcome: "held",
          publicationGenerationId: null,
          quarantines: pipeline.quarantines,
          affectedAssetIds: assessment.affectedAssetIds,
        }),
        publicationClockSec: fixedInput.clockSec,
        signal: publicationSignal,
        timing: subphaseElapsedMs,
      });
      let journal: SafetyScoreJournalResult = { status: "skipped", reason: "post-commit-interrupted", rows: 0 };
      let postCommitFailure: { stage: SafetyScoreV9PublicationFailureStage; code: string; message: string } | null = null;
      try {
        beginPhase("journal", "journal");
        journal = await journalSafetyScorePublication({
          db: input.db, publication, fixedInput, attemptId, attemptedAtSec,
          outcome: "held", holdReasons: assessment.reasons,
          transferMaterialityGenerationId: input.transferMaterialityGeneration?.generationId ?? null,
          signal: publicationSignal,
        });
      } catch (error) {
        postCommitFailure = { stage, ...safeFailure(error, stage) };
      }
      finishPhase();
      const cause = abortCause();
      if (postCommitFailure === null && cause !== null) {
        postCommitFailure = { stage, ...safeFailure(publicationSignal.reason, stage) };
      }
      if (postCommitFailure !== null) {
        logWorkerEvent({
          scope: "lib", level: "warn", event: "safety_score_v9_held_journal_interrupted",
          job: "compute-safety-score-v9", message: "Held publication state retained after journal interruption",
          metadata: { abortCause: cause, ...postCommitFailure },
        });
      }
      return {
        status: "held",
        attemptId,
        phaseElapsedMs,
        subphaseElapsedMs,
        phaseTimingBasis: "workers-io-boundary-attributed",
        abortCause: cause,
        warnings: postCommitFailure === null ? [] : ["held-state-committed-before-journal-failure"],
        postCommitFailure,
        journal,
        captureArchive: { status: "skipped", reason: "publication-held" },
        attemptedPublicationGenerationId:
          publication.publicationGenerationId,
        reasons: assessment.reasons,
        coverageFloors,
        quarantines: pipeline.quarantines,
        affectedAssetIds: assessment.affectedAssetIds,
        bridgeJoinDiagnostics: pipeline.bridgeJoinDiagnostics ?? [],
      };
    }

    if (
      fixedInput.baseInputGenerationId !==
      publication.baseInputGenerationId
    ) {
      throw new Error(
        "Accepted Safety Score v9 input does not match the publication base generation",
      );
    }
    beginPhase("serialize", "serialize");
    const partial = assessment.affectedAssetIds.length > 0;
    let replayCaptureValue: string | undefined;
    if (input.fixedInputCacheValue !== undefined) {
      try {
        replayCaptureValue = (await buildSafetyScoreV9PublicationReplayCapture(
          publication, preparedInput.replay!(), input.transferMaterialityGeneration ?? null,
        )).value;
      } catch (error) {
        if (error instanceof SafetyScoreV9ReplayCaptureIdentityError) throw error;
        logWorkerEvent({
          scope: "lib",
          level: "warn",
          event: "safety_score_v9_replay_capture_retention_failed",
          job: "compute-safety-score-v9",
          message: "Accepted replay delta could not be serialized; canonical publication continues",
          metadata: { reason: toErrorMessage(error).slice(0, 200) },
        });
      }
    }
    preparedInput.replay = null;
    beginPhase("publication-write", "persist");
    pendingIdentity = buildSafetyScoreV9PublicationIdentity(publication);
    pendingClockSec = fixedInput.clockSec;
    pendingPublished = {
      status: "published", attemptId,
      publicationGenerationId: publication.publicationGenerationId,
      candidateId: publication.candidateId,
      outcome: partial ? "partial" : "clean",
      quarantines: pipeline.quarantines,
      affectedAssetIds: assessment.affectedAssetIds,
      bridgeJoinDiagnostics: pipeline.bridgeJoinDiagnostics ?? [],
      journal: { status: "skipped", reason: "post-commit-interrupted", rows: 0 },
      captureArchive: { status: "skipped", reason: "post-commit-interrupted" },
      publicMaterialization: { status: "skipped", reason: "post-commit-interrupted" },
      warnings: [], postCommitFailure: null, phaseElapsedMs, subphaseElapsedMs, abortCause: null,
      phaseTimingBasis: "workers-io-boundary-attributed",
    };
    const persisted = await persistSafetyScoreV9Publication(input.db, {
      publication,
      buildAcceptedProjections: buildSafetyScoreV9AcceptedProjections,
      publicationReplayCaptureValue: replayCaptureValue,
      publicationReplayBaseValue: replayCaptureValue === undefined ? undefined : input.fixedInputCacheValue,
      publicationHealth: {
        schemaVersion: 2,
        status: "current",
        acceptedPublicationGenerationId:
          publication.publicationGenerationId,
        acceptedAtSec: fixedInput.clockSec,
        attemptedAtSec: fixedInput.clockSec,
        heldSinceSec: null,
        reasons: [],
      },
      publicationAttempt: publicationAttempt({
        attemptedAtSec: fixedInput.clockSec,
        outcome: partial
          ? "published-partial"
          : "published-clean",
        publicationGenerationId:
          publication.publicationGenerationId,
        quarantines: pipeline.quarantines,
        affectedAssetIds: assessment.affectedAssetIds,
      }),
      publicationClockSec: fixedInput.clockSec,
      signal: publicationSignal,
      timing: subphaseElapsedMs,
      deferPublicMaterialization: input.deferPublicMaterialization,
      chunkedPublicationWrites: input.chunkedPublicationWrites,
    });
    committed = true;
    finishPhase();
    stage = "alert-envelope";
    try {
      // Thin alert-lane projection of the publication just accepted. The
      // response is already in memory here, so this is the one place the
      // envelope can be written without a publication decode. Non-fatal:
      // alert lanes fail closed until a matching thin envelope is available.
      await persistAlertSafetyV9SourceEnvelope(
        input.db,
        {
          cards: publication.cards,
          safetyScoreIdentity:
            buildSafetyScoreV9PublicationIdentity(publication),
          publishedAt: fixedInput.clockSec,
        },
        publicationSignal,
      );
    } catch (error) {
      logWorkerEvent({
        scope: "lib",
        level: "warn",
        event: "safety_score_v9_alert_source_envelope_persist_failed",
        job: "compute-safety-score-v9",
        message: "Safety Score V9 alert source envelope could not be persisted",
        metadata: { error: String(error).slice(0, 200) },
      });
    }
    beginPhase("journal", "journal");
    const journal = await journalSafetyScorePublication({
      db: input.db, publication, fixedInput, attemptId, attemptedAtSec,
      outcome: "accepted",
      transferMaterialityGenerationId: input.transferMaterialityGeneration?.generationId ?? null,
      signal: publicationSignal,
    });
    pendingPublished.journal = journal;
    beginPhase("archive", "archive");
    const captureArchive = await archiveSafetyScoreCapture({
      db: input.db, bucket: input.captureArchiveBucket, publication,
      cacheRows: persisted.captureArchiveCacheRows, signal: publicationSignal,
      deadlineMs: publicationDeadlineMs, ctx: input.captureArchiveContext,
    });
    finishPhase();
    pendingPublished.captureArchive = captureArchive;
    // An interrupted run leaves materialization to the next accepted run or a
    // reader repair; the previously selected generation stays served meanwhile.
    if (persisted.acceptedMaterialization !== null && !publicationSignal.aborted) {
      pendingPublished.publicMaterialization = await materializeAcceptedPublication(
        input.db, persisted.acceptedMaterialization, publicationSignal, subphaseElapsedMs,
      );
      if (pendingPublished.publicMaterialization.status === "failed") {
        pendingPublished.warnings.push("public-materialization-failed");
      }
    }
    pendingPublished.abortCause = abortCause();
    if (pendingPublished.abortCause !== null) {
      pendingPublished.warnings.push("publication-committed-before-abort");
      // A materialization interrupted by the abort already reports its own failure.
      if (pendingPublished.publicMaterialization.status !== "failed") pendingPublished.postCommitFailure = {
        stage, ...safeFailure(publicationSignal.reason ?? new DOMException("Publication deadline exhausted", "TimeoutError"), stage),
      };
      logWorkerEvent({
        scope: "lib", level: "warn", event: "safety_score_v9_post_commit_interrupted",
        job: "compute-safety-score-v9", message: "Canonical publication committed before cancellation",
        metadata: { publicationGenerationId: publication.publicationGenerationId, stage, abortCause: pendingPublished.abortCause },
      });
    }
    return pendingPublished;
  } catch (error) {
    finishPhase();
    const cause = abortCause();
    // D1 can commit before a failed acknowledgment (including a non-abort
    // transport error). Confirm the exact identity and current health using a
    // fresh bounded signal; an exception alone establishes neither outcome.
    if (!committed && pendingPublished !== null) {
      try {
        const [identity, health] = await withIndependentPublicationBudget((signal) => Promise.all([
          loadSafetyScoreV9PublicationIdentityEnvelope(input.db, signal),
          loadSafetyScoreV9PublicationHealth(input.db, signal),
        ]));
        committed = identity !== null && pendingIdentity !== null &&
          safetyScorePublicationIdentitiesMatch(identity, pendingIdentity) &&
          health?.status === "current" && health.acceptedAtSec === pendingClockSec &&
          health.acceptedPublicationGenerationId === pendingPublished.publicationGenerationId;
      } catch (recoveryError) {
        logWorkerEvent({
          scope: "lib", level: "warn", event: "safety_score_v9_commit_check_failed",
          message: "Could not establish accepted publication identity after persistence failure",
          metadata: { error: toErrorMessage(recoveryError).slice(0, 200) },
        });
      }
    }
    if (committed && pendingPublished !== null) {
      pendingPublished.abortCause = cause;
      pendingPublished.warnings.push("publication-committed-before-post-commit-failure");
      pendingPublished.postCommitFailure = { stage, ...safeFailure(error, stage) };
      logWorkerEvent({
        scope: "lib", level: "warn", event: "safety_score_v9_post_commit_interrupted",
        job: "compute-safety-score-v9", message: "Canonical publication retained after post-commit failure",
        metadata: { publicationGenerationId: pendingPublished.publicationGenerationId, stage, abortCause: cause, error: toErrorMessage(error).slice(0, 200) },
      });
      return pendingPublished;
    }
    const failure = safeFailure(error, stage);
    await persistFailedPublicationAttempt({
      db: input.db,
      attemptedAtSec,
      failure: {
        stage,
        phaseElapsedMs,
        phaseTimingBasis: "workers-io-boundary-attributed",
        abortCause: cause,
        ...failure,
      },
    });
    return {
      status: "failed",
      attemptId,
      stage,
      phaseElapsedMs,
      subphaseElapsedMs,
      phaseTimingBasis: "workers-io-boundary-attributed",
      abortCause: cause,
      journal: { status: "skipped", reason: "publication-failed", rows: 0 },
      captureArchive: { status: "skipped", reason: "publication-failed" },
      ...failure,
    };
  }
}
