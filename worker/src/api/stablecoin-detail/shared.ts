import { logWorkerEventArgs } from "../../lib/structured-log";
import { setCache } from "../../lib/db-cache";
import { buildPerCoinCacheControl, PER_COIN_CACHE_TTL_SECONDS, API_CACHE_PROFILES as CACHE_PROFILES } from "@shared/lib/api-cache-profiles";
import { DAY_SECONDS } from "@shared/lib/time-constants";
import { DETAIL_WRITE_FAILURE_KEY_PREFIX } from "../../lib/detail-cache-generation";
import { binarySearchNearest } from "../../lib/binary-search";
import { errorResponse, jsonResponse } from "../../lib/api-response";
import { claimDetailCacheGeneration, publishDetailCacheGeneration } from "../../lib/detail-cache-generation";
import { logWorkerEvent } from "../../lib/structured-log";
import { assessFreshnessTimestamp } from "../../lib/api-freshness-age";
import { buildFreshnessMeta } from "../../lib/api-freshness";
import { addFreshnessHeaders } from "../../lib/api-freshness-headers";
import { API_FRESHNESS_MAX_AGE_SEC, DETAIL_HISTORY_FALLBACK_REASON } from "@shared/lib/api-freshness";
import { isKinesisWrapperSupplyCutoverActive } from "@shared/lib/supply-perimeter-changes";
import { historicalSupplyQuantity, matchesCurrentSupplyPerimeter, type HistoricalSupplyQuantityRow } from "../../lib/supply-history-db";
import { isKinesisWrapperSupplyId } from "@shared/lib/onchain-supply-probe";
import { classifySupplyCoverage, parseSupplyObservationProvenance } from "@shared/lib/supply-provenance";
import { bucketUnixSecondsToUtcDay } from "@shared/lib/time-buckets";
import { getCompletedSupplySnapshot } from "../../lib/supply-snapshot-completion";

export const CACHE_TTL_SECONDS = PER_COIN_CACHE_TTL_SECONDS;
export const DETAIL_UPSTREAM_TIMEOUT_MS = 12_000;
export const DETAIL_UPSTREAM_MAX_RETRIES = 2;
export const DETAIL_STALE_CACHE_MAX_AGE_SECONDS = DAY_SECONDS;
const DETAIL_HISTORY_MAX_AGE_SECONDS = 3 * DAY_SECONDS;
// D1 caps a single value at 2 MiB (2,097,152 B); leave headroom so the write
// is refused here (with a failure marker) instead of erroring inside D1.
const DETAIL_CACHE_MAX_VALUE_BYTES = 1_900_000;
const COMMODITY_HISTORY_VERSION = 1;
const VERSIONED_COMMODITY_HISTORY_IDS = new Set(["paxg-paxos", "vnxau-vnx"]);

function commodityHistoryVersion(id: string): number | undefined {
  if (id === "xaut-tether") return 2;
  if (isKinesisWrapperSupplyId(id)) return isKinesisWrapperSupplyCutoverActive(id, Math.floor(Date.now() / 1000)) ? 1 : 2;
  return VERSIONED_COMMODITY_HISTORY_IDS.has(id) ? COMMODITY_HISTORY_VERSION : undefined;
}

export function hasCurrentCommodityHistory(id: string, detail: Record<string, unknown>): boolean {
  const version = commodityHistoryVersion(id);
  return version === undefined || detail.commodityHistoryVersion === version;
}

export function admitCommodityDetailCache(id: string, cached: DetailCacheEntry): DetailCacheEntry {
  if (!cached || commodityHistoryVersion(id) === undefined) return cached;
  try {
    const detail = JSON.parse(cached.value);
    return detail && hasCurrentCommodityHistory(id, detail) ? cached : null;
  } catch {
    return null;
  }
}

type DetailCacheEntry = { value: string; updatedAt: number } | null;
type DetailTokens = Record<string, unknown>[];
type ResolvedDetailHistory = { tokens: DetailTokens; observedAt: number | null; fallback: boolean };
type DefiLlamaCoinChartPricePoint = { timestamp: number; price: number };

interface DefiLlamaCoinChartEntry {
  prices?: DefiLlamaCoinChartPricePoint[];
}

interface DefiLlamaCoinChartResponse {
  coins?: Record<string, DefiLlamaCoinChartEntry | undefined>;
}

export interface DetailResponseHelpers {
  cached: DetailCacheEntry;
  createFreshResponseFromBody(body: string): Response;
  createFreshResponseFromTokens(tokens: DetailTokens): Response;
  createFallbackResponseFromTokens(tokens: DetailTokens, observedAt: number | null): Response;
  createResponseFromResolvedTokens(history: ResolvedDetailHistory, body?: Record<string, unknown>): Response;
  resolveTokensWithSupplyHistoryFallback(
    tokens: DetailTokens,
    reasons: { emptyReason: string; staleReason: string },
  ): Promise<ResolvedDetailHistory>;
  staleCacheOrError(status: number, message: string): Response;
  trySupplyHistoryFallback(reason: string, latestTokenDate?: number | null): Promise<Response | null>;
  serveWrapperHistory(): Promise<Response>;
}

export function logUpstreamFailure(
  source: string,
  stablecoinId: string,
  status: number | "no-response",
): void {
  logWorkerEventArgs("api", "warn", `[detail] upstream failure source=${source} stablecoin=${stablecoinId} status=${status}`);
}

export function logUpstreamException(
  source: string,
  stablecoinId: string,
  err: unknown,
): void {
  logWorkerEventArgs("api", "error",
    `[detail] upstream exception source=${source} stablecoin=${stablecoinId} error=${String(err).slice(0, 300)}`,
  );
}

function createJsonResponse(body: string, cacheControl: string): Response {
  return new Response(body, {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": cacheControl,
    },
  });
}

export function createWrapperDetailUnavailableResponse(): Response {
  const reason = "wrapper-detail-unavailable";
  return jsonResponse({ error: "Wrapper supply history and current detail are unavailable", reason }, {
    status: 503,
    noStore: true,
    headers: { "X-Data-Freshness": "unknown", "X-Data-Freshness-Reason": reason },
  });
}

function detailHistoryFreshness(observedAt: number, now: number) {
  return {
    ...buildFreshnessMeta(observedAt, DETAIL_HISTORY_MAX_AGE_SECONDS, "stablecoin-detail", {
      assessedAt: now, freshBudgetSec: DETAIL_HISTORY_MAX_AGE_SECONDS,
      degradedBudgetSec: DETAIL_HISTORY_MAX_AGE_SECONDS,
    }),
    status: "stale" as const,
    reason: DETAIL_HISTORY_FALLBACK_REASON,
  };
}

/** Assess the stored D1 clock again on each public read, including cache hits. */
export function applyWrapperDetailHistoryFreshness(
  detail: Record<string, unknown>, headers: Headers, now: number,
): boolean {
  const clock = detail.commodityHistoryObservedAt;
  if (typeof clock !== "number" || !Number.isSafeInteger(clock) || clock <= 0 || clock > now ||
    now - clock > DETAIL_HISTORY_MAX_AGE_SECONDS ||
    !Array.isArray(detail.tokens) || detail.tokens.length === 0) return false;

  const meta = detailHistoryFreshness(clock, now);
  detail._meta = meta;
  headers.set("X-Data-Updated-At", String(clock));
  headers.set("X-Data-Age", String(meta.ageSeconds));
  headers.set("X-Data-Freshness", meta.status);
  headers.set("X-Data-Freshness-Reason", meta.reason);
  headers.set("Warning", '110 - "Stablecoin detail history is retained fallback data"');
  const cacheControl = headers.get("Cache-Control");
  if (cacheControl != null) {
    const bounded = addFreshnessHeaders({ "Cache-Control": cacheControl }, clock, DETAIL_HISTORY_MAX_AGE_SECONDS, {
      assessedAt: now, freshBudgetSec: DETAIL_HISTORY_MAX_AGE_SECONDS,
    });
    headers.set("Cache-Control", bounded["Cache-Control"] ?? cacheControl);
  }
  return true;
}

export function createFreshCacheHitResponse(cachedValue: string, ageSeconds: number, updatedAt: number): Response {
  const response = createJsonResponse(
    cachedValue,
    buildPerCoinCacheControl(CACHE_TTL_SECONDS - ageSeconds),
  );
  response.headers.set("X-Data-Age", String(Math.max(0, ageSeconds)));
  response.headers.set("X-Data-Updated-At", String(updatedAt));
  return response;
}

export function createStaleCacheHitResponse(cachedValue: string, ageSeconds: number, updatedAt: number): Response {
  // A cache entry due for background revalidation is not necessarily old data.
  // Keep the producer clock and no-store policy; classify its public health
  // using the same budget as the detail page's current market snapshot.
  const freshness = buildFreshnessMeta(updatedAt, API_FRESHNESS_MAX_AGE_SEC.stablecoins, "stablecoin-detail");
  return new Response(cachedValue, {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": CACHE_PROFILES.noStore,
      "X-Data-Age": String(Math.max(0, ageSeconds)),
      "X-Data-Updated-At": String(updatedAt),
      ...(freshness.status !== "fresh" ? {
        Warning: '110 - "Stablecoin detail cache is stale; refresh scheduled"',
      } : {}),
      "X-Data-Freshness": freshness.status,
    },
  });
}

function createFreshUpstreamResponse(body: string): Response {
  const response = createJsonResponse(body, buildPerCoinCacheControl(CACHE_TTL_SECONDS));
  response.headers.set("X-Data-Updated-At", String(Math.floor(Date.now() / 1000)));
  return response;
}

function createStaleCacheResponse(cached: DetailCacheEntry): Response | null {
  if (!cached) return null;
  const ageSeconds = Math.max(0, Math.floor(Date.now() / 1000) - cached.updatedAt);
  // The served generation keeps its own age budget; a failed refresh is a warning, not an automatic stale verdict.
  const freshness = buildFreshnessMeta(cached.updatedAt, API_FRESHNESS_MAX_AGE_SEC.stablecoins, "stablecoin-detail");
  return new Response(cached.value, {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": CACHE_PROFILES.noStore,
      "X-Data-Age": String(ageSeconds),
      "X-Data-Updated-At": String(cached.updatedAt),
      "Warning": "110 - \"Stablecoin detail cache is stale; refresh failed\"",
      "X-Data-Freshness": freshness.status,
    },
  });
}

function staleCacheOrError(
  cached: DetailCacheEntry,
  status: number,
  message: string,
): Response {
  return createStaleCacheResponse(cached) ?? errorResponse(status, message, { noStore: true });
}

export function createDetailResponseHelpers(config: {
  db: D1Database;
  stablecoinId: string;
  pegType: string;
  cached: DetailCacheEntry;
  execCtx: ExecutionContext;
  onFreshAcquisition?: () => void;
}): DetailResponseHelpers {
  const cacheKey = `detail:${config.stablecoinId}`;
  const cached = admitCommodityDetailCache(config.stablecoinId, config.cached);
  const historyVersion = { commodityHistoryVersion: commodityHistoryVersion(config.stablecoinId) };
  // Failed/oversized cache writes used to vanish into sampled console logs,
  // leaving flagship coins on a synchronous-refetch-per-request path for
  // weeks. A small marker row makes the failure visible to the staleness
  // watchdog, which alerts on fresh markers.
  const recordCacheWriteFailure = async (reason: string, bytes: number): Promise<void> => {
    try {
      await setCache(
        config.db,
        `${DETAIL_WRITE_FAILURE_KEY_PREFIX}${config.stablecoinId}`,
        JSON.stringify({ reason, bytes }),
      );
    } catch {
      // D1 itself is unavailable; cron telemetry covers that failure mode.
    }
  };

  const queueCacheWrite = (body: string): void => {
    config.execCtx.waitUntil(
      (async () => {
        const bodyBytes = new TextEncoder().encode(body).length;
        if (bodyBytes > DETAIL_CACHE_MAX_VALUE_BYTES) {
          logWorkerEventArgs("api", "error",
            `[detail] cache write skipped stablecoin=${config.stablecoinId} bytes=${bodyBytes} exceeds ${DETAIL_CACHE_MAX_VALUE_BYTES}`,
          );
          await recordCacheWriteFailure("value-too-large", bodyBytes);
          return;
        }
        try {
          const claim = await claimDetailCacheGeneration(config.db, config.stablecoinId);
          const write = await publishDetailCacheGeneration(config.db, cacheKey, body, claim);
          if (!write.written) {
            logWorkerEvent({
              scope: "api",
              level: "info",
              event: "stablecoin_detail.cache_write_superseded",
              route: "stablecoin-detail",
              message: "Skipped detail cache write because a newer refresh owns publication",
              metadata: {
                stablecoinId: config.stablecoinId,
                generation: write.generation,
              },
            });
          }
        } catch (err) {
          logWorkerEventArgs("api", "error",
            `[detail] cache write failed stablecoin=${config.stablecoinId} bytes=${bodyBytes} error=${String(err).slice(0, 300)}`,
          );
          await recordCacheWriteFailure("write-error", bodyBytes);
        }
      })(),
    );
  };

  const loadSupplyHistoryFallback = async (
    reason: string,
    latestTokenDate?: number | null,
  ): Promise<DetailTokens> => {
    const tokens = await fetchSupplyHistoryFallback(config.db, config.stablecoinId, config.pegType);
    if (tokens.length > 0) {
      const latestSuffix = latestTokenDate != null ? ` latest=${latestTokenDate}` : "";
      logWorkerEventArgs("api", "warn",
        `[detail] fallback source=supply_history stablecoin=${config.stablecoinId} reason=${reason} points=${tokens.length}${latestSuffix}`,
      );
    }
    return tokens;
  };

  const trySupplyHistoryFallback = async (
    reason: string,
    latestTokenDate?: number | null,
  ): Promise<Response | null> => {
    const tokens = await loadSupplyHistoryFallback(reason, latestTokenDate);
    if (tokens.length === 0) return null;
    return createFallbackResponseFromTokens(tokens, getLatestDetailTokenDate(tokens), historyVersion);
  };

  const createFreshResponseFromBody = (body: string): Response => {
    queueCacheWrite(body);
    const response = createFreshUpstreamResponse(body);
    config.onFreshAcquisition?.();
    return response;
  };

  const createFreshResponseFromTokens = (tokens: DetailTokens): Response =>
    createFreshResponseFromBody(JSON.stringify({ tokens }));

  const createFallbackResponseFromTokens = (
    tokens: DetailTokens,
    observedAt: number | null,
    body?: Record<string, unknown>,
  ): Response => {
    const now = Math.floor(Date.now() / 1000);
    const assessment = assessFreshnessTimestamp(now, observedAt);
    const meta = assessment.reason == null && observedAt != null
      ? detailHistoryFreshness(observedAt, now)
      : { updatedAt: null, ageSeconds: null, assessedAt: now, status: "unknown" as const,
          freshBudgetSec: DETAIL_HISTORY_MAX_AGE_SECONDS, degradedBudgetSec: DETAIL_HISTORY_MAX_AGE_SECONDS,
          reason: assessment.reason };
    const response = createJsonResponse(JSON.stringify({ ...body, tokens, _meta: meta }), CACHE_PROFILES.noStore);
    response.headers.set("X-Data-Updated-At", meta.updatedAt == null ? "unknown" : String(meta.updatedAt));
    response.headers.set("X-Data-Age", meta.ageSeconds == null ? "unavailable" : String(meta.ageSeconds));
    response.headers.set("X-Data-Freshness", meta.status);
    response.headers.set("X-Data-Freshness-Reason", meta.reason ?? DETAIL_HISTORY_FALLBACK_REASON);
    response.headers.set("Warning", '110 - "Stablecoin detail history is retained fallback data"');
    return response;
  };

  const createResponseFromResolvedTokens = (
    history: ResolvedDetailHistory,
    body?: Record<string, unknown>,
  ): Response =>
    history.fallback || !isDetailHistoryFresh(history.tokens)
      ? createFallbackResponseFromTokens(history.tokens, history.observedAt, { ...body, ...historyVersion })
      : createFreshResponseFromBody(JSON.stringify({ ...body, ...historyVersion, tokens: history.tokens }));

  const serveWrapperHistory = async (): Promise<Response> => {
    const tokens = await loadSupplyHistoryFallback("wrapper-history").catch((error) => {
      logUpstreamException("wrapper-supply-history", config.stablecoinId, error);
      return [];
    });
    const observedAt = tokens.reduce((latest, token) => Math.max(latest, Number(token.supplyObservedAt)), 0);
    if (observedAt <= 0) return createWrapperDetailUnavailableResponse();
    const body = JSON.stringify({ ...historyVersion, commodityHistoryObservedAt: observedAt, tokens });
    if (!isDetailHistoryFresh([{ date: observedAt }])) {
      return createFallbackResponseFromTokens(tokens, observedAt, { ...historyVersion, commodityHistoryObservedAt: observedAt });
    }
    queueCacheWrite(body);
    config.onFreshAcquisition?.();
    const response = createFreshUpstreamResponse(body);
    response.headers.set("X-Data-Updated-At", String(observedAt));
    return response;
  };

  const resolveTokensWithSupplyHistoryFallback = async (
    tokens: DetailTokens,
    reasons: { emptyReason: string; staleReason: string },
  ): Promise<ResolvedDetailHistory> => {
    if (tokens.length === 0) {
      const fallbackTokens = await loadSupplyHistoryFallback(reasons.emptyReason);
      const resolved = fallbackTokens.length > 0 ? fallbackTokens : tokens;
      return { tokens: resolved, observedAt: getLatestDetailTokenDate(resolved), fallback: true };
    }

    if (!isDetailHistoryFresh(tokens)) {
      const fallbackTokens = await loadSupplyHistoryFallback(
        reasons.staleReason,
        getLatestDetailTokenDate(tokens),
      );
      const resolved = fallbackTokens.length > 0 ? fallbackTokens : tokens;
      return { tokens: resolved, observedAt: getLatestDetailTokenDate(resolved), fallback: true };
    }

    if (config.stablecoinId === "xaut-tether") {
      const startDay = bucketUnixSecondsToUtcDay(Date.now() / 1000) - 32 * DAY_SECONDS;
      const scopedHistory = await fetchSupplyHistoryFallback(config.db, config.stablecoinId, config.pegType, startDay)
        .catch((error) => {
          logUpstreamException("xaut-native-supply-history", config.stablecoinId, error);
          return [];
        });
      const byDay = new Map(scopedHistory.filter((token) => token.nativeSupplySource === "onchain-circulating-supply")
        .map((token) => [token.date, token]));
      tokens = tokens.map((token) => {
        const checkpoint = typeof token.date === "number" ? byDay.get(bucketUnixSecondsToUtcDay(token.date)) : undefined;
        return checkpoint ? { ...token, totalCirculating: checkpoint.totalCirculating,
          nativeSupplySource: checkpoint.nativeSupplySource, nativeSupplyObservedAt: checkpoint.nativeSupplyObservedAt } : token;
      });
    }
    return { tokens, observedAt: getLatestDetailTokenDate(tokens), fallback: false };
  };

  return {
    cached,
    createFreshResponseFromBody,
    createFreshResponseFromTokens,
    createFallbackResponseFromTokens,
    createResponseFromResolvedTokens,
    resolveTokensWithSupplyHistoryFallback,
    staleCacheOrError: (status, message) => staleCacheOrError(cached, status, message),
    trySupplyHistoryFallback,
    serveWrapperHistory,
  };
}

/** Fallback: build tokens array from D1 supply_history when external APIs have no data. */
async function fetchSupplyHistoryFallback(
  db: D1Database,
  stablecoinId: string,
  pegType: string,
  startDay?: number,
): Promise<Record<string, unknown>[]> {
  const now = Math.floor(Date.now() / 1000);
  const wrapper = isKinesisWrapperSupplyCutoverActive(stablecoinId, now);
  const xaut = stablecoinId === "xaut-tether";
  const completion = wrapper || xaut ? await getCompletedSupplySnapshot(db) : null;
  if (wrapper && !completion) return [];
  const result = await db
    .prepare(
      `SELECT snapshot_date, circulating_usd, circulating_native, supply_provenance, price, price_observed_at,
         valuation_price_usd, valuation_observed_at_sec
       FROM supply_history
       WHERE stablecoin_id = ?${completion ? " AND snapshot_date <= ?" : ""}${startDay != null ? " AND snapshot_date >= ?" : ""}
       ORDER BY snapshot_date ASC`,
    )
    .bind(stablecoinId, ...(completion ? [completion.snapshotDate] : []), ...(startDay != null ? [startDay] : []))
    .all<HistoricalSupplyQuantityRow & { supply_provenance: string | null }>();

  return (result.results ?? [])
    .filter((row) => matchesCurrentSupplyPerimeter(stablecoinId, row.snapshot_date, row.supply_provenance, now))
    .map((row) => ({ ...row, provenance: parseSupplyObservationProvenance(row.supply_provenance).provenance }))
    .filter(({ provenance }) => !wrapper || (provenance?.supplySource === "onchain-total-supply" &&
      provenance.supplyObservedAt != null && provenance.supplyObservedAt > 0 && provenance.supplyObservedAt <= now))
    .filter((row) => (
      typeof row.circulating_usd === "number"
      && Number.isFinite(row.circulating_usd)
      && row.circulating_usd >= 0
      && row.snapshot_date > 0
      && assessFreshnessTimestamp(now, row.snapshot_date).reason == null
    ))
    .map((row) => {
      const native = historicalSupplyQuantity(stablecoinId, pegType, row, row.provenance, now);
      const hasNative = native != null;
      const xautScoped = xaut && completion != null && hasNative && row.provenance?.supplySource === "onchain-circulating-supply" &&
        classifySupplyCoverage(row.provenance) === "complete" && assessFreshnessTimestamp(now, row.provenance.supplyObservedAt).reason == null;
      return {
        date: row.snapshot_date,
        ...(wrapper ? { supplyObservedAt: row.provenance?.supplyObservedAt } : {}),
        ...(xautScoped ? {
          nativeSupplySource: row.provenance?.supplySource,
          nativeSupplyObservedAt: row.provenance?.supplyObservedAt,
        } : {}),
        totalCirculatingUSD: { [pegType]: row.circulating_usd },
        totalCirculating: hasNative && (!xaut || xautScoped) ? { [pegType]: native } : {},
      };
    });
}

export function findNearestPrice(
  sortedPrices: { timestamp: number; price: number }[],
  date: number,
): number | null {
  const match = binarySearchNearest(sortedPrices, date, (p) => p.timestamp);
  if (!match || bucketUnixSecondsToUtcDay(match.timestamp) !== bucketUnixSecondsToUtcDay(date)) return null;
  const price = match.price;
  return typeof price === "number" && Number.isFinite(price) && price > 0 ? price : null;
}

/** An omitted bucket means USD supply could not be converted with a usable price. */
export function buildNativeSupplyBuckets(
  pegType: string,
  supplyUsd: number,
  price: number | null | undefined,
): Record<string, number> {
  if (typeof price !== "number" || !Number.isFinite(price) || price <= 0) return {};
  const nativeSupply = supplyUsd / price;
  return Number.isFinite(nativeSupply) && (nativeSupply > 0 || supplyUsd === 0)
    ? { [pegType]: nativeSupply }
    : {};
}

function dateKeyFromTimestampMs(tsMs: number): string {
  return new Date(tsMs).toISOString().slice(0, 10);
}

export function buildPriceMapByDate(
  prices: [number, number][] | undefined,
): Map<string, number> {
  const priceMap = new Map<string, number>();
  if (!prices) return priceMap;

  for (const [ts, price] of prices) {
    if (Number.isFinite(price)) {
      priceMap.set(dateKeyFromTimestampMs(ts), price);
    }
  }
  return priceMap;
}

export function extractDefiLlamaCoinChartPrices(
  payload: unknown,
  geckoId: string,
): DefiLlamaCoinChartPricePoint[] {
  if (!payload || typeof payload !== "object") return [];

  const coins = (payload as DefiLlamaCoinChartResponse).coins;
  const prices = coins?.[`coingecko:${geckoId}`]?.prices;
  if (!Array.isArray(prices)) return [];

  return prices
    .filter((point): point is DefiLlamaCoinChartPricePoint => (
      typeof point?.timestamp === "number"
      && Number.isFinite(point.timestamp)
      && typeof point?.price === "number"
      && Number.isFinite(point.price)
    ))
    .sort((left, right) => left.timestamp - right.timestamp);
}

export function getLatestDetailTokenDate(tokens: ReadonlyArray<Record<string, unknown>>): number | null {
  let latestDate: number | null = null;

  for (const token of tokens) {
    const date = token.date;
    if (typeof date !== "number" || !Number.isFinite(date)) continue;
    if (latestDate == null || date > latestDate) latestDate = date;
  }

  return latestDate;
}

function isDetailHistoryFresh(
  tokens: ReadonlyArray<Record<string, unknown>>,
  nowSec = Math.floor(Date.now() / 1000),
): boolean {
  const assessment = assessFreshnessTimestamp(nowSec, getLatestDetailTokenDate(tokens));
  return assessment.ageSeconds != null && assessment.ageSeconds <= DETAIL_HISTORY_MAX_AGE_SECONDS;
}

export function buildTokenRowsFromMarketCaps(
  marketCaps: [number, number][],
  pegType: string,
  priceMap: Map<string, number>,
  resolveMcap?: (mcap: number, price: number | null) => number,
): Record<string, unknown>[] {
  return marketCaps
    .filter(([, mcap]) => Number.isFinite(mcap) && mcap > 0)
    .map(([ts, mcap]) => {
      const date = Math.floor(ts / 1000);
      const candidatePrice = priceMap.get(dateKeyFromTimestampMs(ts));
      const price = typeof candidatePrice === "number" && Number.isFinite(candidatePrice) && candidatePrice > 0
        ? candidatePrice
        : null;
      const marketCap = resolveMcap ? resolveMcap(mcap, price) : mcap;
      return {
        date,
        totalCirculatingUSD: { [pegType]: marketCap },
        totalCirculating: buildNativeSupplyBuckets(pegType, marketCap, price),
      };
    });
}
