import type { MintBurnClassification, MintBurnHourlyBucket, MintBurnValuationCompleteness } from "@shared/types/mint-burn";
import {
  combineMintBurnValuationCompleteness,
  resolveMintBurnValuationCompleteness,
} from "@shared/lib/mint-burn-valuation";
import { DAY_HOURS, HOUR_SECONDS } from "@/lib/constants";

export interface ChartDatum {
  ts: number;
  /** Positive when net flow is positive (mint dominated bucket), else 0. */
  positiveDelta: number | null;
  /** Negative when net flow is negative (burn dominated bucket), else 0. */
  negativeDelta: number | null;
  /** Raw mint and burn volumes for the tooltip. */
  mint: number | null;
  burn: number | null;
  /** Net flow for this bucket; `null` for a gap or an unavailable (partial-valuation) net. */
  net: number | null;
  /** Running cumulative of net flow; stops at the first bucket whose net is unavailable. */
  cumulative: number | null;
  /** 7-period trailing mean of observed net flow. Drives the reference band. */
  rollingNet: number | null;
  /** Bucket valuation completeness; `null` for an interpolated gap. */
  valuation: MintBurnValuationCompleteness | null;
  mintClassification: MintBurnClassification["completeness"];
  burnClassification: MintBurnClassification["completeness"];
  /** Wire hourly scan coverage for the bucket. */
  scanComplete: boolean;
  /** The bucket covers less than its full period at a published-window edge. */
  periodPartial: boolean;
  isInterpolated: boolean;
}

const DAY_SECONDS = DAY_HOURS * 60 * 60;
const WATERFALL_BUCKET_THRESHOLD_HOURS = 7 * DAY_HOURS;

interface AggregatedBucket {
  ts: number;
  mint: number | null;
  burn: number | null;
  net: number | null;
  valuation: MintBurnValuationCompleteness | null;
  mintClassification: MintBurnClassification["completeness"];
  burnClassification: MintBurnClassification["completeness"];
  scanComplete: boolean;
  periodPartial: boolean;
  isInterpolated: boolean;
}

function aggregateBuckets(
  sorted: MintBurnHourlyBucket[],
  bucketSeconds: number,
  publishedWindow?: { start: number; end: number },
): AggregatedBucket[] {
  if (sorted.length === 0) return [];
  const byBucket = new Map<
    number,
    { hours: number; mint: number; burn: number; net: number | null; valuation: MintBurnValuationCompleteness; scanComplete: boolean; mintClassification: MintBurnClassification["completeness"]; burnClassification: MintBurnValuationCompleteness }
  >();
  for (const b of sorted) {
    const bucketTs = Math.floor(b.hourTs / bucketSeconds) * bucketSeconds;
    const entry = byBucket.get(bucketTs) ?? { hours: 0, mint: 0, burn: 0, net: 0, valuation: "complete", scanComplete: true, mintClassification: "complete", burnClassification: "complete" };
    entry.hours++;
    const valuation = resolveMintBurnValuationCompleteness(b.valuation);
    entry.mint += b.mintVolumeUsd;
    entry.burn += b.burnVolumeUsd;
    // A null or partial hourly net makes the re-bucketed net unavailable, never 0.
    entry.net = entry.net == null || b.netFlowUsd == null || b.scanCoverage?.complete === false || valuation === "partial" || (b.classification != null && b.classification.completeness !== "complete") ? null : entry.net + b.netFlowUsd;
    entry.mintClassification = combineMintBurnValuationCompleteness(entry.mintClassification, b.classification?.mintCompleteness ?? "complete");
    entry.burnClassification = combineMintBurnValuationCompleteness(entry.burnClassification, b.classification?.burnCompleteness ?? "complete");
    entry.valuation = combineMintBurnValuationCompleteness(entry.valuation, valuation);
    entry.scanComplete = entry.scanComplete && b.scanCoverage?.complete !== false;
    byBucket.set(bucketTs, entry);
  }

  const startBucket = Math.floor(sorted[0].hourTs / bucketSeconds) * bucketSeconds;
  const endBucket = Math.floor(sorted[sorted.length - 1].hourTs / bucketSeconds) * bucketSeconds;
  const result: AggregatedBucket[] = [];
  for (let bucketTs = startBucket; bucketTs <= endBucket; bucketTs += bucketSeconds) {
    const entry = byBucket.get(bucketTs);
    // A bucket only partly inside the published window has observed subtotals, not a full period.
    const coveredSeconds = publishedWindow
      ? Math.min(bucketTs + bucketSeconds, publishedWindow.end) - Math.max(bucketTs, publishedWindow.start)
      : bucketSeconds;
    const expectedHours = (Math.min(bucketTs + bucketSeconds, publishedWindow?.end ?? sorted.at(-1)!.hourTs + HOUR_SECONDS)
      - Math.max(bucketTs, publishedWindow?.start ?? sorted[0].hourTs)) / HOUR_SECONDS;
    const missingHours = (entry?.hours ?? 0) < expectedHours;
    result.push({
      ts: bucketTs * 1000,
      mint: entry?.mint ?? null,
      burn: entry?.burn ?? null,
      net: missingHours ? null : entry?.net ?? null,
      valuation: entry?.valuation ?? null,
      mintClassification: entry?.mintClassification ?? "unknown",
      burnClassification: entry?.burnClassification ?? "unknown",
      scanComplete: !missingHours && (entry?.scanComplete ?? false),
      periodPartial: coveredSeconds < bucketSeconds,
      isInterpolated: entry == null,
    });
  }
  return result;
}

export function buildFlowChartModel(
  hourly: MintBurnHourlyBucket[],
  publishedWindow?: { start: number; end: number },
) {
  /**
   * Range probe: needs a separate pass on raw hourly so the threshold check is
   * cheap and predictable. Used to pick the aggregation cadence (hourly vs
   * daily) before we shape the chart data, and as the X-axis tick range.
   */
  const rangeHours = (() => {
    if (hourly.length < 2) return 0;
    let min = hourly[0].hourTs;
    let max = hourly[0].hourTs;
    for (const b of hourly) {
      if (b.hourTs < min) min = b.hourTs;
      if (b.hourTs > max) max = b.hourTs;
    }
    return (max - min) / 3600;
  })();

  const useDailyBuckets = rangeHours > WATERFALL_BUCKET_THRESHOLD_HOURS;
  const bucketSeconds = useDailyBuckets ? DAY_SECONDS : HOUR_SECONDS;

  const chartData: ChartDatum[] = (() => {
    if (hourly.length === 0) return [];
    const sorted = [...hourly].sort((a, b) => a.hourTs - b.hourTs);
    // Only the 30d daily re-bucketing can straddle the published window's edges.
    const buckets = aggregateBuckets(sorted, bucketSeconds, useDailyBuckets ? publishedWindow : undefined);

    // 7-bucket trailing window for rolling-net band. Window scales with cadence
    // so the daily view shows a 7-day band; hourly view shows a 7-hour band.
    const window = 7;
    let cumulative = 0;
    // Once a bucket's net is unavailable the running total is unproven from there on.
    let cumulativeUnavailable = false;
    const result: ChartDatum[] = [];
    for (let i = 0; i < buckets.length; i += 1) {
      const b = buckets[i];
      const hasObservation = b.net != null;
      if (b.net == null) cumulativeUnavailable = true;
      if (b.net != null) cumulative += b.net;
      const start = Math.max(0, i - (window - 1));
      let rolling = 0;
      let rollingCount = 0;
      for (let j = start; j <= i; j += 1) {
        const value = buckets[j].net;
        if (value == null) break;
        rolling += value;
        rollingCount += 1;
      }
      result.push({
        ts: b.ts,
        positiveDelta: b.net == null ? null : b.net > 0 ? b.net : 0,
        negativeDelta: b.net == null ? null : b.net < 0 ? b.net : 0,
        mint: b.mint,
        burn: b.burn,
        net: b.net,
        cumulative: hasObservation && !cumulativeUnavailable ? cumulative : null,
        rollingNet: hasObservation && rollingCount === i - start + 1 ? rolling / rollingCount : null,
        valuation: b.valuation,
        mintClassification: b.mintClassification,
        burnClassification: b.burnClassification,
        scanComplete: b.scanComplete,
        periodPartial: b.periodPartial,
        isInterpolated: b.isInterpolated,
      });
    }
    return result;
  })();

  const hasInterpolated = chartData.some((d) => d.isInterpolated);
  const partialBuckets = chartData.filter((d) => !d.isInterpolated && d.net == null);
  const partialBucketCount = partialBuckets.length;
  // Where the running total stops being proven: the last plotted cumulative
  // point before the first partial bucket. Labelled in the plot, not only below it.
  const firstPartialIndex = chartData.findIndex((d) => d.net == null);
  const lastProven = firstPartialIndex > 0
    ? chartData.slice(0, firstPartialIndex).findLast((d) => d.cumulative != null)
    : undefined;
  const cumulativeStop = lastProven?.cumulative != null ? { ts: lastProven.ts, value: lastProven.cumulative } : null;
  return { rangeHours, useDailyBuckets, bucketSeconds, chartData, hasInterpolated, partialBuckets, partialBucketCount, cumulativeStop };
}
