import { TRACKED_STABLECOINS, TRACKED_META_BY_ID } from "../../../src/lib/stablecoins";
import { derivePegRates, getPegReference } from "../../../src/lib/peg-rates";
import { getCache, setCache } from "../lib/db";
import { getDepegThresholdBps, DEFILLAMA_COINS, DEFILLAMA_BASE, RUB_FALLBACK, USER_AGENT } from "../lib/constants";
import { isReasonablePrice } from "../cron/enrich-prices";
import { withErrorHandler } from "../lib/api-utils";
import { requireAdmin } from "../lib/auth";
import { binarySearchNearest } from "../lib/binary-search";
import type { StablecoinData, StablecoinMeta } from "../../../src/lib/types";
import { sumPegBuckets } from "../../../src/lib/supply";
const BATCH_SIZE = 3; // 3 detail + 6 price charts + 1 FX fetch = 10 subrequests per batch

// ── Historical FX rate support ──────────────────────────────────────

/** Maps pegCurrency → frankfurter currency code (ECB-published) */
const PEG_TO_FX: Record<string, string> = {
  EUR: "EUR",
  GBP: "GBP",
  CHF: "CHF",
  BRL: "BRL",
  JPY: "JPY",
  IDR: "IDR",
  SGD: "SGD",
  TRY: "TRY",
  AUD: "AUD",
  ZAR: "ZAR",
};

/** Maps coin ID → frankfurter currency code for OTHER-pegged coins */
const OTHER_COIN_FX: Record<string, string> = {
  "289": "SGD",  // XSGD
  "122": "JPY",  // GYEN
  "300": "TRY",  // TRYB
  "165": "AUD",  // AUDD
};

/** Commodity peg currencies that need spot price history */
const COMMODITY_PEGS = new Set(["GOLD", "SILVER"]);


interface FxTimeSeries {
  timestamp: number; // unix seconds
  rate: number;      // USD per unit
}

interface FrankfurterTimeSeriesResponse {
  base: string;
  start_date: string;
  end_date: string;
  rates: Record<string, Record<string, number>>; // date → { currency: unitsPerUSD }
}

/**
 * Fetch daily historical FX rates from frankfurter.app (ECB data).
 * Returns USD-per-unit time series keyed by currency code.
 * On failure, returns {} — callers fall back to current rates.
 */
async function fetchHistoricalFxRates(
  currencies: string[],
  startDate: string,
  endDate: string,
): Promise<Record<string, FxTimeSeries[]>> {
  if (currencies.length === 0) return {};
  try {
    const url = `https://api.frankfurter.app/${startDate}..${endDate}?from=USD&to=${currencies.join(",")}`;
    const res = await fetch(url, {
      headers: { "User-Agent": USER_AGENT },
    });
    if (!res.ok) {
      console.error(`[backfill-depegs] frankfurter.app returned ${res.status}`);
      return {};
    }
    const data: FrankfurterTimeSeriesResponse = await res.json();

    const result: Record<string, FxTimeSeries[]> = {};
    for (const currency of currencies) {
      result[currency] = [];
    }

    // data.rates is keyed by date string "YYYY-MM-DD"
    for (const [dateStr, dayRates] of Object.entries(data.rates)) {
      const ts = Math.floor(new Date(dateStr + "T00:00:00Z").getTime() / 1000);
      for (const [currency, unitsPerUsd] of Object.entries(dayRates)) {
        if (unitsPerUsd > 0 && result[currency]) {
          result[currency].push({ timestamp: ts, rate: 1 / unitsPerUsd });
        }
      }
    }

    // Sort each series by timestamp
    for (const series of Object.values(result)) {
      series.sort((a, b) => a.timestamp - b.timestamp);
    }

    return result;
  } catch (err) {
    console.error(`[backfill-depegs] FX fetch failed:`, err);
    return {};
  }
}

const COMMODITY_CACHE_KEY = "commodity-history";
const COMMODITY_CACHE_MAX_AGE_SEC = 30 * 86400; // 30 days

/**
 * Fetch historical gold & silver spot prices from metals.dev /v1/timeseries.
 * Splits the date range into 30-day windows (API limit) and fetches sequentially
 * to avoid hitting Worker subrequest limits. Results are cached in D1 for 30 days
 * to avoid burning the 100/month free-tier quota on repeated backfills.
 */
async function fetchCommoditySpotHistoryMetals(
  db: D1Database,
  apiKey: string,
  startDate: string, // "YYYY-MM-DD"
  endDate: string,
): Promise<{ data: Record<string, FxTimeSeries[]>; source: "cache" | "api"; goldPoints: number; silverPoints: number }> {
  // Check D1 cache first
  const cached = await getCache(db, COMMODITY_CACHE_KEY);
  if (cached && (Math.floor(Date.now() / 1000) - cached.updatedAt) < COMMODITY_CACHE_MAX_AGE_SEC) {
    try {
      const data = JSON.parse(cached.value) as Record<string, FxTimeSeries[]>;
      console.log(`[backfill-depegs] Using cached commodity history (age: ${Math.floor((Date.now() / 1000 - cached.updatedAt) / 86400)}d)`);
      return { data, source: "cache", goldPoints: data.GOLD?.length ?? 0, silverPoints: data.SILVER?.length ?? 0 };
    } catch {
      console.warn("[backfill-depegs] Failed to parse commodity cache, refetching");
    }
  }

  const result: Record<string, FxTimeSeries[]> = { GOLD: [], SILVER: [] };
  try {
    // Build 30-day windows
    const windows: { start: string; end: string }[] = [];
    let cursor = new Date(startDate + "T00:00:00Z");
    const end = new Date(endDate + "T00:00:00Z");
    while (cursor < end) {
      const windowEnd = new Date(cursor);
      windowEnd.setUTCDate(windowEnd.getUTCDate() + 29);
      const clampedEnd = windowEnd > end ? end : windowEnd;
      windows.push({
        start: cursor.toISOString().slice(0, 10),
        end: clampedEnd.toISOString().slice(0, 10),
      });
      cursor = new Date(clampedEnd);
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }

    console.log(`[backfill-depegs] Fetching metals.dev timeseries: ${windows.length} windows (sequential)`);

    // Fetch sequentially to avoid Worker subrequest limits
    let failCount = 0;
    for (const w of windows) {
      const url = `https://api.metals.dev/v1/timeseries?api_key=${apiKey}&start_date=${w.start}&end_date=${w.end}&currency=USD&unit=toz`;
      const res = await fetch(url, {
        headers: { "User-Agent": USER_AGENT },
      });
      if (!res.ok) {
        if (res.status === 429) {
          const retryAfter = parseInt(res.headers.get("Retry-After") ?? "5", 10);
          console.warn(`[backfill-depegs] metals.dev 429, waiting ${retryAfter}s`);
          await new Promise((r) => setTimeout(r, retryAfter * 1000));
          // Retry once
          const retry = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
          if (!retry.ok) { failCount++; continue; }
          const retryData = (await retry.json()) as {
            rates?: Record<string, { metals?: { gold?: number; silver?: number } }>;
          };
          if (retryData?.rates) parseCommodityRates(retryData.rates, result);
          continue;
        }
        console.warn(`[backfill-depegs] metals.dev ${w.start}..${w.end} returned ${res.status}`);
        failCount++;
        continue;
      }
      const data = (await res.json()) as {
        rates?: Record<string, { metals?: { gold?: number; silver?: number } }>;
      };
      if (data?.rates) parseCommodityRates(data.rates, result);
    }

    // Sort each series
    result.GOLD.sort((a, b) => a.timestamp - b.timestamp);
    result.SILVER.sort((a, b) => a.timestamp - b.timestamp);

    console.log(`[backfill-depegs] metals.dev: ${result.GOLD.length} gold, ${result.SILVER.length} silver data points (${failCount} failures)`);

    // Cache in D1 if we got meaningful data (>100 gold points guards against mostly-failed fetch)
    if (result.GOLD.length > 100) {
      try {
        await setCache(db, COMMODITY_CACHE_KEY, JSON.stringify(result));
        console.log("[backfill-depegs] Cached commodity history in D1");
      } catch (err) {
        console.warn("[backfill-depegs] Failed to cache commodity history:", err);
      }
    }
  } catch (err) {
    console.error(`[backfill-depegs] metals.dev timeseries fetch failed:`, err);
  }
  return { data: result, source: "api", goldPoints: result.GOLD.length, silverPoints: result.SILVER.length };
}

/** Parse metals.dev rates into GOLD/SILVER time series arrays */
function parseCommodityRates(
  rates: Record<string, { metals?: { gold?: number; silver?: number } }>,
  result: Record<string, FxTimeSeries[]>,
): void {
  for (const [dateStr, dayData] of Object.entries(rates)) {
    const ts = Math.floor(new Date(dateStr + "T00:00:00Z").getTime() / 1000);
    const gold = dayData?.metals?.gold;
    const silver = dayData?.metals?.silver;
    if (typeof gold === "number" && gold > 0) {
      result.GOLD.push({ timestamp: ts, rate: gold });
    }
    if (typeof silver === "number" && silver > 0) {
      result.SILVER.push({ timestamp: ts, rate: silver });
    }
  }
}

/**
 * Build a lookup function that returns the FX rate (USD per unit) at a given
 * timestamp, using binary search nearest-neighbor on the daily ECB series.
 * If the series is empty, returns the static fallback.
 */
function buildFxLookup(series: FxTimeSeries[], fallback: number): (timestamp: number) => number {
  if (series.length === 0) return () => fallback;

  return (timestamp: number): number =>
    binarySearchNearest(series, timestamp, (s) => s.timestamp)?.rate ?? fallback;
}

interface PricePoint {
  timestamp: number;
  price: number;
}

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

export const handleBackfillDepegs = withErrorHandler("backfill-depegs", async (db: D1Database, url: URL, adminSecret?: string, request?: Request, metalsApiKey?: string): Promise<Response> => {
  const authError = await requireAdmin(request, adminSecret);
  if (authError) return authError;

  const singleId = url.searchParams.get("stablecoin");

  let coins;
  if (singleId) {
    const match = TRACKED_STABLECOINS.filter((c) => c.id === singleId);
    if (match.length === 0) {
      return new Response(JSON.stringify({ error: "Stablecoin not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }
    coins = match;
  } else {
    const batch = parseInt(url.searchParams.get("batch") ?? "0", 10);
    const start = batch * BATCH_SIZE;
    coins = TRACKED_STABLECOINS.slice(start, start + BATCH_SIZE);
  }

  if (coins.length === 0) {
    return new Response(JSON.stringify({ message: "No coins in this batch" }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  // Get peg rates from cached stablecoin data
  const cached = await getCache(db, "stablecoins");
  let pegRates: Record<string, number> = { peggedUSD: 1 };

  if (cached) {
    try {
      const data = JSON.parse(cached.value) as { peggedAssets: StablecoinData[]; fxFallbackRates?: Record<string, number> };
      const metaById = new Map(TRACKED_STABLECOINS.map((s) => [s.id, s]));
      ({ rates: pegRates } = derivePegRates(data.peggedAssets, metaById, data.fxFallbackRates));
    } catch (err) {
      console.error("[backfill-depegs] Failed to parse peg rates from cache:", err);
    }
  }

  // Filter to processable coins (skip NAV tokens)
  const processable = coins.filter(
    (m) => !m.flags.navToken
  );

  // Manual overrides for coins where DefiLlama has wrong/missing geckoId

  let totalEvents = 0;
  const errors: string[] = [];
  const skipped: string[] = [];

  // Collect FX currencies needed by this batch
  const neededFxCurrencies = new Set<string>();
  let needsCommodities = false;
  for (const meta of processable) {
    const peg = meta.flags.pegCurrency;
    if (peg === "USD") continue;
    if (COMMODITY_PEGS.has(peg)) {
      needsCommodities = true;
    } else {
      const fx = PEG_TO_FX[peg] ?? OTHER_COIN_FX[meta.id];
      if (fx) neededFxCurrencies.add(fx);
    }
  }

  // Fetch historical FX rates for the full 4-year backfill window
  const fourYearsAgoMs = Date.now() - 4 * 365 * 86400 * 1000;
  const startDate = new Date(fourYearsAgoMs).toISOString().slice(0, 10);
  const endDate = new Date().toISOString().slice(0, 10);

  // Fetch FX and commodity spot history in parallel
  const fxPromise = neededFxCurrencies.size > 0
    ? fetchHistoricalFxRates([...neededFxCurrencies], startDate, endDate)
    : Promise.resolve({} as Record<string, FxTimeSeries[]>);

  const commodityPromise = needsCommodities && metalsApiKey
    ? fetchCommoditySpotHistoryMetals(db, metalsApiKey, startDate, endDate)
    : Promise.resolve({ data: {} as Record<string, FxTimeSeries[]>, source: "api" as const, goldPoints: 0, silverPoints: 0 });

  const [fxSeries, commodityResult] = await Promise.all([fxPromise, commodityPromise]);
  const commoditySeries = commodityResult.data;

  // Process coins sequentially — each needs detail fetch + 2 price chart fetches.
  // Serializing avoids memory pressure from parsing multiple large JSON responses.
  for (const meta of processable) {
    // Fetch per-coin detail endpoint (includes gecko_id + supply history)
    let detail: CoinDetail | null = null;
    try {
      const res = await fetch(`${DEFILLAMA_BASE}/stablecoin/${encodeURIComponent(meta.id)}`);
      if (res.ok) {
        detail = (await res.json()) as CoinDetail;
      }
    } catch (err) {
      console.error(`[backfill-depegs] Failed to fetch detail for ${meta.symbol}:`, err);
    }

    const trackedMeta = TRACKED_META_BY_ID.get(meta.id);
    const geckoId = trackedMeta?.geckoId ?? detail?.gecko_id;

    // Build coins chart API identifier: prefer geckoId, fall back to address
    let coinId: string | null = null;
    if (geckoId) {
      coinId = `coingecko:${geckoId}`;
    } else if (detail?.address && detail.address.startsWith("0x")) {
      coinId = `ethereum:${detail.address}`;
    }

    if (!coinId) {
      skipped.push(meta.symbol);
      continue;
    }

    // Parse supply data from the detail response (avoids extra fetch)
    const supplyByDate = parseSupplyData(detail?.tokens ?? []);

    // Build time-varying peg reference function for this coin
    const peg = meta.flags.pegCurrency;
    const pegType = `pegged${peg}`;
    const currentPegRef = getPegReference(pegType, pegRates, meta.commodityOunces);
    let getPegRef: (timestamp: number) => number;

    if (peg === "USD") {
      getPegRef = () => 1;
    } else if (peg === "RUB") {
      getPegRef = () => RUB_FALLBACK;
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
      const fxCode = PEG_TO_FX[peg] ?? OTHER_COIN_FX[meta.id];
      const series = fxCode ? fxSeries[fxCode] ?? [] : [];
      const fallback = currentPegRef > 0 ? currentPegRef : 1;
      const fxLookup = buildFxLookup(series, fallback);
      getPegRef = fxLookup;
    }

    try {
      const events = await backfillCoin(meta, coinId, getPegRef, supplyByDate);

      if (events.length > 0) {
        // Atomic: DELETE + INSERT in a single batch (D1 batch is transactional)
        const deleteStmt = db
          .prepare("DELETE FROM depeg_events WHERE stablecoin_id = ?")
          .bind(meta.id);
        const insertStmts = events.map((e) =>
          db.prepare(
            `INSERT INTO depeg_events (stablecoin_id, symbol, peg_type, direction, peak_deviation_bps, started_at, ended_at, start_price, peak_price, recovery_price, peg_reference, source)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'backfill')`
          ).bind(
            meta.id, meta.symbol, e.pegType, e.direction, e.peakDeviationBps,
            e.startedAt, e.endedAt, e.startPrice, e.peakPrice, e.recoveryPrice, e.pegRef
          )
        );
        await db.batch([deleteStmt, ...insertStmts]);
        totalEvents += events.length;
      }
    } catch (err) {
      errors.push(`${meta.symbol}: ${err}`);
    }
  }

  return new Response(
    JSON.stringify({
      coinsProcessed: coins.length,
      eventsCreated: totalEvents,
      skipped: skipped.length > 0 ? skipped : undefined,
      errors: errors.length > 0 ? errors : undefined,
      commodities: needsCommodities ? {
        source: commodityResult.source,
        goldDataPoints: commodityResult.goldPoints,
        silverDataPoints: commodityResult.silverPoints,
      } : undefined,
    }),
    { headers: { "Content-Type": "application/json" } }
  );
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

async function backfillCoin(
  meta: StablecoinMeta,
  coinId: string, // e.g. "coingecko:dai" or "ethereum:0x6b17..."
  getPegRef: (timestamp: number) => number,
  supplyByDate: Map<number, number>
): Promise<BackfillEvent[]> {
  const pegType = `pegged${meta.flags.pegCurrency}`;

  const twoYearsAgo = Math.floor(Date.now() / 1000) - 2 * 365 * 86400;
  const fourYearsAgo = twoYearsAgo - 2 * 365 * 86400;

  const [pricesOld, pricesRecent] = await Promise.all([
    fetchPriceChart(coinId, fourYearsAgo),
    fetchPriceChart(coinId, twoYearsAgo),
  ]);

  const priceMap = new Map<number, number>();
  for (const p of [...pricesOld, ...pricesRecent]) {
    priceMap.set(p.timestamp, p.price);
  }
  const prices = Array.from(priceMap.entries())
    .map(([timestamp, price]) => ({ timestamp, price }))
    .sort((a, b) => a.timestamp - b.timestamp);

  if (prices.length === 0) return [];

  return extractDepegEvents(prices, getPegRef, pegType, supplyByDate);
}

async function fetchPriceChart(coinId: string, start: number): Promise<PricePoint[]> {
  try {
    const res = await fetch(
      `${DEFILLAMA_COINS}/chart/${coinId}?start=${start}&span=800&period=1d`,
      { headers: { "User-Agent": USER_AGENT } }
    );
    if (!res.ok) return [];
    const data = (await res.json()) as {
      coins: Record<string, { prices: PricePoint[] }>;
    };
    return data.coins?.[coinId]?.prices ?? [];
  } catch (err) {
    console.error(`[backfill-depegs] Failed to fetch price chart for ${coinId}:`, err);
    return [];
  }
}

function parseSupplyData(tokens: SupplyPoint[]): Map<number, number> {
  const map = new Map<number, number>();
  for (const point of tokens) {
    const ts = parseInt(point.date, 10);
    if (isNaN(ts)) continue;
    const supply = sumPegBuckets(point.circulating);
    map.set(ts, supply);
  }
  return map;
}

function findNearestSupply(supplyByDate: Map<number, number>, timestamp: number): number | null {
  if (supplyByDate.size === 0) return null;
  let closest: number | null = null;
  let closestDist = Infinity;
  for (const [ts, supply] of supplyByDate) {
    const dist = Math.abs(ts - timestamp);
    if (dist < closestDist) {
      closestDist = dist;
      closest = supply;
    }
    if (ts > timestamp + 7 * 86400) break;
  }
  return closest;
}

function extractDepegEvents(
  prices: PricePoint[],
  getPegRef: (timestamp: number) => number,
  pegType: string,
  supplyByDate: Map<number, number>
): BackfillEvent[] {
  const threshold = getDepegThresholdBps(pegType);
  const events: BackfillEvent[] = [];
  let current: BackfillEvent | null = null;

  for (const point of prices) {
    const { timestamp, price } = point;
    if (price <= 0) continue;
    if (!isReasonablePrice(price, pegType)) continue;

    if (supplyByDate.size > 0) {
      const supply = findNearestSupply(supplyByDate, timestamp);
      if (supply !== null && supply < 1_000_000) continue;
    }

    const pegRef = getPegRef(timestamp);
    if (pegRef <= 0) continue;

    const bps = Math.round(((price / pegRef) - 1) * 10000);
    const absBps = Math.abs(bps);
    const direction = bps >= 0 ? "above" : "below";

    if (absBps >= threshold) {
      if (!current) {
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
      } else if (current.direction !== direction) {
        // Direction change: close current event, open new one
        current.endedAt = timestamp;
        current.recoveryPrice = price;
        events.push(current);
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
      } else {
        if (absBps > Math.abs(current.peakDeviationBps)) {
          current.peakDeviationBps = bps;
          current.peakPrice = price;
        }
      }
    } else if (current) {
      current.endedAt = timestamp;
      current.recoveryPrice = price;
      events.push(current);
      current = null;
    }
  }

  if (current) {
    const lastTs = prices[prices.length - 1].timestamp;
    const now = Math.floor(Date.now() / 1000);
    if (now - lastTs > 7 * 86400) {
      current.endedAt = lastTs;
    }
    events.push(current);
  }

  return events;
}
