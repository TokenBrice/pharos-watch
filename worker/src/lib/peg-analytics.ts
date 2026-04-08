import { TRACKED_META_BY_ID, ACTIVE_STABLECOINS } from "@shared/lib/stablecoins";
import { DAY_SECONDS } from "@shared/lib/time-constants";
import { computePegScore, coinTrackingStart } from "@shared/lib/peg-score";
import { derivePegRates, getPegReference } from "@shared/lib/peg-rates";
import { getDepegDewsMethodologyVersionAt } from "@shared/lib/depeg-dews-version";
import { sumPegBuckets } from "@shared/lib/supply";
import type { DepegEvent, PegSummaryCoin, StablecoinData } from "@shared/types/market";
import { DEPEG_EVENT_MIN_SUPPLY_USD } from "./constants";
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

export async function derivePegAnalyticsSnapshot(
  db: D1Database,
  options: DerivePegAnalyticsOptions,
): Promise<PegAnalyticsSnapshot> {
  const includeNavTokens = options.includeNavTokens ?? false;
  const nowSec = Math.floor(Date.now() / 1000);
  const fourYearsAgoSec = nowSec - Math.ceil(4 * 365.25 * DAY_SECONDS);

  const [eventsResult, firstSeenMap] = await Promise.all([
    db.prepare("SELECT * FROM depeg_events WHERE started_at > ? ORDER BY started_at DESC")
      .bind(fourYearsAgoSec)
      .all<DepegRow>(),
    getFirstSeenDates(db),
  ]);

  const allEvents = (eventsResult.results ?? []).map(rowToDepegEvent);
  const eventsByCoin = new Map<string, DepegEvent[]>();
  for (const event of allEvents) {
    const list = eventsByCoin.get(event.stablecoinId) ?? [];
    list.push(event);
    eventsByCoin.set(event.stablecoinId, list);
  }

  const priceById = new Map(options.peggedAssets.map((asset) => [asset.id, asset]));
  const { rates: pegRates } = derivePegRates(options.peggedAssets, TRACKED_META_BY_ID, options.fxFallbackRates);
  const methodologyVersion = getDepegDewsMethodologyVersionAt(options.methodologyAsOf);
  const trackingFallbackStart = nowSec - 4 * 365.25 * DAY_SECONDS;

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
    if (asset?.price != null && typeof asset.price === "number" && Number.isFinite(asset.price)) {
      if (supply >= DEPEG_EVENT_MIN_SUPPLY_USD) {
        const pegRef = getPegReference(asset.pegType, pegRates, meta.commodityOunces);
        currentDeviationBps = deriveDepegSignal(asset.price, pegRef)?.bps ?? null;
      }
    }

    const trackingAnchorSec = parseLaunchDateSec(meta.launchDate) ?? firstSeenMap.get(meta.id) ?? null;
    const trackingStart = coinTrackingStart(events, trackingFallbackStart, trackingAnchorSec);
    const scoreResult = computePegScore(events, trackingStart, nowSec);

    pegDataById.set(meta.id, {
      id: meta.id,
      symbol: meta.symbol,
      name: meta.name,
      pegType: asset?.pegType ?? "",
      pegCurrency: meta.flags.pegCurrency,
      governance: meta.flags.governance,
      currentDeviationBps,
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
