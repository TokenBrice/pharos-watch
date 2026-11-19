import { API_FRESHNESS_MAX_AGE_SEC } from "@shared/lib/api-freshness";
import { formatUsdPriceAdaptive } from "@shared/lib/format";
import { DAY_SECONDS, SECONDS_PER_MINUTE } from "@shared/lib/time-constants";
import { currentAdmissionUnavailableReason } from "@shared/lib/reference-admission";
import { isObservedPrice } from "@shared/lib/pricing-source-policy";
import { ACTIVE_IDS, FROZEN_IDS, TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { buildSocialDepegBriefingElement } from "@shared/lib/social-card/templates";
import { loadStablecoinsCache } from "../lib/stablecoins-cache";
import { renderPng, socialCardMeasurer } from "../lib/og-render";
import { admittedDepegRecoveryAt } from "../lib/tape-projectors/depeg";
import {
  effectiveStartedAtSql, EXCLUDE_SUPERSEDED_ACTIVE_INCIDENT_EVENTS_SQL, readPublicDepegPeakBasis, type DepegPeakBasisRow,
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

async function renderDepegBriefing(db: D1Database): Promise<Response> {
  const now = Math.floor(Date.now() / 1000);
  const oneDayAgo = now - DAY_SECONDS;
  const [stablecoins, openEvents, closedEvents, newTodayResult] = await Promise.all([
    loadStablecoinsCache(db, { contract: "published" }),
    db.prepare(`SELECT e.stablecoin_id, e.symbol, e.direction, e.peak_deviation_bps, e.peg_reference,
                       e.peg_type, e.source, e.started_at, e.ended_at, e.start_price, p.quote_mode,
                       e.peak_price, e.peak_peg_reference, e.peak_quote_domain, e.peer_basis_json, e.pending_reason,
                       nq.value AS current_native_quote
                FROM depeg_events e LEFT JOIN depeg_event_provenance p ON p.event_id = e.id
                LEFT JOIN cache nq ON nq.key = '${NATIVE_EVENT_QUOTE_CACHE_PREFIX}' || e.id
                WHERE e.ended_at IS NULL AND ${EXCLUDE_SUPERSEDED_ACTIVE_INCIDENT_EVENTS_SQL}
                  AND NOT ${reviewedDepegDisputeSql("e")}`)
      .all<NativeEventPriceEvidence & DepegPeakBasisRow & {
        stablecoin_id: string; symbol: string; direction: "above" | "below";
        current_native_quote: string | null;
      }>(),
    db.prepare(`SELECT e.*
                FROM depeg_events e
                WHERE e.ended_at IS NOT NULL AND e.ended_at > ?
                  AND ${EXCLUDE_SUPERSEDED_ACTIVE_INCIDENT_EVENTS_SQL} AND NOT ${reviewedDepegDisputeSql("e")}`)
      .bind(oneDayAgo).all<Parameters<typeof admittedDepegRecoveryAt>[0]>(),
    db.prepare(`SELECT COUNT(*) as count
                FROM depeg_events e
                WHERE e.started_at > ? AND e.started_at <= ? AND ${effectiveStartedAtSql("e")} > ?
                  AND ${EXCLUDE_SUPERSEDED_ACTIVE_INCIDENT_EVENTS_SQL} AND NOT ${reviewedDepegDisputeSql("e")}`)
      .bind(oneDayAgo, now, oneDayAgo).first<{ count: number }>(),
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
  const eligibleEvents = openEvents.results.filter((row) =>
    ACTIVE_IDS.has(row.stablecoin_id) && !FROZEN_IDS.has(row.stablecoin_id));
  const openEventById = new Map<string, (typeof eligibleEvents)[number]>();
  for (const row of eligibleEvents) {
    const existing = openEventById.get(row.stablecoin_id);
    if (!existing || Math.abs(row.peak_deviation_bps) > Math.abs(existing.peak_deviation_bps)) {
      openEventById.set(row.stablecoin_id, row);
    }
  }
  const nativeQuoteTimes: number[] = [];

  const activeDepegs = [...openEventById.values()].map((row) => {
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
    return {
      symbol: nativeEvent ? `${row.symbol} (native peg)` : row.symbol,
      deviationBps: usesPublishedDeviation
        ? admittedBps == null ? null : Math.round(admittedBps)
        : legacyHeld ? null : legacySignal?.bps ?? null,
      ...(deviationHeld ? { deviationHeld } : {}),
      deviationStale: admission?.status === "stale-reference" || expiredAdmission === "reference-over-budget" || expiredAdmission === "quote-before-reopen",
      peakBps: row.direction === "below" ? -Math.abs(row.peak_deviation_bps) : Math.abs(row.peak_deviation_bps),
      ...readPublicDepegPeakBasis(row),
    };
  }).sort((a, b) => {
    if (a.deviationBps == null) return b.deviationBps == null ? Math.abs(b.peakBps) - Math.abs(a.peakBps) : 1;
    if (b.deviationBps == null) return -1;
    return Math.abs(b.deviationBps) - Math.abs(a.deviationBps);
  }).slice(0, 3);
  const recoveredToday = closedEvents.results.filter((row) => {
    const recoveryAt = admittedDepegRecoveryAt(row, { inferLegacyClose: true });
    return recoveryAt != null && recoveryAt > oneDayAgo && recoveryAt <= now;
  }).length;
  const rows = activeDepegs.map(({ symbol, deviationBps, deviationHeld, deviationStale, peakBps, peakBasis, peakPeerMedianUsd }) => ({
    symbol,
    current: deviationBps != null ? `${deviationBps > 0 ? "+" : ""}${deviationBps} bps`
      : deviationHeld ? "Reference market closed" : deviationStale ? "Reference not yet updated" : "Current unavailable",
    peak: `Peak ${peakBps} bps${peakBasis ? " vs peer median" : ""}`,
    ...(peakBasis ? { peakNote: peakPeerMedianUsd == null ? "Lower confidence"
      : `Peer median $${formatUsdPriceAdaptive(peakPeerMedianUsd)} · Lower confidence` } : {}),
  }));
  const measure = await socialCardMeasurer();
  const image = await renderPng(buildSocialDepegBriefingElement({
    assessedAt: utcMinute(now), total: openEventById.size, rows, recoveredToday,
    newToday: newTodayResult?.count ?? null,
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
