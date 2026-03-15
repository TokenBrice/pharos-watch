import { PSI_ELIGIBLE_STABLECOINS, PSI_ELIGIBLE_META_BY_ID } from "@shared/lib/psi-eligible";
import { derivePegRates, getPegReference } from "@shared/lib/peg-rates";
import { getDepegThresholdBps, DEFILLAMA_BASE, RUB_FALLBACK, USER_AGENT, DEPEG_CONFIRMATION_SUPPLY_THRESHOLD } from "../lib/constants";
import {
  buildPriceReasonablenessOptions,
  buildPriceValidationContext,
  type PriceReasonablenessOptions,
  validatePriceCandidateAgainstReference,
} from "../lib/price-validation";
import { withErrorHandler, jsonResponse } from "../lib/api-utils";
import { withAdmin } from "../lib/auth";
import { binarySearchNearest } from "../lib/binary-search";
import { cgUrl, cgHeaders } from "../lib/coingecko";
import { fetchWithRetry } from "../lib/fetch-retry";
import { RATE_LIMITS } from "../lib/rate-limit";
import type { StablecoinMeta } from "@shared/types";
import { sumPegBuckets } from "@shared/lib/supply";
import { noCoinsInBatchResponse, selectBackfillCoins } from "../lib/backfill-query";
import { loadStablecoinsCache } from "../lib/stablecoins-cache";
import { fetchAuthoritativeHistoricalPriceSeries } from "../lib/authoritative-price-sources";

// ── Re-exports from extracted modules (preserve public API) ─────────
export {
  type FxTimeSeries,
  PEG_TO_FX,
  SECONDARY_PEG_TO_FX,
  OTHER_COIN_FX,
  COMMODITY_PEGS,
  fetchHistoricalFxRates,
  fetchHistoricalSecondaryFxRates,
  buildCommodityMedianSeriesFromCg,
  buildFxLookup,
} from "./backfill-fx";

export {
  type PricePoint,
  fetchCgPriceHistoryDaily,
  fetchCgPriceHistoryHourly,
  fetchDlPriceChart,
  collapsePricesToDailyTimestamps,
  fetchMarketBackfillPrices,
} from "./backfill-price-sources";

// ── Imports from extracted modules (used in this file) ──────────────
import {
  type FxTimeSeries,
  PEG_TO_FX,
  SECONDARY_PEG_TO_FX,
  OTHER_COIN_FX,
  COMMODITY_PEGS,
  fetchHistoricalFxRates,
  fetchHistoricalSecondaryFxRates,
  buildCommodityMedianSeriesFromCg,
  buildFxLookup,
} from "./backfill-fx";

import {
  type PricePoint,
  collapsePricesToDailyTimestamps,
  fetchMarketBackfillPrices,
} from "./backfill-price-sources";

const BATCH_SIZE = 3;
const BATCH_CHUNK_SIZE = 100;

/** Consecutive above-threshold data points needed to confirm a large-cap depeg.
 *  Mirrors the live system's pending → re-check → promote flow. */
const BACKFILL_MIN_CONFIRM_POINTS = 2;

/** Max gap (seconds) between data points before pending resets.
 *  6h handles CG hourly gaps but resets for day-scale gaps. */
const BACKFILL_PENDING_MAX_GAP_SEC = 6 * 3600;

interface SupplyPoint {
  date: string;
  circulating?: Record<string, number>;
}

/** Per-coin detail from /stablecoin/:id — includes gecko_id and historical supply */
interface CoinDetail {
  gecko_id?: string;
  address?: string;
  tokens?: SupplyPoint[];
}

interface PreparedBackfillCoin {
  meta: StablecoinMeta;
  geckoId?: string;
  supplyByDate: SupplySnapshot[];
}

export const handleBackfillDepegs = withErrorHandler("backfill-depegs", async (db: D1Database, url: URL, trustedAdmin?: boolean, request?: Request): Promise<Response> => {
  return withAdmin(request, async () => {

    const selection = selectBackfillCoins(url, PSI_ELIGIBLE_STABLECOINS, {
      defaultBatchSize: BATCH_SIZE,
      allowBatchSizeOverride: false,
    });
    if ("response" in selection) {
      return selection.response;
    }
    const coins = selection.coins;

    if (coins.length === 0) {
      return noCoinsInBatchResponse();
    }

  // Get peg rates from cached stablecoin data
  let pegRates: Record<string, number> = { peggedUSD: 1 };
  let fxRates: Record<string, number> | undefined;

  const stablecoinsCache = await loadStablecoinsCache(db, { mode: "lenient", allowLegacyArray: true });
  if (stablecoinsCache.kind !== "ok") {
    console.warn(`[backfill-depegs] stablecoins cache ${stablecoinsCache.kind} (${stablecoinsCache.reason})`);
  }
  const stablecoinsPayload =
    stablecoinsCache.kind === "ok" || (stablecoinsCache.kind === "degraded" && stablecoinsCache.payload)
      ? stablecoinsCache.payload
      : null;
  if (stablecoinsPayload) {
    const metaById = new Map(PSI_ELIGIBLE_STABLECOINS.map((s) => [s.id, s]));
    ({ rates: pegRates } = derivePegRates(
      stablecoinsPayload.peggedAssets,
      metaById,
      stablecoinsPayload.fxFallbackRates,
    ));
    fxRates = stablecoinsPayload.fxFallbackRates;
  }

  // Filter to processable coins (skip NAV tokens)
  const processable = coins.filter(
    (m) => !m.flags.navToken
  );

  // Manual overrides for coins where DefiLlama has wrong/missing geckoId

  let totalEvents = 0;
  const errors: string[] = [];
  const skipped: string[] = [];

  // Collect coin details and historical FX currencies needed by this batch
  const neededFxCurrencies = new Set<string>();
  const neededSecondaryFxCurrencies = new Set<string>();
  let needsCommodities = false;
  const preparedCoins: PreparedBackfillCoin[] = [];

  // Fetch historical FX rates only as far back as the oldest supply snapshot in this batch.
  // If supply history is missing, fall back to 10 years to preserve current behavior.
  const tenYearsAgoMs = Date.now() - 10 * 365 * 86400 * 1000;
  const defaultStartDate = new Date(tenYearsAgoMs).toISOString().slice(0, 10);
  const endDate = new Date().toISOString().slice(0, 10);
  let historicalFxStartDate = endDate;

  for (const meta of processable) {
    let detail: CoinDetail | null = null;
    const dlId = meta.llamaId ?? meta.id;
    try {
      const res = await fetch(`${DEFILLAMA_BASE}/stablecoin/${encodeURIComponent(dlId)}`);
      if (res.ok) {
        detail = (await res.json()) as CoinDetail;
      }
    } catch (err) {
      console.error(`[backfill-depegs] Failed to fetch detail for ${meta.symbol}:`, err);
    }

    const trackedMeta = PSI_ELIGIBLE_META_BY_ID.get(meta.id);
    const geckoId = trackedMeta?.geckoId ?? detail?.gecko_id;
    const supplyByDate = parseSupplyData(detail?.tokens ?? []);
    preparedCoins.push({ meta, geckoId, supplyByDate });

    const peg = meta.flags.pegCurrency;
    if (peg === "USD") continue;

    let earliestDate: string;
    if (supplyByDate[0]) {
      earliestDate = new Date(supplyByDate[0].ts * 1000).toISOString().slice(0, 10);
    } else if (SECONDARY_PEG_TO_FX[peg] && geckoId) {
      // Secondary FX coins with no DL supply data would otherwise default to 10 years,
      // triggering ~3,600 per-day CDN fetches for the cold-start FX cache build.
      // Fetch the CG ATL/genesis date to anchor the window to the coin's actual inception.
      try {
        await new Promise(r => setTimeout(r, RATE_LIMITS.COINGECKO_BACKFILL_MS));
        const cgRes = await fetchWithRetry(
          cgUrl(`/coins/${geckoId}?localization=false&tickers=false&market_data=true&community_data=false&developer_data=false`),
          { headers: cgHeaders({ "User-Agent": USER_AGENT }) },
          1,
          { timeoutMs: 10_000 },
        );
        if (cgRes?.ok) {
          const cgData = await cgRes.json() as {
            genesis_date?: string | null;
            market_data?: { atl_date?: Record<string, string> };
          };
          const inceptionStr = cgData.genesis_date ?? cgData.market_data?.atl_date?.["usd"];
          if (inceptionStr) {
            const d = new Date(inceptionStr);
            d.setUTCDate(d.getUTCDate() - 7); // 7-day buffer
            earliestDate = d.toISOString().slice(0, 10);
          } else {
            earliestDate = defaultStartDate;
          }
        } else {
          earliestDate = defaultStartDate;
        }
      } catch {
        earliestDate = defaultStartDate;
      }
    } else {
      earliestDate = defaultStartDate;
    }
    if (earliestDate < historicalFxStartDate) {
      historicalFxStartDate = earliestDate;
    }

    if (COMMODITY_PEGS.has(peg)) {
      needsCommodities = true;
    } else {
      const secondaryFx = SECONDARY_PEG_TO_FX[peg];
      if (secondaryFx) {
        neededSecondaryFxCurrencies.add(secondaryFx);
        continue;
      }

      const fx = PEG_TO_FX[peg] ?? OTHER_COIN_FX[meta.id];
      if (fx) {
        neededFxCurrencies.add(fx);
      }
    }
  }

  // Fetch FX rates and commodity peer-median series in parallel.
  // Commodity peg reference is derived from the median of all tracked gold/silver
  // token CG prices — same approach as derivePegRates() in the live system.
  const fxPromise = neededFxCurrencies.size > 0
    ? fetchHistoricalFxRates([...neededFxCurrencies], historicalFxStartDate, endDate)
    : Promise.resolve({} as Record<string, FxTimeSeries[]>);

  const secondaryFxPromise = neededSecondaryFxCurrencies.size > 0
    ? fetchHistoricalSecondaryFxRates(db, [...neededSecondaryFxCurrencies], historicalFxStartDate, endDate)
    : Promise.resolve({} as Record<string, FxTimeSeries[]>);

  const commodityPromise = needsCommodities
    ? buildCommodityMedianSeriesFromCg()
    : Promise.resolve({} as Record<string, FxTimeSeries[]>);

  const [fxSeriesPrimary, fxSeriesSecondary, commoditySeries] = await Promise.all([
    fxPromise,
    secondaryFxPromise,
    commodityPromise,
  ]);
  const fxSeries = { ...fxSeriesPrimary, ...fxSeriesSecondary };

  // Process coins sequentially — each still needs CG price history fetch.
  // Serializing avoids memory pressure from parsing multiple large JSON responses.
  for (const { meta, geckoId, supplyByDate } of preparedCoins) {
    if (!geckoId) {
      skipped.push(meta.symbol);
      continue;
    }

    // Build time-varying peg reference function for this coin
    const peg = meta.flags.pegCurrency;
    const pegType = `pegged${peg}`;
    const currentPegRef = getPegReference(pegType, pegRates, meta.commodityOunces);
    let getPegRef: (timestamp: number) => number;

    if (peg === "USD") {
      getPegRef = () => 1;
    } else if (COMMODITY_PEGS.has(peg)) {
      // Commodity peg (gold/silver): use historical spot price series
      const series = commoditySeries[peg] ?? [];
      const fallback = currentPegRef > 0 ? currentPegRef : 1;
      const spotLookup = buildFxLookup(series, fallback);
      if (meta.commodityOunces && meta.commodityOunces > 0) {
        const oz = meta.commodityOunces;
        getPegRef = (ts) => spotLookup(ts) * oz;
      } else {
        getPegRef = spotLookup;
      }
    } else {
      const fxCode = PEG_TO_FX[peg] ?? SECONDARY_PEG_TO_FX[peg] ?? OTHER_COIN_FX[meta.id];
      const series = fxCode ? fxSeries[fxCode] ?? [] : [];
      const fallbackRate = fxRates?.[pegType];
      const fallback = typeof fallbackRate === "number" && fallbackRate > 0
        ? fallbackRate
        : currentPegRef > 0
          ? currentPegRef
          : peg === "RUB"
            ? RUB_FALLBACK
            : 1;
      const fxLookup = buildFxLookup(series, fallback);
      getPegRef = fxLookup;
    }

    try {
      const events = await backfillCoin(meta, geckoId, getPegRef, supplyByDate, fxRates);

      // null = CG had no price data → preserve existing events
      if (events === null) {
        skipped.push(meta.symbol);
        continue;
      }

      // Only replace backfill-sourced events; preserve live-cron-detected events
      // (live cron catches brief intraday depegs that daily backfill data misses).
      const deleteStmt = db
        .prepare("DELETE FROM depeg_events WHERE stablecoin_id = ? AND source = 'backfill'")
        .bind(meta.id);
      if (events.length > 0) {
        const insertStmts = events.map((e) =>
          db.prepare(
            `INSERT INTO depeg_events (stablecoin_id, symbol, peg_type, direction, peak_deviation_bps, started_at, ended_at, start_price, peak_price, recovery_price, peg_reference, source)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'backfill')`
          ).bind(
            meta.id, meta.symbol, e.pegType, e.direction, e.peakDeviationBps,
            e.startedAt, e.endedAt, e.startPrice, e.peakPrice, e.recoveryPrice, e.pegRef
          )
        );
        await db.batch([deleteStmt]);
        for (let i = 0; i < insertStmts.length; i += BATCH_CHUNK_SIZE) {
          const chunk = insertStmts.slice(i, i + BATCH_CHUNK_SIZE);
          await db.batch(chunk);
        }
        totalEvents += events.length;
      } else {
        await deleteStmt.run();
      }
    } catch (err) {
      errors.push(`${meta.symbol}: ${err}`);
    }
  }

    return jsonResponse({
      coinsProcessed: coins.length,
      eventsCreated: totalEvents,
      skipped: skipped.length > 0 ? skipped : undefined,
      errors: errors.length > 0 ? errors : undefined,
      commodities: needsCommodities ? {
        goldDataPoints: commoditySeries["GOLD"]?.length ?? 0,
        silverDataPoints: commoditySeries["SILVER"]?.length ?? 0,
      } : undefined,
    });
  }, trustedAdmin);
});

interface BackfillEvent {
  pegType: string;
  direction: string;
  peakDeviationBps: number;
  startedAt: number;
  endedAt: number | null;
  startPrice: number;
  peakPrice: number;
  recoveryPrice: number | null;
  pegRef: number;
}

interface SupplySnapshot {
  ts: number;
  supply: number;
}

/** Returns null when no trusted historical source is available (caller should preserve existing events). */
async function backfillCoin(
  meta: StablecoinMeta,
  geckoId: string,
  getPegRef: (timestamp: number) => number,
  supplyByDate: SupplySnapshot[],
  fxRates?: Record<string, number>,
): Promise<BackfillEvent[] | null> {
  const pegType = `pegged${meta.flags.pegCurrency}`;

  let marketPrices: PricePoint[] | null = null;
  const loadMarketPrices = async (): Promise<PricePoint[] | null> => {
    if (marketPrices != null) return marketPrices;
    marketPrices = await fetchMarketBackfillPrices(meta, geckoId);
    return marketPrices;
  };

  const candidateTimestamps = supplyByDate.length > 0
    ? supplyByDate.map((snapshot) => snapshot.ts)
    : collapsePricesToDailyTimestamps((await loadMarketPrices()) ?? []);

  const authoritativeHistory = await fetchAuthoritativeHistoricalPriceSeries(meta, {
    candidateTimestamps,
    supplySnapshots: supplyByDate,
  });

  let prices: PricePoint[] | null;
  if (authoritativeHistory.matched) {
    prices = authoritativeHistory.prices;
    if (!prices || prices.length === 0) {
      console.warn(
        `[backfill-depegs] authoritative historical price source unavailable for ${meta.symbol}` +
        `${authoritativeHistory.source ? ` (${authoritativeHistory.source})` : ""}; preserving existing backfill rows`,
      );
      return null;
    }
  } else {
    prices = await loadMarketPrices();
    if (!prices || prices.length === 0) return null;
  }

  return extractDepegEvents(
    prices,
    getPegRef,
    pegType,
    supplyByDate,
    fxRates,
    buildPriceReasonablenessOptions({
      navToken: meta.flags.navToken,
      commodityOunces: meta.commodityOunces,
    }),
  );
}

export function parseSupplyData(tokens: SupplyPoint[]): SupplySnapshot[] {
  const map = new Map<number, number>();
  for (const point of tokens) {
    const ts = parseInt(point.date, 10);
    if (isNaN(ts)) continue;
    const supply = sumPegBuckets(point.circulating);
    map.set(ts, supply);
  }
  return Array.from(map.entries())
    .map(([ts, supply]) => ({ ts, supply }))
    .sort((a, b) => a.ts - b.ts);
}

export function findNearestSupply(supplyByDate: SupplySnapshot[], timestamp: number): number | null {
  if (supplyByDate.length === 0) return null;
  const nearest = binarySearchNearest(supplyByDate, timestamp, (s) => s.ts);
  return nearest?.supply ?? null;
}

export function extractDepegEvents(
  prices: PricePoint[],
  getPegRef: (timestamp: number) => number,
  pegType: string,
  supplyByDate: SupplySnapshot[],
  fxRates?: Record<string, number>,
  priceValidationOpts?: PriceReasonablenessOptions,
): BackfillEvent[] {
  const threshold = getDepegThresholdBps(pegType);
  const events: BackfillEvent[] = [];
  let current: BackfillEvent | null = null;
  const validationContext = buildPriceValidationContext({
    pegType,
    navToken: priceValidationOpts?.navToken,
    commodityOunces: priceValidationOpts?.commodityOunces,
  });

  // Pending state for large-cap confirmation (mirrors live pending → confirm flow)
  let pending: {
    direction: string;
    count: number;
    firstTs: number;
    lastTs: number;
    peakBps: number;
    startPrice: number;
    peakPrice: number;
    pegRef: number;
  } | null = null;

  /** Promote pending to an active event */
  function promotePending(): void {
    if (!pending) return;
    current = {
      pegType,
      direction: pending.direction,
      peakDeviationBps: pending.peakBps,
      startedAt: pending.firstTs,
      endedAt: null,
      startPrice: pending.startPrice,
      peakPrice: pending.peakPrice,
      recoveryPrice: null,
      pegRef: pending.pegRef,
    };
    pending = null;
  }

  for (const point of prices) {
    const { timestamp, price } = point;
    if (price <= 0) continue;

    if (supplyByDate.length > 0) {
      const supply = findNearestSupply(supplyByDate, timestamp);
      if (supply !== null && supply < 1_000_000) continue;
    }

    const pegRef = getPegRef(timestamp);
    if (pegRef <= 0) continue;
    const decision = validatePriceCandidateAgainstReference(
      price,
      validationContext,
      "historical_backfill",
      { price: pegRef, type: fxRates ? "fresh" : "none" },
    );
    if (!decision.accepted) continue;

    const bps = Math.round(((price / pegRef) - 1) * 10000);
    const absBps = Math.abs(bps);
    const direction = bps >= 0 ? "above" : "below";

    // Determine if this coin is large-cap at this point in time
    const supply = findNearestSupply(supplyByDate, timestamp);
    const isLargeCap = supply !== null && supply >= DEPEG_CONFIRMATION_SUPPLY_THRESHOLD;

    if (absBps >= threshold) {
      if (current) {
        if (current.direction !== direction) {
          // Direction change: close current event, fall through to "no event" path below
          current.endedAt = timestamp;
          current.recoveryPrice = price;
          events.push(current);
          current = null;
          // fall through — will be handled as "no active event" below
        } else {
          // Same direction: update peak, continue
          if (absBps > Math.abs(current.peakDeviationBps)) {
            current.peakDeviationBps = bps;
            current.peakPrice = price;
          }
          continue;
        }
      }

      // No active event — decide whether to open immediately or require confirmation
      if (!isLargeCap) {
        // Small cap: instant event (existing behavior)
        current = {
          pegType,
          direction,
          peakDeviationBps: bps,
          startedAt: timestamp,
          endedAt: null,
          startPrice: price,
          peakPrice: price,
          recoveryPrice: null,
          pegRef,
        };
        pending = null;
      } else {
        // Large cap: require consecutive confirmation points
        if (!pending || pending.direction !== direction
            || (timestamp - pending.lastTs) > BACKFILL_PENDING_MAX_GAP_SEC) {
          // Start new pending
          pending = {
            direction,
            count: 1,
            firstTs: timestamp,
            lastTs: timestamp,
            peakBps: bps,
            startPrice: price,
            peakPrice: price,
            pegRef,
          };
        } else {
          // Continue pending
          pending.count++;
          pending.lastTs = timestamp;
          if (absBps > Math.abs(pending.peakBps)) {
            pending.peakBps = bps;
            pending.peakPrice = price;
          }
          if (pending.count >= BACKFILL_MIN_CONFIRM_POINTS) {
            promotePending();
          }
        }
      }
    } else {
      // Below threshold
      if (current) {
        current.endedAt = timestamp;
        current.recoveryPrice = price;
        events.push(current);
        current = null;
      }
      // Discard pending — recovered before confirmation
      pending = null;
    }
  }

  // Close any remaining active event
  if (current) {
    const lastTs = prices[prices.length - 1].timestamp;
    const now = Math.floor(Date.now() / 1000);
    if (now - lastTs > 7 * 86400) {
      current.endedAt = lastTs;
    }
    events.push(current);
  }
  // Discard any unconfirmed pending at end of series

  return events;
}
