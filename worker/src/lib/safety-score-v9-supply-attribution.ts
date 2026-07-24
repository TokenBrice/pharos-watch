import { CHAIN_META } from "@shared/lib/chains";
import { sha256Hex } from "@shared/lib/sha256";
import { stableJsonStringifyV1 } from "@shared/lib/stable-json";
import { ACTIVE_META_BY_ID } from "@shared/lib/stablecoins/registry";
import {
  createSupplyAttributionJournalV1,
  type SupplyAttributionAdmissionCode,
  type SupplyAttributionJournalV1,
} from "@shared/types/safety-score-v9-supply-attribution-journal";
import { rethrowIfAborted, throwIfAborted } from "./abort";
import type { ChainRpcConfig } from "./chain-registry";
import {
  fetchEvmMulticall3Aggregate3AtBlock,
  type EvmMulticall3Result,
} from "./evm-rpc";
import { encodeBalanceOfCallData, TOTAL_SUPPLY_SELECTOR } from "./evm-selectors";
import { normalizeFixedInput, type ReportCardsFixedInput } from "./report-cards-fixed-input";
import { buildReviewedDeploymentRouteInventory } from "./safety-score-v9-supply-attribution-contract";
import {
  observeWmReviewedDeploymentUnitPartitionAttempt,
  type WmReviewedDeploymentObservationAttempt,
  type WmReviewedDeploymentRejectionCode,
} from "./safety-score-v9-wm-supply-observer";

interface LockMintSupplyAttributionConfig {
  canonicalChain: string;
  lockboxAddresses: readonly string[];
  pooledRepresentationLabel: string;
}

const LOCK_MINT_SUPPLY_ATTRIBUTIONS: Readonly<Record<string, LockMintSupplyAttributionConfig>> = {
  "xaut-tether": {
    canonicalChain: "ethereum",
    lockboxAddresses: ["0xb9c2321bb7d0db468f570d10a424d1cc8efd696c"],
    pooledRepresentationLabel: "XAUt0 lock-mint pool",
  },
};

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
  canonicalTotalSupplyRaw: bigint;
  lockboxBalancesRaw: readonly bigint[];
  canonicalChainLabel: string;
  pooledRepresentationLabel: string;
}): LockMintSupplyPartition | null {
  if (!Number.isFinite(input.aggregateSupplyUsd) || input.aggregateSupplyUsd <= 0) return null;
  if (input.canonicalTotalSupplyRaw <= 0n || input.lockboxBalancesRaw.length === 0) return null;

  let lockedRaw = 0n;
  for (const balance of input.lockboxBalancesRaw) {
    if (balance < 0n) return null;
    lockedRaw += balance;
  }
  if (lockedRaw <= 0n || lockedRaw >= input.canonicalTotalSupplyRaw) return null;

  const pooledShareScaled =
    (lockedRaw * LOCK_MINT_SHARE_SCALE + input.canonicalTotalSupplyRaw / 2n) /
    input.canonicalTotalSupplyRaw;
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

function decodeUint256(result: EvmMulticall3Result | undefined): bigint | null {
  if (!result?.success || !/^0x[0-9a-fA-F]{64}$/.test(result.returnData)) return null;
  return BigInt(result.returnData);
}

async function observeLockMintSupplyPartition(
  assetId: string,
  aggregateSupplyUsd: number,
  config: LockMintSupplyAttributionConfig,
  chainRpcs: Map<string, ChainRpcConfig>,
  signal?: AbortSignal,
): Promise<LockMintSupplyPartition | null> {
  const meta = ACTIVE_META_BY_ID.get(assetId);
  const canonicalContract = meta?.contracts?.find((contract) => contract.chain === config.canonicalChain);
  const canonicalChain = CHAIN_META[config.canonicalChain];
  if (!canonicalContract || canonicalChain?.type !== "evm" || !chainRpcs.has(config.canonicalChain)) return null;

  if (!Number.isFinite(aggregateSupplyUsd) || aggregateSupplyUsd <= 0) return null;

  const calls = [
    {
      label: "canonical-total-supply",
      target: canonicalContract.address,
      callData: TOTAL_SUPPLY_SELECTOR,
      allowFailure: false,
    },
    ...config.lockboxAddresses.map((lockboxAddress, index) => ({
      label: `lockbox-balance:${index}`,
      target: canonicalContract.address,
      callData: encodeBalanceOfCallData(lockboxAddress),
      allowFailure: false,
    })),
  ];
  const results = await fetchEvmMulticall3Aggregate3AtBlock(
    config.canonicalChain,
    calls,
    "latest",
    {
      chainRpcs,
      signal,
      timeoutMs: 10_000,
      maxRetries: 1,
    },
  );
  if (!results || results.length !== calls.length) return null;

  const canonicalTotalSupplyRaw = decodeUint256(results[0]);
  const lockboxBalancesRaw = results.slice(1).map(decodeUint256);
  if (canonicalTotalSupplyRaw === null || lockboxBalancesRaw.some((balance) => balance === null)) return null;

  return deriveLockMintSupplyPartition({
    aggregateSupplyUsd,
    canonicalTotalSupplyRaw,
    lockboxBalancesRaw: lockboxBalancesRaw as bigint[],
    canonicalChainLabel: canonicalChain.name,
    pooledRepresentationLabel: config.pooledRepresentationLabel,
  });
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

  if (chainRpcs && chainRpcs.size > 0) {
    for (const [assetId, config] of Object.entries(LOCK_MINT_SUPPLY_ATTRIBUTIONS)) {
      throwIfAborted(signal);
      if (!activeAssetIds.has(assetId)) continue;
      if (hasUpstreamChainSupply(fixedInput, assetId)) continue;
      const existingAggregateSupplyUsd = aggregateSupplyUsd(fixedInput, assetId);

      try {
        const partition = await observeLockMintSupplyPartition(
          assetId,
          existingAggregateSupplyUsd,
          config,
          chainRpcs,
          signal,
        );
        if (!partition) continue;
        attributionById[assetId] = {
          model: "canonical-lock-mint-partition-v1",
          observedAtSec: fixedInput.clockSec,
          currentSupplyUsdByChain: partition.currentSupplyUsdByChain,
        };
      } catch (error) {
        rethrowIfAborted(error, signal);
        console.warn(`[safety-score-v9] Supply attribution failed for ${assetId}`);
      }
    }
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
  if (attribution?.model === "reviewed-deployment-unit-partition-v1") {
    const rows: V9CurrentChainRows = {};
    for (const deployment of attribution.deployments) {
      rows[deployment.chainId] = {
        current: (rows[deployment.chainId]?.current ?? 0) + deployment.currentSupplyUsd,
      };
    }
    return rows;
  }
  return fixedInput.chainCirculatingById[assetId] ?? {};
}

export function safetyScoreV9ChainSupplyObservedAtSec(
  fixedInput: Readonly<ReportCardsFixedInput>,
  assetId: string,
  fallbackObservedAtSec: number,
): number {
  return fixedInput.safetyScoreV9SupplyAttributionById?.[assetId]?.observedAtSec ?? fallbackObservedAtSec;
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
