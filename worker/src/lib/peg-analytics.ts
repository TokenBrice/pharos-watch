import { DEPEG_EVENT_MIN_SUPPLY_USD } from "@shared/lib/depeg-config";
import { WORKER_ACTIVE_STABLECOINS } from "@shared/lib/stablecoins/worker-runtime-registry";
import {
  computePegScore,
  computeRecentPegStats,
  coinTrackingStart,
  NULL_PEG_SCORE_RESULT,
  PEG_SCORE_LOOKBACK_SEC,
} from "@shared/lib/peg-score";
import { getMethodologyVersionAt } from "@shared/lib/methodology-versions/registry";
import { getCirculatingRawOrNull } from "@shared/lib/supply";
import { isObservedPrice } from "@shared/lib/pricing-source-policy";
import type { DepegEvent, StablecoinData } from "@shared/types/market";
import type { PegSummaryCoin } from "@shared/types/peg";

import { type DepegRow } from "./depeg-helpers";
import {
  EXCLUDE_SUPERSEDED_ACTIVE_INCIDENT_EVENTS_SQL,
  IncidentProjectionUnavailableError,
  loadActiveIncidentProjections,
  rowToPublicDepegEvent,
} from "./depeg-event-projection";
import { getFirstSeenDates } from "./db";
import { deriveCurrentPegObservationMap } from "./current-peg-observations";

export interface DerivePegAnalyticsOptions {
  peggedAssets: StablecoinData[];
  fxFallbackRates?: Record<string, number>;
  methodologyAsOf: number;
  includeNavTokens?: boolean;
}

export interface PegAnalyticsSnapshot {
  nowSec: number;
  allEvents: DepegEvent[];
  eventsByCoin: Map<string, DepegEvent[]>;
  pegDataById: Map<string, PegSummaryCoin>;
}

function parseLaunchDateSec(dateText: string | undefined): number | null {
  if (!dateText) return null;
  const parsedMs = Date.parse(`${dateText}T00:00:00Z`);
  return Number.isFinite(parsedMs) ? Math.floor(parsedMs / 1000) : null;
}

type PegHistoryCoverage = NonNullable<PegSummaryCoin["historyCoverage"]>;

function resolveTrackingAnchor(
  meta: (typeof WORKER_ACTIVE_STABLECOINS)[number],
  events: DepegEvent[],
  firstObservedAtSec: number | undefined,
  fourYearsAgoSec: number,
): { trackingStart: number | null; coverage: PegHistoryCoverage | null } {
  const auditedCoverageStart = parseLaunchDateSec(meta.pegScoreCoverage?.startDate);
  const launchStart = parseLaunchDateSec(meta.launchDate);
  const anchor = auditedCoverageStart ?? launchStart ?? firstObservedAtSec ?? null;
  const trackingStart = coinTrackingStart(events, fourYearsAgoSec, anchor);
  if (trackingStart == null) return { trackingStart: null, coverage: null };

  const source: PegHistoryCoverage["source"] = auditedCoverageStart != null
    ? "audited-replay"
    : launchStart != null
      ? "asset-age"
      : firstObservedAtSec != null
        ? "first-observation"
        : "first-event";

  return {
    trackingStart,
    coverage: {
      startedAt: trackingStart,
      source,
      status: auditedCoverageStart != null ? "verified" : "assumed",
    },
  };
}

function hasUsableCurrentPrice(asset: StablecoinData): asset is StablecoinData & { price: number } {
  return isObservedPrice(asset) && typeof asset.price === "number" && Number.isFinite(asset.price) && asset.price > 0;
}

function buildPriceFirstSeenObservations(
  assets: readonly StablecoinData[],
  fallbackObservedAtSec: number,
): Array<{ id: string; observedAtSec: number }> {
  const observations: Array<{ id: string; observedAtSec: number }> = [];
  for (const asset of assets) {
    if (!hasUsableCurrentPrice(asset)) continue;
    const observedAtSec =
      asset.priceSyncedAt ??
      asset.priceUpdatedAt ??
      asset.priceObservedAt ??
      fallbackObservedAtSec;
    if (typeof observedAtSec === "number" && Number.isFinite(observedAtSec) && observedAtSec > 0) {
      observations.push({ id: asset.id, observedAtSec });
    }
  }
  return observations;
}

export async function derivePegAnalyticsSnapshot(
  db: D1Database,
  options: DerivePegAnalyticsOptions,
): Promise<PegAnalyticsSnapshot> {
  const includeNavTokens = options.includeNavTokens ?? false;
  const nowSec = Math.floor(Date.now() / 1000);
  const fourYearsAgoSec = nowSec - PEG_SCORE_LOOKBACK_SEC;

  const activeIncidentProjectionLoad = await loadActiveIncidentProjections(db, null);
  if (!activeIncidentProjectionLoad.available) throw new IncidentProjectionUnavailableError();
  const firstSeenMap = await getFirstSeenDates(
    db,
    buildPriceFirstSeenObservations(options.peggedAssets, options.methodologyAsOf),
  );
  const activeIncidentCondition = ` AND ${EXCLUDE_SUPERSEDED_ACTIVE_INCIDENT_EVENTS_SQL}`;
  const eventsResult = await db.prepare(
    `SELECT /* pharos:peg-analytics:recent-depeg-events */
       * FROM depeg_events_with_provenance WHERE (ended_at IS NULL OR ended_at > ?)${activeIncidentCondition} ORDER BY started_at DESC`,
  )
    .bind(fourYearsAgoSec)
    .all<DepegRow>();

  const allEvents = (eventsResult.results ?? []).map((row) =>
    rowToPublicDepegEvent(row, activeIncidentProjectionLoad.projections),
  );
  const eventsByCoin = new Map<string, DepegEvent[]>();
  for (const event of allEvents) {
    const list = eventsByCoin.get(event.stablecoinId) ?? [];
    list.push(event);
    eventsByCoin.set(event.stablecoinId, list);
  }

  const priceById = new Map(options.peggedAssets.map((asset) => [asset.id, asset]));
  const currentPegObservationById = deriveCurrentPegObservationMap({
    peggedAssets: options.peggedAssets,
    fxFallbackRates: options.fxFallbackRates,
    asOf: options.methodologyAsOf,
  });
  const methodologyVersion = getMethodologyVersionAt("depeg-dews", options.methodologyAsOf);
  const trackingFallbackStart = nowSec - PEG_SCORE_LOOKBACK_SEC;

  const pegDataById = new Map<string, PegSummaryCoin>();
  for (const meta of WORKER_ACTIVE_STABLECOINS) {
    if (!includeNavTokens && meta.flags.navToken) continue;

    const asset = priceById.get(meta.id);
    const events = eventsByCoin.get(meta.id) ?? [];
    // Unknown supply is neither above nor below the floor: it is flagged
    // `currentSupplyUnavailable`, never counted as coverage-limited.
    const supply = getCirculatingRawOrNull(asset);
    const depegEventCoverageLimited =
      !meta.flags.navToken &&
      supply !== null &&
      supply > 0 &&
      supply < DEPEG_EVENT_MIN_SUPPLY_USD;

    // Price availability is a distinct fact from peg-reference authority: a coin
    // with no usable price observation has an UNOBSERVED deviation, not a
    // withheld or quiet one. Downstream scoring must be able to tell the two
    // apart instead of reading the shared null as "at peg".
    const currentPegObservation = currentPegObservationById.get(meta.id) ?? {
      currentDeviationBps: null,
      pegReference: null,
      pegReferenceUnavailable: false,
      currentPriceUnavailable: !meta.flags.navToken,
      currentSupplyUnavailable: !meta.flags.navToken,
    };

    const { trackingStart, coverage: historyCoverage } = resolveTrackingAnchor(
      meta,
      events,
      firstSeenMap.get(meta.id),
      trackingFallbackStart,
    );
    const scoreResult = meta.flags.navToken
      ? { ...NULL_PEG_SCORE_RESULT }
      : computePegScore(events, trackingStart, nowSec);
    const recent90d = meta.flags.navToken ? null : computeRecentPegStats(events, trackingStart, nowSec);

    pegDataById.set(meta.id, {
      id: meta.id,
      symbol: meta.symbol,
      name: meta.name,
      pegType: asset?.pegType ?? "",
      pegCurrency: meta.flags.pegCurrency,
      governance: meta.flags.governance,
      ...(!isObservedPrice(asset ?? {}) ? {
        // PegSummaryCoin.priceSource is optional, not nullable: a null list source is published as absent.
        priceSource: asset?.priceSource ?? undefined,
        priceObservedAtMode: asset?.priceObservedAtMode,
      } : {}),
      ...(asset?.nominalPriceReference ? { nominalPriceReference: asset.nominalPriceReference } : {}),
      currentDeviationBps: currentPegObservation.currentDeviationBps,
      pegReference: currentPegObservation.pegReference,
      ...(currentPegObservation.pegReferenceUnavailable ? { pegReferenceUnavailable: true } : {}),
      ...(currentPegObservation.currentPriceUnavailable ? { currentPriceUnavailable: true } : {}),
      ...(currentPegObservation.currentSupplyUnavailable ? { currentSupplyUnavailable: true } : {}),
      depegEventCoverageLimited,
      pegScore: scoreResult.pegScore,
      unknownCoverageSeconds: scoreResult.unknownCoverageSeconds,
      pegPct: scoreResult.pegPct,
      severityScore: scoreResult.severityScore,
      spreadPenalty: scoreResult.spreadPenalty,
      eventCount: scoreResult.eventCount,
      worstDeviationBps: scoreResult.worstDeviationBps,
      activeDepeg: scoreResult.activeDepeg,
      lastEventAt: scoreResult.lastEventAt,
      trackingSpanDays: scoreResult.trackingSpanDays,
      historyCoverage: meta.flags.navToken ? null : historyCoverage,
      recent90d,
      methodologyVersion,
    });
  }

  return {
    nowSec,
    allEvents,
    eventsByCoin,
    pegDataById,
  };
}
