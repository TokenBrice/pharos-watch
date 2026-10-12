import {
  BLACKLIST_STATUS_BUCKET_ORDER,
  type BlacklistStatusBucket,
  type BlacklistStatusBucketKey,
} from "../blacklist-status-buckets";

export const FREEZABLE_BLACKLIST_STATUS_BUCKETS: ReadonlySet<BlacklistStatusBucketKey> = new Set<BlacklistStatusBucketKey>([
  "yes",
  "upstream",
  "possible",
]);

/** Display format of the freezable share, shared by the FreezeWatch hero and its share card. */
export function formatShare(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0%";
  if (value > 99 && value < 100) return `${value.toFixed(2)}%`;
  if (value < 0.1) return `${value.toFixed(2)}%`;
  if (value < 1) return `${value.toFixed(1)}%`;
  return `${value.toFixed(0)}%`;
}

/**
 * `complete`: every reviewed asset reported supply. `partial`: some did not; totals and shares
 * cover observed supply only and must be labelled so. `unavailable`: no reviewed asset reported
 * supply, so no supply total or share can be claimed (registry counts remain valid).
 */
export type FreezableSupplyCoverage = "complete" | "partial" | "unavailable";

export interface FreezableSummary {
  ordered: BlacklistStatusBucket[];
  /** Observed supply across every bucket — the known-supply denominator. */
  totalMarketCap: number;
  freezableMarketCap: number;
  /** Registry count of freezable assets; independent of supply availability. */
  freezableCount: number;
  /** Freezable percentage of observed supply; `null` when no positive supply is observed. */
  freezableShare: number | null;
  /** Reviewed assets whose supply is unavailable and therefore excluded from every total. */
  supplyUnavailableCount: number;
  coverage: FreezableSupplyCoverage;
}

/**
 * Derive the freezable-supply headline figures from the status buckets. Shared
 * by the FreezeWatch hero header (which renders the beam + sub-metrics), the
 * meter body below it, the stats band and the FreezeWatch share card, so they
 * stay in lockstep.
 */
export function computeFreezableSummary(buckets: BlacklistStatusBucket[] | null | undefined): FreezableSummary {
  const ordered = BLACKLIST_STATUS_BUCKET_ORDER.map((key) =>
    buckets?.find((bucket) => bucket.key === key),
  ).filter((bucket): bucket is BlacklistStatusBucket => Boolean(bucket));
  const totalMarketCap = ordered.reduce((sum, bucket) => sum + bucket.marketCap, 0);
  const freezableBuckets = ordered.filter((bucket) => FREEZABLE_BLACKLIST_STATUS_BUCKETS.has(bucket.key));
  const freezableMarketCap = freezableBuckets.reduce((sum, bucket) => sum + bucket.marketCap, 0);
  const freezableCount = freezableBuckets.reduce((sum, bucket) => sum + bucket.count, 0);
  const registryCount = ordered.reduce((sum, bucket) => sum + bucket.count, 0);
  const supplyUnavailableCount = ordered.reduce((sum, bucket) => sum + bucket.supplyUnavailableCount, 0);
  const coverage: FreezableSupplyCoverage =
    registryCount - supplyUnavailableCount <= 0 ? "unavailable" : supplyUnavailableCount > 0 ? "partial" : "complete";
  const freezableShare =
    coverage !== "unavailable" && totalMarketCap > 0 ? (freezableMarketCap / totalMarketCap) * 100 : null;
  return { ordered, totalMarketCap, freezableMarketCap, freezableCount, freezableShare, supplyUnavailableCount, coverage };
}

/** Qualifier for totals/shares built from a partial observed-supply denominator. */
export function describeFreezableSupplyCoverage(summary: Pick<FreezableSummary, "coverage" | "supplyUnavailableCount">): string | null {
  if (summary.coverage !== "partial") return null;
  const assets = summary.supplyUnavailableCount === 1 ? "asset" : "assets";
  return `Observed supply only · ${summary.supplyUnavailableCount} ${assets} without supply data excluded`;
}
