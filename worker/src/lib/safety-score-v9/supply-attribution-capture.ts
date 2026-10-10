import { sha256Hex } from "@shared/lib/sha256";
import { stableJsonStringifyV1 } from "@shared/lib/stable-json";
import { SAFETY_SCORE_V9_SUPPLY_ATTRIBUTION_REFRESH_INTERVAL_SEC } from "@shared/lib/cron-jobs";
import {
  admissionCodeForSupplyAttributionRejection,
  createSupplyAttributionJournalV1,
  withSupplyAttributionJournalDiagnosticV1,
  SUPPLY_ATTRIBUTION_CAPTURE_BUDGET,
  type SupplyAttributionRejectionCode,
  type SupplyAttributionJournalV1,
} from "@shared/lib/safety-score-v9-supply-attribution-journal";
import {
  SUPPLY_ATTRIBUTION_ATTEMPT_DIAGNOSTICS_MAX,
  SupplyAttributionAttemptDiagnosticSchema,
  type SupplyAttributionAttemptDiagnostic,
  type SupplyAttributionCaptureFailureReason,
} from "@shared/types/safety-score-v9-supply-attribution";
import { rethrowIfAborted } from "../abort";
import type { ChainRpcConfig } from "../chain-registry";
import type { V9ExecutionWindow } from "../v9-slot-window";
import type { SafetyScoreV9CompilerInput } from "./native-input";
import {
  CENTRIFUGE_BURN_MINT_ASSET_IDS,
  buildReviewedDeploymentRouteInventory,
} from "./supply-attribution-contract";
import { REVIEWED_ECONOMIC_SUPPLY_PLANS, buildReviewedEconomicDeploymentInventory } from "./supply-attribution-contract";
import { observeReviewedEconomicDeploymentPartitionAttempt } from "./economic-supply-observer";
import type { BodyReadObserver } from "../response-body";
import { V9_CANDIDATE_POLICY_V1 } from "@shared/lib/safety-score-v9/policy";
import {
  observeCentrifugeReviewedDeploymentUnitPartitionAttempt,
} from "./centrifuge-supply-observer";
import {
  observeWmReviewedDeploymentUnitPartitionAttempt,
} from "./wm-supply-observer";
import {
  buildXautRepresentationGroupInventory,
  XAUT_ASSET_ID,
} from "./xaut-supply-attribution-contract";
import {
  observeXautRepresentationGroupSupplyAttributionAttempt,
} from "./xaut-supply-observer";
import type { SafetyScoreV9SupplyAttributionInput } from "./supply-attribution-source";
import { runBudgetedSupplyAttributionAssets } from "./supply-attribution-capture-budget";
import {
  aggregateSupplyUsd,
  safetyScoreV9SupplyAttributionExpectedAssetIds,
  SAFETY_SCORE_V9_SUPPLY_ATTRIBUTION_SOURCE_ID_BY_ASSET,
} from "./supply-attribution";

type V9SupplyAttributionById = SafetyScoreV9CompilerInput["safetyScoreV9SupplyAttributionById"];

export interface SafetyScoreV9SupplyAttributionCapture {
  attributionById: V9SupplyAttributionById;
  captureClockSec: number;
  expectedAssetIds: string[];
  journalRecords: SupplyAttributionJournalV1[];
  diagnosticsById?: Record<string, SupplyAttributionAttemptDiagnostic[]>;
  failureReasonById?: Record<string, SupplyAttributionCaptureFailureReason>;
}

export interface SafetyScoreV9SupplyAttributionCaptureOptions {
  clockMode: "source" | "wall";
  notBeforeSec?: number;
  executionWindow?: V9ExecutionWindow;
  db?: D1Database;
  onBodyRead?: BodyReadObserver;
}

type SupplyAttributionValue = Exclude<
  V9SupplyAttributionById[string],
  { model: "canonical-lock-mint-partition-v1" }
>;

type SupplyAttributionObservationAttempt =
  | {
      status: "accepted";
      attribution: SupplyAttributionValue;
    }
  | {
      status: "rejected";
      rejectionCode: SupplyAttributionRejectionCode;
      failedRouteId: string | null;
      rejectedSourceObservedAtSec?: number | null;
    };

interface SupplyAttributionAssetDescriptor {
  assetId: string;
  sourceId: SupplyAttributionJournalV1["sourceId"];
  sourceOriginClass: SupplyAttributionJournalV1["sourceOriginClass"];
  routeInventoryDigest: () => string | null;
  observe: (input: {
    fixedInput: Readonly<SafetyScoreV9SupplyAttributionInput>;
    aggregateSupplyUsd: number;
    registryFingerprint: string;
    scoringClockSec: number;
    chainRpcs: Map<string, ChainRpcConfig>;
    signal?: AbortSignal;
    executionWindow?: V9ExecutionWindow;
    assetDeadlineMs?: number;
    db?: D1Database;
    onDiagnostic?: (diagnostic: SupplyAttributionAttemptDiagnostic) => void;
    onBodyRead?: BodyReadObserver;
  }) => Promise<SupplyAttributionObservationAttempt>;
}

function supplyAttributionAssetDescriptors():
  SupplyAttributionAssetDescriptor[] {
  return [
    {
      assetId: XAUT_ASSET_ID,
      sourceId:
        SAFETY_SCORE_V9_SUPPLY_ATTRIBUTION_SOURCE_ID_BY_ASSET[XAUT_ASSET_ID],
      sourceOriginClass: "issuer-disclosure-plus-onchain",
      routeInventoryDigest:
        () => buildXautRepresentationGroupInventory()?.digest ?? null,
      observe: observeXautRepresentationGroupSupplyAttributionAttempt,
    },
    ...CENTRIFUGE_BURN_MINT_ASSET_IDS.map(
      (assetId): SupplyAttributionAssetDescriptor => ({
        assetId,
        sourceId:
          SAFETY_SCORE_V9_SUPPLY_ATTRIBUTION_SOURCE_ID_BY_ASSET[assetId],
        sourceOriginClass: "onchain-observation",
        routeInventoryDigest:
          () => buildReviewedDeploymentRouteInventory(assetId)?.digest ?? null,
        observe: (input) =>
          observeCentrifugeReviewedDeploymentUnitPartitionAttempt({
            assetId,
            ...input,
          }),
      }),
    ),
    ...[...REVIEWED_ECONOMIC_SUPPLY_PLANS.keys()].map((assetId): SupplyAttributionAssetDescriptor => ({
      assetId, sourceId: V9_CANDIDATE_POLICY_V1.policy.semantic.supplyAttribution.journalSourceId,
      sourceOriginClass: "issuer-disclosure-plus-onchain",
      routeInventoryDigest: () => buildReviewedEconomicDeploymentInventory(assetId)?.digest ?? null,
      observe: ({ fixedInput, scoringClockSec, chainRpcs, signal, db, onDiagnostic, onBodyRead }) => observeReviewedEconomicDeploymentPartitionAttempt({ assetId, fixedInput, scoringClockSec, chainRpcs, signal, db, onDiagnostic, onBodyRead }),
    })),
    {
      assetId: "wm-m0",
      sourceId: SAFETY_SCORE_V9_SUPPLY_ATTRIBUTION_SOURCE_ID_BY_ASSET["wm-m0"],
      sourceOriginClass: "onchain-observation",
      routeInventoryDigest:
        () => buildReviewedDeploymentRouteInventory("wm-m0")?.digest ?? null,
      observe: observeWmReviewedDeploymentUnitPartitionAttempt,
    },
  ];
}

function findLastDiagnosticIndex(
  diagnostics: readonly SupplyAttributionAttemptDiagnostic[] | undefined,
  predicate: (diagnostic: SupplyAttributionAttemptDiagnostic) => boolean,
): number {
  if (diagnostics) {
    for (let index = diagnostics.length - 1; index >= 0; index--) {
      if (predicate(diagnostics[index])) return index;
    }
  }
  return -1;
}

function buildSupplyAttributionJournalRecord(input: {
  descriptor: SupplyAttributionAssetDescriptor;
  fixedInput: Readonly<SafetyScoreV9SupplyAttributionInput>;
  attemptId: string;
  attemptedAtSec: number;
  completedAtSec: number;
  scoringClockSec: number;
  outcome: SupplyAttributionObservationAttempt;
  diagnostics?: SupplyAttributionAttemptDiagnostic[];
}): SupplyAttributionJournalV1 {
  const { descriptor, outcome } = input;
  let diagnosticIndex = findLastDiagnosticIndex(input.diagnostics, row => row.hardEvidenceFailure && row.failurePredicate !== null);
  if (diagnosticIndex < 0) {
    diagnosticIndex = findLastDiagnosticIndex(input.diagnostics, row => row.failurePredicate !== null);
  }
  const diagnostic = input.diagnostics?.[diagnosticIndex];
  return createSupplyAttributionJournalV1(withSupplyAttributionJournalDiagnosticV1({
    schemaVersion: 1,
    lane: "supply-attribution",
    assetId: descriptor.assetId,
    attemptId: input.attemptId,
    sourceId: descriptor.sourceId,
    sourceOriginClass: descriptor.sourceOriginClass,
    baseInputGenerationId: input.fixedInput.baseInputGenerationId,
    sourceGeneration: input.fixedInput.sourceGeneration,
    registryFingerprint: input.fixedInput.registryFingerprint,
    routeInventoryDigest:
      outcome.status === "accepted"
        ? outcome.attribution.routeInventoryDigest
        : descriptor.routeInventoryDigest(),
    attemptCode: "supply-attribution.collector.attempted",
    admissionCode:
      outcome.status === "accepted"
        ? "supply-attribution.admission.accepted"
        : admissionCodeForSupplyAttributionRejection(
            outcome.rejectionCode,
          ),
    fallbackCode:
      outcome.status === "accepted"
        ? "supply-attribution.fallback.not-used"
        : "supply-attribution.fallback.aggregate-only",
    ...(outcome.status === "rejected"
      ? { rejectionCode: outcome.rejectionCode }
      : {}),
    attemptedAtSec: input.attemptedAtSec,
    completedAtSec: input.completedAtSec,
    scoringClockSec: input.scoringClockSec,
    sourceObservedAtSec:
      outcome.status === "accepted"
        ? outcome.attribution.observedAtSec
        : outcome.rejectedSourceObservedAtSec ?? null,
    failedRouteId:
      outcome.status === "rejected" ? outcome.failedRouteId : null,
    contentSha256:
      outcome.status === "accepted"
        ? sha256Hex(stableJsonStringifyV1(outcome.attribution))
        : null,
  }, diagnostic));
}

async function runSupplyAttributionAssetCapture(input: {
  descriptor: SupplyAttributionAssetDescriptor;
  fixedInput: Readonly<SafetyScoreV9SupplyAttributionInput>;
  chainRpcs?: Map<string, ChainRpcConfig>;
  signal?: AbortSignal;
  executionWindow?: V9ExecutionWindow;
  assetDeadlineMs?: number;
  db?: D1Database;
  observationClockSec: (attemptedAtSec: number) => number;
  attributionById: V9SupplyAttributionById;
  journalRecords: SupplyAttributionJournalV1[];
  rejectionCode?: SupplyAttributionRejectionCode;
  onDiagnostic?: (diagnostic: SupplyAttributionAttemptDiagnostic) => void;
  onBodyRead?: BodyReadObserver;
  diagnostics?: SupplyAttributionAttemptDiagnostic[];
}): Promise<void> {
  const attemptedAtSec = Math.floor(Date.now() / 1_000);
  const scoringClockSec = input.observationClockSec(attemptedAtSec);
  // Lane/source are already explicit; keep the same UUID entropy without a
  // redundant prefix consuming the bounded journal's diagnostic headroom.
  const attemptId = crypto.randomUUID();
  let outcome: SupplyAttributionObservationAttempt;
  try {
    const supplyUsd = aggregateSupplyUsd(input.fixedInput, input.descriptor.assetId);
    outcome =
      input.rejectionCode || supplyUsd === null
        ? { status: "rejected", rejectionCode: input.rejectionCode ?? "packet-reconciliation-failed", failedRouteId: null }
        : input.chainRpcs && input.chainRpcs.size > 0
        ? await input.descriptor.observe({
            fixedInput: input.fixedInput,
            aggregateSupplyUsd: supplyUsd,
            registryFingerprint: input.fixedInput.registryFingerprint,
            scoringClockSec,
            chainRpcs: input.chainRpcs,
            signal: input.signal,
            executionWindow: input.executionWindow,
            assetDeadlineMs: input.assetDeadlineMs,
            db: input.db,
            onDiagnostic: input.onDiagnostic,
            onBodyRead: input.onBodyRead,
          })
        : {
            status: "rejected",
            rejectionCode: "chain-rpc-unavailable",
            failedRouteId: null,
            rejectedSourceObservedAtSec: null,
          };
  } catch (error) {
    rethrowIfAborted(error, input.signal);
    outcome = {
      status: "rejected",
      rejectionCode: "deployment-state-unavailable",
      failedRouteId: null,
      rejectedSourceObservedAtSec: null,
    };
  }
  const completedAtSec = Math.max(
    attemptedAtSec,
    Math.floor(Date.now() / 1_000),
  );
  let journalRecord: SupplyAttributionJournalV1;
  try {
    journalRecord = buildSupplyAttributionJournalRecord({
      descriptor: input.descriptor,
      fixedInput: input.fixedInput,
      attemptId,
      attemptedAtSec,
      completedAtSec,
      scoringClockSec,
      outcome,
      diagnostics: input.diagnostics,
    });
  } catch (error) {
    rethrowIfAborted(error, input.signal);
    outcome = {
      status: "rejected",
      rejectionCode: "deployment-state-unavailable",
      failedRouteId: null,
      rejectedSourceObservedAtSec: null,
    };
    journalRecord = buildSupplyAttributionJournalRecord({
      descriptor: input.descriptor,
      fixedInput: input.fixedInput,
      attemptId,
      attemptedAtSec,
      completedAtSec,
      scoringClockSec,
      outcome,
      diagnostics: input.diagnostics,
    });
  }
  if (outcome.status === "accepted") {
    input.attributionById[input.descriptor.assetId] =
      outcome.attribution;
  }
  input.journalRecords.push(journalRecord);
}

/**
 * Captures V9-only supply attribution without mutating the public stablecoin
 * row or the V8 chain map used by exact replay.
 */
export async function captureSafetyScoreV9SupplyAttribution(
  fixedInput: Readonly<SafetyScoreV9SupplyAttributionInput>,
  chainRpcs?: Map<string, ChainRpcConfig>,
  signal?: AbortSignal,
  options: SafetyScoreV9SupplyAttributionCaptureOptions = {
    clockMode: "source",
  },
): Promise<SafetyScoreV9SupplyAttributionCapture> {
  if (
    options.notBeforeSec !== undefined &&
    (!Number.isSafeInteger(options.notBeforeSec) ||
      options.notBeforeSec < fixedInput.clockSec)
  ) {
    throw new Error(
      "Supply attribution capture floor must be a safe integer at or after its exact base-input clock",
    );
  }
  let captureClockSec = fixedInput.clockSec;
  const observationClockSec = (attemptedAtSec: number): number => {
    const clockSec =
      options.clockMode === "wall"
        ? Math.max(
            fixedInput.clockSec,
            options.notBeforeSec ?? 0,
            attemptedAtSec,
          )
        : fixedInput.clockSec;
    captureClockSec = Math.max(captureClockSec, clockSec);
    return clockSec;
  };
  const expectedAssetIds =
    safetyScoreV9SupplyAttributionExpectedAssetIds(fixedInput);
  const expectedAssetIdSet = new Set(expectedAssetIds);
  const attributionById: V9SupplyAttributionById = {};
  const journalRecords: SupplyAttributionJournalV1[] = [];
  const failureReasonById: Record<string, SupplyAttributionCaptureFailureReason> = {};
  // Kept outside child task results so an authenticated prefix survives a
  // timeout/abort that discards the child's eventual return value.
  const diagnosticsById: Record<string, SupplyAttributionAttemptDiagnostic[]> = {};
  const retainDiagnostic = (assetId: string, diagnostic: SupplyAttributionAttemptDiagnostic) => {
    const validated = SupplyAttributionAttemptDiagnosticSchema.parse(diagnostic);
    const rows = diagnosticsById[assetId] ??= [];
    if (rows.length < SUPPLY_ATTRIBUTION_ATTEMPT_DIAGNOSTICS_MAX) {
      rows.push(validated);
    } else {
      // Preserve both hard failures and authenticated progress over idle writes.
      let index = findLastDiagnosticIndex(rows, row => !row.hardEvidenceFailure &&
        !(row.persisted && row.authenticatedCursorAdvanced && row.incompleteBootstrap));
      if (index < 0 && (validated.hardEvidenceFailure ||
        (validated.persisted && validated.authenticatedCursorAdvanced && validated.incompleteBootstrap))) {
        index = findLastDiagnosticIndex(rows, row => !row.hardEvidenceFailure);
      }
      if (index >= 0) rows[index] = validated;
    }
  };

  const descriptors = supplyAttributionAssetDescriptors().filter(
    descriptor => expectedAssetIdSet.has(descriptor.assetId),
  );
  const results = await runBudgetedSupplyAttributionAssets(
    descriptors,
    async (descriptor, assetSignal, assetDeadlineMs) => {
      const assetAttributionById: V9SupplyAttributionById = {};
      const assetJournalRecords: SupplyAttributionJournalV1[] = [];
      const assetDiagnostics = diagnosticsById[descriptor.assetId] ??= [];
      await runSupplyAttributionAssetCapture({
        descriptor, fixedInput, chainRpcs, signal: assetSignal,
        executionWindow: options.executionWindow, db: options.db,
        assetDeadlineMs,
        observationClockSec, attributionById: assetAttributionById,
        journalRecords: assetJournalRecords,
        onDiagnostic: diagnostic => retainDiagnostic(descriptor.assetId, diagnostic),
        onBodyRead: options.onBodyRead,
        diagnostics: assetDiagnostics,
      });
      return { attributionById: assetAttributionById, journalRecords: assetJournalRecords };
    },
    {
      signal, executionWindow: options.executionWindow,
      // Retries of the same exact input keep the same execution order. Each
      // consecutive producer bucket gives a different asset the first chance
      // before the shared capture deadline; result indexes remain unchanged.
      startIndex: Math.floor(fixedInput.clockSec / SAFETY_SCORE_V9_SUPPLY_ATTRIBUTION_REFRESH_INTERVAL_SEC),
      assetTimeoutMs: descriptor => descriptor.assetId === "wm-m0"
        ? SUPPLY_ATTRIBUTION_CAPTURE_BUDGET.wmAssetTimeoutMs
        : SUPPLY_ATTRIBUTION_CAPTURE_BUDGET.assetTimeoutMs,
    },
  );
  for (let index = 0; index < descriptors.length; index++) {
    const result = results[index];
    if (result.status === "completed") {
      Object.assign(attributionById, result.value.attributionById);
      journalRecords.push(...result.value.journalRecords);
    } else {
      failureReasonById[descriptors[index].assetId] = result.reason;
      // Every expected asset still receives an exact attempt outcome. Neither
      // timeout nor exhaustion is an empty inventory or a positive zero.
      await runSupplyAttributionAssetCapture({
        descriptor: descriptors[index], fixedInput, signal, observationClockSec,
        attributionById, journalRecords,
        diagnostics: diagnosticsById[descriptors[index].assetId],
        rejectionCode: result.reason === "observer-failed"
          ? "deployment-state-unavailable"
          : "deployment-observation-window-insufficient",
      });
    }
  }

  return {
    attributionById,
    captureClockSec,
    expectedAssetIds,
    journalRecords,
    diagnosticsById,
    failureReasonById,
  };
}

