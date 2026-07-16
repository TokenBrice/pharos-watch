import { ACTIVE_IDS } from "@shared/lib/stablecoins/registry";
import { isRecord } from "@shared/lib/type-guards";
import type {
  ActivePriceCoverageGap,
  ActivePriceCoverageHealth,
  StablecoinPublicationHealth,
} from "@shared/types/status";
import { tryParseJson } from "./json-parse";

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

function nullableFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function parseMissingActivePriceAssets(value: unknown): ActivePriceCoverageGap[] {
  if (!Array.isArray(value)) return [];
  const parsed: ActivePriceCoverageGap[] = [];
  for (const entry of value) {
    if (!isRecord(entry) || typeof entry.stablecoinId !== "string") continue;
    parsed.push({
      stablecoinId: entry.stablecoinId,
      marketCapUsd: nullableFiniteNumber(entry.marketCapUsd),
      currentPrice: nullableFiniteNumber(entry.currentPrice),
      currentSource: typeof entry.currentSource === "string" ? entry.currentSource : null,
      currentObservedAt: nullableFiniteNumber(entry.currentObservedAt),
      currentConfidence: typeof entry.currentConfidence === "string" ? entry.currentConfidence : null,
    });
  }
  return parsed;
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
    missingActiveAssets: parseMissingActivePriceAssets(coverage.missingActiveAssets),
    observedAt,
  };
}

export interface StablecoinCoverageHealthSnapshot {
  publication: StablecoinPublicationHealth;
  activePriceCoverage: ActivePriceCoverageHealth;
}

export async function loadStablecoinCoverageHealth(
  db: D1Database,
): Promise<StablecoinCoverageHealthSnapshot> {
  const row = await db
    .prepare(
      `SELECT started_at, metadata
         FROM cron_runs
        WHERE job = 'sync-stablecoins' AND metadata IS NOT NULL
        ORDER BY started_at DESC, id DESC
        LIMIT 1`,
    )
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
): Promise<StablecoinPublicationHealth> {
  return (await loadStablecoinCoverageHealth(db)).publication;
}
