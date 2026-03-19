import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins";
import { sumPegBuckets } from "@shared/lib/supply";
import {
  computeCapacityScore,
  computeEffectiveExitScore,
  computeRedemptionBackstopScore,
  REDEMPTION_ACCESS_SCORES,
  REDEMPTION_EXECUTION_SCORES,
  REDEMPTION_OUTPUT_ASSET_SCORES,
  REDEMPTION_SETTLEMENT_SCORES,
} from "@shared/lib/redemption-backstop-scoring";
import {
  getRedemptionBackstopConfig,
  type RedemptionBackstopConfig,
  type RedemptionCapacityModel,
  type RedemptionCostModel,
} from "@shared/lib/redemption-backstops";
import { REDEMPTION_BACKSTOP_VERSION } from "@shared/lib/redemption-backstop-version";
import type { RedemptionBackstopEntry, StablecoinData } from "@shared/types";
import {
  getReserveSyncState,
  LIVE_RESERVE_FRESHNESS_SEC,
} from "./live-reserves-store";

interface CapacityResolution {
  immediateCapacityUsd: number | null;
  immediateCapacityRatio: number | null;
  provider: string;
  sourceMode: RedemptionBackstopEntry["sourceMode"];
  notes: string[];
}

function coerceFiniteNumber(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function resolveDocs(
  stablecoinId: string,
): RedemptionBackstopEntry["docs"] | undefined {
  const meta = TRACKED_META_BY_ID.get(stablecoinId);
  if (!meta) return undefined;

  if (meta.proofOfReserves?.url) {
    return {
      label: meta.proofOfReserves.provider
        ? `${meta.proofOfReserves.provider} feed`
        : "Reserve feed",
      url: meta.proofOfReserves.url,
    };
  }

  const preferredLink = meta.links?.find(
    (link) =>
      link.label === "Docs" ||
      link.label === "Proof of Reserve" ||
      link.label === "Transparency" ||
      link.label === "Website",
  );
  if (!preferredLink) return undefined;

  return {
    label: preferredLink.label,
    url: preferredLink.url,
  };
}

function resolveCostScore(
  costModel: RedemptionCostModel,
): { score: number; feeBps: number | null; feeDescription?: string } {
  if (costModel.kind === "dynamic-or-unclear") {
    return {
      score: 40,
      feeBps: null,
      ...(costModel.feeDescription
        ? { feeDescription: costModel.feeDescription }
        : {}),
    };
  }
  if (costModel.kind === "manual-or-unbounded") {
    return {
      score: 20,
      feeBps: null,
      ...(costModel.feeDescription
        ? { feeDescription: costModel.feeDescription }
        : {}),
    };
  }

  const feeBps = Math.max(0, costModel.feeBps);
  const base = {
    feeBps,
    ...(costModel.feeDescription
      ? { feeDescription: costModel.feeDescription }
      : {}),
  };
  if (feeBps <= 10) return { score: 100, ...base };
  if (feeBps <= 50) return { score: 80, ...base };
  if (feeBps <= 100) return { score: 60, ...base };
  return { score: 40, ...base };
}

async function resolveCapacityFromReserveSyncMetadata(
  db: D1Database,
  stablecoinId: string,
  supplyUsd: number | null,
  fallbackRatio: number | undefined,
  now: number,
): Promise<CapacityResolution> {
  const syncState = await getReserveSyncState(db, stablecoinId);
  const metadata = syncState?.metadata ?? {};
  const immediateCapacityUsd = coerceFiniteNumber(metadata.immediateRedeemableUsd);
  const suppliedRatio = coerceFiniteNumber(metadata.immediateRedeemableRatio);
  const reserveUpdatedAt =
    typeof syncState?.lastSuccessAt === "number" ? syncState.lastSuccessAt : null;
  const isFresh =
    reserveUpdatedAt != null &&
    now - reserveUpdatedAt <= LIVE_RESERVE_FRESHNESS_SEC;

  if (immediateCapacityUsd != null) {
    const derivedRatio =
      suppliedRatio != null
        ? Math.max(0, Math.min(1, suppliedRatio))
        : supplyUsd != null && supplyUsd > 0
          ? Math.max(0, Math.min(1, immediateCapacityUsd / supplyUsd))
          : null;

    return {
      immediateCapacityUsd,
      immediateCapacityRatio: derivedRatio,
      provider: "reserve-sync-metadata",
      sourceMode: isFresh ? "dynamic" : "estimated",
      notes: [
        ...(isFresh ? [] : ["Live reserve metadata stale; using last successful sync"]),
      ],
    };
  }

  if (fallbackRatio != null && supplyUsd != null && supplyUsd > 0) {
    return {
      immediateCapacityUsd: supplyUsd * fallbackRatio,
      immediateCapacityRatio: fallbackRatio,
      provider: "reserve-sync-fallback",
      sourceMode: "estimated",
      notes: ["Live reserve metadata unavailable; using configured fallback ratio"],
    };
  }

  return {
    immediateCapacityUsd: null,
    immediateCapacityRatio: null,
    provider: "reserve-sync-metadata",
    sourceMode: "static",
    notes: ["Live reserve metadata unavailable"],
  };
}

async function resolveCapacity(
  db: D1Database,
  stablecoinId: string,
  model: RedemptionCapacityModel,
  supplyUsd: number | null,
  now: number,
): Promise<CapacityResolution> {
  if (model.kind === "supply-full") {
    return {
      immediateCapacityUsd: supplyUsd,
      immediateCapacityRatio:
        supplyUsd != null && supplyUsd > 0 ? 1 : null,
      provider: "supply-full-model",
      sourceMode: "estimated",
      notes: [],
    };
  }

  if (model.kind === "supply-ratio") {
    return {
      immediateCapacityUsd:
        supplyUsd != null ? supplyUsd * model.ratio : null,
      immediateCapacityRatio: model.ratio,
      provider: "supply-ratio-model",
      sourceMode: "estimated",
      notes: [],
    };
  }

  return resolveCapacityFromReserveSyncMetadata(
    db,
    stablecoinId,
    supplyUsd,
    model.fallbackRatio,
    now,
  );
}

export async function resolveRedemptionBackstopEntry(
  db: D1Database,
  asset: StablecoinData,
  dexLiquidityScore: number | null,
  now = Math.floor(Date.now() / 1000),
): Promise<RedemptionBackstopEntry | null> {
  const config = getRedemptionBackstopConfig(asset.id);
  if (!config) return null;

  return buildRedemptionBackstopEntry(
    db,
    asset.id,
    config,
    sumPegBuckets(asset.circulating),
    dexLiquidityScore,
    now,
  );
}

export async function buildRedemptionBackstopEntry(
  db: D1Database,
  stablecoinId: string,
  config: RedemptionBackstopConfig,
  supplyUsd: number | null,
  dexLiquidityScore: number | null,
  now = Math.floor(Date.now() / 1000),
): Promise<RedemptionBackstopEntry> {
  const capacity = await resolveCapacity(
    db,
    stablecoinId,
    config.capacityModel,
    supplyUsd,
    now,
  );
  const capacityScoring = computeCapacityScore({
    immediateCapacityUsd: capacity.immediateCapacityUsd,
    immediateCapacityRatio: capacity.immediateCapacityRatio,
  });
  const accessScore = REDEMPTION_ACCESS_SCORES[config.accessModel];
  const settlementScore = REDEMPTION_SETTLEMENT_SCORES[config.settlementModel];
  const executionCertaintyScore =
    REDEMPTION_EXECUTION_SCORES[config.executionModel];
  const outputAssetQualityScore =
    REDEMPTION_OUTPUT_ASSET_SCORES[config.outputAssetType];
  const {
    score: costScore,
    feeBps,
    feeDescription,
  } = resolveCostScore(config.costModel);
  const scored = computeRedemptionBackstopScore({
    routeFamily: config.routeFamily,
    accessScore,
    settlementScore,
    executionCertaintyScore,
    capacityScore: capacityScoring.score,
    outputAssetQualityScore,
    costScore,
    totalScoreCap: config.totalScoreCap,
  });

  return {
    stablecoinId,
    score: scored.score,
    effectiveExitScore: computeEffectiveExitScore(
      dexLiquidityScore,
      scored.score,
    ),
    dexLiquidityScore,
    accessScore,
    settlementScore,
    executionCertaintyScore,
    capacityScore: capacityScoring.score,
    outputAssetQualityScore,
    costScore,
    routeFamily: config.routeFamily,
    accessModel: config.accessModel,
    settlementModel: config.settlementModel,
    executionModel: config.executionModel,
    outputAssetType: config.outputAssetType,
    provider: capacity.provider,
    sourceMode: capacity.sourceMode,
    immediateCapacityUsd: capacity.immediateCapacityUsd,
    immediateCapacityRatio: capacity.immediateCapacityRatio,
    feeBps,
    feeDescription,
    queueEnabled:
      config.routeFamily === "queue-redeem" ||
      config.settlementModel === "queued",
    methodologyVersion: REDEMPTION_BACKSTOP_VERSION,
    updatedAt: now,
    ...(resolveDocs(stablecoinId) ? { docs: resolveDocs(stablecoinId) } : {}),
    notes: [...(config.notes ?? []), ...capacity.notes],
    capsApplied: scored.capsApplied,
  };
}
