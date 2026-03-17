import { TRACKED_META_BY_ID, ACTIVE_STABLECOINS } from "@shared/lib/stablecoins";
import { computePegScore, coinTrackingStart } from "@shared/lib/peg-score";
import { derivePegRates, getPegReference } from "@shared/lib/peg-rates";
import { getDepegDewsMethodologyVersionAt } from "@shared/lib/depeg-dews-version";
import { sumPegBuckets } from "@shared/lib/supply";
import type { DepegEvent, PegSummaryCoin, StablecoinData } from "@shared/types";
import { type DepegRow, rowToDepegEvent } from "./depeg-helpers";
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

export async function derivePegAnalyticsSnapshot(
  db: D1Database,
  options: DerivePegAnalyticsOptions,
): Promise<PegAnalyticsSnapshot> {
  const includeNavTokens = options.includeNavTokens ?? false;
  const nowSec = Math.floor(Date.now() / 1000);
  const fourYearsAgoSec = nowSec - Math.ceil(4 * 365.25 * 86400);

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
  const trackingFallbackStart = nowSec - 4 * 365.25 * 86400;

  const pegDataById = new Map<string, PegSummaryCoin>();
  for (const meta of ACTIVE_STABLECOINS) {
    if (!includeNavTokens && meta.flags.navToken) continue;

    const asset = priceById.get(meta.id);
    const events = eventsByCoin.get(meta.id) ?? [];

    let currentDeviationBps: number | null = null;
    if (asset?.price != null && typeof asset.price === "number" && Number.isFinite(asset.price)) {
      const supply = asset.circulating ? sumPegBuckets(asset.circulating) : 0;
      if (supply >= 1_000_000) {
        const pegRef = getPegReference(asset.pegType, pegRates, meta.commodityOunces);
        if (pegRef > 0) {
          currentDeviationBps = Math.round(((asset.price / pegRef) - 1) * 10000);
        }
      }
    }

    const trackingStart = coinTrackingStart(events, trackingFallbackStart, firstSeenMap.get(meta.id));
    const scoreResult = computePegScore(events, trackingStart, nowSec);

    pegDataById.set(meta.id, {
      id: meta.id,
      symbol: meta.symbol,
      name: meta.name,
      pegType: asset?.pegType ?? "",
      pegCurrency: meta.flags.pegCurrency,
      governance: meta.flags.governance,
      currentDeviationBps,
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
