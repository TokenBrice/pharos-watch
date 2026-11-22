import { getPublishedLegacyPegReference } from "@shared/lib/current-peg-observations";
import { includePsiEventDeviation } from "../lib/psi-recompute";
import { logWorkerEventArgs } from "../lib/structured-log";
import { getCirculatingRawOrNull, getUsdMarketCapBaselineOrNull, hasDatedUsdValuation, isOutageFallbackCarry, matchesSupplySnapshotDay } from "@shared/lib/supply";
import { bucketUnixSecondsToUtcDay } from "@shared/lib/time-buckets";
import { DAY_SECONDS } from "@shared/lib/time-constants";
import { DEPEG_MAX_CONTINUOUS_OBSERVATION_GAP_SEC } from "@shared/lib/depeg-closure";
import { DEPEG_PRIMARY_PRICE_MAX_AGE_SEC, DEPEG_SEVERITY_BPS, DEX_PROTOCOL_SOURCE_FRESHNESS_SEC } from "@shared/lib/depeg-config";
import { CORE_PSI_ELIGIBLE_IDS, PSI_ELIGIBLE_META_BY_ID } from "@shared/lib/psi-eligible";
import { derivePegRates, getPegReference, isParityPrice, normalizePegType } from "@shared/lib/peg-rates";
import { getCommodityOuncesAtQuote } from "@shared/lib/commodity-median";
import { getLegacyReferenceClosureStart, getReferenceMarket, getReferenceMarketClosureStart, getReferenceSessionState } from "@shared/lib/reference-market-hours";
import { deriveAuthoritativePegSignal } from "./authoritative-peg-signal";
import { assessDetectionReference, assessIndependentPeerMove, attachDetectionReferenceContext, sourceObservationClock } from "./depeg-detection/reference-policy";
import { admittedDeviationBps, evaluateReferenceAdmission } from "@shared/lib/reference-admission";
import { getPublishedReferenceEvidence, readAdmittedNativeEventObservation } from "../lib/psi-reference";
import { computePsiStressBreadth } from "../lib/psi-replay";
import { asRawDeviationBps, type ReferenceAdmission } from "@shared/types/reference-admission";
import { PSI_METHODOLOGY_VERSION } from "@shared/lib/methodology-versions/constants";
import { round1 } from "@shared/lib/math";
import { DEWS_GENERATION_CONSUMER_MAX_AGE_SEC } from "@shared/lib/api-freshness";
import type { CronResult } from "../lib/cron-logger";
import { createCronResult } from "../lib/cron-result";
import { getPriceCache } from "../lib/price-cache";
import { deriveDepegSignal } from "@shared/lib/depeg-signals";
import { computeStabilityIndex, getDepreciationFactor } from "../lib/stability-index";
import { loadStablecoinsCache } from "../lib/stablecoins-cache";
import { loadPublishedStressSignalGeneration } from "../lib/stress-signals-current-rows";
import { canonicalizePsiStablecoinId } from "@shared/lib/stablecoin-id-registry";
import { CORE_STABLECOIN_AGGREGATE_UNIVERSE } from "@shared/lib/stablecoins/aggregate-universe";
import { CORE_AGGREGATE_ACTIVE_IDS } from "@shared/lib/stablecoins/aggregate-registry";
import { classifyPsiUniverseCoverage } from "@shared/lib/psi-policy";
import { throwIfAborted } from "../lib/abort";
import { isNativePegEvent, type NativeEventPriceEvidence } from "@shared/lib/depeg-quote-domain";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { hasPeerDeviationReceipt, readPeerDeviationMarks } from "../lib/depeg-observation-marks";
import { loadDexPoolChallengers, readDepegCoverageLedger } from "../lib/depeg-helpers";
import { auditVerdictNotInSql } from "../lib/depeg-audit";
import { PEG_SCORE_EXCLUDED_AUDIT_VERDICTS } from "@shared/types/depeg-audit";
import { reviewedDepegDisputeSql } from "@shared/data/depegs/reviewed-depeg-disposition-sql";
import { getDepegRecoveryThresholdBps, getDepegThresholdBps } from "../lib/depeg-threshold-policy";
import { COINGECKO_NATIVE_IMPLIED_SOURCE } from "../lib/native-peg-implied-prices";
import { POOL_CHALLENGE_MIN_TVL } from "../lib/price-depeg-voting-policy";
import { isEarlierSupplyPerimeter, isAmbiguousSupplyPerimeterDay } from "@shared/lib/supply-perimeter-changes";
import { isReplaySafePriceSource } from "@shared/lib/pricing-source-policy";
import { protocolParProvider } from "../lib/authoritative-price-sources/protocol-par";
import { NATIVE_EVENT_QUOTE_CACHE_PREFIX } from "../lib/native-peg-quote-cache";
import { isRecord } from "@shared/lib/type-guards";

type PsiActiveDepegRow = NativeEventPriceEvidence & {
  id: number;
  stablecoin_id: string;
  current_native_quote: string | null;
  last_trusted_price_at: number | null;
  price_coverage_gap_started_at: number | null;
  pending_reason?: string | null;
  peer_basis_json?: string | null;
  peak_deviation_bps: number;
  peak_price?: number | null;
  peak_peg_reference?: number | null;
  peak_quote_domain?: string | null;
  direction?: string;
  admitted_coverage_json?: string | null;
  disposition?: string | null;
};

const REPLAY_PRICE_CACHE_TTL_SEC = 6 * 60 * 60;
const DEWS_STRESS_MAX_AGE_SEC = DEWS_GENERATION_CONSUMER_MAX_AGE_SEC;

interface PsiEventContribution {
  startedAt: number;
  bps: number;
  observedAt: number | null;
  legacySampleAt?: number;
  basis?: "peer-relative";
  confidence?: "low";
}

/** Contributor bps of the last sample published before the closure, within the replay-price budget; null when unreadable. */
async function loadPreClosureContributorBps(
  db: D1Database,
  closedSince: number,
): Promise<{ storedAt: number; bpsById: Map<string, number> } | null> {
  try {
    const row = await db
      .prepare("SELECT stored_at, input_snapshot FROM stability_index_samples WHERE stored_at < ? AND stored_at >= ? ORDER BY stored_at DESC LIMIT 1")
      .bind(closedSince, closedSince - REPLAY_PRICE_CACHE_TTL_SEC)
      .first<{ stored_at: number; input_snapshot: string }>();
    const contributors = row ? (JSON.parse(row.input_snapshot) as { contributors?: unknown }).contributors : null;
    if (!row || !Array.isArray(contributors)) return null;
    const bpsById = new Map<string, number>();
    for (const entry of contributors as Array<{ id?: unknown; bps?: unknown } | null>) {
      if (typeof entry?.id === "string" && typeof entry.bps === "number" && Number.isFinite(entry.bps)) {
        bpsById.set(entry.id, entry.bps);
      }
    }
    return { storedAt: row.stored_at, bpsById };
  } catch (error) {
    logWorkerEventArgs("handler", "warn", "[stability-index] pre-closure sample unreadable:", error);
    return null;
  }
}

export async function computeAndStoreStabilityIndex(
  db: D1Database,
  signal?: AbortSignal,
  options?: { referenceMode?: "legacy" | "per-observation" },
): Promise<CronResult> {
  const stablecoinsCache = await loadStablecoinsCache(db, { mode: "strict" });
  if (stablecoinsCache.kind !== "ok") {
    return createCronResult({
      status: "degraded",
      itemCount: 0,
      metadata: {
        reason: "stablecoins-cache-unavailable",
        fallbackMode: "stablecoins-cache-unavailable",
        stablecoinsCacheReason: stablecoinsCache.reason,
        dewsUnavailable: true,
      },
    });
  }

  const clocked = stablecoinsCache.payload.fxReferenceObservations !== undefined;
  const perObservation = options?.referenceMode === "per-observation" || clocked;
  const selections = clocked ? stablecoinsCache.payload.selectedPegReferences : undefined;
  const tracked = stablecoinsCache.payload.peggedAssets.filter((coin) => CORE_PSI_ELIGIBLE_IDS.has(coin.id));
  const legacyFxPegById = new Map(tracked.flatMap((asset) =>
    getPublishedLegacyPegReference(asset, stablecoinsCache.payload, stablecoinsCache.updatedAt)
      ? [[asset.id, normalizePegType(asset.pegType)] as const] : []));
  const now = Math.floor(Date.now() / 1000);

  let totalMcapUsd = 0;
  let pairedMcapUsd = 0;
  let pairedPrevWeek = 0;
  const mcapById = new Map<string, number>();
  const symbolById = new Map<string, string>();

  const supplyUnavailableIds: string[] = [];
  const carriedSupplyIds: string[] = [];
  const trendUnavailableIds: string[] = [];
  const nativeQuantityMomentum: Record<string, number> = {};
  for (const coin of tracked) {
    const mcap = getCirculatingRawOrNull(coin);
    if (mcap == null || !Number.isFinite(mcap) || mcap < 0) {
      supplyUnavailableIds.push(coin.id);
      continue;
    }
    // An outage-fallback restore keeps its original clock and source; it is a
    // documented weight, not a supply observation made by this run (R6).
    // Routine main-path carries (chain dropout, coverage restore) stay observed.
    if (isOutageFallbackCarry(coin)) carriedSupplyIds.push(coin.id);
    totalMcapUsd += mcap;
    const clock = coin.supplyObservedAt;
    const week = coin.supplyChangeBaselines?.week;
    const pairedStock = isRecord(week) && typeof week.observedAt === "number" && Number.isSafeInteger(week.observedAt) &&
      week.observedAt > 0 && typeof clock === "number" && Number.isSafeInteger(clock) && clock <= now &&
      clock > 0 && now - clock <= DAY_SECONDS &&
      matchesSupplySnapshotDay(week.observedAt, bucketUnixSecondsToUtcDay(clock) - 7 * DAY_SECONDS) &&
      !isOutageFallbackCarry(coin) && !isAmbiguousSupplyPerimeterDay(coin.id, week.observedAt) &&
      !isAmbiguousSupplyPerimeterDay(coin.id, clock) &&
      isEarlierSupplyPerimeter(coin.id, clock) === isEarlierSupplyPerimeter(coin.id, week.observedAt);
    const datedValuation = pairedStock &&
      hasDatedUsdValuation(coin.supplySource, clock, coin.valuationPriceUsd, coin.valuationObservedAtSec, now);
    const reportedDollarCap = coin.supplySource === "defillama";
    const paired = pairedStock && (reportedDollarCap || datedValuation);
    const prevWeek = paired || week === undefined ? getUsdMarketCapBaselineOrNull(coin, "week") : null;
    if (datedValuation && (!reportedDollarCap || coin.valuationObservedAtSec != null) &&
        typeof week.circulatingNative === "number" && Number.isFinite(week.circulatingNative) &&
        week.circulatingNative > 0 && coin.circulatingNative != null && Number.isFinite(coin.circulatingNative) &&
        coin.circulatingNative >= 0) {
      const change = ((coin.circulatingNative - week.circulatingNative) / week.circulatingNative) * 100;
      if (Number.isFinite(change)) nativeQuantityMomentum[coin.id] = change;
    }
    if (prevWeek != null && Number.isFinite(prevWeek) && prevWeek >= 0) {
      pairedMcapUsd += mcap;
      pairedPrevWeek += prevWeek;
    } else {
      trendUnavailableIds.push(coin.id);
    }
    mcapById.set(coin.id, mcap);
    symbolById.set(coin.id, coin.symbol);
  }

  const coreTrackedIds = new Set(
    tracked.filter((coin) => CORE_AGGREGATE_ACTIVE_IDS.has(coin.id)).map((coin) => coin.id),
  );
  const coreSupplyUnavailableCount = supplyUnavailableIds
    .filter((id) => CORE_AGGREGATE_ACTIVE_IDS.has(id))
    .length;
  const coreCarriedSupplyCount = carriedSupplyIds
    .filter((id) => CORE_AGGREGATE_ACTIVE_IDS.has(id))
    .length;
  const universeCoverage = {
    expected: CORE_AGGREGATE_ACTIVE_IDS.size,
    // Coverage measures the core aggregate cohort only; PSI-historical assets
    // are outside the denominator and supply availability is its own component.
    // Carried supply remains a published weight but is not admitted as an
    // observation this generation.
    present: coreTrackedIds.size,
    admittedSupply: coreTrackedIds.size - coreSupplyUnavailableCount - coreCarriedSupplyCount,
    missingFromCacheIds: [...CORE_AGGREGATE_ACTIVE_IDS]
      .filter((id) => !coreTrackedIds.has(id))
      .sort(),
    supplyUnavailableIds,
    carriedSupplyIds,
    trendUnavailableIds,
  };
  const universeCoverageStatus = classifyPsiUniverseCoverage(
    universeCoverage.expected,
    universeCoverage.present,
  );

  const mcap7dChangePct = Number.isFinite(pairedPrevWeek) && pairedPrevWeek > 0 && Number.isFinite(pairedMcapUsd)
    ? ((pairedMcapUsd - pairedPrevWeek) / pairedPrevWeek) * 100
    : null;
  if (!Number.isFinite(totalMcapUsd) || totalMcapUsd <= 0 || mcap7dChangePct == null || !Number.isFinite(mcap7dChangePct)) {
    const reason = !Number.isFinite(totalMcapUsd) || totalMcapUsd <= 0
      ? "insufficient-market-cap"
      : "trend-inputs-unavailable";
    return createCronResult({
      status: "degraded",
      itemCount: 0,
      metadata: {
        reason,
        fallbackMode: reason,
        totalMcapUsd,
        mcap7dChangePct: mcap7dChangePct != null && Number.isFinite(mcap7dChangePct) ? mcap7dChangePct : null,
        supplyUnavailableIds,
        trendUnavailableIds,
        preservedCurrentSample: true,
      },
    });
  }

  throwIfAborted(signal);

  // Active depegs — use current price to compute live deviation
  let activeDepegs: D1Result<PsiActiveDepegRow>;
  try {
    const eligible = auditVerdictNotInSql("p.audit_verdict", PEG_SCORE_EXCLUDED_AUDIT_VERDICTS);
    const query = (receipt: boolean) => db
      .prepare(`SELECT e.id, e.stablecoin_id, e.peg_reference, e.started_at, e.peg_type, e.source, e.pending_reason, e.direction,
                       e.start_price, e.peak_deviation_bps, e.ended_at, e.recovery_price, e.last_trusted_price_at,
                       e.price_coverage_gap_started_at, p.quote_mode,
                       nq.value AS current_native_quote${receipt ? `, e.peer_basis_json, e.peak_price, e.peak_peg_reference,
                       e.peak_quote_domain, e.admitted_coverage_json, e.disposition` : ""}
                FROM depeg_events e LEFT JOIN depeg_event_provenance p ON p.event_id = e.id
                LEFT JOIN cache nq ON nq.key = '${NATIVE_EVENT_QUOTE_CACHE_PREFIX}' || e.id
                WHERE e.ended_at IS NULL AND ${eligible.sql}
                  ${receipt ? `AND NOT ${reviewedDepegDisputeSql("e", false)}` : ""}`)
      .bind(...eligible.binds)
      .all<PsiActiveDepegRow>();
    activeDepegs = await query(true).catch((error: unknown) => {
      if (error instanceof Error && /no such column: e\.peer_basis_json\b/i.test(error.message)) return query(false);
      throw error;
    });
  } catch (err) {
    logWorkerEventArgs("handler", "warn", "[stability-index] depeg query failed:", err);
    const depegEventsFailureReason = String(err);
    return createCronResult({
      status: "degraded",
      itemCount: 0,
      metadata: {
        reason: "depeg-events-unavailable",
        fallbackMode: "depeg-events-unavailable",
        depegEventsUnavailable: true,
        depegEventsFailureReason,
        totalMcapUsd,
        mcap7dChangePct,
      },
    });
  }

  const priceById = new Map<string, { price: number; observedAt: number | null; upstreamObservedAt: number | null }>();
  for (const coin of tracked) {
    if (coin.priceSource !== COINGECKO_NATIVE_IMPLIED_SOURCE &&
        isParityPrice(coin) && coin.price != null && typeof coin.price === "number" && coin.price > 0) {
      const upstreamObservedAt = sourceObservationClock(coin);
      priceById.set(coin.id, { price: coin.price, upstreamObservedAt,
        observedAt: (perObservation && !legacyFxPegById.has(coin.id)) || coin.id === "xagm-matrixdock"
          ? upstreamObservedAt : coin.priceObservedAt ?? null });
    }
  }

  // Keep already-open depegs in PSI when the current stablecoins snapshot temporarily
  // lacks a usable price but we still have a recent replay-safe positive cached price.
  const replayPriceById = new Map<string, { price: number; observedAt: number | null }>();
  try {
    const replayPriceCache = await getPriceCache(db);
    for (const [assetId, cached] of replayPriceCache) {
      // The cache does not preserve parity-unit proof for these assets.
      if (assetId === "xofm-mento" || assetId === "susd-solayer") continue;
      // Replay fallback uses only replay-safe cached values; a nominal par
      // reference is not an observed price and cannot turn an open depeg into
      // measured calm. Legacy `protocol-redeem` par rows carry no mode.
      if (!isReplaySafePriceSource(cached.source) || cached.observedAtMode === "nominal_reference") continue;
      if (cached.source === "protocol-redeem" && protocolParProvider.matches(assetId)) continue;
      if (
        cached.price != null &&
        Number.isFinite(cached.price) &&
        cached.price > 0 &&
        Number.isFinite(cached.updatedAt) &&
        cached.updatedAt <= now &&
        now - cached.updatedAt < REPLAY_PRICE_CACHE_TTL_SEC
      ) {
        replayPriceById.set(assetId, { price: cached.price, observedAt: cached.hasExplicitClocks && cached.observedAtMode === "upstream" ? cached.observedAt ?? null : null });
      }
    }
  } catch (error) {
    logWorkerEventArgs("handler", "warn", "[stability-index] replay price cache unavailable; open-depeg fallback disabled:", error);
  }

  // Read DEWS stress signals (from previous 15-min cycle) for stress breadth
  let dewsRows: { stablecoin_id: string; band: string }[] = [];
  let dewsUnavailable = false;
  let dewsFailureReason: string | null = null;
  let dewsLatestComputedAt: number | null = null;
  let dewsRowsRead = 0;
  const publishedDews = await loadPublishedStressSignalGeneration(db, now);
  throwIfAborted(signal);
  if (publishedDews.status !== "ok" || !publishedDews.exactCoverageVerified) {
    dewsUnavailable = true;
    dewsFailureReason = publishedDews.status !== "ok" ? publishedDews.reason : "generation-coverage-unverified";
  } else {
    const rows = publishedDews.rows.filter((row) => CORE_PSI_ELIGIBLE_IDS.has(row.stablecoin_id));
    dewsRows = rows;
    dewsRowsRead = rows.length;
    for (const row of rows) {
      if (!Number.isFinite(row.computed_at)) {
        dewsUnavailable = true;
        dewsFailureReason ??= "stress_signals latest rows are missing computed_at";
        continue;
      }

      dewsLatestComputedAt =
        dewsLatestComputedAt == null ? row.computed_at : Math.max(dewsLatestComputedAt, row.computed_at);

      const rowAgeSec = now - row.computed_at;
      if (rowAgeSec > DEWS_STRESS_MAX_AGE_SEC) {
        dewsUnavailable = true;
        dewsFailureReason ??= `stress_signals latest row for ${row.stablecoin_id} is stale (ageSec=${rowAgeSec}, maxAgeSec=${DEWS_STRESS_MAX_AGE_SEC})`;
      }
    }
  }

  if (dewsUnavailable) {
    return createCronResult({
      status: "degraded",
      itemCount: 0,
      metadata: {
        reason: "dews-unavailable",
        fallbackMode: "dews-unavailable",
        dewsUnavailable,
        dewsFailureReason,
        dewsLatestComputedAt,
        dewsRowsRead,
        dewsMaxAgeSec: DEWS_STRESS_MAX_AGE_SEC,
        totalMcapUsd,
        mcap7dChangePct,
        preservedCurrentSample: true,
      },
    });
  }

  type DepegRow = PsiActiveDepegRow;
  const usesLegacyScoring = (id: string, event: DepegRow) => {
    const legacyPeg = legacyFxPegById.get(id);
    const pegKey = normalizePegType(event.peg_type);
    return !hasPeerDeviationReceipt(event) && (
      !perObservation || (legacyPeg !== undefined && legacyPeg === pegKey) ||
      (options?.referenceMode !== "per-observation" && pegKey === "peggedUSD"));
  };
  const grouped = new Map<string, DepegRow[]>();
  for (const r of activeDepegs.results ?? []) {
    const canonicalId = canonicalizePsiStablecoinId(r.stablecoin_id);
    if (!CORE_PSI_ELIGIBLE_IDS.has(canonicalId)) continue;
    const coverage = readDepegCoverageLedger(r);
    if (coverage !== undefined && !coverage?.some(({ fromSec, toSec }) => fromSec <= now && now < toSec)) {
      const latest = coverage ? coverage[coverage.length - 1] : undefined;
      // A fresh direct quote can reach the next PSI slot without extending the stored event history.
      if (!latest || now < latest.toSec || r.last_trusted_price_at !== latest.toSec - 1 ||
          r.price_coverage_gap_started_at != null || hasPeerDeviationReceipt(r)) continue;
      const current = priceById.get(canonicalId);
      const observedAt = isNativePegEvent(r)
        ? readAdmittedNativeEventObservation(r, now, usesLegacyScoring(canonicalId, r) &&
          getReferenceMarket(PSI_ELIGIBLE_META_BY_ID.get(canonicalId)?.flags.pegCurrency) != null)?.observedAt
        : current ? current.upstreamObservedAt : replayPriceById.get(canonicalId)?.observedAt;
      if (observedAt == null || !Number.isSafeInteger(observedAt) || now - observedAt > DEPEG_MAX_CONTINUOUS_OBSERVATION_GAP_SEC ||
          observedAt < latest.fromSec || observedAt >= latest.toSec) continue;
    }
    const list = grouped.get(canonicalId) ?? [];
    list.push(r);
    grouped.set(canonicalId, list);
  }

  const depegs: { bps: number; mcapUsd: number; depegAgeDays: number }[] = [];
  const contributors: {
    id: string;
    symbol: string;
    bps: number;
    mcapUsd: number;
    ageDays: number;
    factor: number;
  }[] = [];
  let replayPriceFallbackCount = 0;
  let openDepegsWithoutPrice = 0;
  const hasScheduledEvent = [...grouped].some(([id, events]) =>
    getReferenceMarket(PSI_ELIGIBLE_META_BY_ID.get(id)?.flags.pegCurrency) != null &&
    events.some((event) => !legacyFxPegById.has(id) || legacyFxPegById.get(id) !== normalizePegType(event.peg_type)));
  let legacyPegRates: ReturnType<typeof derivePegRates> | undefined;
  const closedSince = { metal: getReferenceMarketClosureStart("metal", now), fx: getReferenceMarketClosureStart("fx", now) };
  const baselines = new Map<number, Awaited<ReturnType<typeof loadPreClosureContributorBps>>>();
  const heldContributorIds = new Set<string>();
  const eventContributions: Record<number, PsiEventContribution> = {};
  const referenceAdmissions: Record<number, ReferenceAdmission> = {};
  const peerSubjectIds = new Set([...grouped].flatMap(([id, events]) =>
    events.some(hasPeerDeviationReceipt) ? [id] : []));
  let previous: Partial<Record<number, PsiEventContribution>> = {};
  if ((perObservation && hasScheduledEvent) || peerSubjectIds.size > 0) {
    try {
      const row = await db.prepare(
        "SELECT input_snapshot FROM stability_index_samples WHERE stored_at <= ? ORDER BY stored_at DESC LIMIT 1",
      ).bind(now).first<{ input_snapshot: string }>();
      if (row) {
        const snapshot: unknown = JSON.parse(row.input_snapshot);
        if (!isRecord(snapshot) || (snapshot.eventContributions !== undefined && !isRecord(snapshot.eventContributions))) {
          throw new Error("invalid PSI contribution snapshot");
        }
        previous = (snapshot.eventContributions ?? {}) as Partial<Record<number, PsiEventContribution>>;
      }
    } catch (error) {
      logWorkerEventArgs("handler", "warn", "[stability-index] prior admitted contributions unreadable:", error);
      // An admitted candidate can still predate the durable carry.
      return createCronResult({
        status: "degraded", itemCount: 0,
        metadata: { reason: "prior-contribution-unavailable", preservedCurrentSample: true },
      });
    }
  }
  const peerAssets = peerSubjectIds.size
    ? stablecoinsCache.payload.peggedAssets.filter((asset) => !TRACKED_META_BY_ID.get(asset.id)?.flags.navToken)
    : [];
  const peerAssetById = new Map(peerAssets.filter((asset) => peerSubjectIds.has(asset.id)).map((asset) => [asset.id, asset]));
  const peerRates = derivePegRates(peerAssets, TRACKED_META_BY_ID, undefined);
  let peerPools: Awaited<ReturnType<typeof loadDexPoolChallengers>> | undefined;
  if (peerAssetById.size > 0) {
    attachDetectionReferenceContext(peerRates.rates, peerAssets, TRACKED_META_BY_ID,
      new Set((activeDepegs.results ?? []).map(({ stablecoin_id }) => stablecoin_id)), null);
    try {
      peerPools = await loadDexPoolChallengers(db, POOL_CHALLENGE_MIN_TVL, DEX_PROTOCOL_SOURCE_FRESHNESS_SEC, now);
    } catch (error) {
      logWorkerEventArgs("handler", "warn", "[stability-index] peer corroboration unavailable:", error);
    }
  }

  for (const [coinId, events] of grouped) {
    const mcapUsd = mcapById.get(coinId);
    const meta = PSI_ELIGIBLE_META_BY_ID.get(coinId);
    const market = getReferenceMarket(meta?.flags.pegCurrency);
    const session = market == null ? null : getReferenceSessionState(market, now);
    const currentPrice = priceById.get(coinId);
    const dynamicWeight = coinId === "xagm-matrixdock";
    const commodityEntitlement = dynamicWeight ? tracked.find((asset) => asset.id === coinId)?.commodityEntitlement : undefined;
    const replayPrice = replayPriceById.get(coinId);
    const usdQuote = currentPrice ?? replayPrice;
    if (currentPrice == null && replayPrice != null && events.some((event) => !isNativePegEvent(event))) {
      replayPriceFallbackCount++;
    }

    const aggregate = { worstBps: 0, earliestStart: Infinity };
    const legacyAggregate = { worstBps: 0, earliestStart: Infinity };
    const legacyEvents = events.filter((event) => usesLegacyScoring(coinId, event));
    if (mcapUsd == null && legacyEvents.length === events.length) continue;
    const legacyClosureStart = market && legacyEvents.length ? getLegacyReferenceClosureStart(market, now) : null;
    let missingPrice = false;
    let unsupportedBasis = false;
    let legacyMaxAbsBps = 0;
    for (const event of events) {
      const pegKey = normalizePegType(event.peg_type);
      const native = isNativePegEvent(event);
      const peerRelative = hasPeerDeviationReceipt(event);
      const legacy = usesLegacyScoring(coinId, event);
      const quoteMode = event.quote_mode;
      if (quoteMode != null && quoteMode !== "usd" && quoteMode !== "native-peg") {
        if (legacy) {
          unsupportedBasis = missingPrice = true;
          continue;
        }
        return createCronResult({
          status: "degraded", itemCount: 0,
          metadata: { reason: "event-quote-basis-unsupported", eventId: event.id, preservedCurrentSample: true },
        });
      }
      const nativeQuote = native ? readAdmittedNativeEventObservation(event, now,
        legacy && market != null) : null;
      const quoteUnit = { assetId: coinId, commodityEntitlement,
        quoteObservedAtSec: native ? nativeQuote?.observedAt : usdQuote?.observedAt };
      const eventReference = native ? getCommodityOuncesAtQuote(event.peg_reference, quoteUnit) : event.peg_reference;
      if (legacy) {
        const price = native ? nativeQuote?.value : usdQuote?.price;
        let deviation;
        if (!native && pegKey !== "peggedUSD") {
          legacyPegRates ??= derivePegRates(stablecoinsCache.payload.peggedAssets, TRACKED_META_BY_ID,
            stablecoinsCache.payload.fxFallbackRates);
          const current = deriveAuthoritativePegSignal({
            price, pegCurrency: meta?.flags.pegCurrency, pegType: event.peg_type, ...quoteUnit,
            pegRates: legacyPegRates.rates, pegRateSources: legacyPegRates.sources,
            pegRateCounts: legacyPegRates.counts, commodityOunces: meta?.commodityOunces,
          });
          deviation = current.kind === "signal" ? current.signal : null;
        } else {
          deviation = price != null && eventReference != null ? deriveDepegSignal(price, eventReference) : null;
        }
        // A legacy quote can show a severe move during the fixed-UTC closure.
        const heldNative = nativeQuote && !nativeQuote.traded && legacyClosureStart != null &&
          deviation && deviation.absRawBps < DEPEG_SEVERITY_BPS.severe;
        if (deviation && !heldNative) {
          includePsiEventDeviation(legacyAggregate, deviation.bps, event.started_at);
          legacyMaxAbsBps = Math.max(legacyMaxAbsBps, deviation.absRawBps);
        } else {
          missingPrice = true;
        }
        continue;
      }
      let observedAt = usdQuote?.observedAt ?? null;
      let bps: number | null = null;
      if (peerRelative) {
        const stored = event.peg_type == null ? undefined : readPeerDeviationMarks({ ...event, peg_type: event.peg_type })
          .find((mark) => mark.availableAt <= now);
        bps = stored?.rawBps ?? null;
        observedAt = stored?.quoteObservedAt ?? null;
        const asset = peerAssetById.get(coinId);
        if (stored && asset && meta && peerPools?.has(coinId)) {
          const reference = assessDetectionReference({
            asset, meta, pegRates: peerRates.rates, pegRateSources: peerRates.sources, now, signal: null,
          });
          const current = reference && assessIndependentPeerMove({
            asset, reference, native: null, pools: peerPools.get(coinId), now,
            threshold: getDepegThresholdBps(event.peg_type), recoveryThreshold: getDepegRecoveryThresholdBps(event.peg_type),
          });
          const clock = sourceObservationClock(asset);
          if (current && clock != null && clock >= event.started_at && clock > stored.quoteObservedAt) {
            bps = current.signal.rawBps;
            observedAt = clock;
          }
        }
      } else if (native) {
        const quote = nativeQuote;
        observedAt = quote?.observedAt ?? null;
        if (quote && eventReference != null && (quote.traded || (session?.open && quote.observedAt >= session.sessionOpenedAtSec))) {
          bps = deriveDepegSignal(quote.value, eventReference)?.bps ?? null;
        }
      } else if (pegKey === "peggedUSD") {
        bps = usdQuote ? deriveDepegSignal(usdQuote.price, event.peg_reference)?.bps ?? null : null;
      }
      if (market && pegKey && bps == null && !peerRelative && !native) {
        const reference = getPublishedReferenceEvidence(selections?.[pegKey],
          `stablecoins:${stablecoinsCache.updatedAt}`, now);
        const pegRef = reference && getPegReference(pegKey, { [pegKey]: reference.usdPerUnit }, meta?.commodityOunces, quoteUnit);
        const signal = pegRef != null && usdQuote ? deriveDepegSignal(usdQuote.price, pegRef) : null;
        const raw = signal && Number.isFinite(signal.rawBps) ? asRawDeviationBps(signal.rawBps) : null;
        const admission = evaluateReferenceAdmission({ ...(reference ?? { kind: "none" }),
          decisionAtSec: now, quoteObservedAtSec: observedAt, rawDeviationBps: raw,
        });
        referenceAdmissions[event.id] = admission;
        bps = admittedDeviationBps(raw, admission);
      }
      if (market) {
        let carried = previous[event.id];
        const evidenceAt = carried?.observedAt ?? carried?.legacySampleAt;
        if (carried?.startedAt !== event.started_at || !Number.isFinite(carried.bps) ||
            (peerRelative && (carried.basis !== "peer-relative" || carried.observedAt == null)) ||
            evidenceAt == null || !Number.isSafeInteger(evidenceAt) || evidenceAt > now ||
            evidenceAt < event.started_at - (peerRelative ? DEPEG_PRIMARY_PRICE_MAX_AGE_SEC : 0)) {
          carried = undefined;
        }
        if (bps != null && observedAt != null && (peerRelative || observedAt >= event.started_at) &&
            (carried?.observedAt == null || observedAt > carried.observedAt)) {
          carried = { startedAt: event.started_at, bps, observedAt,
            ...(peerRelative ? { basis: "peer-relative", confidence: "low" } as const : {}),
          };
        } else {
          const closureStart = session?.closureStartSec;
          if (!peerRelative && !dynamicWeight && !carried && closureStart != null && events.length === 1 && event.started_at < closureStart) {
            if (!baselines.has(closureStart)) {
              baselines.set(closureStart, await loadPreClosureContributorBps(db, closureStart));
            }
            const baseline = baselines.get(closureStart);
            const legacyBps = baseline?.bpsById.get(coinId);
            if (baseline && baseline.storedAt >= event.started_at && legacyBps != null) {
              carried = { startedAt: event.started_at, bps: legacyBps, observedAt: null, legacySampleAt: baseline.storedAt };
            }
          }
          if (carried) heldContributorIds.add(coinId);
        }
        bps = carried?.bps ?? null;
        if (carried) eventContributions[event.id] = carried;
        else {
          const reason = !native && pegKey !== "peggedUSD" && referenceAdmissions[event.id]?.kind === "none"
            ? "selected-reference-unavailable" : "admitted-contribution-unavailable";
          return createCronResult({
            status: "degraded", itemCount: 0,
            metadata: { reason, eventId: event.id, preservedCurrentSample: true },
          });
        }
      }
      if (bps == null) {
        missingPrice = true;
        continue;
      }
      includePsiEventDeviation(aggregate, bps, event.started_at);
    }

    if (legacyEvents.length && !dynamicWeight && !unsupportedBasis && legacyClosureStart != null &&
        legacyEvents.every((event) => Math.max(event.started_at, event.last_trusted_price_at ?? 0) < legacyClosureStart) &&
        legacyMaxAbsBps < DEPEG_SEVERITY_BPS.severe) {
      if (!baselines.has(legacyClosureStart)) {
        baselines.set(legacyClosureStart, await loadPreClosureContributorBps(db, legacyClosureStart));
      }
      const baseline = baselines.get(legacyClosureStart);
      const held = baseline && !events.some((event) => hasPeerDeviationReceipt(event) && event.started_at <= baseline.storedAt)
        ? baseline.bpsById.get(coinId) : undefined;
      missingPrice = held == null;
      if (held == null) {
        legacyAggregate.earliestStart = Infinity;
      } else {
        legacyAggregate.worstBps = held;
        legacyAggregate.earliestStart = Math.min(...legacyEvents.map((event) => event.started_at));
        heldContributorIds.add(coinId);
      }
    }
    if (legacyAggregate.earliestStart !== Infinity) {
      includePsiEventDeviation(aggregate, legacyAggregate.worstBps, legacyAggregate.earliestStart);
    }
    if (missingPrice) openDepegsWithoutPrice++;
    const { worstBps, earliestStart } = aggregate;
    if (mcapUsd == null || earliestStart === Infinity) continue;
    const ageDays = Math.max(0, (now - earliestStart) / DAY_SECONDS);

    depegs.push({ bps: worstBps, mcapUsd, depegAgeDays: ageDays });

    contributors.push({
      id: coinId,
      symbol: symbolById.get(coinId) ?? coinId,
      bps: worstBps,
      mcapUsd,
      ageDays: round1(ageDays),
      factor: getDepreciationFactor(ageDays),
    });
  }

  throwIfAborted(signal);
  const degradedComponents: string[] = [
    ...(openDepegsWithoutPrice > 0 ? ["open-depeg-no-price"] : []),
    ...(supplyUnavailableIds.length > 0 ? ["supply-unavailable"] : []),
    ...(trendUnavailableIds.length > 0 ? ["trend-inputs-unavailable"] : []),
    ...(carriedSupplyIds.length > 0 ? ["carried-supply"] : []),
    ...(universeCoverageStatus !== "ok" ? ["universe-coverage"] : []),
  ];

  const dewsStressBreadth = computePsiStressBreadth(dewsRows, mcapById, new Set(contributors.map(({ id }) => id)));
  const result = computeStabilityIndex({ depegs, totalMcapUsd, mcap7dChangePct, dewsStressBreadth });
  if (!result) {
    logWorkerEventArgs("handler", "warn",
      `[stability-index] skipped sample due to insufficient market-cap input (totalMcapUsd=${totalMcapUsd})`,
    );
    return createCronResult({
      status: "degraded",
      itemCount: 0,
      metadata: {
        reason: "insufficient-market-cap",
        fallbackMode: "insufficient-market-cap",
        totalMcapUsd,
        depegCount: depegs.length,
        dewsStressBreadth,
        dewsUnavailable,
        dewsFailureReason,
        dewsLatestComputedAt,
        dewsRowsRead,
        dewsMaxAgeSec: DEWS_STRESS_MAX_AGE_SEC,
      },
    });
  }

  await db
    .prepare(
      `INSERT OR REPLACE INTO stability_index_samples (stored_at, score, band, components, input_snapshot, methodology_version)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      now,
      result.score,
      result.band,
      JSON.stringify(result.components),
      JSON.stringify({
        aggregateUniverse: CORE_STABLECOIN_AGGREGATE_UNIVERSE,
        depegCount: depegs.length,
        totalMcapUsd,
        mcap7dChangePct,
        ...(Object.keys(nativeQuantityMomentum).length ? { nativeQuantityMomentum } : {}),
        dewsStressBreadth,
        dewsUnavailable,
        dewsFailureReason,
        dewsLatestComputedAt,
        dewsRowsRead,
        dewsMaxAgeSec: DEWS_STRESS_MAX_AGE_SEC,
        replayPriceFallbackCount,
        openDepegsWithoutPrice,
        degradedComponents,
        supplyUnavailableIds,
        carriedSupplyIds,
        trendUnavailableIds,
        universeCoverage: {
          ...universeCoverage,
          status: universeCoverageStatus,
        },
        contributors,
        referenceScoringMode: perObservation ? "per-observation" : "legacy",
        eventContributions,
        referenceAdmissions,
        ...(heldContributorIds.size > 0 ? { heldContributorIds: [...heldContributorIds] } : {}),
        ...(closedSince.metal != null || closedSince.fx != null
          ? {
            referenceMarketClosedSince: closedSince,
            referenceMarketBaselineAt: Object.fromEntries([...baselines].map(([since, base]) => [since, base?.storedAt ?? null])),
          }
          : {}),
        methodologyVersion: PSI_METHODOLOGY_VERSION,
      }),
      PSI_METHODOLOGY_VERSION,
    )
    .run();

  // Prune samples older than 90 days
  await db
    .prepare("DELETE FROM stability_index_samples WHERE stored_at < ?")
    .bind(Math.floor(Date.now() / 1000) - 90 * DAY_SECONDS)
    .run();

  logWorkerEventArgs("handler", "info", `[stability-index] score=${result.score} band=${result.band}`);
  return createCronResult({
    status: "ok",
    itemCount: 1,
    productivity: {
      productive: true,
      reason: "psi-sample-published",
      publications: [
        {
          surface: "psi",
          generationId: `psi:${now}`,
          publishedAt: now,
          candidateRows: 1,
          publishedRows: 1,
          expectedRows: 1,
          validationSummary: { methodologyVersion: PSI_METHODOLOGY_VERSION },
        },
      ],
    },
    metadata: {
      reason: "psi-sample-published",
      ...(degradedComponents.length > 0 ? {
        quality: { reason: degradedComponents[0], reasons: degradedComponents },
      } : {}),
      supplyUnavailableIds,
      carriedSupplyIds,
      trendUnavailableIds,
      supplyUnavailableCount: supplyUnavailableIds.length,
      carriedSupplyCount: carriedSupplyIds.length,
      trendUnavailableCount: trendUnavailableIds.length,
      universeCoverage: {
        ...universeCoverage,
        status: universeCoverageStatus,
      },
      aggregateUniverse: CORE_STABLECOIN_AGGREGATE_UNIVERSE,
      score: result.score,
      band: result.band,
      dewsStressBreadth,
      dewsUnavailable,
      dewsFailureReason,
      dewsLatestComputedAt,
      dewsRowsRead,
      dewsMaxAgeSec: DEWS_STRESS_MAX_AGE_SEC,
      replayPriceFallbackCount,
      openDepegsWithoutPrice,
      degradedComponents,
    },
  });
}
