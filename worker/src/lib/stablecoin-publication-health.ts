import { ACTIVE_IDS } from "@shared/lib/stablecoins/registry";
import { isRecord } from "@shared/lib/type-guards";
import { ActivePriceCoverageHealthSchema } from "@shared/types/status/core";
import type {
  ActivePriceCoverageGap,
  ActivePriceCoverageHealth,
  StablecoinPublicationHealth,
} from "@shared/types/status";
import { tryParseJson } from "./json-parse";
import {
  parseMissingActivePriceDetailsById,
  resolveStablecoinPriceGapReviews,
  resolveStablecoinMarketHours,
} from "./stablecoin-publication-coverage";

export function unknownStablecoinPublicationHealth(
  observedAt: number | null = null,
): StablecoinPublicationHealth {
  return {
    status: "unknown",
    expectedActiveCount: ACTIVE_IDS.size,
    presentActiveCount: 0,
    waivedActiveCount: 0,
    missingActiveIds: [],
    waivedActiveIds: [],
    expiredWaiverIds: [],
    observedAt,
  };
}

export function unknownActivePriceCoverageHealth(
  observedAt: number | null = null,
  unavailableReason: ActivePriceCoverageHealth["unavailableReason"] = "coverage-missing",
): ActivePriceCoverageHealth {
  return {
    status: "unknown",
    unavailableReason,
    expectedActiveCount: null,
    presentActiveCount: null,
    pricedActiveCount: null,
    missingPriceCount: null,
    nominalReferenceCount: null,
    nominalReferenceMarketCapUsd: null,
    nominalReferenceIds: [],
    nominalReferenceReason: "reviewed-nominal-reference",
    pricedActiveIds: [],
    missingActiveIds: [],
    affectedMarketCapUsd: null,
    missingActiveAssets: [],
    alertEligibleCount: null,
    alertEligibleIds: [],
    scheduledClosureGapIds: [],
    acknowledgedGapIds: [],
    acknowledgedGapCount: null,
    expiredMarketHoursCalendarIds: [],
    invalidMarketHoursCalendarIds: [],
    expiredGapReviewIds: [],
    invalidGapReviewIds: [],
    maxConsecutiveMissingGenerations: null,
    observedAt,
  };
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}



function parseStablecoinPublicationHealth(
  metadataJson: string,
  observedAt: number,
): StablecoinPublicationHealth {
  const metadata = tryParseJson(metadataJson);
  const coverage = isRecord(metadata) && isRecord(metadata.activePublicationCoverage)
    ? metadata.activePublicationCoverage
    : null;
  if (!coverage) return unknownStablecoinPublicationHealth(observedAt);
  const expectedActiveCount = typeof coverage.expectedActiveCount === "number"
    ? coverage.expectedActiveCount
    : 0;
  const presentActiveCount = typeof coverage.presentActiveCount === "number"
    ? coverage.presentActiveCount
    : 0;
  const waivedActiveCount = typeof coverage.waivedActiveCount === "number"
    ? coverage.waivedActiveCount
    : 0;
  const missingActiveIds = stringArray(coverage.missingActiveIds);
  const complete = coverage.complete === true
    && expectedActiveCount === ACTIVE_IDS.size
    && presentActiveCount + waivedActiveCount === expectedActiveCount
    && missingActiveIds.length === 0;
  return {
    status: complete ? "complete" : "incomplete",
    expectedActiveCount,
    presentActiveCount,
    waivedActiveCount,
    missingActiveIds,
    waivedActiveIds: stringArray(coverage.waivedActiveIds),
    expiredWaiverIds: stringArray(coverage.expiredWaiverIds),
    observedAt,
  };
}

function parseActivePriceCoverageHealth(
  metadataJson: string,
  observedAt: number,
  nowSec: number,
): ActivePriceCoverageHealth {
  const metadata = tryParseJson(metadataJson);
  const coverage = isRecord(metadata) && isRecord(metadata.activePriceCoverage)
    ? metadata.activePriceCoverage
    : null;
  if (!coverage) return unknownActivePriceCoverageHealth(observedAt, "coverage-malformed");

  const parsed = ActivePriceCoverageHealthSchema.safeParse({
    ...coverage,
    status: coverage.complete === true ? "complete" : "incomplete",
    observedAt,
  });
  if (!parsed.success) return unknownActivePriceCoverageHealth(observedAt, "coverage-malformed");
  const {
    expectedActiveCount, presentActiveCount, pricedActiveCount,
    pricedActiveIds, missingActiveIds, missingPriceCount,
  } = parsed.data;
  const nominalReferenceIds = parsed.data.nominalReferenceIds ?? [];
  const nominalReferenceCount = parsed.data.nominalReferenceCount ?? 0;
  const accountedIds = [...pricedActiveIds, ...nominalReferenceIds];
  const reviews = resolveStablecoinPriceGapReviews([...ACTIVE_IDS], nowSec);
  const marketHours = resolveStablecoinMarketHours([...ACTIVE_IDS], nowSec);
  const parseOptions = { nowSec, reviewsById: reviews.activeById };
  const missingDetailsById = parseMissingActivePriceDetailsById(coverage, parseOptions);
  const missingActiveAssets = (missingActiveIds.length > 0
    ? missingActiveIds
    : [...missingDetailsById.keys()])
    .map((stablecoinId) => missingDetailsById.get(stablecoinId))
    .filter((entry): entry is ActivePriceCoverageGap => entry != null);
  const derivedAlertEligibleIds = missingActiveAssets
    .filter((entry) => entry.alertEligible)
    .map((entry) => entry.stablecoinId);
  // Recompute from registry truth even for metadata written before a review
  // was added, renewed, removed, or expired. Compact streaks keep re-alerting
  // after expiry even when the producer persisted an empty eligible-ID list.
  const scheduledClosureGapIds = missingActiveIds.filter((id) => marketHours.closedById.has(id)
    && !pricedActiveIds.includes(id) && (missingDetailsById.get(id)?.currentPrice ?? 0) <= 0);
  const scheduledIds = new Set(scheduledClosureGapIds);
  const acknowledgedGapIds = missingActiveIds.filter((id) => !scheduledIds.has(id)
    && reviews.activeById.has(id)
    && !pricedActiveIds.includes(id)
    && (missingDetailsById.get(id)?.currentPrice ?? 0) <= 0,
  );
  const acknowledgedIds = new Set(acknowledgedGapIds);
  const alertEligibleIds = [...new Set([
    ...stringArray(coverage.alertEligibleIds),
    ...derivedAlertEligibleIds,
  ])].filter((id) => !acknowledgedIds.has(id) && !marketHours.alertSuppressedIds.has(id) && !nominalReferenceIds.includes(id));
  const complete = coverage.complete === true
    && expectedActiveCount === ACTIVE_IDS.size
    && presentActiveCount === ACTIVE_IDS.size
    && pricedActiveCount != null && pricedActiveCount + nominalReferenceCount === ACTIVE_IDS.size
    && nominalReferenceCount === nominalReferenceIds.length
    && accountedIds.length === ACTIVE_IDS.size
    && new Set(accountedIds).size === ACTIVE_IDS.size
    && accountedIds.every((stablecoinId) => ACTIVE_IDS.has(stablecoinId))
    && missingPriceCount === 0
    && missingActiveIds.length === 0;

  return {
    status: complete ? "complete" : "incomplete",
    expectedActiveCount,
    presentActiveCount,
    pricedActiveCount,
    missingPriceCount,
    nominalReferenceCount,
    nominalReferenceMarketCapUsd: parsed.data.nominalReferenceMarketCapUsd === undefined
      ? 0 : parsed.data.nominalReferenceMarketCapUsd,
    nominalReferenceIds,
    nominalReferenceReason: "reviewed-nominal-reference",
    pricedActiveIds,
    missingActiveIds,
    affectedMarketCapUsd: parsed.data.affectedMarketCapUsd,
    missingActiveAssets,
    alertEligibleCount: alertEligibleIds.length,
    alertEligibleIds,
    scheduledClosureGapIds,
    acknowledgedGapIds,
    acknowledgedGapCount: acknowledgedGapIds.length,
    expiredMarketHoursCalendarIds: marketHours.expiredCalendarIds,
    invalidMarketHoursCalendarIds: marketHours.invalidCalendarIds,
    expiredGapReviewIds: reviews.expiredGapReviewIds,
    invalidGapReviewIds: reviews.invalidGapReviewIds,
    maxConsecutiveMissingGenerations: parsed.data.maxConsecutiveMissingGenerations,
    observedAt,
  };
}

export interface StablecoinCoverageHealthSnapshot {
  publication: StablecoinPublicationHealth;
  activePriceCoverage: ActivePriceCoverageHealth;
}

export async function loadStablecoinCoverageHealth(
  db: D1Database,
  now = Math.floor(Date.now() / 1000),
): Promise<StablecoinCoverageHealthSnapshot> {
  // Synthetic abandoned/no-write rows still carry wrapper metadata. Keep them
  // visible to cron health without letting them erase the last publication's
  // exact row and price coverage evidence.
  const row = await db
    .prepare(
      `SELECT started_at, metadata
         FROM cron_runs
        WHERE job = 'sync-stablecoins'
          AND metadata IS NOT NULL
          AND metadata LIKE '%"activePublicationCoverage"%'
          AND metadata LIKE '%"activePriceCoverage"%'
          AND started_at >= ?
        ORDER BY started_at DESC, id DESC
        LIMIT 1`,
    )
    .bind(now - 7 * 24 * 60 * 60)
    .first<{ started_at: number; metadata: string }>();
  return row?.metadata
    ? {
        publication: parseStablecoinPublicationHealth(row.metadata, row.started_at),
        activePriceCoverage: parseActivePriceCoverageHealth(row.metadata, row.started_at, now),
      }
    : {
        publication: unknownStablecoinPublicationHealth(),
        activePriceCoverage: unknownActivePriceCoverageHealth(),
      };
}

export async function loadStablecoinPublicationHealth(
  db: D1Database,
  now?: number,
): Promise<StablecoinPublicationHealth> {
  return (await loadStablecoinCoverageHealth(db, now)).publication;
}
