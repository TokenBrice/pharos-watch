import { WORKER_ACTIVE_IDS as ACTIVE_IDS } from "@shared/lib/stablecoins/worker-runtime-registry";
import { isRecord } from "@shared/lib/type-guards";
import { ActivePriceCoverageHealthSchema } from "@shared/types/status/core";
import type {
  ActivePriceCoverageGap,
  ActivePriceCoverageHealth,
  StablecoinPublicationHealth,
} from "@shared/types/status";
import { tryParseJson } from "./json-parse";
import {
  parseMissingActivePriceDetail,
  parsePersistedMissingActivePriceState,
  resolveStablecoinPriceGapReviews,
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
    acknowledgedGapIds: [],
    acknowledgedGapCount: null,
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
  metadata: unknown,
  observedAt: number,
): StablecoinPublicationHealth {
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
  metadata: unknown,
  observedAt: number,
  nowSec: number,
): ActivePriceCoverageHealth {
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
  const parseOptions = { nowSec, reviewsById: reviews.activeById };
  const missingDetailsById = new Map(
    (Array.isArray(coverage.missingActiveState)
      ? coverage.missingActiveState
          .slice(0, ACTIVE_IDS.size)
          .map((value) => parsePersistedMissingActivePriceState(value, parseOptions))
          .filter((entry): entry is ActivePriceCoverageGap => entry != null)
      : [])
      .map((entry) => [entry.stablecoinId, entry] as const),
  );
  const verboseMissingDetails = Array.isArray(coverage.missingActiveAssets)
    ? coverage.missingActiveAssets
        .map((value) => parseMissingActivePriceDetail(value, parseOptions))
        .filter((entry): entry is ActivePriceCoverageGap => entry != null)
    : [];
  for (const entry of verboseMissingDetails) {
    missingDetailsById.set(entry.stablecoinId, entry);
  }
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
  const acknowledgedGapIds = missingActiveIds.filter((id) =>
    reviews.activeById.has(id)
    && !pricedActiveIds.includes(id)
    && (missingDetailsById.get(id)?.currentPrice ?? 0) <= 0,
  );
  const acknowledgedIds = new Set(acknowledgedGapIds);
  const alertEligibleIds = [...new Set([
    ...stringArray(coverage.alertEligibleIds),
    ...derivedAlertEligibleIds,
  ])].filter((id) => !acknowledgedIds.has(id) && !nominalReferenceIds.includes(id));
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
    acknowledgedGapIds,
    acknowledgedGapCount: acknowledgedGapIds.length,
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

/** Decodes one `sync-stablecoins` cron metadata object into the publication and
 * active-price coverage health that `getStablecoinPublicationImpactStatus` judges. */
export function parseStablecoinCoverageHealth(
  metadata: unknown,
  observedAt: number,
  nowSec: number,
): StablecoinCoverageHealthSnapshot {
  return {
    publication: parseStablecoinPublicationHealth(metadata, observedAt),
    activePriceCoverage: parseActivePriceCoverageHealth(metadata, observedAt, nowSec),
  };
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
    ? parseStablecoinCoverageHealth(tryParseJson(row.metadata), row.started_at, now)
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
