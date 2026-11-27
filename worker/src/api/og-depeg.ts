import { API_FRESHNESS_MAX_AGE_SEC } from "@shared/lib/api-freshness";
import {
  classifyOpenIncidentCoverage,
  classifyOpenIncidentTier,
  compareOpenIncidentRows,
  isNearParUnconfirmedOpenIncident,
} from "@shared/lib/active-depegs";
import { DDR_INCIDENT_REOPEN_MERGE_WINDOW_SEC } from "@shared/lib/depeg-config";
import { formatUsdPriceAdaptive } from "@shared/lib/format";
import { getCirculatingRawOrNull } from "@shared/lib/supply";
import { DAY_SECONDS, SECONDS_PER_MINUTE } from "@shared/lib/time-constants";
import { currentAdmissionUnavailableReason } from "@shared/lib/reference-admission";
import { isObservedPrice } from "@shared/lib/pricing-source-policy";
import { ACTIVE_IDS, FROZEN_IDS, TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { buildSocialDepegBriefingElement } from "@shared/lib/social-card/templates";
import { loadStablecoinsCache } from "../lib/stablecoins-cache";
import { renderPng, socialCardMeasurer } from "../lib/og-render";
import { admittedDepegRecoveryAt } from "../lib/tape-projectors/depeg";
import {
  isValidOptionalEscalationTimestamp,
  linkedOpenIncidentJsonFragment,
  reopenPredecessorJsonFragment,
  resolveOpenIncidentEscalationMetadata,
} from "../lib/depeg-escalation-metadata";
import { rowPriceCoverage, type DepegRow } from "../lib/depeg-helpers";
import { parseJson } from "../lib/json-parse";
import {
  effectiveStartedAtSql, EXCLUDE_SUPERSEDED_ACTIVE_INCIDENT_EVENTS_SQL, PROJECTED_DEPEG_PEAK_SQL,
  readProjectedDepegPeak, readPublicDepegPeakBasis, type DepegPeakBasisRow,
} from "../lib/depeg-event-projection";
import { reviewedDepegDisputeSql } from "@shared/data/depegs/reviewed-depeg-disposition-sql";
import { deriveCurrentPegObservationMap, type CurrentPegObservation } from "../lib/current-peg-observations";
import { deriveDepegSignal, readDeviationProjection } from "@shared/lib/depeg-signals";
import { getReferenceMarket, isReferenceDeviationHeld, isReferenceMarketClosed } from "@shared/lib/reference-market-hours";
import {
  isNativePegEvent,
  type NativeEventPriceEvidence,
  PSI_NATIVE_EVIDENCE_MAX_AGE_SEC,
} from "@shared/lib/depeg-quote-domain";
import { NATIVE_EVENT_QUOTE_CACHE_PREFIX } from "../lib/native-peg-quote-cache";
import { readAdmittedNativeEventObservation } from "../lib/psi-reference";

const unavailable = (reason: string) => new Response(reason, { status: 503, headers: {
  "Cache-Control": "no-store", "Retry-After": "60", "Content-Type": "text/plain",
} });
const utcMinute = (sec: number) => new Date(sec * 1000).toISOString().slice(0, 16).replace("T", " ");

function freshUntil(clock: number | null | undefined, budget: number, now: number): number | null {
  return clock != null && Number.isSafeInteger(clock) && clock > 0 && clock <= now && clock + budget > now
    ? clock + budget : null;
}

function parseOptionalTimestamp(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function parseRowCoverage(row: {
  id?: number;
  price_coverage_json?: string | null;
  last_trusted_price_at?: number | null;
  price_coverage_gap_started_at?: number | null;
}) {
  let priceCoverageJson = row.price_coverage_json ?? null;
  if (priceCoverageJson?.includes('"referenceHold"')) {
    const decoded = parseJson(priceCoverageJson);
    if (
      decoded.ok &&
      decoded.value != null &&
      typeof decoded.value === "object" &&
      !Array.isArray(decoded.value) &&
      "referenceHold" in decoded.value
    ) {
      const { referenceHold: _referenceHold, ...coverage } = decoded.value as Record<string, unknown>;
      priceCoverageJson = JSON.stringify(coverage);
    }
  }
  return rowPriceCoverage({
    id: typeof row.id === "number" ? row.id : 0,
    price_coverage_json: priceCoverageJson,
    last_trusted_price_at: row.last_trusted_price_at ?? null,
    price_coverage_gap_started_at: row.price_coverage_gap_started_at ?? null,
  } as DepegRow);
}

async function renderDepegBriefing(db: D1Database): Promise<Response> {
  const now = Math.floor(Date.now() / 1000);
  const oneDayAgo = now - DAY_SECONDS;
  const [stablecoins, openEvents, closedEvents, newTodayEvents] = await Promise.all([
    loadStablecoinsCache(db, { contract: "published" }),
    db.prepare(`SELECT e.id, e.stablecoin_id, e.symbol, e.direction, e.peak_deviation_bps, e.peg_reference,
                       e.peg_type, e.source, e.started_at, ${effectiveStartedAtSql("e")} AS effective_started_at,
                       e.ended_at, e.start_price, p.quote_mode,
                       e.peak_price, e.peak_peg_reference, e.peak_quote_domain, e.peer_basis_json, e.pending_reason,
                       e.peak_escalated_at, e.price_coverage_json, e.last_trusted_price_at, e.price_coverage_gap_started_at,
                       (SELECT COUNT(*) FROM depeg_events raw_open WHERE raw_open.ended_at IS NULL AND raw_open.stablecoin_id = e.stablecoin_id) AS physical_open_count,
                       ${linkedOpenIncidentJsonFragment("e")} AS linked_incident_json,
                       ${reopenPredecessorJsonFragment("e")} AS reopen_predecessor_json,
                       nq.value AS current_native_quote, ${PROJECTED_DEPEG_PEAK_SQL} AS incident_peak_json
                FROM depeg_events e LEFT JOIN depeg_event_provenance p ON p.event_id = e.id
                LEFT JOIN cache nq ON nq.key = '${NATIVE_EVENT_QUOTE_CACHE_PREFIX}' || e.id
                WHERE e.ended_at IS NULL AND ${EXCLUDE_SUPERSEDED_ACTIVE_INCIDENT_EVENTS_SQL}
                  AND NOT ${reviewedDepegDisputeSql("e")}`)
      .bind(DDR_INCIDENT_REOPEN_MERGE_WINDOW_SEC, DDR_INCIDENT_REOPEN_MERGE_WINDOW_SEC)
      .all<NativeEventPriceEvidence & DepegPeakBasisRow & {
        id?: number;
        stablecoin_id: string; symbol: string; direction: "above" | "below";
        effective_started_at?: number | null;
        peak_escalated_at?: number | null;
        price_coverage_json?: string | null;
        last_trusted_price_at?: number | null;
        price_coverage_gap_started_at?: number | null;
        physical_open_count?: number | null;
        linked_incident_json?: string | null;
        reopen_predecessor_json?: string | null;
        current_native_quote: string | null;
        incident_peak_json: string | null;
      }>(),
    db.prepare(`SELECT e.*
                FROM depeg_events e
                WHERE e.ended_at IS NOT NULL AND e.ended_at > ?
                  AND ${EXCLUDE_SUPERSEDED_ACTIVE_INCIDENT_EVENTS_SQL} AND NOT ${reviewedDepegDisputeSql("e")}`)
      .bind(oneDayAgo).all<Parameters<typeof admittedDepegRecoveryAt>[0]>(),
    db.prepare(`SELECT /* pharos:og-depeg:new-today */
                       e.id, e.started_at, ${effectiveStartedAtSql("e")} AS effective_started_at,
                       e.peak_deviation_bps, e.peak_escalated_at,
                       ${linkedOpenIncidentJsonFragment("e")} AS linked_incident_json,
                       ${reopenPredecessorJsonFragment("e")} AS reopen_predecessor_json
                FROM depeg_events e
                WHERE e.started_at > ? AND e.started_at <= ? AND ${effectiveStartedAtSql("e")} > ?
                  AND ${EXCLUDE_SUPERSEDED_ACTIVE_INCIDENT_EVENTS_SQL} AND NOT ${reviewedDepegDisputeSql("e")}`)
      .bind(
        DDR_INCIDENT_REOPEN_MERGE_WINDOW_SEC,
        DDR_INCIDENT_REOPEN_MERGE_WINDOW_SEC,
        oneDayAgo,
        now,
        oneDayAgo,
      )
      .all<{
        id?: number;
        started_at: number;
        effective_started_at?: number | null;
        peak_deviation_bps: number;
        peak_escalated_at?: number | null;
        linked_incident_json?: string | null;
        reopen_predecessor_json?: string | null;
      }>(),
  ]);
  if (openEvents.success !== true || !Array.isArray(openEvents.results) ||
      closedEvents.success !== true || !Array.isArray(closedEvents.results)) {
    return unavailable("incident-ledger-unavailable");
  }
  const marketFreshUntil = stablecoins.kind === "ok"
    ? freshUntil(stablecoins.updatedAt, API_FRESHNESS_MAX_AGE_SEC.stablecoins, now) : null;
  const assets = stablecoins.kind === "ok" ? stablecoins.payload.peggedAssets : [];
  const assetById = new Map(assets.map((asset) => [asset.id, asset]));
  let legacyObservations: Map<string, CurrentPegObservation> | undefined;
  let expiresAt = Math.min(now + SECONDS_PER_MINUTE, marketFreshUntil ?? Infinity);
  const eligibleEvents = openEvents.results
    .filter((row) => ACTIVE_IDS.has(row.stablecoin_id) && !FROZEN_IDS.has(row.stablecoin_id))
    .map((row) => ({ ...row, incidentPeak: readProjectedDepegPeak(row.incident_peak_json) }));
  const openRowCountByCoin = new Map<string, number>();
  for (const row of eligibleEvents) {
    openRowCountByCoin.set(row.stablecoin_id, (openRowCountByCoin.get(row.stablecoin_id) ?? 0) + 1);
  }
  const nativeQuoteTimes: number[] = [];

  const activeEntries = eligibleEvents.map((row) => {
    const asset = assetById.get(row.stablecoin_id);
    const quoteAt = asset?.priceObservedAt === undefined ? asset?.priceUpdatedAt : asset.priceObservedAt;
    const quoteFreshUntil = freshUntil(quoteAt, API_FRESHNESS_MAX_AGE_SEC.stablecoins, now);
    const nativeEvent = isNativePegEvent(row);
    const nativeObservation = nativeEvent
      ? readAdmittedNativeEventObservation(row, now)
      : null;
    const pegCurrency = TRACKED_META_BY_ID.get(row.stablecoin_id)?.flags.pegCurrency;
    const market = getReferenceMarket(pegCurrency);
    const closed = isReferenceMarketClosed(market, now);
    // Calendar edges occur on whole minutes. Never cache a reading across the next close or reopen.
    if (market && closed !== isReferenceMarketClosed(market, now + SECONDS_PER_MINUTE)) {
      expiresAt = Math.min(expiresAt, now - now % SECONDS_PER_MINUTE + SECONDS_PER_MINUTE);
    }
    const nativeHeld = nativeEvent && !nativeObservation?.traded && closed;
    if (nativeObservation && !nativeHeld) {
      nativeQuoteTimes.push(nativeObservation.observedAt);
      expiresAt = Math.min(expiresAt, nativeObservation.observedAt + PSI_NATIVE_EVIDENCE_MAX_AGE_SEC);
    }
    const usdAvailable = marketFreshUntil != null && asset && isObservedPrice(asset) &&
      typeof asset.price === "number" && Number.isFinite(asset.price) && asset.price > 0 && quoteFreshUntil != null;
    if (!nativeEvent && usdAvailable) expiresAt = Math.min(expiresAt, marketFreshUntil!, quoteFreshUntil!);
    const current = !nativeEvent && usdAvailable ? asset.currentPeg : undefined;
    const admission = current?.referenceAdmission;
    const currentUnavailable = current?.currentPriceUnavailable || current?.pegReferenceUnavailable;
    const projectedBps = readDeviationProjection(current, pegCurrency === "USD", quoteAt);
    const usesPublishedDeviation = !nativeEvent && (currentUnavailable || current?.currentDeviationBps === null || projectedBps !== undefined
      || (pegCurrency !== "USD" && stablecoins.kind === "ok" && stablecoins.payload.fxReferenceObservations !== undefined &&
        current?.legacyFxReference !== true));
    let legacySignal = null;
    if (nativeEvent && nativeObservation && !nativeHeld) {
      legacySignal = deriveDepegSignal(nativeObservation.value, row.peg_reference);
    } else if (!usesPublishedDeviation && usdAvailable && !nativeEvent && stablecoins.kind === "ok") {
      legacyObservations ??= deriveCurrentPegObservationMap({
        peggedAssets: assets, fxFallbackRates: stablecoins.payload.fxFallbackRates, asOf: stablecoins.updatedAt ?? now,
      });
      legacySignal = legacyObservations.get(row.stablecoin_id)?.currentSignal ?? null;
    }
    const legacyHeld = !nativeEvent && legacySignal != null && quoteAt != null &&
      isReferenceDeviationHeld(pegCurrency, quoteAt, legacySignal.absRawBps);
    const expiredAdmission = admission?.status === "admitted" && pegCurrency
      ? currentAdmissionUnavailableReason(admission, pegCurrency, asset?.priceObservedAt, now) : null;
    const deviationHeld = admission?.status === "held-closed-session" || expiredAdmission === "reference-market-closed"
      || legacyHeld || nativeHeld;
    const admittedBps = admission == null || (pegCurrency && expiredAdmission == null &&
      admission.referenceObservedAtSec === current?.pegReference?.asOf) ? projectedBps : null;
    if (admittedBps != null && admission?.referenceObservedAtSec != null && admission.budgetSec != null) {
      expiresAt = Math.min(expiresAt, admission.referenceObservedAtSec + admission.budgetSec);
    }
    const rawDeviationBps = usesPublishedDeviation
      ? (admittedBps ?? null)
      : legacyHeld ? null : (legacySignal?.rawBps ?? null);
    const deviationBps = rawDeviationBps == null ? null : Math.round(rawDeviationBps);
    const peakBps = row.incidentPeak?.peakDeviationBps ?? row.peak_deviation_bps;
    const baseEffectiveStartedAt = typeof row.effective_started_at === "number" ? row.effective_started_at : row.started_at;
    const escalationMeta =
      row.linked_incident_json != null || row.reopen_predecessor_json != null
        ? resolveOpenIncidentEscalationMetadata({
            started_at: row.started_at,
            peak_deviation_bps: row.peak_deviation_bps,
            peak_escalated_at: row.peak_escalated_at,
            linked_incident_json: row.linked_incident_json,
            reopen_predecessor_json: row.reopen_predecessor_json,
          })
        : null;
    const rawEscalationInvalid = !isValidOptionalEscalationTimestamp(row.peak_escalated_at);
    const effectiveStartedAt = escalationMeta ? escalationMeta.incidentStartedAt : baseEffectiveStartedAt;
    const escalatedAt = escalationMeta
      ? escalationMeta.effectiveEscalatedAt
      : rawEscalationInvalid
        ? null
        : parseOptionalTimestamp(row.peak_escalated_at);
    const tier = escalationMeta?.onsetIndeterminate || escalationMeta?.escalationInvalid || rawEscalationInvalid
      ? null
      : classifyOpenIncidentTier({ startedAt: effectiveStartedAt, escalatedAt }, now);
    const isSinglePhysicalOpen =
      typeof row.physical_open_count === "number"
        ? row.physical_open_count === 1
        : openRowCountByCoin.get(row.stablecoin_id) === 1;
    const coverage = isSinglePhysicalOpen ? parseRowCoverage(row) : null;
    const evidence = classifyOpenIncidentCoverage(coverage, now);
    const marketCapUsd = marketFreshUntil != null && asset ? getCirculatingRawOrNull(asset) : null;
    const exposureUsd =
      marketCapUsd != null && rawDeviationBps != null ? (marketCapUsd * Math.abs(rawDeviationBps)) / 10_000 : null;
    return {
      id: row.id != null ? `${row.stablecoin_id}:${row.id}` : row.stablecoin_id,
      stablecoinId: row.stablecoin_id,
      symbol: nativeEvent ? `${row.symbol} (native peg)` : row.symbol,
      bps: rawDeviationBps,
      deviationBps,
      exposureUsd,
      evidence,
      pegCurrency,
      tier,
      ...(deviationHeld ? { deviationHeld } : {}),
      deviationStale: admission?.status === "stale-reference" || expiredAdmission === "reference-over-budget" || expiredAdmission === "quote-before-reopen",
      peakBps: row.direction === "below" ? -Math.abs(peakBps) : Math.abs(peakBps),
      ...(row.incidentPeak
        ? { peakBasis: row.incidentPeak.peakBasis, peakPeerMedianUsd: row.incidentPeak.peakPeerMedianUsd }
        : readPublicDepegPeakBasis(row)),
    };
  });

  // Dedupe displayed Top 3 rows by coin while keeping `total`, `recentCount`, and
  // `longRunningCount` grounded in all eligible open event rows.
  const dedupeDisplayedByCoin = (entries: typeof activeEntries) => {
    const seen = new Set<string>();
    const picked: typeof activeEntries = [];
    for (const entry of entries) {
      if (seen.has(entry.stablecoinId)) continue;
      seen.add(entry.stablecoinId);
      picked.push(entry);
      if (picked.length >= 3) break;
    }
    return picked;
  };

  const splitValid = activeEntries.every((entry) => entry.tier !== null);
  let activeDepegs: typeof activeEntries;
  let recentCount: number | undefined;
  let longRunningCount: number | undefined;
  let showingLongRunningFallback: boolean | undefined;
  if (splitValid) {
    const recentEntries = activeEntries
      .filter((entry) => entry.tier !== "long_running")
      .sort(compareOpenIncidentRows);
    const longRunningEntries = activeEntries
      .filter((entry) => entry.tier === "long_running")
      .sort(compareOpenIncidentRows);
    recentCount = recentEntries.length;
    longRunningCount = longRunningEntries.length;
    showingLongRunningFallback = recentCount === 0 && longRunningCount > 0;
    activeDepegs = dedupeDisplayedByCoin(showingLongRunningFallback ? longRunningEntries : recentEntries);
  } else {
    activeDepegs = dedupeDisplayedByCoin([...activeEntries].sort(compareOpenIncidentRows));
  }

  // Apply canonical-onset and <=6h reopen resolution across all candidate 24h starts
  // (open and closed alike) so closing an unlinked reopen never inflates "new in 24h".
  let newToday: number | null = null;
  if (newTodayEvents.success === true && Array.isArray(newTodayEvents.results)) {
    let count = 0;
    let indeterminate = false;
    for (const row of newTodayEvents.results) {
      const baseEffectiveStartedAt =
        typeof row.effective_started_at === "number" ? row.effective_started_at : row.started_at;
      if (!(row.started_at > oneDayAgo && row.started_at <= now && baseEffectiveStartedAt > oneDayAgo)) continue;
      if (row.linked_incident_json != null || row.reopen_predecessor_json != null) {
        const meta = resolveOpenIncidentEscalationMetadata({
          started_at: row.started_at,
          peak_deviation_bps: row.peak_deviation_bps,
          peak_escalated_at: parseOptionalTimestamp(row.peak_escalated_at),
          linked_incident_json: row.linked_incident_json,
          reopen_predecessor_json: row.reopen_predecessor_json,
        });
        if (meta.resolutionKind === "reopen_continuation") {
          continue;
        }
        if (meta.onsetIndeterminate) {
          indeterminate = true;
          break;
        }
        if (Math.min(baseEffectiveStartedAt, meta.incidentStartedAt) <= oneDayAgo) {
          continue;
        }
      }
      count++;
    }
    newToday = indeterminate ? null : count;
  }

  const recoveredToday = closedEvents.results.filter((row) => {
    const recoveryAt = admittedDepegRecoveryAt(row, { inferLegacyClose: true });
    return recoveryAt != null && recoveryAt > oneDayAgo && recoveryAt <= now;
  }).length;
  const rows = activeDepegs.map(({ symbol, bps, deviationBps, deviationHeld, deviationStale, evidence, pegCurrency, peakBps, peakBasis, peakPeerMedianUsd }) => {
    const currentNote = deviationBps == null
      ? undefined
      : isNearParUnconfirmedOpenIncident(evidence, bps, pegCurrency)
        ? "Near par"
        : evidence === "unconfirmed"
          ? "Unconfirmed"
          : undefined;
    return {
      symbol,
      current: deviationBps != null ? `${deviationBps > 0 ? "+" : ""}${deviationBps} bps`
        : deviationHeld ? "Reference market closed" : deviationStale ? "Reference not yet updated" : "Current unavailable",
      ...(currentNote ? { currentNote } : {}),
      peak: `Peak ${peakBps} bps${peakBasis ? " vs peer median" : ""}`,
      ...(peakBasis ? { peakNote: peakPeerMedianUsd == null ? "Lower confidence"
        : `Peer median $${formatUsdPriceAdaptive(peakPeerMedianUsd)} · Lower confidence` } : {}),
    };
  });
  const measure = await socialCardMeasurer();
  const image = await renderPng(buildSocialDepegBriefingElement({
    assessedAt: utcMinute(now), total: eligibleEvents.length, rows, recoveredToday,
    newToday,
    ...(recentCount !== undefined && longRunningCount !== undefined
      ? { recentCount, longRunningCount, showingLongRunningFallback }
      : {}),
    marketAt: marketFreshUntil != null && stablecoins.updatedAt != null ? utcMinute(stablecoins.updatedAt) : null,
    nativeAt: nativeQuoteTimes.length ? utcMinute(Math.min(...nativeQuoteTimes)) : null,
  }, { measure, logos: new Map() }));
  const maxAge = Math.floor(expiresAt - Date.now() / 1000);
  if (maxAge <= 0) return unavailable("observation-expired");
  return new Response(image as Uint8Array<ArrayBuffer>, { headers: {
    "Content-Type": "image/png", "Cache-Control": `public, max-age=${maxAge}, s-maxage=${maxAge}`,
    "X-Content-Type-Options": "nosniff",
  } });
}

export async function handleDepegBriefingOg(db: D1Database): Promise<Response> {
  try {
    return await renderDepegBriefing(db);
  } catch (error) {
    console.error("[og-depeg] Render or source failed", error);
    return unavailable("render-or-source-failed");
  }
}
