import { ACTIVE_META_BY_ID } from "@shared/lib/stablecoins";
import { sumPegBuckets } from "@shared/lib/supply";
import { getCache } from "../../lib/db-cache";
import { throwIfAborted } from "../../lib/abort";
import type { PeggedAsset } from "./enrich-prices";
import { parseStablecoinsCachePayload } from "./shared";

const CHAIN_CIRCULATING_KEYS = ["current", "circulatingPrevDay", "circulatingPrevWeek", "circulatingPrevMonth"];
const ADDRESS_OVERRIDES: Record<string, string> = {
  "m-m0": "0x866A2BF4E572CbcF37D5071A7a58503Bfb36be1b",
  "bean-beanstalk": "arbitrum:0xBEA0005B8599265D41256905A9B3073D397812E4",
};

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

function sumPegBucketValues(bucket: unknown): number {
  if (bucket == null || typeof bucket !== "object") return 0;
  return Object.values(bucket as Record<string, unknown>).reduce<number>(
    (sum, value) => sum + (typeof value === "number" && Number.isFinite(value) ? value : 0),
    0,
  );
}

function countFiniteBuckets(buckets: Record<string, number> | undefined): number {
  if (!buckets) return 0;
  return Object.values(buckets).filter((value) => typeof value === "number" && Number.isFinite(value)).length;
}

function countChainEntries(chainCirculating: unknown): number {
  if (!chainCirculating || typeof chainCirculating !== "object") return 0;
  return Object.keys(chainCirculating as Record<string, unknown>).length;
}

function compareCanonicalAssetQuality(left: PeggedAsset, right: PeggedAsset): number {
  const leftVector = [
    sumPegBuckets(left.circulating),
    countChainEntries(left.chainCirculating),
    Array.isArray(left.chains) ? left.chains.length : 0,
    countFiniteBuckets(left.circulatingPrevDay ?? undefined) +
      countFiniteBuckets(left.circulatingPrevWeek ?? undefined) +
      countFiniteBuckets(left.circulatingPrevMonth ?? undefined),
    left.price != null && typeof left.price === "number" && left.price > 0 ? 1 : 0,
    typeof left.priceUpdatedAt === "number" && Number.isFinite(left.priceUpdatedAt) ? left.priceUpdatedAt : 0,
    left.geckoId ? 1 : 0,
    left.cmcSlug ? 1 : 0,
    left.address ? 1 : 0,
  ];
  const rightVector = [
    sumPegBuckets(right.circulating),
    countChainEntries(right.chainCirculating),
    Array.isArray(right.chains) ? right.chains.length : 0,
    countFiniteBuckets(right.circulatingPrevDay ?? undefined) +
      countFiniteBuckets(right.circulatingPrevWeek ?? undefined) +
      countFiniteBuckets(right.circulatingPrevMonth ?? undefined),
    right.price != null && typeof right.price === "number" && right.price > 0 ? 1 : 0,
    typeof right.priceUpdatedAt === "number" && Number.isFinite(right.priceUpdatedAt) ? right.priceUpdatedAt : 0,
    right.geckoId ? 1 : 0,
    right.cmcSlug ? 1 : 0,
    right.address ? 1 : 0,
  ];

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
        entry[key] = sumPegBucketValues(value);
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
    if (!asset.address && ADDRESS_OVERRIDES[asset.id]) {
      asset.address = ADDRESS_OVERRIDES[asset.id];
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
    return Math.floor(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()) / 1000);
  };

  const date1d = utcMidnight(1);
  const date7d = utcMidnight(7);
  const date30d = utcMidnight(30);

  throwIfAborted(signal);
  const historyRows = await db
    .prepare("SELECT stablecoin_id, snapshot_date, circulating_usd FROM supply_history WHERE snapshot_date IN (?, ?, ?)")
    .bind(date1d, date7d, date30d)
    .all<SupplyHistoryRow>();

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
      .map((asset) => [asset.id, asset.price as number]),
  );

  let compared = 0;
  let identical = 0;

  for (const asset of currentAssets) {
    const previousPrice = previousPrices.get(asset.id);
    if (previousPrice == null || asset.price == null || typeof asset.price !== "number" || asset.price <= 0) continue;

    compared++;
    if (Math.abs(asset.price - previousPrice) / previousPrice < 0.0001) {
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
