import { logWorkerEventArgs } from "./structured-log";
import {
  BINANCE_MARKETS,
  CEX_PROVIDER_AUDIT_CONFIG,
  COINBASE_PRODUCTS,
  KRAKEN_MARKETS,
} from "@shared/lib/pricing-provider-config";
import { USER_AGENT } from "./constants";
import { fetchJsonWithRetry } from "./fetch-retry";
import { throwIfAborted } from "./abort";
import { parsePositiveNumber } from "./number-utils";

const CEX_ORDERBOOK_TIMEOUT_MS = 7_500;
const CEX_ORDERBOOK_RETRIES = 0;
const ORDERBOOK_DEPTH_BAND = 0.02;
const MAX_SPREAD_BPS = 100;
const MAJOR_SYMBOLS = new Set(["USDC", "USDT"]);

type Venue = "binance" | "coinbase" | "kraken";

interface OrderbookLevel {
  price: number;
  size: number;
}

export interface CexOrderbookDepth {
  venue: Venue;
  symbol: string;
  productId: string;
  midPrice: number;
  spreadBps: number;
  depthDown2PctUsd: number;
  depthUp2PctUsd: number;
  bidLevels: number;
  askLevels: number;
  fetchedAt: number;
}

export interface DirectCexOrderbookDepthSummary {
  checkedSymbols: number;
  venueCount: number;
  observations: number;
  maxDepthDown2PctUsdBySymbol: Record<string, number>;
  maxDepthUp2PctUsdBySymbol: Record<string, number>;
}

function normalizeLevels(rows: unknown): OrderbookLevel[] {
  if (!Array.isArray(rows)) return [];
  const levels: OrderbookLevel[] = [];
  for (const row of rows) {
    if (!Array.isArray(row) || row.length < 2) continue;
    const price = parsePositiveNumber(row[0]);
    const size = parsePositiveNumber(row[1]);
    if (price != null && size != null) {
      levels.push({ price, size });
    }
  }
  return levels;
}

export function computeOrderbookDepth(args: {
  venue: Venue;
  symbol: string;
  productId: string;
  bids: OrderbookLevel[];
  asks: OrderbookLevel[];
  fetchedAt?: number;
}): CexOrderbookDepth | null {
  const bids = [...args.bids].sort((a, b) => b.price - a.price);
  const asks = [...args.asks].sort((a, b) => a.price - b.price);
  const bestBid = bids[0]?.price;
  const bestAsk = asks[0]?.price;
  if (bestBid == null || bestAsk == null || bestBid <= 0 || bestAsk <= 0 || bestAsk < bestBid) return null;
  const midPrice = (bestBid + bestAsk) / 2;
  const spreadBps = ((bestAsk - bestBid) / midPrice) * 10_000;
  if (!Number.isFinite(spreadBps) || spreadBps > MAX_SPREAD_BPS) return null;

  const minBidPrice = midPrice * (1 - ORDERBOOK_DEPTH_BAND);
  const maxAskPrice = midPrice * (1 + ORDERBOOK_DEPTH_BAND);
  const depthDown2PctUsd = bids
    .filter((level) => level.price >= minBidPrice)
    .reduce((sum, level) => sum + (level.price * level.size), 0);
  const depthUp2PctUsd = asks
    .filter((level) => level.price <= maxAskPrice)
    .reduce((sum, level) => sum + (level.price * level.size), 0);

  if (!Number.isFinite(depthDown2PctUsd) || depthDown2PctUsd <= 0) return null;

  return {
    venue: args.venue,
    symbol: args.symbol,
    productId: args.productId,
    midPrice,
    spreadBps,
    depthDown2PctUsd,
    depthUp2PctUsd,
    bidLevels: bids.length,
    askLevels: asks.length,
    fetchedAt: args.fetchedAt ?? Math.floor(Date.now() / 1000),
  };
}

async function fetchJson(url: string, signal?: AbortSignal): Promise<unknown | null> {
  const result = await fetchJsonWithRetry<unknown>(
    url,
    {
      signal,
      headers: { Accept: "application/json", "User-Agent": USER_AGENT },
    },
    CEX_ORDERBOOK_RETRIES,
    { timeoutMs: CEX_ORDERBOOK_TIMEOUT_MS },
  );
  return result?.response.ok ? result.body : null;
}

export async function fetchBinanceOrderbookDepths(signal?: AbortSignal): Promise<CexOrderbookDepth[]> {
  const rows: CexOrderbookDepth[] = [];
  const markets = BINANCE_MARKETS.filter((market) => MAJOR_SYMBOLS.has(market.symbol));
  for (const market of markets) {
    throwIfAborted(signal);
    const payload = await fetchJson(
      `https://api.binance.com/api/v3/depth?symbol=${market.pair}&limit=1000`,
      signal,
    ) as { bids?: unknown[]; asks?: unknown[] } | null;
    if (!payload) continue;
    const depth = computeOrderbookDepth({
      venue: "binance",
      symbol: market.symbol,
      productId: market.pair,
      bids: normalizeLevels(payload.bids),
      asks: normalizeLevels(payload.asks),
    });
    if (depth) rows.push(depth);
  }
  return rows;
}

export async function fetchCoinbaseOrderbookDepths(signal?: AbortSignal): Promise<CexOrderbookDepth[]> {
  const rows: CexOrderbookDepth[] = [];
  const products = COINBASE_PRODUCTS.filter((product) => MAJOR_SYMBOLS.has(product.symbol));
  for (const product of products) {
    throwIfAborted(signal);
    const payload = await fetchJson(
      `${CEX_PROVIDER_AUDIT_CONFIG.coinbase.metadataUrl}/${product.productId}/book?level=2`,
      signal,
    ) as { bids?: unknown[]; asks?: unknown[] } | null;
    if (!payload) continue;
    const depth = computeOrderbookDepth({
      venue: "coinbase",
      symbol: product.symbol,
      productId: product.productId,
      bids: normalizeLevels(payload.bids),
      asks: normalizeLevels(payload.asks),
    });
    if (depth) rows.push(depth);
  }
  return rows;
}

export async function fetchKrakenOrderbookDepths(signal?: AbortSignal): Promise<CexOrderbookDepth[]> {
  const rows: CexOrderbookDepth[] = [];
  const markets = KRAKEN_MARKETS.filter((market) => MAJOR_SYMBOLS.has(market.symbol));
  for (const market of markets) {
    throwIfAborted(signal);
    const payload = await fetchJson(
      `https://api.kraken.com/0/public/Depth?pair=${market.requestPair}&count=500`,
      signal,
    ) as { error?: string[]; result?: Record<string, { bids?: unknown[]; asks?: unknown[] }> } | null;
    if (!payload || (Array.isArray(payload.error) && payload.error.length > 0)) continue;
    const marketBook = Object.entries(payload.result ?? {}).find(([key]) => (
      (market.responseKeys as readonly string[]).includes(key)
    ))?.[1];
    if (!marketBook) continue;
    const depth = computeOrderbookDepth({
      venue: "kraken",
      symbol: market.symbol,
      productId: market.requestPair,
      bids: normalizeLevels(marketBook.bids),
      asks: normalizeLevels(marketBook.asks),
    });
    if (depth) rows.push(depth);
  }
  return rows;
}

export function summarizeCexOrderbookDepths(rows: CexOrderbookDepth[]): DirectCexOrderbookDepthSummary {
  const symbols = new Set(rows.map((row) => row.symbol));
  const venues = new Set(rows.map((row) => row.venue));
  const maxDepthDown2PctUsdBySymbol: Record<string, number> = {};
  const maxDepthUp2PctUsdBySymbol: Record<string, number> = {};

  for (const row of rows) {
    maxDepthDown2PctUsdBySymbol[row.symbol] = Math.max(
      maxDepthDown2PctUsdBySymbol[row.symbol] ?? 0,
      Math.round(row.depthDown2PctUsd),
    );
    maxDepthUp2PctUsdBySymbol[row.symbol] = Math.max(
      maxDepthUp2PctUsdBySymbol[row.symbol] ?? 0,
      Math.round(row.depthUp2PctUsd),
    );
  }

  return {
    checkedSymbols: symbols.size,
    venueCount: venues.size,
    observations: rows.length,
    maxDepthDown2PctUsdBySymbol,
    maxDepthUp2PctUsdBySymbol,
  };
}

export async function fetchMajorStablecoinOrderbookDepthSummary(
  signal?: AbortSignal,
): Promise<DirectCexOrderbookDepthSummary> {
  const rows: CexOrderbookDepth[] = [];
  const venues: Array<[string, (signal?: AbortSignal) => Promise<CexOrderbookDepth[]>]> = [
    ["binance", fetchBinanceOrderbookDepths],
    ["coinbase", fetchCoinbaseOrderbookDepths],
    ["kraken", fetchKrakenOrderbookDepths],
  ];
  for (const [venue, fetchDepths] of venues) {
    try {
      rows.push(...await fetchDepths(signal));
    } catch (err) {
      if (signal?.aborted) throw err instanceof Error ? err : new Error(String(err));
      logWorkerEventArgs("lib", "warn", `[cex-orderbooks] direct depth fetch failed for ${venue}:`, err);
    }
  }
  return summarizeCexOrderbookDepths(rows);
}
