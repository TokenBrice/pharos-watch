import { CLIENT_CORE_AGGREGATE_ACTIVE_IDS } from "./stablecoins/aggregate-client-registry";
import { getCirculatingRawOrNull } from "./supply";
import { buildSupplyObservationProvenance, classifySupplyCoverage, type SupplyCoverage } from "./supply-provenance";
import type { StablecoinListResponse } from "../types";
import { HOMEPAGE_COHORT_BUCKET_IDS, type HomepageCohortBucketKey } from "./homepage-cohort-config";

export type { HomepageHeroSnapshot } from "../types/homepage";
import type { HomepageHeroSnapshot } from "../types/homepage";

const COHORT_BUCKET_BY_ID = new Map<string, HomepageCohortBucketKey>(
  (Object.entries(HOMEPAGE_COHORT_BUCKET_IDS) as Array<[HomepageCohortBucketKey, readonly string[]]>).flatMap(
    ([bucket, ids]) => ids.map((id) => [id, bucket] as const),
  ),
);

interface HomepageHeroMarketRow {
  id: string;
  pegType: string;
  /** `null` when the source row carries no observed supply; `0` only for an explicit zero. */
  circulatingUsd: number | null;
  /** Chain coverage of the numeric amount; only meaningful when `circulatingUsd` is admitted. */
  supplyCoverage: SupplyCoverage;
}

export function buildHomepageHeroSnapshot(
  rows: readonly HomepageHeroMarketRow[],
  asOfISO: string | null,
): HomepageHeroSnapshot {
  let totalUsd = 0;
  let nonUsdUsd = 0;
  let nonUsdObservedCount = 0;
  let othersUsd = 0;
  let othersObservedCount = 0;
  let supplyUnavailableCount = 0;
  let supplyPartialCount = 0;
  let supplyCoverageUnknownCount = 0;
  const cohortSums: Record<HomepageCohortBucketKey, number> = { usdt: 0, usdc: 0, sky: 0 };
  const observedIds = new Set<string>();
  const presentIds = new Set<string>();
  const incompleteIds = new Set<string>();

  for (const row of rows) {
    if (!CLIENT_CORE_AGGREGATE_ACTIVE_IDS.has(row.id)) {
      continue;
    }
    if (presentIds.has(row.id)) continue;
    presentIds.add(row.id);

    const circulatingUsd = row.circulatingUsd;
    if (circulatingUsd == null || !Number.isFinite(circulatingUsd) || circulatingUsd < 0) {
      supplyUnavailableCount += 1;
      continue;
    }
    observedIds.add(row.id);
    totalUsd += circulatingUsd;
    // Partial and unrecorded amounts stay in the observed subtotal but can never certify completeness.
    if (row.supplyCoverage === "partial") supplyPartialCount += 1;
    else if (row.supplyCoverage === "unknown") supplyCoverageUnknownCount += 1;
    if (row.supplyCoverage !== "complete") incompleteIds.add(row.id);

    if (row.pegType !== "peggedUSD") {
      nonUsdObservedCount += 1;
      nonUsdUsd += circulatingUsd;
    }

    const bucket = COHORT_BUCKET_BY_ID.get(row.id);
    if (bucket) cohortSums[bucket] += circulatingUsd;
    else {
      othersUsd += circulatingUsd;
      othersObservedCount += 1;
    }
  }

  // A cohort is known only when every core-aggregate member reported an observed supply with recorded full
  // chain coverage; an absent, unavailable, partial or unrecorded member leaves the cohort unavailable.
  const cohortValue = (bucket: HomepageCohortBucketKey): number | null =>
    HOMEPAGE_COHORT_BUCKET_IDS[bucket].every((id) =>
      !CLIENT_CORE_AGGREGATE_ACTIVE_IDS.has(id) || (observedIds.has(id) && !incompleteIds.has(id)))
      ? cohortSums[bucket]
      : null;
  const usdt = cohortValue("usdt");
  const usdc = cohortValue("usdc");
  const sky = cohortValue("sky");
  const supplyExpectedCount = CLIENT_CORE_AGGREGATE_ACTIVE_IDS.size;
  const supplyMissingCount = supplyExpectedCount - presentIds.size;
  const knownTotal = observedIds.size > 0 ? totalUsd : null;
  const knownNonUsd = nonUsdObservedCount > 0 ? nonUsdUsd : null;

  return {
    asOfISO,
    totalUsd: knownTotal,
    nonUsdUsd: knownNonUsd,
    nonUsdShare: knownNonUsd !== null && totalUsd > 0 ? nonUsdUsd / totalUsd : null,
    supplyUnavailableCount,
    supplyObservedCount: observedIds.size,
    supplyExpectedCount,
    supplyMissingCount,
    supplyPartialCount,
    supplyCoverageUnknownCount,
    cohort: {
      ts: asOfISO ? Date.parse(asOfISO) : 0,
      usdt,
      usdc,
      sky,
      others: othersObservedCount > 0 ? othersUsd : null,
      nonUsd: knownNonUsd,
      total: knownTotal,
    },
  };
}

export function buildLiveHomepageHeroSnapshot(
  data: StablecoinListResponse,
  updatedAtSeconds?: number,
): HomepageHeroSnapshot {
  const asOfISO = typeof updatedAtSeconds === "number" && Number.isFinite(updatedAtSeconds)
    ? new Date(updatedAtSeconds * 1000).toISOString()
    : null;

  return buildHomepageHeroSnapshot(
    data.peggedAssets.map((asset) => ({
      id: asset.id,
      pegType: asset.pegType,
      circulatingUsd: getCirculatingRawOrNull(asset),
      // The live payload is the admitted current row, so its guard (or absence) is recorded coverage.
      supplyCoverage: classifySupplyCoverage(buildSupplyObservationProvenance(asset)),
    })),
    asOfISO,
  );
}

type SupplyCoverageCounts = Pick<
  HomepageHeroSnapshot,
  "supplyObservedCount" | "supplyExpectedCount" | "supplyPartialCount" | "supplyCoverageUnknownCount"
>;

/** Members observed with recorded full chain coverage; absent counts (old payloads) are never assumed zero. */
function fullyObservedCount(snapshot: SupplyCoverageCounts): number | null {
  if (snapshot.supplyPartialCount == null || snapshot.supplyCoverageUnknownCount == null) return null;
  return Math.max(0, snapshot.supplyObservedCount - snapshot.supplyPartialCount - snapshot.supplyCoverageUnknownCount);
}

/**
 * Every core-aggregate member observed with recorded full chain coverage; the one completeness verdict for
 * the homepage hero and route share cards. A partial-chain remainder or unrecorded coverage is a subtotal.
 */
export function isHomepageSupplyComplete(snapshot: SupplyCoverageCounts): boolean {
  return fullyObservedCount(snapshot) === snapshot.supplyExpectedCount;
}

/** "Partial · 266/267 assets observed" for a known subtotal (fully observed members); `null` when complete. */
export function describeHomepageSupplyCoverage(snapshot: SupplyCoverageCounts): string | null {
  return isHomepageSupplyComplete(snapshot)
    ? null
    : `Partial · ${fullyObservedCount(snapshot) ?? snapshot.supplyObservedCount}/${snapshot.supplyExpectedCount} assets observed`;
}
