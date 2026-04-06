import {
  REQUEST_ATTRIBUTION_PRUNE_INTERVAL_SEC,
  REQUEST_ATTRIBUTION_RETENTION_DAYS,
  type ApiRequestRouteMetric,
} from "@shared/lib/request-attribution";
import { IsolateLocalState } from "./isolate-local-state";
import type {
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

  const pruneBucket = nowSec - (nowSec % REQUEST_ATTRIBUTION_PRUNE_INTERVAL_SEC);
  if (_rsa.state.lastApiRequestSourcePruneBucket !== pruneBucket && !_rsa.state.pendingApiRequestSourcePrune) {
    _rsa.state.lastApiRequestSourcePruneBucket = pruneBucket;
    const prunePromise = db
      .prepare("DELETE FROM api_request_consumer_stats WHERE bucket_start < ?")
      .bind(nowSec - API_REQUEST_SOURCE_STATS_RETENTION_SEC)
      .run()
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

export function buildApiRequestAttributionResponse(config: {
  generatedAt: number;
  from: number;
  to: number;
  bucketSizeSec: number;
  routeLimit: number;
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
}): ApiRequestAttributionResponse {
  return {
    generatedAt: config.generatedAt,
    window: {
      from: config.from,
      to: config.to,
      durationSec: Math.max(0, config.to - config.from),
      bucketSizeSec: config.bucketSizeSec,
      routeLimit: config.routeLimit,
      retentionDays: API_REQUEST_SOURCE_STATS_RETENTION_DAYS,
    },
    totals: buildApiRequestAttributionSplit(config.totals.siteRequests, config.totals.externalRequests),
    siteDelivery: buildSiteDelivery(config.siteDelivery),
    lanes: config.lanes,
    routes: config.routes,
    buckets: config.buckets,
    scope: {
      countsTotalSiteDemand: true,
      countsWorkerLoad: true,
      includesPagesProxyCacheHits: true,
    },
  };
}
