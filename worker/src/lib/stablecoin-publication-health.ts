import { ACTIVE_IDS, ACTIVE_STABLECOINS } from "@shared/lib/stablecoins/registry";
import { isRecord } from "@shared/lib/type-guards";
import type {
  ActivePriceCoverageGap,
  ActivePriceCoverageHealth,
  StablecoinPublicationHealth,
} from "@shared/types/status";
import { tryParseJson } from "./json-parse";
import { ACTIVE_PRICE_COVERAGE_ALERT_GENERATIONS } from "./stablecoin-publication-coverage";

const ACTIVE_STABLECOIN_SYMBOL_BY_ID = new Map(
  ACTIVE_STABLECOINS.map((stablecoin) => [stablecoin.id, stablecoin.symbol] as const),
);

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

function nullableFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function parseMissingActivePriceAssets(value: unknown): ActivePriceCoverageGap[] {
  if (!Array.isArray(value)) return [];
  const parsed: ActivePriceCoverageGap[] = [];
  for (const entry of value) {
    if (!isRecord(entry) || typeof entry.stablecoinId !== "string") continue;
    const consecutiveMissingGenerations = Math.max(1, Math.floor(finiteNumber(
      entry.consecutiveMissingGenerations,
      1,
    )));
    parsed.push({
      stablecoinId: entry.stablecoinId,
      symbol: typeof entry.symbol === "string" ? entry.symbol : entry.stablecoinId,
      marketCapUsd: nullableFiniteNumber(entry.marketCapUsd),
      currentPrice: nullableFiniteNumber(entry.currentPrice),
      currentSource: typeof entry.currentSource === "string" ? entry.currentSource : null,
      currentObservedAt: nullableFiniteNumber(entry.currentObservedAt),
      currentConfidence: typeof entry.currentConfidence === "string" ? entry.currentConfidence : null,
      consecutiveMissingGenerations,
      lastAcceptedPrice: nullableFiniteNumber(entry.lastAcceptedPrice),
      lastAcceptedSource: typeof entry.lastAcceptedSource === "string" ? entry.lastAcceptedSource : null,
      lastAcceptedObservedAt: nullableFiniteNumber(entry.lastAcceptedObservedAt),
      rejectionReason: typeof entry.rejectionReason === "string" ? entry.rejectionReason : "no-accepted-price",
      alertEligible: entry.alertEligible === true
        || consecutiveMissingGenerations >= ACTIVE_PRICE_COVERAGE_ALERT_GENERATIONS,
    });
  }
  return parsed;
}

function parseMissingActivePriceState(value: unknown): ActivePriceCoverageGap[] {
  if (!Array.isArray(value)) return [];
  const parsed: ActivePriceCoverageGap[] = [];
  for (const entry of value.slice(0, ACTIVE_IDS.size)) {
    if (!Array.isArray(entry) || entry.length < 6 || typeof entry[0] !== "string") continue;
    const consecutiveMissingGenerations = Math.max(1, Math.floor(finiteNumber(entry[1], 1)));
    parsed.push({
      stablecoinId: entry[0],
      symbol: ACTIVE_STABLECOIN_SYMBOL_BY_ID.get(entry[0]) ?? entry[0],
      marketCapUsd: null,
      currentPrice: null,
      currentSource: null,
      currentObservedAt: null,
      currentConfidence: null,
      consecutiveMissingGenerations,
      lastAcceptedPrice: nullableFiniteNumber(entry[2]),
      lastAcceptedSource: typeof entry[3] === "string" ? entry[3] : null,
      lastAcceptedObservedAt: nullableFiniteNumber(entry[4]),
      rejectionReason: typeof entry[5] === "string" ? entry[5] : "no-accepted-price",
      alertEligible: consecutiveMissingGenerations >= ACTIVE_PRICE_COVERAGE_ALERT_GENERATIONS,
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
  const missingDetailsById = new Map(
    parseMissingActivePriceState(coverage.missingActiveState)
      .map((entry) => [entry.stablecoinId, entry] as const),
  );
  for (const entry of parseMissingActivePriceAssets(coverage.missingActiveAssets)) {
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
