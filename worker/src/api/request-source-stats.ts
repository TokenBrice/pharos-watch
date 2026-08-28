import type { ApiRequestWorkerLane } from "@shared/types";
import { jsonResponse } from "../lib/api-response";
import { parseQueryParams } from "../lib/api-params";
import {
  buildApiRequestAttributionResponse,
  buildApiRequestAttributionKeyedPublicApiSummary,
  mapApiKeyStatsRows,
  mapLaneStatsRows,
  mapRouteStatsRows,
  mapTimeBucketRows,
} from "../lib/request-source-attribution";
import { runAdminRoute, type AdminRouteContext } from "../lib/route-wrappers";

interface TotalsRow {
  pages_site_requests: number | null;
  public_api_site_requests: number | null;
  external_requests: number | null;
}

interface RouteRow {
  route_key: string;
  route_path: string;
  site_requests: number | null;
  external_requests: number | null;
}

interface BucketRow {
  bucket_start: number;
  site_requests: number | null;
  external_requests: number | null;
}

interface LaneRow {
  lane: ApiRequestWorkerLane;
  site_requests: number | null;
  external_requests: number | null;
}

interface SiteDeliveryRow {
  total_pages_site_requests: number | null;
  pages_cache_hits: number | null;
  pages_upstream_fetches: number | null;
  pages_upstream_timeouts: number | null;
  pages_upstream_errors: number | null;
}

interface ApiKeySummaryRow {
  keyed_requests: number | null;
  total_keys: number | null;
}

interface ApiKeyRow {
  api_key_id: number;
  name: string;
  masked_token: string;
  traffic_class: "external" | "site";
  is_active: number;
  expires_at: number | null;
  rate_limit_per_minute: number;
  request_count: number | null;
}

export function handleRequestSourceStats({ db, trustedAdmin, request }: AdminRouteContext): Promise<Response> {
  return runAdminRoute(
    {
      endpoint: "request-source-stats",
      request,
      trustedAdmin,
    },
    async () => {
      const now = Math.floor(Date.now() / 1000);
      const url = new URL(request?.url ?? "https://ops-api.pharos.watch/api/request-source-stats");
      const parsed = parseQueryParams(url.searchParams, {
        hours: { type: "int", default: 24, min: 1, max: 24 * 35 },
        bucketSec: { type: "int", default: 3600, min: 60, max: 86400, name: "bucketSec" },
        routeLimit: { type: "int", default: 20, min: 1, max: 100, name: "routeLimit" },
        apiKeyLimit: { type: "int", default: 25, min: 1, max: 100, name: "apiKeyLimit" },
      });
      if (parsed instanceof Response) return parsed;

      const { hours, bucketSec, routeLimit, apiKeyLimit } = parsed;
      const to = now;
      const from = now - hours * 3600;

      const [totalsRow, routeRows, bucketRows, laneRows, siteDeliveryRow, apiKeySummaryRow, apiKeyRows] = await Promise.all([
        db.prepare(
          `SELECT
             COALESCE((
               SELECT SUM(request_count)
               FROM site_data_request_stats
               WHERE bucket_start >= ? AND bucket_start < ?
             ), 0) AS pages_site_requests,
             COALESCE((
               SELECT SUM(request_count)
               FROM api_request_consumer_stats
               WHERE bucket_start >= ? AND bucket_start < ?
                 AND lane = 'public-api'
                 AND consumer_class = 'site'
             ), 0) AS public_api_site_requests,
             COALESCE((
               SELECT SUM(request_count)
               FROM api_request_consumer_stats
               WHERE bucket_start >= ? AND bucket_start < ?
                 AND lane = 'public-api'
                 AND consumer_class = 'external'
             ), 0) AS external_requests`,
        )
          .bind(from, to, from, to, from, to)
          .first<TotalsRow>(),
        db.prepare(
          `SELECT
             route_key,
             route_path,
             SUM(site_requests) AS site_requests,
             SUM(external_requests) AS external_requests
           FROM (
             SELECT
               route_key,
               route_path,
               SUM(request_count) AS site_requests,
               0 AS external_requests
             FROM site_data_request_stats
             WHERE bucket_start >= ? AND bucket_start < ?
             GROUP BY route_key, route_path

             UNION ALL

             SELECT
               route_key,
               route_path,
               SUM(CASE WHEN lane = 'public-api' AND consumer_class = 'site' THEN request_count ELSE 0 END) AS site_requests,
               SUM(CASE WHEN lane = 'public-api' AND consumer_class = 'external' THEN request_count ELSE 0 END) AS external_requests
             FROM api_request_consumer_stats
             WHERE bucket_start >= ? AND bucket_start < ?
             GROUP BY route_key, route_path
           ) AS combined
           GROUP BY route_key, route_path
           ORDER BY (COALESCE(site_requests, 0) + COALESCE(external_requests, 0)) DESC, route_key ASC
           LIMIT ?`,
        )
          .bind(from, to, from, to, routeLimit)
          .all<RouteRow>(),
        db.prepare(
          `SELECT
             bucket_start,
             SUM(site_requests) AS site_requests,
             SUM(external_requests) AS external_requests
           FROM (
             SELECT
               CAST(bucket_start / ? AS INTEGER) * ? AS bucket_start,
               SUM(request_count) AS site_requests,
               0 AS external_requests
             FROM site_data_request_stats
             WHERE bucket_start >= ? AND bucket_start < ?
             GROUP BY CAST(bucket_start / ? AS INTEGER) * ?

             UNION ALL

             SELECT
               CAST(bucket_start / ? AS INTEGER) * ? AS bucket_start,
               SUM(CASE WHEN lane = 'public-api' AND consumer_class = 'site' THEN request_count ELSE 0 END) AS site_requests,
               SUM(CASE WHEN lane = 'public-api' AND consumer_class = 'external' THEN request_count ELSE 0 END) AS external_requests
             FROM api_request_consumer_stats
             WHERE bucket_start >= ? AND bucket_start < ?
             GROUP BY CAST(bucket_start / ? AS INTEGER) * ?
           ) AS combined
           GROUP BY bucket_start
           ORDER BY bucket_start ASC`,
        )
          .bind(
            bucketSec,
            bucketSec,
            from,
            to,
            bucketSec,
            bucketSec,
            bucketSec,
            bucketSec,
            from,
            to,
            bucketSec,
            bucketSec,
          )
          .all<BucketRow>(),
        db.prepare(
          `SELECT
             lane,
             SUM(CASE WHEN consumer_class = 'site' THEN request_count ELSE 0 END) AS site_requests,
             SUM(CASE WHEN consumer_class = 'external' THEN request_count ELSE 0 END) AS external_requests
           FROM api_request_consumer_stats
           WHERE bucket_start >= ? AND bucket_start < ?
           GROUP BY lane
           ORDER BY CASE lane
             WHEN 'public-api' THEN 0
             WHEN 'site-api' THEN 1
             ELSE 2
           END ASC, lane ASC`,
        )
          .bind(from, to)
          .all<LaneRow>(),
        db.prepare(
          `SELECT
             COALESCE(SUM(request_count), 0) AS total_pages_site_requests,
             COALESCE(SUM(CASE WHEN delivery_path = 'pages-cache-hit' THEN request_count ELSE 0 END), 0) AS pages_cache_hits,
             COALESCE(SUM(CASE WHEN delivery_path = 'pages-upstream-fetch' THEN request_count ELSE 0 END), 0) AS pages_upstream_fetches,
             COALESCE(SUM(CASE WHEN delivery_path = 'pages-upstream-timeout' THEN request_count ELSE 0 END), 0) AS pages_upstream_timeouts,
             COALESCE(SUM(CASE WHEN delivery_path = 'pages-upstream-error' THEN request_count ELSE 0 END), 0) AS pages_upstream_errors
           FROM site_data_request_stats
           WHERE bucket_start >= ? AND bucket_start < ?`,
        )
          .bind(from, to)
          .first<SiteDeliveryRow>(),
        db.prepare(
          `SELECT
             COALESCE(SUM(request_count), 0) AS keyed_requests,
             COUNT(DISTINCT api_key_id) AS total_keys
           FROM api_key_request_stats
           WHERE bucket_start >= ? AND bucket_start < ?`,
        )
          .bind(from, to)
          .first<ApiKeySummaryRow>(),
        db.prepare(
          `SELECT
             stats.api_key_id,
             keys.name,
             ('ph_live_' || keys.key_prefix || '_********') AS masked_token,
             keys.traffic_class,
             keys.is_active,
             keys.expires_at,
             keys.rate_limit_per_minute,
             stats.request_count
           FROM (
             SELECT
               api_key_id,
               SUM(request_count) AS request_count
             FROM api_key_request_stats
             WHERE bucket_start >= ? AND bucket_start < ?
             GROUP BY api_key_id
             ORDER BY SUM(request_count) DESC, api_key_id ASC
             LIMIT ?
           ) AS stats
           INNER JOIN api_keys AS keys
             ON keys.id = stats.api_key_id
           ORDER BY stats.request_count DESC, stats.api_key_id ASC`,
        )
          .bind(from, to, apiKeyLimit)
          .all<ApiKeyRow>(),
      ]);

      const pagesSiteRequests = totalsRow?.pages_site_requests ?? 0;
      const publicApiSiteRequests = totalsRow?.public_api_site_requests ?? 0;
      const externalRequests = totalsRow?.external_requests ?? 0;
      const totalPublicApiRequests = publicApiSiteRequests + externalRequests;
      const keyedRequests = apiKeySummaryRow?.keyed_requests ?? 0;
      const totalKeys = apiKeySummaryRow?.total_keys ?? 0;
      const apiKeys = mapApiKeyStatsRows(apiKeyRows.results ?? [], keyedRequests, totalPublicApiRequests);
      const returnedKeyedRequests = apiKeys.reduce((sum, row) => sum + row.requestCount, 0);

      const body = buildApiRequestAttributionResponse({
        generatedAt: now,
        from,
        to,
        bucketSizeSec: bucketSec,
        routeLimit,
        apiKeyLimit,
        totals: {
          siteRequests: pagesSiteRequests + publicApiSiteRequests,
          externalRequests,
        },
        siteDelivery: {
          pagesSiteRequests: siteDeliveryRow?.total_pages_site_requests ?? 0,
          publicApiSiteRequests,
          pagesCacheHits: siteDeliveryRow?.pages_cache_hits ?? 0,
          pagesUpstreamFetches: siteDeliveryRow?.pages_upstream_fetches ?? 0,
          pagesUpstreamTimeouts: siteDeliveryRow?.pages_upstream_timeouts ?? 0,
          pagesUpstreamErrors: siteDeliveryRow?.pages_upstream_errors ?? 0,
        },
        lanes: mapLaneStatsRows(laneRows.results ?? []),
        routes: mapRouteStatsRows(routeRows.results ?? []),
        buckets: mapTimeBucketRows(bucketRows.results ?? []),
        keyedPublicApi: buildApiRequestAttributionKeyedPublicApiSummary(
          keyedRequests,
          totalPublicApiRequests,
          totalKeys,
          apiKeys.length,
          returnedKeyedRequests,
        ),
        apiKeys,
      });

      return jsonResponse(body, { noStore: true });
    },
  );
}
