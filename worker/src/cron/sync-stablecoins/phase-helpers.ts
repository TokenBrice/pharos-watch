import { ACTIVE_META_BY_ID, TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { sumPegBuckets } from "@shared/lib/supply";
import { runWithOverloadRetry } from "../../lib/cron-lease";
import { getCache } from "../../lib/db-cache";
import { throwIfAborted } from "../../lib/abort";
import { startOfUtcDaySec } from "../../lib/time-constants";
import type { PeggedAsset } from "./enrich-prices";
import { parseStablecoinsCachePayload } from "./shared";
import { TRACKED_ASSET_ADDRESS_OVERRIDES } from "./tracked-asset-overrides";

const CHAIN_CIRCULATING_KEYS = ["current", "circulatingPrevDay", "circulatingPrevWeek", "circulatingPrevMonth"];

export interface StructuralValidationResult {
  validAssets: PeggedAsset[];
  droppedMalformedAssets: number;
}

export interface CanonicalDeduplicationResult {
  dedupedAssets: PeggedAsset[];
  duplicateRows: number;
  affectedIds: string[];
}

export interface PriceStalenessSummary {
  compared: number;
  identical: number;
  stale: boolean;
}

function countFiniteBuckets(buckets: Record<string, number> | undefined): number {
  if (!buckets) return 0;
  return Object.values(buckets).filter((value) => typeof value === "number" && Number.isFinite(value)).length;
}

function countChainEntries(chainCirculating: unknown): number {
  if (!chainCirculating || typeof chainCirculating !== "object") return 0;
  return Object.keys(chainCirculating as Record<string, unknown>).length;
}

function buildQualityVector(asset: PeggedAsset): number[] {
  return [
    sumPegBuckets(asset.circulating),
    countChainEntries(asset.chainCirculating),
    Array.isArray(asset.chains) ? asset.chains.length : 0,
    countFiniteBuckets(asset.circulatingPrevDay ?? undefined) +
      countFiniteBuckets(asset.circulatingPrevWeek ?? undefined) +
      countFiniteBuckets(asset.circulatingPrevMonth ?? undefined),
    asset.price != null && typeof asset.price === "number" && asset.price > 0 ? 1 : 0,
    typeof asset.priceUpdatedAt === "number" && Number.isFinite(asset.priceUpdatedAt) ? asset.priceUpdatedAt : 0,
    asset.geckoId ? 1 : 0,
    asset.cmcSlug ? 1 : 0,
    asset.address ? 1 : 0,
  ];
}

function compareCanonicalAssetQuality(left: PeggedAsset, right: PeggedAsset): number {
  const leftVector = buildQualityVector(left);
  const rightVector = buildQualityVector(right);

  for (let index = 0; index < leftVector.length; index += 1) {
    if (leftVector[index] === rightVector[index]) continue;
    return leftVector[index] - rightVector[index];
  }

  return 0;
}

export function filterStructurallyValidAssets(assets: PeggedAsset[]): StructuralValidationResult {
  const validAssets = assets.filter(
    (asset) => asset.id != null && typeof asset.name === "string" && typeof asset.symbol === "string" && asset.circulating != null,
  );
  return {
    validAssets,
    droppedMalformedAssets: assets.length - validAssets.length,
  };
}

export function normalizeChainCirculating(assets: PeggedAsset[]): void {
  for (const asset of assets) {
    const chainCirculating = asset.chainCirculating as Record<string, Record<string, unknown>> | undefined;
    if (!chainCirculating || typeof chainCirculating !== "object") continue;

    for (const chain of Object.keys(chainCirculating)) {
      const entry = chainCirculating[chain];
      if (!entry || typeof entry !== "object") continue;

      for (const key of CHAIN_CIRCULATING_KEYS) {
        const value = entry[key];
        if (!value || typeof value !== "object") continue;
        entry[key] = sumPegBuckets(value as Record<string, number>);
      }
    }
  }
}

export function applyTrackedAssetOverrides(assets: PeggedAsset[]): void {
  for (const asset of assets) {
    const meta = ACTIVE_META_BY_ID.get(String(asset.id));

    if (meta?.geckoId) {
      asset.geckoId = meta.geckoId;
    }
    if (meta?.cmcSlug) {
      asset.cmcSlug = meta.cmcSlug;
    }
    if (meta?.flags?.navToken) {
      asset.navToken = true;
    }
    if (!asset.address && TRACKED_ASSET_ADDRESS_OVERRIDES[asset.id]) {
      asset.address = TRACKED_ASSET_ADDRESS_OVERRIDES[asset.id];
    }
    // contracts come from curated tracked metadata (covers active + frozen),
    // since ACTIVE_META_BY_ID alone would skip frozen rows injected by mergeFrozenSnapshots.
    const trackedMeta = meta ?? TRACKED_META_BY_ID.get(String(asset.id));
    if (trackedMeta?.contracts && trackedMeta.contracts.length > 0) {
      asset.contracts = trackedMeta.contracts;
    }
  }
}

export function dedupeCanonicalAssets(assets: PeggedAsset[]): CanonicalDeduplicationResult {
  const deduped = new Map<string, PeggedAsset>();
  const affectedIds = new Set<string>();
  let duplicateRows = 0;

  for (const asset of assets) {
    const id = String(asset.id);
    const existing = deduped.get(id);
    if (!existing) {
      deduped.set(id, asset);
      continue;
    }

    duplicateRows += 1;
    affectedIds.add(id);
    if (compareCanonicalAssetQuality(asset, existing) > 0) {
      deduped.set(id, asset);
    }
  }

  return {
    dedupedAssets: [...deduped.values()],
    duplicateRows,
    affectedIds: [...affectedIds],
  };
}

interface SupplyHistoryRow {
  stablecoin_id: string;
  snapshot_date: number;
  circulating_usd: number;
}

export async function fillMissingSupplyHistory(
  db: D1Database,
  assets: PeggedAsset[],
  signal?: AbortSignal,
): Promise<number> {
  throwIfAborted(signal);
  const nowMs = Date.now();
  const utcMidnight = (daysAgo: number): number => {
    const date = new Date(nowMs);
    date.setUTCDate(date.getUTCDate() - daysAgo);
    return startOfUtcDaySec(date);
  };

  const date1d = utcMidnight(1);
  const date7d = utcMidnight(7);
  const date30d = utcMidnight(30);

  throwIfAborted(signal);
  const historyRows = await runWithOverloadRetry(() => db
    .prepare("SELECT stablecoin_id, snapshot_date, circulating_usd FROM supply_history WHERE snapshot_date IN (?, ?, ?)")
    .bind(date1d, date7d, date30d)
    .all<SupplyHistoryRow>(), 3, signal);

  if ((historyRows.results ?? []).length === 0) {
    return 0;
  }

  const historyById = new Map<string, { day?: number; week?: number; month?: number }>();
  for (const row of historyRows.results ?? []) {
    const entry = historyById.get(row.stablecoin_id) ?? {};
    if (row.snapshot_date === date1d) entry.day = row.circulating_usd;
    else if (row.snapshot_date === date7d) entry.week = row.circulating_usd;
    else if (row.snapshot_date === date30d) entry.month = row.circulating_usd;
    historyById.set(row.stablecoin_id, entry);
  }

  let fillCount = 0;
  for (const asset of assets) {
    throwIfAborted(signal);
    const historical = historyById.get(String(asset.id));
    if (!historical) continue;

    const circulating = asset.circulating;
    if (!circulating) continue;

    const pegKey = Object.keys(circulating)[0];
    if (!pegKey) continue;

    const currentValue = circulating[pegKey] ?? 0;
    const isReasonable = (value: number) =>
      currentValue > 0 && Math.abs(value - currentValue) / currentValue <= 0.30;

    if (asset.circulatingPrevDay == null && historical.day != null && isReasonable(historical.day)) {
      asset.circulatingPrevDay = { [pegKey]: historical.day };
      fillCount++;
    }
    if (asset.circulatingPrevWeek == null && historical.week != null && isReasonable(historical.week)) {
      asset.circulatingPrevWeek = { [pegKey]: historical.week };
      fillCount++;
    }
    if (asset.circulatingPrevMonth == null && historical.month != null && isReasonable(historical.month)) {
      asset.circulatingPrevMonth = { [pegKey]: historical.month };
      fillCount++;
    }
  }

  return fillCount;
}

export function computePriceStalenessSummary(
  previousAssets: PeggedAsset[],
  currentAssets: PeggedAsset[],
): PriceStalenessSummary {
  const previousPrices = new Map(
    previousAssets
      .filter((asset) => asset.price != null && typeof asset.price === "number" && asset.price > 0)
      .map((asset) => [asset.id, {
        price: asset.price as number,
        observedAt: asset.priceObservedAt ?? asset.priceUpdatedAt ?? null,
        syncedAt: asset.priceSyncedAt ?? null,
        source: asset.priceSource ?? null,
        confidence: asset.priceConfidence ?? null,
      }]),
  );

  let compared = 0;
  let identical = 0;

  for (const asset of currentAssets) {
    const previous = previousPrices.get(asset.id);
    if (previous == null || asset.price == null || typeof asset.price !== "number" || asset.price <= 0) continue;

    compared++;
    const currentObservedAt = asset.priceObservedAt ?? asset.priceUpdatedAt ?? null;
    const currentSyncedAt = asset.priceSyncedAt ?? null;
    const currentSource = asset.priceSource ?? null;
    const currentConfidence = asset.priceConfidence ?? null;
    const hasNewerObservation =
      (currentObservedAt != null && previous.observedAt != null && currentObservedAt > previous.observedAt) ||
      (currentObservedAt != null && previous.observedAt == null) ||
      (currentSyncedAt != null && previous.syncedAt != null && currentSyncedAt > previous.syncedAt) ||
      (currentSyncedAt != null && previous.syncedAt == null);
    const hasFreshMetadata =
      hasNewerObservation ||
      currentSource !== previous.source ||
      currentConfidence !== previous.confidence;
    if (Math.abs(asset.price - previous.price) / previous.price < 0.0001 && !hasFreshMetadata) {
      identical++;
    }
  }

  return {
    compared,
    identical,
    stale: compared >= 50 && identical / compared > 0.95,
  };
}

export async function detectPriceStaleness(
  db: D1Database,
  currentAssets: PeggedAsset[],
  signal?: AbortSignal,
): Promise<PriceStalenessSummary | null> {
  throwIfAborted(signal);
  const previousCache = await getCache(db, "stablecoins");
  if (!previousCache) return null;

  const previousData = parseStablecoinsCachePayload(previousCache.value);
  if (!previousData) {
    console.warn("[sync-stablecoins] Failed to parse previous stablecoins cache in staleness check");
    return null;
  }

  return computePriceStalenessSummary(previousData.peggedAssets, currentAssets);
}
