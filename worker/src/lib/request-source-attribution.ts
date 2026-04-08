import {
  REQUEST_ATTRIBUTION_PRUNE_INTERVAL_SEC,
  REQUEST_ATTRIBUTION_RETENTION_DAYS,
  type ApiRequestRouteMetric,
} from "@shared/lib/request-attribution";
import { IsolateLocalState } from "./isolate-local-state";
import type {
  ApiRequestAttributionApiKeyStat,
  ApiRequestAttributionKeyedPublicApiSummary,
  ApiRequestAttributionLaneStat,
  ApiRequestAttributionResponse,
  ApiRequestAttributionRouteStat,
  ApiRequestAttributionSiteDelivery,
  ApiRequestAttributionSplit,
  ApiRequestAttributionTimeBucket,
  ApiRequestConsumerClass,
  ApiRequestWorkerLane,
} from "@shared/types";

export const API_REQUEST_SOURCE_STATS_RETENTION_DAYS = REQUEST_ATTRIBUTION_RETENTION_DAYS;
const API_REQUEST_SOURCE_STATS_RETENTION_SEC = API_REQUEST_SOURCE_STATS_RETENTION_DAYS * 24 * 60 * 60;

const _rsa = new IsolateLocalState(() => ({
  lastApiRequestSourcePruneBucket: null as number | null,
  pendingApiRequestSourcePrune: null as Promise<void> | null,
}));

export function resetRequestAttributionStateForTests(): void {
  _rsa.reset();
}

async function maybePruneRequestAttributionStats(
  db: D1Database,
  nowSec: number,
): Promise<void> {
  const pruneBucket = nowSec - (nowSec % REQUEST_ATTRIBUTION_PRUNE_INTERVAL_SEC);
  if (_rsa.state.lastApiRequestSourcePruneBucket !== pruneBucket && !_rsa.state.pendingApiRequestSourcePrune) {
    _rsa.state.lastApiRequestSourcePruneBucket = pruneBucket;
    const prunePromise = Promise.all([
      db.prepare("DELETE FROM api_request_consumer_stats WHERE bucket_start < ?")
        .bind(nowSec - API_REQUEST_SOURCE_STATS_RETENTION_SEC)
        .run(),
      db.prepare("DELETE FROM api_key_request_stats WHERE bucket_start < ?")
        .bind(nowSec - API_REQUEST_SOURCE_STATS_RETENTION_SEC)
        .run(),
    ])
      .then(() => {})
      .catch((error) => {
        console.warn("[request-attribution] worker prune failed:", error);
      })
      .finally(() => {
        if (_rsa.state.pendingApiRequestSourcePrune === prunePromise) {
          _rsa.state.pendingApiRequestSourcePrune = null;
        }
      });
    _rsa.state.pendingApiRequestSourcePrune = prunePromise;
  }

  if (_rsa.state.pendingApiRequestSourcePrune) {
    await _rsa.state.pendingApiRequestSourcePrune;
  }
}

export async function recordWorkerRequestAttribution(
  db: D1Database,
  route: ApiRequestRouteMetric,
  lane: ApiRequestWorkerLane,
  consumerClass: ApiRequestConsumerClass,
  nowSec = Math.floor(Date.now() / 1000),
): Promise<void> {
  const bucketStart = nowSec - (nowSec % 60);
  await db.prepare(
    `INSERT INTO api_request_consumer_stats (
       bucket_start,
       route_key,
       route_path,
       lane,
       consumer_class,
       request_count
     )
     VALUES (?, ?, ?, ?, ?, 1)
     ON CONFLICT(bucket_start, route_key, lane, consumer_class)
     DO UPDATE SET
       request_count = request_count + 1,
       route_path = excluded.route_path`,
  )
    .bind(bucketStart, route.routeKey, route.routePath, lane, consumerClass)
    .run();

  await maybePruneRequestAttributionStats(db, nowSec);
}

export async function recordApiKeyRequestAttribution(
  db: D1Database,
  apiKeyId: number,
  nowSec = Math.floor(Date.now() / 1000),
): Promise<void> {
  const bucketStart = nowSec - (nowSec % 60);
  await db.prepare(
    `INSERT INTO api_key_request_stats (
       api_key_id,
       bucket_start,
       request_count
     )
     VALUES (?, ?, 1)
     ON CONFLICT(api_key_id, bucket_start)
     DO UPDATE SET request_count = request_count + 1`,
  )
    .bind(apiKeyId, bucketStart)
    .run();

  await maybePruneRequestAttributionStats(db, nowSec);
}

function roundPct(value: number): number {
  return Number(value.toFixed(2));
}

function toCount(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function buildApiRequestAttributionSplit(
  siteRequests: number,
  externalRequests: number,
): ApiRequestAttributionSplit {
  const totalRequests = siteRequests + externalRequests;
  const siteSharePct = totalRequests > 0 ? roundPct((siteRequests / totalRequests) * 100) : 0;
  const externalSharePct = totalRequests > 0 ? roundPct((externalRequests / totalRequests) * 100) : 0;

  return {
    siteRequests,
    externalRequests,
    totalRequests,
    siteSharePct,
    externalSharePct,
  };
}

export function mapRouteStatsRows(
  rows: Array<{ route_key: string; route_path: string; site_requests: number | null; external_requests: number | null }>,
): ApiRequestAttributionRouteStat[] {
  return rows.map((row) => ({
    routeKey: row.route_key,
    routePath: row.route_path,
    ...buildApiRequestAttributionSplit(toCount(row.site_requests), toCount(row.external_requests)),
  }));
}

export function mapTimeBucketRows(
  rows: Array<{ bucket_start: number; site_requests: number | null; external_requests: number | null }>,
): ApiRequestAttributionTimeBucket[] {
  return rows.map((row) => ({
    bucketStart: row.bucket_start,
    ...buildApiRequestAttributionSplit(toCount(row.site_requests), toCount(row.external_requests)),
  }));
}

export function mapLaneStatsRows(
  rows: Array<{ lane: ApiRequestWorkerLane; site_requests: number | null; external_requests: number | null }>,
): ApiRequestAttributionLaneStat[] {
  return rows.map((row) => ({
    lane: row.lane,
    ...buildApiRequestAttributionSplit(toCount(row.site_requests), toCount(row.external_requests)),
  }));
}

function buildSiteDelivery(config: {
  pagesSiteRequests: number;
  publicApiSiteRequests: number;
  pagesCacheHits: number;
  pagesUpstreamFetches: number;
  pagesUpstreamTimeouts: number;
  pagesUpstreamErrors: number;
}): ApiRequestAttributionSiteDelivery {
  return {
    totalSiteRequests: config.pagesSiteRequests + config.publicApiSiteRequests,
    pagesCacheHits: config.pagesCacheHits,
    pagesUpstreamFetches: config.pagesUpstreamFetches,
    pagesUpstreamTimeouts: config.pagesUpstreamTimeouts,
    pagesUpstreamErrors: config.pagesUpstreamErrors,
    publicApiSiteRequests: config.publicApiSiteRequests,
  };
}

export function buildApiRequestAttributionKeyedPublicApiSummary(
  keyedRequests: number,
  totalPublicApiRequests: number,
  totalKeys: number,
  returnedKeys: number,
  returnedRequests: number,
): ApiRequestAttributionKeyedPublicApiSummary {
  const clampedKeyedRequests = Math.max(0, keyedRequests);
  const clampedTotalPublicApiRequests = Math.max(0, totalPublicApiRequests);
  const unkeyedRequests = Math.max(0, clampedTotalPublicApiRequests - clampedKeyedRequests);
  const totalKeysSafe = Math.max(0, totalKeys);
  const returnedKeysSafe = Math.min(Math.max(0, returnedKeys), totalKeysSafe);
  const omittedKeys = Math.max(0, totalKeysSafe - returnedKeysSafe);
  const omittedRequests = Math.max(0, clampedKeyedRequests - Math.max(0, returnedRequests));

  return {
    keyedRequests: clampedKeyedRequests,
    unkeyedRequests,
    totalRequests: clampedTotalPublicApiRequests,
    keyedSharePct: clampedTotalPublicApiRequests > 0 ? roundPct((clampedKeyedRequests / clampedTotalPublicApiRequests) * 100) : 0,
    unkeyedSharePct: clampedTotalPublicApiRequests > 0 ? roundPct((unkeyedRequests / clampedTotalPublicApiRequests) * 100) : 0,
    totalKeys: totalKeysSafe,
    returnedKeys: returnedKeysSafe,
    omittedKeys,
    omittedRequests,
    truncated: omittedKeys > 0,
  };
}

export function mapApiKeyStatsRows(
  rows: Array<{
    api_key_id: number;
    name: string;
    masked_token: string;
    traffic_class: "external" | "site";
    is_active: number;
    expires_at: number | null;
    rate_limit_per_minute: number;
    request_count: number | null;
  }>,
  keyedRequests: number,
  totalPublicApiRequests: number,
): ApiRequestAttributionApiKeyStat[] {
  return rows.map((row) => {
    const requestCount = toCount(row.request_count);
    return {
      apiKeyId: row.api_key_id,
      name: row.name,
      maskedToken: row.masked_token,
      trafficClass: row.traffic_class,
      isActive: row.is_active === 1,
      expiresAt: row.expires_at,
      rateLimitPerMinute: row.rate_limit_per_minute,
      requestCount,
      shareOfKeyedRequestsPct: keyedRequests > 0 ? roundPct((requestCount / keyedRequests) * 100) : 0,
      shareOfTotalPublicApiRequestsPct: totalPublicApiRequests > 0 ? roundPct((requestCount / totalPublicApiRequests) * 100) : 0,
    };
  });
}

export function buildApiRequestAttributionResponse(config: {
  generatedAt: number;
  from: number;
  to: number;
  bucketSizeSec: number;
  routeLimit: number;
  apiKeyLimit: number;
  totals: {
    siteRequests: number;
    externalRequests: number;
  };
  siteDelivery: {
    pagesSiteRequests: number;
    publicApiSiteRequests: number;
    pagesCacheHits: number;
    pagesUpstreamFetches: number;
    pagesUpstreamTimeouts: number;
    pagesUpstreamErrors: number;
  };
  lanes: ApiRequestAttributionLaneStat[];
  routes: ApiRequestAttributionRouteStat[];
  buckets: ApiRequestAttributionTimeBucket[];
  keyedPublicApi: ApiRequestAttributionKeyedPublicApiSummary;
  apiKeys: ApiRequestAttributionApiKeyStat[];
}): ApiRequestAttributionResponse {
  return {
    generatedAt: config.generatedAt,
    window: {
      from: config.from,
      to: config.to,
      durationSec: Math.max(0, config.to - config.from),
      bucketSizeSec: config.bucketSizeSec,
      routeLimit: config.routeLimit,
      apiKeyLimit: config.apiKeyLimit,
      retentionDays: API_REQUEST_SOURCE_STATS_RETENTION_DAYS,
    },
    totals: buildApiRequestAttributionSplit(config.totals.siteRequests, config.totals.externalRequests),
    siteDelivery: buildSiteDelivery(config.siteDelivery),
    lanes: config.lanes,
    routes: config.routes,
    buckets: config.buckets,
    keyedPublicApi: config.keyedPublicApi,
    apiKeys: config.apiKeys,
    scope: {
      countsTotalSiteDemand: true,
      countsWorkerLoad: true,
      includesPagesProxyCacheHits: true,
    },
  };
}
