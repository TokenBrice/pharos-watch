import { MIN_PEER_MEDIAN_CONTRIBUTORS } from "./peg-reference-trust";
import { bucketTimestampToUtcDay, findAsOfSnapshot, type TimestampedRatePoint } from "./rate-series";
import { median } from "./stats";
import type { StablecoinData } from "../types/supply";

export type CommodityPeg = "GOLD" | "SILVER";

export type CommodityQuoteUnit = {
  assetId?: string;
  commodityEntitlement?: StablecoinData["commodityEntitlement"];
  quoteObservedAtSec?: number | null;
};

/** Matrixdock adjusts the represented weight daily. Replay must not borrow a later block. */
export function getCommodityOuncesAtQuote(staticOunces: number | undefined, unit?: CommodityQuoteUnit): number | null {
  if (unit?.assetId !== "xagm-matrixdock") return staticOunces ?? 1;
  const entitlement = unit.commodityEntitlement;
  const quoteAt = unit.quoteObservedAtSec;
  if (!entitlement || quoteAt == null || !Number.isSafeInteger(quoteAt) || quoteAt <= 0
    || !Number.isSafeInteger(entitlement.observedAtSec) || entitlement.observedAtSec <= 0
    || entitlement.source !== "matrixdock-frs" || typeof entitlement.generation !== "string"
    || !/^ethereum:[1-9]\d*$/.test(entitlement.generation)
    || entitlement.quoteObservedAtSec !== quoteAt
    || entitlement.observedAtSec > quoteAt
    || bucketTimestampToUtcDay(entitlement.observedAtSec) !== bucketTimestampToUtcDay(quoteAt)
    || !Number.isFinite(entitlement.ozPerToken) || entitlement.ozPerToken <= 0) return null;
  return entitlement.ozPerToken;
}

export interface CommodityMedianSource {
  assetId: string;
  sourceId: string;
  commodityOunces?: number;
  prices: readonly CommodityPricePoint[];
}

export function findCommodityPeerMedian(
  sources: readonly CommodityMedianSource[],
  subjectId: string,
  atSec: number,
  maxAgeSec: number,
) {
  const peers = new Map<string, { rate: number; timestamp: number; assetId: string }>();
  const seenAssets = new Set<string>();
  const subjectSource = sources.find((source) => source.assetId === subjectId)?.sourceId;
  for (const source of sources) {
    if (!source.sourceId.trim() || source.assetId === subjectId || source.sourceId === subjectSource || peers.has(source.sourceId)
      || seenAssets.has(source.assetId) || (source.assetId !== "xagm-matrixdock" && source.commodityOunces == null)) continue;
    const point = findAsOfSnapshot(source.prices, atSec, (entry) => entry.timestamp, maxAgeSec);
    if (!point || !Number.isSafeInteger(point.timestamp) || point.timestamp <= 0) continue;
    const ounces = getCommodityOuncesAtQuote(source.commodityOunces, {
      assetId: source.assetId, commodityEntitlement: point.commodityEntitlement, quoteObservedAtSec: point.timestamp,
    });
    if (ounces == null || !Number.isFinite(ounces) || ounces <= 0) continue;
    const rate = point.price / ounces;
    if (!Number.isFinite(rate) || rate <= 0) continue;
    peers.set(source.sourceId, { rate, timestamp: point.timestamp, assetId: source.assetId });
    seenAssets.add(source.assetId);
  }
  if (peers.size < MIN_PEER_MEDIAN_CONTRIBUTORS) return null;
  const observations = [...peers.values()];
  return {
    usdPerUnit: median(observations.map((peer) => peer.rate))!,
    observedAtSec: Math.min(...observations.map((peer) => peer.timestamp)),
    contributors: observations.map((peer) => peer.assetId),
    contributorEvidence: [...peers].map(([provenanceKey, peer]) => ({
      assetId: peer.assetId, observedAtSec: peer.timestamp, provenanceKey, derivation: "spot-derived" as const,
    })),
  };
}

export interface CommodityPricePoint {
  timestamp: number;
  price: number;
  commodityEntitlement?: StablecoinData["commodityEntitlement"];
}

export interface DailyCommodityMedianSource {
  assetId?: string;
  peg: CommodityPeg;
  commodityOunces?: number | null;
  prices: readonly CommodityPricePoint[];
  excludeFromMedian?: boolean;
}

/** Descriptive daily aggregates. Historical admission uses findCommodityPeerMedian. */
export function buildCommodityPeerMedianSeries(
  sources: readonly DailyCommodityMedianSource[],
): Record<CommodityPeg, TimestampedRatePoint[]> {
  const coinDailies: Record<CommodityPeg, Map<number, number>[]> = {
    GOLD: [],
    SILVER: [],
  };

  for (const source of sources) {
    if (source.excludeFromMedian || source.prices.length === 0) continue;

    const dayBuckets = new Map<number, { sum: number; count: number }>();
    for (const point of source.prices) {
      const ounces = getCommodityOuncesAtQuote(source.commodityOunces ?? undefined, {
        assetId: source.assetId, commodityEntitlement: point.commodityEntitlement, quoteObservedAtSec: point.timestamp,
      });
      if (ounces == null || ounces <= 0 || !Number.isFinite(ounces)) continue;
      const perOunce = point.price / ounces;
      const day = bucketTimestampToUtcDay(point.timestamp);
      const bucket = dayBuckets.get(day) ?? { sum: 0, count: 0 };
      bucket.sum += perOunce;
      bucket.count += 1;
      dayBuckets.set(day, bucket);
    }

    const dailyMean = new Map<number, number>();
    for (const [day, bucket] of dayBuckets) {
      dailyMean.set(day, bucket.sum / bucket.count);
    }
    coinDailies[source.peg].push(dailyMean);
  }

  return {
    GOLD: buildCrossCoinMedianSeries(coinDailies.GOLD),
    SILVER: buildCrossCoinMedianSeries(coinDailies.SILVER),
  };
}

function buildCrossCoinMedianSeries(
  coinDailies: readonly Map<number, number>[],
): TimestampedRatePoint[] {
  if (coinDailies.length === 0) return [];

  const allDays = new Set<number>();
  for (const dailySeries of coinDailies) {
    for (const day of dailySeries.keys()) {
      allDays.add(day);
    }
  }

  const series: TimestampedRatePoint[] = [];
  for (const day of allDays) {
    const values: number[] = [];
    for (const dailySeries of coinDailies) {
      const value = dailySeries.get(day);
      if (value !== undefined) values.push(value);
    }
    if (values.length === 0) continue;

    const medianValue = median(values);
    if (medianValue == null) continue;
    series.push({ timestamp: day, rate: medianValue });
  }

  series.sort((a, b) => a.timestamp - b.timestamp);
  return series;
}
