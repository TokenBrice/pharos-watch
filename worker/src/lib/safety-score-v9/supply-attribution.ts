import { sha256Hex } from "@shared/lib/sha256";
import { stableJsonStringifyV1 } from "@shared/lib/stable-json";
import { getCirculatingRaw } from "@shared/lib/supply";
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
import { REVIEWED_ECONOMIC_SUPPLY_PLANS, buildReviewedEconomicDeploymentInventory, hasCompleteEligibleProviderSupply } from "./supply-attribution-contract";
import { observeReviewedEconomicDeploymentPartitionAttempt, type SupplyAttributionBodyReadObserver } from "./economic-supply-observer";
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
  XAUT_SUPPLY_ATTRIBUTION_MAX_AGE_SEC,
} from "./xaut-supply-attribution-contract";
import {
  observeXautRepresentationGroupSupplyAttributionAttempt,
} from "./xaut-supply-observer";
import {
  SAFETY_SCORE_V9_SUPPLY_ATTRIBUTION_ASSET_IDS,
  type SafetyScoreV9SupplyAttributionInput,
} from "./supply-attribution-source";
import { runBudgetedSupplyAttributionAssets } from "./supply-attribution-capture-budget";

export { SAFETY_SCORE_V9_SUPPLY_ATTRIBUTION_ASSET_IDS } from "./supply-attribution-source";

const LOCK_MINT_SHARE_SCALE = 10n ** 15n;

export interface LockMintSupplyPartition {
  currentSupplyUsdByChain: Record<string, number>;
  canonicalSupplyUsd: number;
  pooledRepresentationSupplyUsd: number;
}

type V9SupplyAttributionById = SafetyScoreV9CompilerInput["safetyScoreV9SupplyAttributionById"];
type V9CurrentChainRows = Record<string, { current: number }>;

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
  onBodyRead?: SupplyAttributionBodyReadObserver;
}

export function aggregateSupplyUsd(
  fixedInput: Readonly<SafetyScoreV9SupplyAttributionInput>,
  assetId: string,
): number {
  return getCirculatingRaw(fixedInput.aggregateCirculatingById[assetId] ?? {});
}

function hasUpstreamChainSupply(
  fixedInput: Readonly<SafetyScoreV9SupplyAttributionInput>,
  assetId: string,
): boolean {
  return REVIEWED_ECONOMIC_SUPPLY_PLANS.has(assetId)
    ? hasCompleteEligibleProviderSupply(fixedInput, assetId)
    : Object.values(fixedInput.chainCirculatingById[assetId] ?? {}).some(row => row.current > 0);
}

export function safetyScoreV9SupplyAttributionExpectedAssetIds(
  fixedInput: Readonly<SafetyScoreV9SupplyAttributionInput>,
): string[] {
  const activeAssetIds = new Set(fixedInput.activeAssetIds);
  return SAFETY_SCORE_V9_SUPPLY_ATTRIBUTION_ASSET_IDS.filter(
    (assetId) =>
      activeAssetIds.has(assetId) &&
      (assetId === XAUT_ASSET_ID ||
        !hasUpstreamChainSupply(fixedInput, assetId)),
  );
}

/**
 * Partitions an existing aggregate liability by the observed canonical
 * lockbox share. Locked backing and its wrapped holder claims are counted once.
 */
export function deriveLockMintSupplyPartition(input: {
  aggregateSupplyUsd: number;
  canonicalCirculatingLiabilityRaw: bigint;
  lockboxBalancesRaw: readonly bigint[];
  canonicalChainLabel: string;
  pooledRepresentationLabel: string;
}): LockMintSupplyPartition | null {
  if (!Number.isFinite(input.aggregateSupplyUsd) || input.aggregateSupplyUsd <= 0) return null;
  if (input.canonicalCirculatingLiabilityRaw <= 0n || input.lockboxBalancesRaw.length === 0) return null;

  let lockedRaw = 0n;
  for (const balance of input.lockboxBalancesRaw) {
    if (balance < 0n) return null;
    lockedRaw += balance;
  }
  if (lockedRaw <= 0n || lockedRaw >= input.canonicalCirculatingLiabilityRaw) return null;

  const pooledShareScaled =
    (lockedRaw * LOCK_MINT_SHARE_SCALE + input.canonicalCirculatingLiabilityRaw / 2n) /
    input.canonicalCirculatingLiabilityRaw;
  const pooledShare = Number(pooledShareScaled) / Number(LOCK_MINT_SHARE_SCALE);
  if (!Number.isFinite(pooledShare) || pooledShare <= 0 || pooledShare >= 1) return null;

  const pooledRepresentationSupplyUsd = input.aggregateSupplyUsd * pooledShare;
  const canonicalSupplyUsd = input.aggregateSupplyUsd - pooledRepresentationSupplyUsd;
  if (
    !Number.isFinite(canonicalSupplyUsd) ||
    canonicalSupplyUsd <= 0 ||
    !Number.isFinite(pooledRepresentationSupplyUsd) ||
    pooledRepresentationSupplyUsd <= 0
  ) {
    return null;
  }

  return {
    currentSupplyUsdByChain: {
      [input.canonicalChainLabel]: canonicalSupplyUsd,
      [input.pooledRepresentationLabel]: pooledRepresentationSupplyUsd,
    },
    canonicalSupplyUsd,
    pooledRepresentationSupplyUsd,
  };
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
    onBodyRead?: SupplyAttributionBodyReadObserver;
  }) => Promise<SupplyAttributionObservationAttempt>;
}

/**
 * Single owner of the asset → journal sourceId binding; the descriptor table
 * and the generation-side binding assertions resolve through it.
 */
export const SAFETY_SCORE_V9_SUPPLY_ATTRIBUTION_SOURCE_ID_BY_ASSET: Readonly<
  Record<string, SupplyAttributionJournalV1["sourceId"]>
> = {
  [XAUT_ASSET_ID]: "xaut.canonical-lock-mint-group-partition.v2",
  ...Object.fromEntries([...REVIEWED_ECONOMIC_SUPPLY_PLANS.keys()].map(assetId => [
    assetId, V9_CANDIDATE_POLICY_V1.policy.semantic.supplyAttribution.journalSourceId,
  ])),
  "wm-m0": "wm.reviewed-deployment-unit-partition.v1",
  ...Object.fromEntries(
    CENTRIFUGE_BURN_MINT_ASSET_IDS.map(
      (assetId): [string, SupplyAttributionJournalV1["sourceId"]] => [
        assetId,
        "centrifuge.reviewed-deployment-unit-partition.v1",
      ],
    ),
  ),
};

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
  const diagnostic = input.diagnostics?.findLast(row => row.hardEvidenceFailure && row.failurePredicate) ??
    input.diagnostics?.findLast(row => row.failurePredicate !== null);
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
  onBodyRead?: SupplyAttributionBodyReadObserver;
  diagnostics?: SupplyAttributionAttemptDiagnostic[];
}): Promise<void> {
  const attemptedAtSec = Math.floor(Date.now() / 1_000);
  const scoringClockSec = input.observationClockSec(attemptedAtSec);
  // Lane/source are already explicit; keep the same UUID entropy without a
  // redundant prefix consuming the bounded journal's diagnostic headroom.
  const attemptId = crypto.randomUUID();
  let outcome: SupplyAttributionObservationAttempt;
  try {
    outcome =
      input.rejectionCode
        ? { status: "rejected", rejectionCode: input.rejectionCode, failedRouteId: null }
        : input.chainRpcs && input.chainRpcs.size > 0
        ? await input.descriptor.observe({
            fixedInput: input.fixedInput,
            aggregateSupplyUsd: aggregateSupplyUsd(
              input.fixedInput,
              input.descriptor.assetId,
            ),
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
      let index = rows.findLastIndex(row => !row.hardEvidenceFailure &&
        !(row.persisted && row.authenticatedCursorAdvanced && row.incompleteBootstrap));
      if (index < 0 && (validated.hardEvidenceFailure ||
        (validated.persisted && validated.authenticatedCursorAdvanced && validated.incompleteBootstrap))) {
        index = rows.findLastIndex(row => !row.hardEvidenceFailure);
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

export function safetyScoreV9ChainRows(
  fixedInput: Readonly<SafetyScoreV9CompilerInput>,
  assetId: string,
): V9CurrentChainRows {
  const attribution = fixedInput.safetyScoreV9SupplyAttributionById?.[assetId];
  if (attribution?.model === "canonical-lock-mint-partition-v1") {
    return Object.fromEntries(
      Object.entries(attribution.currentSupplyUsdByChain).map(([chain, current]) => [chain, { current }]),
    );
  }
  if (attribution?.model === "canonical-lock-mint-group-partition-v2") {
    return {
      [attribution.canonical.chainId]: {
        current: attribution.canonical.currentSupplyUsd,
      },
      [attribution.representationGroup.deploymentRouteKey]: {
        current: attribution.representationGroup.currentSupplyUsd,
      },
    };
  }
  if (attribution?.model === "reviewed-economic-deployment-partition-v1") {
    const rows: V9CurrentChainRows = {};
    for (const deployment of attribution.deployments) {
      rows[deployment.chainId] = { current: (rows[deployment.chainId]?.current ?? 0) + deployment.currentSupplyUsd };
    }
    if (attribution.unattributedSupplyUsd > 0) rows[`unmatched-economic:${assetId}`] = { current: attribution.unattributedSupplyUsd };
    return rows;
  }
  if (attribution?.model === "reviewed-deployment-unit-partition-v1") {
    const rows: V9CurrentChainRows = {};
    for (const deployment of attribution.deployments) {
      rows[deployment.chainId] = {
        current: (rows[deployment.chainId]?.current ?? 0) + deployment.currentSupplyUsd,
      };
    }
    return rows;
  }
  if (assetId === XAUT_ASSET_ID) return {};
  return fixedInput.chainCirculatingById[assetId] ?? {};
}

export function safetyScoreV9ChainSupplyObservedAtSec(
  fixedInput: Readonly<SafetyScoreV9CompilerInput>,
  assetId: string,
  fallbackObservedAtSec: number,
): number {
  const attribution =
    fixedInput.safetyScoreV9SupplyAttributionById?.[assetId];
  const aggregateObservedAtSec =
    fixedInput.aggregateCirculatingById[assetId]?.observedAtSec;
  if (!attribution) return aggregateObservedAtSec ?? fallbackObservedAtSec;
  return Math.min(
    attribution.observedAtSec,
    aggregateObservedAtSec ?? fallbackObservedAtSec,
  );
}

export function safetyScoreV9ChainSupplyMaxAgeSec(
  fixedInput: Readonly<SafetyScoreV9CompilerInput>,
  assetId: string,
  fallbackMaxAgeSec: number | null,
): number | null {
  const attribution =
    fixedInput.safetyScoreV9SupplyAttributionById?.[assetId];
  // XAUT's finalized Ethereum observation has an explicit one-hour window.
  // Preserve that same bound when the accepted packet becomes fact evidence;
  // otherwise the generic chain-supply window would immediately contradict
  // the per-asset admission contract.
  if (attribution?.model === "reviewed-economic-deployment-partition-v1") {
    return V9_CANDIDATE_POLICY_V1.policy.semantic.supplyAttribution.observationMaxAgeSec;
  }
  return assetId === XAUT_ASSET_ID &&
    attribution?.model === "canonical-lock-mint-group-partition-v2"
    ? XAUT_SUPPLY_ATTRIBUTION_MAX_AGE_SEC
    : fallbackMaxAgeSec;
}

export function safetyScoreV9ChainSupplySourcePayload(fixedInput: Readonly<SafetyScoreV9CompilerInput>) {
  const attributionById = fixedInput.safetyScoreV9SupplyAttributionById ?? {};
  return {
    chainCirculatingById: fixedInput.chainCirculatingById,
    ...(Object.keys(attributionById).length > 0
      ? { safetyScoreV9SupplyAttributionById: attributionById }
      : {}),
    dexDeploymentSupplyCoverageById: fixedInput.dexDeploymentSupplyCoverageById,
  };
}

export function safetyScoreV9ChainSupplySourceGenerationId(
  fixedInput: Readonly<SafetyScoreV9CompilerInput>,
): string {
  const digest = sha256Hex(
    stableJsonStringifyV1({
      domain: "safety-score-v9.chain-supply.v1",
      payload: safetyScoreV9ChainSupplySourcePayload(fixedInput),
    }),
  );
  return `chain-supply:v1:${digest}`;
}
