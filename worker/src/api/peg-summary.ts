import { API_CACHE_PROFILES as CACHE_PROFILES } from "@shared/lib/api-cache-profiles";
import { logWorkerEventArgs } from "../lib/structured-log";
import { derivePegRates, normalizePegType } from "@shared/lib/peg-rates";
import { pegTypeFromCurrency } from "@shared/lib/peg-taxonomy";
import { medianOfRounded } from "@shared/lib/peg-utils";
import { DAY_SECONDS } from "@shared/lib/time-constants";
import { bucketUnixSecondsToUtcDay } from "@shared/lib/time-buckets";
import { API_FRESHNESS_MAX_AGE_SEC } from "@shared/lib/api-freshness";
import { DEPEG_SEVERITY_BPS } from "@shared/lib/depeg-config";
import { parseSupplyObservationProvenance } from "@shared/lib/supply-provenance";
import { WORKER_ACTIVE_IDS, WORKER_TRACKED_META_BY_ID as TRACKED_META_BY_ID } from "@shared/lib/stablecoins/worker-runtime-registry";
import type { StablecoinData } from "@shared/types/supply";
import type { PegSummaryCoin } from "@shared/types/peg";
import { isObservedPrice } from "@shared/lib/pricing-source-policy";
import { addFreshnessHeaders } from "../lib/api-freshness";
import { errorResponse, jsonResponse } from "../lib/api-response";
import { buildMethodologyEnvelope } from "../lib/api-methodology";
import { getDepegThresholdBpsForPegCurrency } from "../lib/depeg-threshold-policy";
import { loadStablecoinsCache } from "../lib/stablecoins-cache";
import { derivePegAnalyticsSnapshot } from "../lib/peg-analytics";
import { countPegEventDays, loadPegAnalyticsCache } from "../lib/peg-analytics-cache";
import { signalCrossesThreshold } from "@shared/lib/depeg-signals";
import { getLegacyReferenceClosureStart, getReferenceMarket } from "@shared/lib/reference-market-hours";
import { deriveCurrentPegObservationMap, selectCurrentPegDexPrices } from "../lib/current-peg-observations";
import { deriveDexDeviationBps, hasFxReferenceEvidence } from "@shared/lib/current-peg-observations";
import {
  effectiveStartedAtSql,
  EXCLUDE_SUPERSEDED_ACTIVE_INCIDENT_EVENTS_SQL,
  IncidentProjectionUnavailableError,
} from "../lib/depeg-event-projection";
import {
  DEPEG_DEWS_METHODOLOGY_CHANGELOG_PATH,
  DEPEG_DEWS_METHODOLOGY_VERSION,
  DEPEG_DEWS_METHODOLOGY_VERSION_LABEL,
} from "@shared/lib/methodology-versions/constants";
import { getMethodologyVersionAt } from "@shared/lib/methodology-versions/registry";
import { toMethodologyVersionLabel } from "@shared/lib/methodology-versions/base";

/**
 * The peg unit the live observation map admits: the curated registry currency
 * decides when the snapshot label disagrees, the snapshot label is used only
 * for currencies with no canonical peg type, and the older analytics label is
 * a last resort for an absent snapshot row.
 */
function resolvePegType(
  asset: StablecoinData | undefined,
  pegCurrency: string,
  cachedPegType: string,
): string {
  const livePegType = normalizePegType(asset?.pegType);
  const registryPegType = normalizePegType(pegTypeFromCurrency(pegCurrency));
  if (livePegType != null && (registryPegType == null || livePegType === registryPegType)) {
    return livePegType;
  }
  if (registryPegType != null) return registryPegType;
  return normalizePegType(cachedPegType) ?? "";
}

type PegEventDayRow = {
  stablecoin_id: string;
  started_at: number;
  provenance_json: string | null;
  provenance_audit_verdict: string | null;
};

function storedAuditVerdict(row: PegEventDayRow): string | null {
  if (row.provenance_json) {
    try {
      const parsed = JSON.parse(row.provenance_json) as { auditVerdict?: unknown } | null;
      if (parsed != null && typeof parsed === "object" && typeof parsed.auditVerdict === "string") {
        return parsed.auditVerdict;
      }
    } catch {
      // Unreadable provenance falls through to the column, as rowToDepegEvent does.
    }
  }
  return row.provenance_audit_verdict;
}

type PegEventDayCountRead =
  | { kind: "ok"; today: number; yesterday: number }
  | { kind: "unavailable"; reason: "peg-event-day-count-read-failed" };

/**
 * Read-time re-bucketing for a cached generation from an earlier UTC day: the
 * cached pair names that generation's "today". The counters must use the same
 * clock the producer counts (`rowToPublicDepegEvent`), i.e. an active
 * incident's projected first onset, not the current fragment's `started_at`.
 * The raw `started_at` is never earlier than that effective onset, so the
 * indexed two-day bound still admits every row the counters can bucket.
 *
 * A failed read is reported, never defaulted to zero: the route answers with
 * an explicit typed 503 instead of an unhandled error or a false calm day.
 */
async function loadPegEventDayCounts(db: D1Database, nowSec: number): Promise<PegEventDayCountRead> {
  const todayStartSec = bucketUnixSecondsToUtcDay(nowSec);
  try {
    const rows = await db.prepare(
      `SELECT /* pharos:peg-summary:depeg-event-day-counts */
         e.stablecoin_id,
         ${effectiveStartedAtSql("e")} AS started_at,
         e.provenance_json, e.provenance_audit_verdict
         FROM depeg_events_with_provenance e
        WHERE e.started_at >= ?
          AND ${EXCLUDE_SUPERSEDED_ACTIVE_INCIDENT_EVENTS_SQL}`,
    ).bind(todayStartSec - DAY_SECONDS).all<PegEventDayRow>();
    const counts = countPegEventDays((rows.results ?? []).map((row) => ({
      stablecoinId: row.stablecoin_id,
      startedAt: row.started_at,
      provenance: { auditVerdict: storedAuditVerdict(row) },
    })), nowSec);
    return { kind: "ok", today: counts.today, yesterday: counts.yesterday };
  } catch (error) {
    logWorkerEventArgs("api", "warn",
      "[peg-summary] depeg event day-count query failed:",
      error instanceof Error ? error.message : error,
    );
    return { kind: "unavailable", reason: "peg-event-day-count-read-failed" };
  }
}

/**
 * Coins with an observed price on the current or previous UTC day's supply
 * snapshot. `snapshot-supply` records only actual observations there (never
 * nominal par) and repairs the day's row when a price returns, so a coin absent
 * from this set has had no usable price for at least a full UTC day, or never.
 * Null when the read fails.
 */
async function loadRecentlyPricedIds(db: D1Database, nowSec: number): Promise<ReadonlySet<string> | null> {
  try {
    const rows = await db.prepare(
      // No DISTINCT: it scans the whole (stablecoin_id, snapshot_date) key; the
      // date index reads only these two days and the Set dedupes.
      `SELECT /* pharos:peg-summary:recently-priced-ids */
         stablecoin_id, price, CASE WHEN price IS NULL THEN supply_provenance END AS supply_provenance
         FROM supply_history
        WHERE snapshot_date >= ? AND (price IS NOT NULL OR supply_provenance IS NOT NULL)`,
    ).bind(bucketUnixSecondsToUtcDay(nowSec) - DAY_SECONDS).all<{
      stablecoin_id: string; price: number | null; supply_provenance: string | null;
    }>();
    return new Set((rows.results ?? []).filter((row) =>
      (row.price != null && Number.isFinite(row.price) && row.price > 0) ||
      parseSupplyObservationProvenance(row.supply_provenance).provenance?.marketQuote != null,
    ).map((row) => row.stablecoin_id));
  } catch (error) {
    logWorkerEventArgs("api", "warn",
      "[peg-summary] recent price-history read failed; unpriced coins publish NR:",
      error instanceof Error ? error.message : error,
    );
    return null;
  }
}

async function resolveCachedEventDayCounts(
  db: D1Database,
  payload: { computedAtSec: number; depegEventsToday: number; depegEventsYesterday: number },
  nowSec: number,
): Promise<PegEventDayCountRead> {
  if (bucketUnixSecondsToUtcDay(payload.computedAtSec) === bucketUnixSecondsToUtcDay(nowSec)) {
    return { kind: "ok", today: payload.depegEventsToday, yesterday: payload.depegEventsYesterday };
  }
  return loadPegEventDayCounts(db, nowSec);
}

function eventDayCountsUnavailable(reason: "peg-event-day-count-read-failed"): Response {
  return jsonResponse({
    error: "Canonical depeg event day counters unavailable",
    reason,
  }, { status: 503, headers: { "Cache-Control": CACHE_PROFILES.noStore } });
}

export const __pegSummaryTestHooks = {
  deriveDexDeviationBps,
  normalizePegTypeFromCurrency: pegTypeFromCurrency,
};


type DexPriceRow = {
  stablecoin_id: string;
  dex_price_usd: number;
  deviation_from_primary_bps: number | null;
  source_pool_count: number;
  source_total_tvl: number;
  updated_at: number;
  price_sources_json: string | null;
};

type DexPriceReadResult =
  | { kind: "ok"; results: DexPriceRow[] }
  | { kind: "degraded"; reason: "dex-prices-read-failed"; results: DexPriceRow[] };

export const handlePegSummary = async (db: D1Database): Promise<Response> => {
  const stablecoinsCache = await loadStablecoinsCache(db, { mode: "strict" });
  if (stablecoinsCache.kind !== "ok") {
    if (stablecoinsCache.reason === "missing-cache") {
      return errorResponse(503, "Data not yet available");
    }
    return errorResponse(503, "Cached stablecoins data is corrupt");
  }
  const { peggedAssets, fxFallbackRates, fxReferenceObservations } = stablecoinsCache.payload;
  const clocked = hasFxReferenceEvidence(fxReferenceObservations);

  const now = Math.floor(Date.now() / 1000);
  // 2. Load DEX prices + shared peg analytics snapshot
  // Narrower aggregate-only column set than the dex-liquidity endpoint.
  const [dexPriceResult, pegAnalyticsCache, recentlyPricedIds] = await Promise.all([
    db.prepare("SELECT stablecoin_id, dex_price_usd, deviation_from_primary_bps, source_pool_count, source_total_tvl, updated_at, price_sources_json FROM dex_prices")
      .all<DexPriceRow>()
      .then((result): DexPriceReadResult => ({ kind: "ok", results: result.results ?? [] }))
      .catch((err): DexPriceReadResult => {
        logWorkerEventArgs("api", "warn",
          "[peg-summary] DEX price query failed, serving degraded response:",
          err instanceof Error ? err.message : err,
        );
        return { kind: "degraded", reason: "dex-prices-read-failed", results: [] };
      }),
    // Producer-published by the quarter-hourly report-cards pass; the direct
    // compute below re-scans ~21K depeg_events rows, so it is fallback-only.
    // A previous-day generation is still accepted: its day-scoped counters are
    // re-bucketed below, so midnight never forces a recompute or an outage.
    loadPegAnalyticsCache(db).catch(() => ({ kind: "miss" as const, reason: "missing-cache" as const })),
    loadRecentlyPricedIds(db, now),
  ]);

  let pegDataById: ReadonlyMap<string, PegSummaryCoin>;
  let depegEventsToday: number;
  let depegEventsYesterday: number;
  // Historical peg fields can lag the live stablecoins cache by up to 30 min,
  // so key response freshness to the older of the two observations. Current
  // deviation and reference admission use the canonical live observation map.
  let freshnessAsOf = stablecoinsCache.updatedAt;
  let analyticsDegradedReason: string | undefined;

  if (pegAnalyticsCache.kind === "ok") {
    pegDataById = pegAnalyticsCache.pegDataById;
    const counts = await resolveCachedEventDayCounts(db, pegAnalyticsCache.payload, now);
    if (counts.kind !== "ok") return eventDayCountsUnavailable(counts.reason);
    depegEventsToday = counts.today;
    depegEventsYesterday = counts.yesterday;
    freshnessAsOf = Math.min(freshnessAsOf, pegAnalyticsCache.payload.computedAtSec);
  } else {
    const pegAnalytics = await derivePegAnalyticsSnapshot(db, {
      peggedAssets,
      fxFallbackRates,
      fxReferenceObservations,
      methodologyAsOf: stablecoinsCache.updatedAt,
      includeNavTokens: true,
    }).catch((error) => {
      if (!(error instanceof IncidentProjectionUnavailableError)) throw error;
      analyticsDegradedReason = error.reason;
      return null;
    });
    if (pegAnalytics === null) {
      const retained = await loadPegAnalyticsCache(db, { maxAgeMs: Infinity });
      if (retained.kind !== "ok") {
        return jsonResponse({
          error: "Canonical incident history unavailable",
          reason: analyticsDegradedReason,
        }, { status: 503, headers: { "Cache-Control": CACHE_PROFILES.noStore } });
      }
      pegDataById = retained.pegDataById;
      const counts = await resolveCachedEventDayCounts(db, retained.payload, now);
      if (counts.kind !== "ok") return eventDayCountsUnavailable(counts.reason);
      depegEventsToday = counts.today;
      depegEventsYesterday = counts.yesterday;
      freshnessAsOf = Math.min(freshnessAsOf, retained.payload.computedAtSec);
    } else {
      pegDataById = pegAnalytics.pegDataById;
      // Count depeg events started today vs yesterday (UTC day boundaries)
      const counts = countPegEventDays(pegAnalytics.allEvents, pegAnalytics.nowSec);
      depegEventsToday = counts.today;
      depegEventsYesterday = counts.yesterday;
    }
  }

  // Build DEX price lookup. A failed read is represented separately from a
  // successful empty result so consumers can distinguish absence from outage.
  const dexPrices = selectCurrentPegDexPrices(dexPriceResult.results, now);

  const priceById = new Map(peggedAssets.map((a) => [a.id, a]));
  const referenceAssets = peggedAssets.filter((asset) => !asset.currentPeg?.currentPriceUnavailable);
  const pegRates = derivePegRates(referenceAssets, TRACKED_META_BY_ID, fxFallbackRates, fxReferenceObservations, now);
  const currentObservations = deriveCurrentPegObservationMap({
    peggedAssets,
    pegRates,
    fxFallbackRates,
    fxReferenceObservations,
    asOf: stablecoinsCache.updatedAt,
    now,
    generation: `stablecoins:${stablecoinsCache.updatedAt}`,
    dexPrices,
  });
  for (const asset of peggedAssets) {
    const published = asset.currentPeg;
    if (!published || (!published.currentPriceUnavailable && !published.pegReferenceUnavailable)) continue;
    const observation = currentObservations.get(asset.id);
    if (!observation) continue;
    const dexAdmission = observation.dexPriceCheck?.referenceAdmission;
    // A quote refusal can leave an independently admitted DEX comparison to the same dated reference.
    const keepDexComparison = !published.currentPriceUnavailable &&
      published.referenceAdmission != null && published.referenceAdmission.status !== "admitted" &&
      dexAdmission?.status === "admitted" && observation.pegReference?.asOf === dexAdmission.referenceObservedAtSec &&
      observation.pegReference.source === dexAdmission.kind;
    const publishedRefusal = published.referenceAdmission?.status !== "admitted" ? published.referenceAdmission : undefined;
    currentObservations.set(asset.id, {
      ...observation,
      currentDeviationBps: null,
      currentSignal: null,
      ...(observation.admittedDeviationBps !== undefined && { admittedDeviationBps: null }),
      referenceAdmission: observation.referenceAdmission?.status === "admitted" ? publishedRefusal : observation.referenceAdmission,
      pegReference: keepDexComparison ? observation.pegReference : null,
      pegReferenceUnavailable: published.pegReferenceUnavailable,
      dexPriceCheck: keepDexComparison ? observation.dexPriceCheck : null,
      ...(published.currentPriceUnavailable && { currentPriceUnavailable: true, primaryTrust: "unusable" }),
    });
  }
  const methodologyVersion = getMethodologyVersionAt("depeg-dews", stablecoinsCache.updatedAt);

  const coins: PegSummaryCoin[] = [];

  let activeDepegCount = 0;
  const allAbsBps: number[] = [];
  let worstCurrent: { id: string; symbol: string; rawBps: number } | null = null;
  let coinsAtPeg = 0;
  let totalTracked = 0;

  for (const meta of TRACKED_META_BY_ID.values()) {
    // A retained analytics generation can still carry a row for a coin that has
    // since left the active registry (retired/frozen). The published peg catalog
    // and active-depeg census share the active registry, as the fresh compute does.
    if (!WORKER_ACTIVE_IDS.has(meta.id)) continue;
    const isNavToken = meta.flags.navToken === true;

    const pegData = pegDataById.get(meta.id);
    if (!pegData) continue;

    const asset = priceById.get(meta.id);
    const observation = currentObservations.get(meta.id);
    const admissionEnabled = clocked && observation?.legacyFxReference !== true;
    const currentBps = observation?.currentDeviationBps ?? null;
    const currentPriceUnavailable = observation?.currentPriceUnavailable ?? !isNavToken;
    const admittedBps = observation?.admittedDeviationBps ?? null;
    // NAV score fields are normalized at the peg-analytics source via
    // NULL_PEG_SCORE_RESULT; only live deviation is withheld again here.
    // Detection needs an observed price, so with none (missing, rejected or
    // nominal-only) for a full UTC day, or ever, an event-free window is
    // unobserved, not time at peg: the score and its time-at-peg views publish
    // NR, never 100 (R1/R2), and `currentPriceUnavailable` names the reason. A
    // shorter miss keeps the score; a failed history read withholds it (R2).
    // Events stay published.
    const scoreUnobserved = currentPriceUnavailable && !(recentlyPricedIds?.has(meta.id) ?? false);
    coins.push({
      id: meta.id,
      symbol: meta.symbol,
      name: meta.name,
      pegType: resolvePegType(asset, meta.flags.pegCurrency, pegData.pegType),
      pegCurrency: meta.flags.pegCurrency,
      governance: meta.flags.governance,
      currentDeviationBps: currentBps,
      admittedDeviationBps: admissionEnabled ? admittedBps : undefined,
      referenceAdmission: observation?.referenceAdmission,
      pegReference: observation?.pegReference ?? null,
      pegReferenceUnavailable: observation?.pegReferenceUnavailable ?? true,
      currentPriceUnavailable,
      depegEventCoverageLimited: pegData.depegEventCoverageLimited,
      ...(observation?.currentSupplyUnavailable ? { currentSupplyUnavailable: true } : {}),
      pegScore: scoreUnobserved ? null : pegData.pegScore,
      price: observation?.currentPriceUnavailable === false && asset && isObservedPrice(asset) &&
        asset.price != null && Number.isFinite(asset.price) && asset.price > 0 ? asset.price : null,
      priceSource: asset?.priceSource ?? undefined,
      priceConfidence: asset?.priceConfidence ?? null,
      priceObservedAt: asset?.currentPeg?.currentPriceUnavailable ? null : asset?.priceObservedAt ?? null,
      priceObservedAtMode: asset?.priceObservedAtMode ?? null,
      ...(asset?.nominalPriceReference ? { nominalPriceReference: asset.nominalPriceReference } : {}),
      priceSyncedAt: asset?.priceSyncedAt ?? null,
      priceUpdatedAt: asset?.priceUpdatedAt ?? null,
      consensusSources: asset?.consensusSources,
      agreeSources: asset?.agreeSources,
      primaryTrust: observation?.primaryTrust ?? "unusable",
      pegPct: scoreUnobserved ? null : pegData.pegPct,
      ...(pegData.unknownCoverageSeconds != null ? { unknownCoverageSeconds: pegData.unknownCoverageSeconds } : {}),
      severityScore: pegData.severityScore,
      spreadPenalty: pegData.spreadPenalty,
      eventCount: pegData.eventCount,
      worstDeviationBps: pegData.worstDeviationBps,
      // NAV tokens carry no peg, so a retained pre-reclassification row must
      // not re-enter the active-depeg census through its cached flag.
      activeDepeg: isNavToken ? false : pegData.activeDepeg,
      lastEventAt: pegData.lastEventAt,
      trackingSpanDays: pegData.trackingSpanDays,
      observationStartedAt: pegData.observationStartedAt ?? null,
      historyCoverage: pegData.historyCoverage,
      recent90d: scoreUnobserved ? null : pegData.recent90d,
      methodologyVersion,
      dexPriceCheck: observation?.dexPriceCheck ?? undefined,
    });

    if (!isNavToken && pegData.activeDepeg) activeDepegCount++;
    const censusBps = admissionEnabled ? admittedBps : currentBps;
    const legacyQuoteAt = asset?.priceObservedAt ?? asset?.priceUpdatedAt;
    const market = getReferenceMarket(meta.flags.pegCurrency);
    const legacyHold = !admissionEnabled && market !== null && censusBps !== null &&
      !signalCrossesThreshold(observation?.currentSignal, DEPEG_SEVERITY_BPS.severe) &&
      typeof legacyQuoteAt === "number" && Number.isFinite(new Date(legacyQuoteAt * 1000).getTime()) &&
      getLegacyReferenceClosureStart(market, legacyQuoteAt) !== null;
    if (censusBps !== null && !legacyHold) {
      totalTracked++;
      const absBps = Math.abs(censusBps);
      allAbsBps.push(absBps);
      const pegThreshold = getDepegThresholdBpsForPegCurrency(meta.flags.pegCurrency);
      const atPeg = admissionEnabled ? absBps < pegThreshold
        : observation?.currentSignal && !signalCrossesThreshold(observation.currentSignal, pegThreshold);
      if (atPeg) coinsAtPeg++;
      if (!worstCurrent || absBps > Math.abs(worstCurrent.rawBps)) {
        worstCurrent = { id: meta.id, symbol: meta.symbol, rawBps: censusBps };
      }
    }
  }

  const medianBps = medianOfRounded(allAbsBps);

  // Flag peg types using fallback rates so frontend can signal stale data
  const fallbackPegTypes = Object.entries(pegRates.sources)
    .filter(([, src]) => src === "fallback")
    .map(([peg]) => peg);
  const fxPegTypes = Object.entries(pegRates.sources)
    .filter(([, src]) => src === "fx")
    .map(([peg]) => peg);

  const degradedReason = analyticsDegradedReason ?? (dexPriceResult.kind === "degraded" ? dexPriceResult.reason : undefined);
  const headers = addFreshnessHeaders(
    {
      "Cache-Control": degradedReason ? CACHE_PROFILES.noStore : CACHE_PROFILES.producerBacked,
    },
    freshnessAsOf,
    API_FRESHNESS_MAX_AGE_SEC.pegSummary,
  );
  if (degradedReason) {
    headers.Warning = analyticsDegradedReason
      ? '199 - "Canonical incident projection unavailable; serving retained analytics"'
      : '199 - "DEX price read failed; cross-checks unavailable"';
  }

  return jsonResponse({
    coins,
    summary: {
      activeDepegCount,
      medianDeviationBps: medianBps,
      worstCurrent: worstCurrent && { id: worstCurrent.id, symbol: worstCurrent.symbol, bps: Math.round(worstCurrent.rawBps) },
      coinsAtPeg,
      totalTracked,
      depegEventsToday,
      depegEventsYesterday,
      ...(fallbackPegTypes.length > 0 ? { fallbackPegRates: fallbackPegTypes } : {}),
      ...(fxPegTypes.length > 0 ? { fxPegRates: fxPegTypes } : {}),
    },
    methodology: buildMethodologyEnvelope({
      version: methodologyVersion,
      versionLabel: toMethodologyVersionLabel(methodologyVersion),
      currentVersion: DEPEG_DEWS_METHODOLOGY_VERSION,
      currentVersionLabel: DEPEG_DEWS_METHODOLOGY_VERSION_LABEL,
      changelogPath: DEPEG_DEWS_METHODOLOGY_CHANGELOG_PATH,
      asOf: freshnessAsOf,
    }),
    ...(degradedReason ? { degradedReason } : {}),
  }, { headers });
};
