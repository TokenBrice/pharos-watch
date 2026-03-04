import { TRACKED_META_BY_ID } from "../../../../src/lib/stablecoins";
import { getCache } from "../../lib/db";
import type { PeggedAsset } from "../enrich-prices";

const CHAIN_CIRCULATING_KEYS = ["current", "circulatingPrevDay", "circulatingPrevWeek", "circulatingPrevMonth"];
const ADDRESS_OVERRIDES: Record<string, string> = {
  "213": "0x866A2BF4E572CbcF37D5071A7a58503Bfb36be1b", // M by M0 — no address in DL stablecoins API
  "67": "arbitrum:0xBEA0005B8599265D41256905A9B3073D397812E4", // BEAN — no address in DL stablecoins API
};

export interface StructuralValidationResult {
  validAssets: PeggedAsset[];
  droppedMalformedAssets: number;
}

/** Keep only assets with required structural fields before deeper enrichment/validation stages. */
export function filterStructurallyValidAssets(assets: PeggedAsset[]): StructuralValidationResult {
  const validAssets = assets.filter(
    (asset) => asset.id != null && typeof asset.name === "string" && typeof asset.symbol === "string" && asset.circulating != null,
  );
  return {
    validAssets,
    droppedMalformedAssets: assets.length - validAssets.length,
  };
}

/** Flatten DefiLlama chainCirculating peg-bucket objects into plain numeric values. */
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

        entry[key] = Object.values(value as Record<string, number>).reduce(
          (sum: number, raw: number) => sum + (Number.isFinite(raw) ? raw : 0),
          0,
        );
      }
    }
  }
}

/** Apply curated metadata overrides so downstream enrichment uses canonical IDs and missing address patches. */
export function applyTrackedAssetOverrides(assets: PeggedAsset[]): void {
  for (const asset of assets) {
    const meta = TRACKED_META_BY_ID.get(String(asset.id));

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

interface SupplyHistoryRow {
  stablecoin_id: string;
  snapshot_date: number;
  circulating_usd: number;
}

/** Fill missing circulatingPrev* fields from daily supply_history snapshots when values are plausibly close to current supply. */
export async function fillMissingSupplyHistory(
  db: D1Database,
  assets: PeggedAsset[],
): Promise<number> {
  const nowMs = Date.now();
  const utcMidnight = (daysAgo: number): number => {
    const date = new Date(nowMs);
    date.setUTCDate(date.getUTCDate() - daysAgo);
    return Math.floor(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()) / 1000);
  };

  const date1d = utcMidnight(1);
  const date7d = utcMidnight(7);
  const date30d = utcMidnight(30);

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
    const historical = historyById.get(String(asset.id));
    if (!historical) continue;

    const circulating = asset.circulating as Record<string, number> | undefined;
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

export interface PriceStalenessSummary {
  compared: number;
  identical: number;
  stale: boolean;
}

/** Compare current prices vs previous cache snapshot and detect likely upstream staleness. */
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

  const stale = compared >= 50 && identical / compared > 0.95;
  return { compared, identical, stale };
}

/** Load previous stablecoins cache and compute staleness summary against current assets. */
export async function detectPriceStaleness(
  db: D1Database,
  currentAssets: PeggedAsset[],
): Promise<PriceStalenessSummary | null> {
  const previousCache = await getCache(db, "stablecoins");
  if (!previousCache) return null;

  const previousData = JSON.parse(previousCache.value) as { peggedAssets?: PeggedAsset[] };
  if (!previousData.peggedAssets) return null;

  return computePriceStalenessSummary(previousData.peggedAssets, currentAssets);
}
