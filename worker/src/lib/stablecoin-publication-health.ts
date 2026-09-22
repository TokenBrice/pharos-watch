import { ACTIVE_IDS } from "@shared/lib/stablecoins/registry";
import { isRecord } from "@shared/lib/type-guards";
import type {
  ActivePriceCoverageGap,
  ActivePriceCoverageHealth,
  StablecoinPublicationHealth,
} from "@shared/types/status";
import { tryParseJson } from "./json-parse";
import {
  parseMissingActivePriceDetail,
  parsePersistedMissingActivePriceState,
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
): ActivePriceCoverageHealth {
  return {
    status: "unknown",
    expectedActiveCount: ACTIVE_IDS.size,
    presentActiveCount: 0,
    pricedActiveCount: 0,
    missingPriceCount: 0,
    pricedActiveIds: [],
    missingActiveIds: [],
    affectedMarketCapUsd: 0,
    missingActiveAssets: [],
    alertEligibleCount: 0,
    alertEligibleIds: [],
    maxConsecutiveMissingGenerations: 0,
    observedAt,
  };
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function finiteNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
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
): ActivePriceCoverageHealth {
  const metadata = tryParseJson(metadataJson);
  const coverage = isRecord(metadata) && isRecord(metadata.activePriceCoverage)
    ? metadata.activePriceCoverage
    : null;
  if (!coverage) return unknownActivePriceCoverageHealth(observedAt);

  const expectedActiveCount = finiteNumber(coverage.expectedActiveCount);
  const presentActiveCount = finiteNumber(coverage.presentActiveCount);
  const pricedActiveCount = finiteNumber(coverage.pricedActiveCount);
  const pricedActiveIds = stringArray(coverage.pricedActiveIds);
  const missingActiveIds = stringArray(coverage.missingActiveIds);
  const missingPriceCount = finiteNumber(coverage.missingPriceCount, missingActiveIds.length);
  const missingDetailsById = new Map(
    (Array.isArray(coverage.missingActiveState)
      ? coverage.missingActiveState
          .slice(0, ACTIVE_IDS.size)
          .map(parsePersistedMissingActivePriceState)
          .filter((entry): entry is ActivePriceCoverageGap => entry != null)
      : [])
      .map((entry) => [entry.stablecoinId, entry] as const),
  );
  const verboseMissingDetails = Array.isArray(coverage.missingActiveAssets)
    ? coverage.missingActiveAssets
        .map(parseMissingActivePriceDetail)
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
  const alertEligibleIds = stringArray(coverage.alertEligibleIds);
  const complete = coverage.complete === true
    && expectedActiveCount === ACTIVE_IDS.size
    && presentActiveCount === ACTIVE_IDS.size
    && pricedActiveCount === ACTIVE_IDS.size
    && pricedActiveIds.length === ACTIVE_IDS.size
    && new Set(pricedActiveIds).size === ACTIVE_IDS.size
    && pricedActiveIds.every((stablecoinId) => ACTIVE_IDS.has(stablecoinId))
    && missingPriceCount === 0
    && missingActiveIds.length === 0;

  return {
    status: complete ? "complete" : "incomplete",
    expectedActiveCount,
    presentActiveCount,
    pricedActiveCount,
    missingPriceCount,
    pricedActiveIds,
    missingActiveIds,
    affectedMarketCapUsd: finiteNumber(coverage.affectedMarketCapUsd),
    missingActiveAssets,
    alertEligibleCount: finiteNumber(coverage.alertEligibleCount, derivedAlertEligibleIds.length),
    alertEligibleIds: alertEligibleIds.length > 0 ? alertEligibleIds : derivedAlertEligibleIds,
    maxConsecutiveMissingGenerations: finiteNumber(
      coverage.maxConsecutiveMissingGenerations,
      missingActiveAssets.reduce(
        (max, entry) => Math.max(max, entry.consecutiveMissingGenerations),
        0,
      ),
    ),
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
        activePriceCoverage: parseActivePriceCoverageHealth(row.metadata, row.started_at),
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
