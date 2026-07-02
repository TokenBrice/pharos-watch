import {
  REQUEST_ATTRIBUTION_PRUNE_INTERVAL_SEC,
  REQUEST_ATTRIBUTION_RETENTION_DAYS,
  createBufferedAttributionRecorder,
  isEnvFlagEnabled,
  type ApiRequestRouteMetric,
  type BufferedAttributionEntry,
} from "@shared/lib/request-attribution";
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

export { isRequestSourceAttributionDisabled } from "@shared/lib/request-attribution";

export const API_REQUEST_SOURCE_STATS_RETENTION_DAYS = REQUEST_ATTRIBUTION_RETENTION_DAYS;
const API_REQUEST_SOURCE_STATS_RETENTION_SEC = API_REQUEST_SOURCE_STATS_RETENTION_DAYS * 24 * 60 * 60;
const REQUEST_ATTRIBUTION_FLUSH_DELAY_MS = 10;
const REQUEST_ATTRIBUTION_BATCH_SIZE = 50;
const API_KEY_REQUEST_ATTRIBUTION_DISABLED_ENV = "API_KEY_REQUEST_ATTRIBUTION_DISABLED";

interface BufferedWorkerRequestAttribution extends BufferedAttributionEntry {
  lane: ApiRequestWorkerLane;
  consumerClass: ApiRequestConsumerClass;
}

interface BufferedApiKeyRequestAttribution extends BufferedAttributionEntry {
  apiKeyId: number;
}

const workerRequestRecorder = createBufferedAttributionRecorder<BufferedWorkerRequestAttribution, D1Database>({
  batchSize: REQUEST_ATTRIBUTION_BATCH_SIZE,
  flushDelayMs: REQUEST_ATTRIBUTION_FLUSH_DELAY_MS,
  pruneIntervalSec: REQUEST_ATTRIBUTION_PRUNE_INTERVAL_SEC,
  retentionSec: API_REQUEST_SOURCE_STATS_RETENTION_SEC,
  insertSql: `INSERT INTO api_request_consumer_stats (
           bucket_start,
           route_key,
           route_path,
           lane,
           consumer_class,
           request_count
         )
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(bucket_start, route_key, lane, consumer_class)
         DO UPDATE SET
           request_count = request_count + excluded.request_count,
           route_path = excluded.route_path`,
  pruneSql: [
    "DELETE FROM api_request_consumer_stats WHERE bucket_start < ?",
    "DELETE FROM api_key_request_stats WHERE bucket_start < ?",
  ],
  logLabel: "worker",
  buildKey: (entry) => `${entry.bucketStart}\t${entry.route.routeKey}\t${entry.lane}\t${entry.consumerClass}`,
  bindInsertParams: (entry) => [
    entry.bucketStart,
    entry.route.routeKey,
    entry.route.routePath,
    entry.lane,
    entry.consumerClass,
    entry.requestCount,
  ],
  mergeBuffered: (existing, incoming) => {
    existing.requestCount += incoming.requestCount;
    existing.route = incoming.route;
  },
});

const apiKeyRequestRecorder = createBufferedAttributionRecorder<BufferedApiKeyRequestAttribution, D1Database>({
  batchSize: REQUEST_ATTRIBUTION_BATCH_SIZE,
  flushDelayMs: REQUEST_ATTRIBUTION_FLUSH_DELAY_MS,
  pruneIntervalSec: REQUEST_ATTRIBUTION_PRUNE_INTERVAL_SEC,
  retentionSec: API_REQUEST_SOURCE_STATS_RETENTION_SEC,
  insertSql: `INSERT INTO api_key_request_stats (
       api_key_id,
       bucket_start,
       request_count
     )
     VALUES (?, ?, ?)
     ON CONFLICT(api_key_id, bucket_start)
     DO UPDATE SET request_count = request_count + excluded.request_count`,
  pruneSql: [],
  logLabel: "api-key",
  buildKey: (entry) => `${entry.bucketStart}\t${entry.apiKeyId}`,
  bindInsertParams: (entry) => [
    entry.apiKeyId,
    entry.bucketStart,
    entry.requestCount,
  ],
  mergeBuffered: (existing, incoming) => {
    existing.requestCount += incoming.requestCount;
  },
});

export function resetRequestAttributionStateForTests(): void {
  workerRequestRecorder.reset();
  apiKeyRequestRecorder.reset();
}

export function isApiKeyRequestAttributionDisabled(env: unknown): boolean {
  return isEnvFlagEnabled(env, API_KEY_REQUEST_ATTRIBUTION_DISABLED_ENV);
}

export async function recordWorkerRequestAttribution(
  db: D1Database,
  route: ApiRequestRouteMetric,
  lane: ApiRequestWorkerLane,
  consumerClass: ApiRequestConsumerClass,
  nowSec = Math.floor(Date.now() / 1000),
): Promise<void> {
  const bucketStart = nowSec - (nowSec % 60);
  await workerRequestRecorder.record(
    db,
    {
      bucketStart,
      route,
      lane,
      consumerClass,
      requestCount: 1,
    },
    nowSec,
  );
}

export async function recordApiKeyRequestAttribution(
  db: D1Database,
  apiKeyId: number,
  nowSec = Math.floor(Date.now() / 1000),
): Promise<void> {
  const bucketStart = nowSec - (nowSec % 60);
  await apiKeyRequestRecorder.record(
    db,
    {
      apiKeyId,
      bucketStart,
      route: { routeKey: "api-key", routePath: "/api/*" },
      requestCount: 1,
    },
    nowSec,
  );

  await workerRequestRecorder.maybePrune(db, nowSec);
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
