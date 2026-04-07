import { bucketTimestampToUtcDay, type TimestampedRatePoint } from "./rate-series";

export type CommodityPeg = "GOLD" | "SILVER";

export interface CommodityPricePoint {
  timestamp: number;
  price: number;
}

export interface CommodityMedianSource {
  peg: CommodityPeg;
  commodityOunces?: number | null;
  prices: readonly CommodityPricePoint[];
  excludeFromMedian?: boolean;
}

export function buildCommodityPeerMedianSeries(
  sources: readonly CommodityMedianSource[],
): Record<CommodityPeg, TimestampedRatePoint[]> {
  const coinDailies: Record<CommodityPeg, Map<number, number>[]> = {
    GOLD: [],
    SILVER: [],
  };

  for (const source of sources) {
    if (source.excludeFromMedian || source.prices.length === 0) continue;

    const dayBuckets = new Map<number, { sum: number; count: number }>();
    for (const point of source.prices) {
      const perOunce =
        source.commodityOunces != null && source.commodityOunces > 0
          ? point.price / source.commodityOunces
          : point.price;
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

    values.sort((a, b) => a - b);
    const mid = Math.floor(values.length / 2);
    const median =
      values.length % 2 === 0
        ? (values[mid - 1] + values[mid]) / 2
        : values[mid];
    series.push({ timestamp: day, rate: median });
  }

  series.sort((a, b) => a.timestamp - b.timestamp);
  return series;
}
