import { sha256Hex } from "@shared/lib/sha256";
import { stableJsonStringifyV1 } from "@shared/lib/stable-json";
import {
  admissionCodeForSupplyAttributionRejection,
  createSupplyAttributionJournalV1,
  type SupplyAttributionRejectionCode,
  type SupplyAttributionJournalV1,
} from "@shared/lib/safety-score-v9-supply-attribution-journal";
import { rethrowIfAborted } from "./abort";
import type { ChainRpcConfig } from "./chain-registry";
import type { ReportCardsFixedInput } from "./report-cards-fixed-input";
import {
  CENTRIFUGE_BURN_MINT_ASSET_IDS,
  buildReviewedDeploymentRouteInventory,
} from "./safety-score-v9-supply-attribution-contract";
import {
  observeCentrifugeReviewedDeploymentUnitPartitionAttempt,
} from "./safety-score-v9-centrifuge-supply-observer";
import {
  observeWmReviewedDeploymentUnitPartitionAttempt,
} from "./safety-score-v9-wm-supply-observer";
import {
  buildXautRepresentationGroupInventory,
  XAUT_ASSET_ID,
} from "./safety-score-v9-xaut-supply-attribution-contract";
import {
  observeXautRepresentationGroupSupplyAttributionAttempt,
} from "./safety-score-v9-xaut-supply-observer";

const LOCK_MINT_SHARE_SCALE = 10n ** 15n;

export const SAFETY_SCORE_V9_SUPPLY_ATTRIBUTION_ASSET_IDS = Object.freeze([
  "wm-m0",
  XAUT_ASSET_ID,
  ...CENTRIFUGE_BURN_MINT_ASSET_IDS,
]);

export interface LockMintSupplyPartition {
  currentSupplyUsdByChain: Record<string, number>;
  canonicalSupplyUsd: number;
  pooledRepresentationSupplyUsd: number;
}

type V9SupplyAttributionById = ReportCardsFixedInput["safetyScoreV9SupplyAttributionById"];
type V9CurrentChainRows = Record<string, { current: number }>;

export interface SafetyScoreV9SupplyAttributionCapture {
  attributionById: V9SupplyAttributionById;
  captureClockSec: number;
  expectedAssetIds: string[];
  journalRecords: SupplyAttributionJournalV1[];
}

export interface SafetyScoreV9SupplyAttributionCaptureOptions {
  clockMode: "source" | "wall";
  notBeforeSec?: number;
}

function aggregateSupplyUsd(
  fixedInput: Readonly<ReportCardsFixedInput>,
  assetId: string,
): number {
  return Object.values(
    fixedInput.aggregateCirculatingById[assetId]?.circulating ?? {},
  ).reduce((sum, value) => sum + value, 0);
}

function hasUpstreamChainSupply(
  fixedInput: Readonly<ReportCardsFixedInput>,
  assetId: string,
): boolean {
  return Object.values(fixedInput.chainCirculatingById[assetId] ?? {}).some(
    (row) => row.current > 0,
  );
}

export function safetyScoreV9SupplyAttributionExpectedAssetIds(
  fixedInput: Readonly<ReportCardsFixedInput>,
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
    aggregateSupplyUsd: number;
    registryFingerprint: string;
    scoringClockSec: number;
    chainRpcs: Map<string, ChainRpcConfig>;
    signal?: AbortSignal;
  }) => Promise<SupplyAttributionObservationAttempt>;
}

function supplyAttributionAssetDescriptors():
  SupplyAttributionAssetDescriptor[] {
  return [
    {
      assetId: XAUT_ASSET_ID,
      sourceId: "xaut.canonical-lock-mint-group-partition.v2",
      sourceOriginClass: "issuer-disclosure-plus-onchain",
      routeInventoryDigest:
        () => buildXautRepresentationGroupInventory()?.digest ?? null,
      observe: observeXautRepresentationGroupSupplyAttributionAttempt,
    },
    {
      assetId: "wm-m0",
      sourceId: "wm.reviewed-deployment-unit-partition.v1",
      sourceOriginClass: "onchain-observation",
      routeInventoryDigest:
        () => buildReviewedDeploymentRouteInventory("wm-m0")?.digest ?? null,
      observe: observeWmReviewedDeploymentUnitPartitionAttempt,
    },
    ...CENTRIFUGE_BURN_MINT_ASSET_IDS.map(
      (assetId): SupplyAttributionAssetDescriptor => ({
        assetId,
        sourceId: "centrifuge.reviewed-deployment-unit-partition.v1",
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
  ];
}

function buildSupplyAttributionJournalRecord(input: {
  descriptor: SupplyAttributionAssetDescriptor;
  fixedInput: Readonly<ReportCardsFixedInput>;
  attemptId: string;
  attemptedAtSec: number;
  completedAtSec: number;
  scoringClockSec: number;
  outcome: SupplyAttributionObservationAttempt;
}): SupplyAttributionJournalV1 {
  const { descriptor, outcome } = input;
  return createSupplyAttributionJournalV1({
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
  });
}

async function runSupplyAttributionAssetCapture(input: {
  descriptor: SupplyAttributionAssetDescriptor;
  fixedInput: Readonly<ReportCardsFixedInput>;
  chainRpcs?: Map<string, ChainRpcConfig>;
  signal?: AbortSignal;
  observationClockSec: (attemptedAtSec: number) => number;
  attributionById: V9SupplyAttributionById;
  journalRecords: SupplyAttributionJournalV1[];
}): Promise<void> {
  const attemptedAtSec = Math.floor(Date.now() / 1_000);
  const scoringClockSec = input.observationClockSec(attemptedAtSec);
  const attemptId = `supply-attribution:${crypto.randomUUID()}`;
  let outcome: SupplyAttributionObservationAttempt;
  try {
    outcome =
      input.chainRpcs && input.chainRpcs.size > 0
        ? await input.descriptor.observe({
            aggregateSupplyUsd: aggregateSupplyUsd(
              input.fixedInput,
              input.descriptor.assetId,
            ),
            registryFingerprint: input.fixedInput.registryFingerprint,
            scoringClockSec,
            chainRpcs: input.chainRpcs,
            signal: input.signal,
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
  if (outcome.status === "accepted") {
    input.attributionById[input.descriptor.assetId] =
      outcome.attribution;
  }
  input.journalRecords.push(
    buildSupplyAttributionJournalRecord({
      descriptor: input.descriptor,
      fixedInput: input.fixedInput,
      attemptId,
      attemptedAtSec,
      completedAtSec,
      scoringClockSec,
      outcome,
    }),
  );
}

/**
 * Captures V9-only supply attribution without mutating the public stablecoin
 * row or the V8 chain map used by exact replay.
 */
export async function captureSafetyScoreV9SupplyAttribution(
  fixedInput: Readonly<ReportCardsFixedInput>,
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

  for (const descriptor of supplyAttributionAssetDescriptors()) {
    if (!expectedAssetIdSet.has(descriptor.assetId)) continue;
    await runSupplyAttributionAssetCapture({
      descriptor,
      fixedInput,
      chainRpcs,
      signal,
      observationClockSec,
      attributionById,
      journalRecords,
    });
  }

  return {
    attributionById,
    captureClockSec,
    expectedAssetIds,
    journalRecords,
  };
}

export function safetyScoreV9ChainRows(
  fixedInput: Readonly<ReportCardsFixedInput>,
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
  fixedInput: Readonly<ReportCardsFixedInput>,
  assetId: string,
  fallbackObservedAtSec: number,
): number {
  const attribution =
    fixedInput.safetyScoreV9SupplyAttributionById?.[assetId];
  if (!attribution) return fallbackObservedAtSec;
  const aggregateObservedAtSec =
    fixedInput.aggregateCirculatingById[assetId]?.observedAtSec;
  return Math.min(
    attribution.observedAtSec,
    aggregateObservedAtSec ?? fallbackObservedAtSec,
  );
}

export function safetyScoreV9ChainSupplySourcePayload(fixedInput: Readonly<ReportCardsFixedInput>) {
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
  fixedInput: Readonly<ReportCardsFixedInput>,
): string {
  const digest = sha256Hex(
    stableJsonStringifyV1({
      domain: "safety-score-v9.chain-supply.v1",
      payload: safetyScoreV9ChainSupplySourcePayload(fixedInput),
    }),
  );
  return `chain-supply:v1:${digest}`;
}
