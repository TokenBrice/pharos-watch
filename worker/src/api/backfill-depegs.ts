import { TRACKED_STABLECOINS } from "../../../src/lib/stablecoins";
import { derivePegRates, getPegReference } from "../../../src/lib/peg-rates";
import { getCache } from "../lib/db";
import { DEPEG_THRESHOLD_BPS } from "../lib/constants";
import { withErrorHandler } from "../lib/api-utils";
import type { StablecoinData, StablecoinMeta } from "../../../src/lib/types";

const DEFILLAMA_COINS = "https://coins.llama.fi";
const DEFILLAMA_BASE = "https://stablecoins.llama.fi";
const BATCH_SIZE = 3; // 3 detail + 6 price charts + 1 FX fetch = 10 subrequests per batch

// ── Historical FX rate support ──────────────────────────────────────

/** Maps pegCurrency → frankfurter currency code (ECB-published) */
const PEG_TO_FX: Record<string, string> = {
  EUR: "EUR",
  GBP: "GBP",
  CHF: "CHF",
  BRL: "BRL",
};

/** Maps coin ID → frankfurter currency code for OTHER-pegged coins */
const OTHER_COIN_FX: Record<string, string> = {
  "289": "SGD",  // XSGD
  "122": "JPY",  // GYEN
  "300": "TRY",  // TRYB
  "165": "AUD",  // AUDD
};

const RUB_FALLBACK = 0.011;

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
      headers: { "User-Agent": "Pharos/1.0 (stablecoin analytics)" },
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

/**
 * Build a lookup function that returns the FX rate (USD per unit) at a given
 * timestamp, using binary search nearest-neighbor on the daily ECB series.
 * If the series is empty, returns the static fallback.
 */
function buildFxLookup(series: FxTimeSeries[], fallback: number): (timestamp: number) => number {
  if (series.length === 0) return () => fallback;

  return (timestamp: number): number => {
    // Binary search for nearest timestamp
    let lo = 0;
    let hi = series.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (series[mid].timestamp < timestamp) lo = mid + 1;
      else hi = mid;
    }
    // lo is the first entry >= timestamp; check if lo-1 is closer
    if (lo > 0) {
      const distLo = Math.abs(series[lo].timestamp - timestamp);
      const distPrev = Math.abs(series[lo - 1].timestamp - timestamp);
      if (distPrev < distLo) return series[lo - 1].rate;
    }
    return series[lo].rate;
  };
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

export const handleBackfillDepegs = withErrorHandler("backfill-depegs", async (db: D1Database, url: URL, adminSecret?: string, request?: Request): Promise<Response> => {
  // Admin-only endpoint: require X-Admin-Key header matching ADMIN_KEY secret
  const adminKey = request?.headers.get("X-Admin-Key");
  if (!adminSecret || !adminKey || adminKey !== adminSecret) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

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
      pegRates = derivePegRates(data.peggedAssets, metaById, data.fxFallbackRates);
    } catch {
      // Fall back to USD=1 only
    }
  }

  // Filter to processable coins (skip NAV tokens, gold synthetics)
  const processable = coins.filter(
    (m) => !m.flags.navToken && !m.id.startsWith("gold-")
  );

  // Manual overrides for coins where DefiLlama has wrong/missing geckoId
  const GECKO_OVERRIDES: Record<string, string> = {
    "226": "frankencoin",
  };

  let totalEvents = 0;
  const errors: string[] = [];
  const skipped: string[] = [];

  // Collect FX currencies needed by this batch
  const neededFxCurrencies = new Set<string>();
  for (const meta of processable) {
    const peg = meta.flags.pegCurrency;
    if (peg === "USD") continue;
    const fx = PEG_TO_FX[peg] ?? OTHER_COIN_FX[meta.id];
    if (fx) neededFxCurrencies.add(fx);
  }

  // Fetch historical FX rates for the full 4-year backfill window
  const fourYearsAgoMs = Date.now() - 4 * 365 * 86400 * 1000;
  const startDate = new Date(fourYearsAgoMs).toISOString().slice(0, 10);
  const endDate = new Date().toISOString().slice(0, 10);
  const fxSeries = neededFxCurrencies.size > 0
    ? await fetchHistoricalFxRates([...neededFxCurrencies], startDate, endDate)
    : {};

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
    } catch { /* skip */ }

    const geckoId = GECKO_OVERRIDES[meta.id] ?? detail?.gecko_id;

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
    const currentPegRef = getPegReference(pegType, pegRates, meta.goldOunces);
    let getPegRef: (timestamp: number) => number;

    if (peg === "USD") {
      getPegRef = () => 1;
    } else if (peg === "RUB") {
      getPegRef = () => RUB_FALLBACK;
    } else {
      const fxCode = PEG_TO_FX[peg] ?? OTHER_COIN_FX[meta.id];
      const series = fxCode ? fxSeries[fxCode] ?? [] : [];
      const fallback = currentPegRef > 0 ? currentPegRef : 1;
      const fxLookup = buildFxLookup(series, fallback);
      if (meta.goldOunces && meta.goldOunces > 0) {
        const oz = meta.goldOunces;
        getPegRef = (ts) => fxLookup(ts) * oz;
      } else {
        getPegRef = fxLookup;
      }
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
      { headers: { "User-Agent": "stablecoin-dashboard/1.0" } }
    );
    if (!res.ok) return [];
    const data = (await res.json()) as {
      coins: Record<string, { prices: PricePoint[] }>;
    };
    return data.coins?.[coinId]?.prices ?? [];
  } catch {
    return [];
  }
}

function parseSupplyData(tokens: SupplyPoint[]): Map<number, number> {
  const map = new Map<number, number>();
  for (const point of tokens) {
    const ts = parseInt(point.date, 10);
    if (isNaN(ts)) continue;
    const supply = point.circulating
      ? Object.values(point.circulating).reduce((s, v) => s + (v ?? 0), 0)
      : 0;
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
  const events: BackfillEvent[] = [];
  let current: BackfillEvent | null = null;

  for (const point of prices) {
    const { timestamp, price } = point;
    if (price <= 0) continue;

    if (supplyByDate.size > 0) {
      const supply = findNearestSupply(supplyByDate, timestamp);
      if (supply !== null && supply < 1_000_000) continue;
    }

    const pegRef = getPegRef(timestamp);
    if (pegRef <= 0) continue;

    const bps = Math.round(((price / pegRef) - 1) * 10000);
    const absBps = Math.abs(bps);
    const direction = bps >= 0 ? "above" : "below";

    if (absBps >= DEPEG_THRESHOLD_BPS) {
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
