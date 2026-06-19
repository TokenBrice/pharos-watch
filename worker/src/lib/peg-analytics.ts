import { TRACKED_META_BY_ID, ACTIVE_STABLECOINS } from "@shared/lib/stablecoins/registry";
import {
  computePegScore,
  coinTrackingStart,
  NULL_PEG_SCORE_RESULT,
  PEG_SCORE_LOOKBACK_SEC,
} from "@shared/lib/peg-score";
import { derivePegRates, getPegReference } from "@shared/lib/peg-rates";
import { getDepegDewsMethodologyVersionAt } from "@shared/lib/depeg-dews-version";
import { sumPegBuckets } from "@shared/lib/supply";
import type { DepegEvent, PegSummaryCoin, StablecoinData } from "@shared/types/market";
import { DEPEG_EVENT_MIN_SUPPLY_USD } from "./constants";
import { isAuthoritativeDepegPegReference } from "@shared/lib/peg-reference-trust";
import { type DepegRow, rowToDepegEvent } from "./depeg-helpers";
import { deriveDepegSignal } from "./depeg-signals";
import { getFirstSeenDates } from "./db";

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

function hasUsableCurrentPrice(asset: StablecoinData): asset is StablecoinData & { price: number } {
  return typeof asset.price === "number" && Number.isFinite(asset.price) && asset.price > 0;
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

  const [eventsResult, firstSeenMap] = await Promise.all([
    db.prepare(
      `SELECT /* pharos:peg-analytics:recent-depeg-events */
         * FROM depeg_events_with_provenance WHERE started_at > ? ORDER BY started_at DESC`,
    )
      .bind(fourYearsAgoSec)
      .all<DepegRow>(),
    getFirstSeenDates(
      db,
      buildPriceFirstSeenObservations(options.peggedAssets, options.methodologyAsOf),
    ),
  ]);

  const allEvents = (eventsResult.results ?? []).map(rowToDepegEvent);
  const eventsByCoin = new Map<string, DepegEvent[]>();
  for (const event of allEvents) {
    const list = eventsByCoin.get(event.stablecoinId) ?? [];
    list.push(event);
    eventsByCoin.set(event.stablecoinId, list);
  }

  const priceById = new Map(options.peggedAssets.map((asset) => [asset.id, asset]));
  const {
    rates: pegRates,
    sources: pegRateSources = {},
    counts: pegRateCounts = {},
  } = derivePegRates(options.peggedAssets, TRACKED_META_BY_ID, options.fxFallbackRates);
  const methodologyVersion = getDepegDewsMethodologyVersionAt(options.methodologyAsOf);
  const trackingFallbackStart = nowSec - PEG_SCORE_LOOKBACK_SEC;

  const pegDataById = new Map<string, PegSummaryCoin>();
  for (const meta of ACTIVE_STABLECOINS) {
    if (!includeNavTokens && meta.flags.navToken) continue;

    const asset = priceById.get(meta.id);
    const events = eventsByCoin.get(meta.id) ?? [];
    const supply = asset?.circulating ? sumPegBuckets(asset.circulating) : 0;
    const depegEventCoverageLimited =
      !meta.flags.navToken &&
      supply > 0 &&
      supply < DEPEG_EVENT_MIN_SUPPLY_USD;

    let currentDeviationBps: number | null = null;
    let pegReferenceUnavailable = false;
    if (!meta.flags.navToken && asset && hasUsableCurrentPrice(asset)) {
      if (supply >= DEPEG_EVENT_MIN_SUPPLY_USD) {
        // Same authority gate as the depeg detection engine: a thin non-USD
        // peer median without a live FX fallback is self-referential (a lone
        // coin always reads ~0; a 2-coin group mirrors half of any real move
        // onto the healthy peer), so deviation is withheld instead of shown.
        if (
          !isAuthoritativeDepegPegReference({
            pegType: asset.pegType,
            pegCurrency: meta.flags.pegCurrency,
            pegRateSource: pegRateSources[asset.pegType] ?? null,
            pegRateContributorCount: pegRateCounts[asset.pegType] ?? null,
          })
        ) {
          pegReferenceUnavailable = true;
        } else {
          const pegRef = getPegReference(asset.pegType, pegRates, meta.commodityOunces);
          currentDeviationBps =
            pegRef != null && Number.isFinite(pegRef) && pegRef > 0
              ? deriveDepegSignal(asset.price, pegRef)?.bps ?? null
              : null;
        }
      }
    }

    const trackingAnchorSec = parseLaunchDateSec(meta.launchDate) ?? firstSeenMap.get(meta.id) ?? null;
    const trackingStart = coinTrackingStart(events, trackingFallbackStart, trackingAnchorSec);
    const scoreResult = meta.flags.navToken
      ? { ...NULL_PEG_SCORE_RESULT }
      : computePegScore(events, trackingStart, nowSec);

    pegDataById.set(meta.id, {
      id: meta.id,
      symbol: meta.symbol,
      name: meta.name,
      pegType: asset?.pegType ?? "",
      pegCurrency: meta.flags.pegCurrency,
      governance: meta.flags.governance,
      currentDeviationBps,
      ...(pegReferenceUnavailable ? { pegReferenceUnavailable } : {}),
      depegEventCoverageLimited,
      pegScore: scoreResult.pegScore,
      pegPct: scoreResult.pegPct,
      severityScore: scoreResult.severityScore,
      spreadPenalty: scoreResult.spreadPenalty,
      eventCount: scoreResult.eventCount,
      worstDeviationBps: scoreResult.worstDeviationBps,
      activeDepeg: scoreResult.activeDepeg,
      lastEventAt: scoreResult.lastEventAt,
      trackingSpanDays: scoreResult.trackingSpanDays,
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
