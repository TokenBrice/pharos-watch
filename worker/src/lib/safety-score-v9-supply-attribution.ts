import { sha256Hex } from "@shared/lib/sha256";
import { stableJsonStringifyV1 } from "@shared/lib/stable-json";
import {
  createSupplyAttributionJournalV1,
  type SupplyAttributionAdmissionCode,
  type SupplyAttributionJournalV1,
} from "@shared/types/safety-score-v9-supply-attribution-journal";
import { rethrowIfAborted } from "./abort";
import type { ChainRpcConfig } from "./chain-registry";
import { normalizeFixedInput, type ReportCardsFixedInput } from "./report-cards-fixed-input";
import { buildReviewedDeploymentRouteInventory } from "./safety-score-v9-supply-attribution-contract";
import {
  observeWmReviewedDeploymentUnitPartitionAttempt,
  type WmReviewedDeploymentObservationAttempt,
  type WmReviewedDeploymentRejectionCode,
} from "./safety-score-v9-wm-supply-observer";
import {
  buildXautRepresentationGroupInventory,
  XAUT_ASSET_ID,
} from "./safety-score-v9-xaut-supply-attribution-contract";
import {
  observeXautRepresentationGroupSupplyAttributionAttempt,
  type XautSupplyAttributionObservationAttempt,
  type XautSupplyAttributionRejectionCode,
} from "./safety-score-v9-xaut-supply-observer";

const LOCK_MINT_SHARE_SCALE = 10n ** 15n;

export interface LockMintSupplyPartition {
  currentSupplyUsdByChain: Record<string, number>;
  canonicalSupplyUsd: number;
  pooledRepresentationSupplyUsd: number;
}

type V9SupplyAttributionById = ReportCardsFixedInput["safetyScoreV9SupplyAttributionById"];
type V9CurrentChainRows = Record<string, { current: number }>;

export interface SafetyScoreV9SupplyAttributionCapture {
  attributionById: V9SupplyAttributionById;
  journalRecords: SupplyAttributionJournalV1[];
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

function admissionCodeForWmRejection(
  rejectionCode: WmReviewedDeploymentRejectionCode,
): SupplyAttributionAdmissionCode {
  switch (rejectionCode) {
    case "route-inventory-unavailable":
      return "supply-attribution.admission.rejected-route-inventory";
    case "deployment-identity-unavailable":
    case "deployment-identity-mismatch":
      return "supply-attribution.admission.rejected-identity-drift";
    case "deployment-state-invalid":
      return "supply-attribution.admission.rejected-invalid-payload";
    case "safe-block-unavailable":
      return "supply-attribution.admission.rejected-stale";
    case "packet-reconciliation-failed":
      return "supply-attribution.admission.rejected-reconciliation";
    case "chain-rpc-unavailable":
    case "deployment-state-unavailable":
      return "supply-attribution.admission.rejected-upstream";
  }
}

function admissionCodeForXautRejection(
  rejectionCode: XautSupplyAttributionRejectionCode,
): SupplyAttributionAdmissionCode {
  switch (rejectionCode) {
    case "route-inventory-unavailable":
      return "supply-attribution.admission.rejected-route-inventory";
    case "transparency-source-config-unavailable":
      return "supply-attribution.admission.rejected-identity-drift";
    case "transparency-payload-invalid":
      return "supply-attribution.admission.rejected-invalid-payload";
    case "transparency-liability-state-invalid":
      return "supply-attribution.admission.rejected-reconciliation";
    case "transparency-clock-skew":
      return "supply-attribution.admission.rejected-skew";
    case "transparency-stale":
      return "supply-attribution.admission.rejected-stale";
    case "transparency-onchain-mismatch":
      return "supply-attribution.admission.rejected-reconciliation";
    case "transparency-source-unavailable":
      return "supply-attribution.admission.rejected-upstream";
    case "deployment-identity-mismatch":
      return "supply-attribution.admission.rejected-identity-drift";
    case "deployment-state-invalid":
      return "supply-attribution.admission.rejected-invalid-payload";
    case "finalized-block-unavailable":
    case "observation-stale":
      return "supply-attribution.admission.rejected-stale";
    case "packet-reconciliation-failed":
      return "supply-attribution.admission.rejected-reconciliation";
    case "chain-rpc-unavailable":
    case "deployment-state-unavailable":
      return "supply-attribution.admission.rejected-upstream";
  }
}

function buildXautSupplyAttributionJournalRecord(input: {
  fixedInput: Readonly<ReportCardsFixedInput>;
  attemptId: string;
  attemptedAtSec: number;
  completedAtSec: number;
  outcome: XautSupplyAttributionObservationAttempt;
}): SupplyAttributionJournalV1 {
  const inventory = buildXautRepresentationGroupInventory();
  const outcome = input.outcome;
  return createSupplyAttributionJournalV1({
    schemaVersion: 1,
    lane: "supply-attribution",
    assetId: XAUT_ASSET_ID,
    attemptId: input.attemptId,
    sourceId: "xaut.canonical-lock-mint-group-partition.v2",
    sourceOriginClass: "issuer-disclosure-plus-onchain",
    baseInputGenerationId: input.fixedInput.baseInputGenerationId,
    sourceGeneration: input.fixedInput.sourceGeneration,
    registryFingerprint: input.fixedInput.registryFingerprint,
    routeInventoryDigest:
      outcome.status === "accepted"
        ? outcome.attribution.routeInventoryDigest
        : inventory?.digest ?? null,
    attemptCode: "supply-attribution.collector.attempted",
    admissionCode:
      outcome.status === "accepted"
        ? "supply-attribution.admission.accepted"
        : admissionCodeForXautRejection(outcome.rejectionCode),
    fallbackCode:
      outcome.status === "accepted"
        ? "supply-attribution.fallback.not-used"
        : "supply-attribution.fallback.aggregate-only",
    attemptedAtSec: input.attemptedAtSec,
    completedAtSec: input.completedAtSec,
    scoringClockSec: input.fixedInput.clockSec,
    sourceObservedAtSec:
      outcome.status === "accepted"
        ? outcome.attribution.observedAtSec
        : null,
    failedRouteId:
      outcome.status === "rejected" ? outcome.failedRouteId : null,
    contentSha256:
      outcome.status === "accepted"
        ? sha256Hex(stableJsonStringifyV1(outcome.attribution))
        : null,
  });
}

function buildWmSupplyAttributionJournalRecord(input: {
  fixedInput: Readonly<ReportCardsFixedInput>;
  attemptId: string;
  attemptedAtSec: number;
  completedAtSec: number;
  outcome: WmReviewedDeploymentObservationAttempt;
}): SupplyAttributionJournalV1 {
  const inventory = buildReviewedDeploymentRouteInventory("wm-m0");
  const outcome = input.outcome;
  return createSupplyAttributionJournalV1({
    schemaVersion: 1,
    lane: "supply-attribution",
    assetId: "wm-m0",
    attemptId: input.attemptId,
    sourceId: "wm.reviewed-deployment-unit-partition.v1",
    sourceOriginClass: "onchain-observation",
    baseInputGenerationId: input.fixedInput.baseInputGenerationId,
    sourceGeneration: input.fixedInput.sourceGeneration,
    registryFingerprint: input.fixedInput.registryFingerprint,
    routeInventoryDigest:
      outcome.status === "accepted"
        ? outcome.attribution.routeInventoryDigest
        : inventory?.digest ?? null,
    attemptCode: "supply-attribution.collector.attempted",
    admissionCode: outcome.status === "accepted"
      ? "supply-attribution.admission.accepted"
      : admissionCodeForWmRejection(outcome.rejectionCode),
    fallbackCode: outcome.status === "accepted"
      ? "supply-attribution.fallback.not-used"
      : "supply-attribution.fallback.aggregate-only",
    attemptedAtSec: input.attemptedAtSec,
    completedAtSec: input.completedAtSec,
    scoringClockSec: input.fixedInput.clockSec,
    sourceObservedAtSec: outcome.status === "accepted"
      ? outcome.attribution.observedAtSec
      : null,
    failedRouteId:
      outcome.status === "rejected" ? outcome.failedRouteId : null,
    contentSha256: outcome.status === "accepted"
      ? sha256Hex(stableJsonStringifyV1(outcome.attribution))
      : null,
  });
}

/**
 * Captures V9-only supply attribution without mutating the public stablecoin
 * row or the V8 chain map used by exact replay.
 */
export async function captureSafetyScoreV9SupplyAttribution(
  fixedInput: Readonly<ReportCardsFixedInput>,
  chainRpcs?: Map<string, ChainRpcConfig>,
  signal?: AbortSignal,
): Promise<SafetyScoreV9SupplyAttributionCapture> {
  const activeAssetIds = new Set(fixedInput.activeAssetIds);
  const attributionById: V9SupplyAttributionById = {};
  const journalRecords: SupplyAttributionJournalV1[] = [];

  if (activeAssetIds.has(XAUT_ASSET_ID)) {
    const attemptedAtSec = Math.floor(Date.now() / 1_000);
    const attemptId = `supply-attribution:${crypto.randomUUID()}`;
    let outcome: XautSupplyAttributionObservationAttempt;
    try {
      outcome =
        chainRpcs && chainRpcs.size > 0
          ? await observeXautRepresentationGroupSupplyAttributionAttempt({
              aggregateSupplyUsd: aggregateSupplyUsd(
                fixedInput,
                XAUT_ASSET_ID,
              ),
              registryFingerprint: fixedInput.registryFingerprint,
              scoringClockSec: fixedInput.clockSec,
              chainRpcs,
              signal,
            })
          : {
              status: "rejected",
              rejectionCode: "chain-rpc-unavailable",
              failedRouteId: null,
            };
    } catch (error) {
      rethrowIfAborted(error, signal);
      outcome = {
        status: "rejected",
        rejectionCode: "deployment-state-unavailable",
        failedRouteId: null,
      };
    }
    const completedAtSec = Math.max(
      attemptedAtSec,
      Math.floor(Date.now() / 1_000),
    );
    if (outcome.status === "accepted") {
      attributionById[XAUT_ASSET_ID] = outcome.attribution;
    }
    journalRecords.push(
      buildXautSupplyAttributionJournalRecord({
        fixedInput,
        attemptId,
        attemptedAtSec,
        completedAtSec,
        outcome,
      }),
    );
  }

  if (activeAssetIds.has("wm-m0") && !hasUpstreamChainSupply(fixedInput, "wm-m0")) {
    const attemptedAtSec = Math.floor(Date.now() / 1_000);
    const attemptId = `supply-attribution:${crypto.randomUUID()}`;
    let outcome: WmReviewedDeploymentObservationAttempt;
    try {
      outcome =
        chainRpcs && chainRpcs.size > 0
          ? await observeWmReviewedDeploymentUnitPartitionAttempt({
              aggregateSupplyUsd: aggregateSupplyUsd(fixedInput, "wm-m0"),
              registryFingerprint: fixedInput.registryFingerprint,
              scoringClockSec: fixedInput.clockSec,
              chainRpcs,
              signal,
            })
          : {
              status: "rejected",
              rejectionCode: "chain-rpc-unavailable",
              failedRouteId: null,
            };
    } catch (error) {
      rethrowIfAborted(error, signal);
      outcome = {
        status: "rejected",
        rejectionCode: "deployment-state-unavailable",
        failedRouteId: null,
      };
    }
    const completedAtSec = Math.max(
      attemptedAtSec,
      Math.floor(Date.now() / 1_000),
    );
    if (outcome.status === "accepted") {
      attributionById["wm-m0"] = outcome.attribution;
    }
    journalRecords.push(
      buildWmSupplyAttributionJournalRecord({
        fixedInput,
        attemptId,
        attemptedAtSec,
        completedAtSec,
        outcome,
      }),
    );
  }

  return { attributionById, journalRecords };
}

export async function captureSafetyScoreV9SupplyAttributionById(
  fixedInput: Readonly<ReportCardsFixedInput>,
  chainRpcs?: Map<string, ChainRpcConfig>,
  signal?: AbortSignal,
): Promise<V9SupplyAttributionById> {
  return (
    await captureSafetyScoreV9SupplyAttribution(fixedInput, chainRpcs, signal)
  ).attributionById;
}

export async function enrichSafetyScoreV9FixedInputSupplyWithEvidence(
  fixedInput: Readonly<ReportCardsFixedInput>,
  chainRpcs?: Map<string, ChainRpcConfig>,
  signal?: AbortSignal,
): Promise<{
  fixedInput: ReportCardsFixedInput;
  journalRecords: SupplyAttributionJournalV1[];
}> {
  const capture = await captureSafetyScoreV9SupplyAttribution(
    fixedInput,
    chainRpcs,
    signal,
  );
  return {
    fixedInput: normalizeFixedInput({
      ...fixedInput,
      safetyScoreV9SupplyAttributionById: capture.attributionById,
    }),
    journalRecords: capture.journalRecords,
  };
}

export async function enrichSafetyScoreV9FixedInputSupply(
  fixedInput: Readonly<ReportCardsFixedInput>,
  chainRpcs?: Map<string, ChainRpcConfig>,
  signal?: AbortSignal,
): Promise<ReportCardsFixedInput> {
  const capture = await enrichSafetyScoreV9FixedInputSupplyWithEvidence(
    fixedInput,
    chainRpcs,
    signal,
  );
  return capture.fixedInput;
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
