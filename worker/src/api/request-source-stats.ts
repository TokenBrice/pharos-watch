import { REQUEST_SOURCE_MEASUREMENT_VERSION } from "@pharos/contracts/request-source";
import { jsonResponse } from "../lib/api-response";
import { parseQueryParams } from "../lib/api-params";
import {
  buildApiRequestAttributionResponse,
  type SourceAggregateRow,
  type SourceKeyRow,
  type SourceKeySummaryRow,
} from "../lib/request-source-attribution";
import { runAdminRoute, type AdminRouteContext } from "../lib/route-wrappers";

// Every input is bounded by the same [from,to) observation clock. The old and new
// stores contain disjoint writer contributions, including during same-minute rollout.
const SOURCE_EVENTS_SQL = `WITH raw_events AS (
  SELECT bucket_start, route_key, route_path, lane, consumer_class, '' AS delivery_path,
    '' AS authentication_class, 1 AS inverse_rate, 1 AS legacy, request_count AS observed_count
  FROM api_request_consumer_stats WHERE bucket_start >= ?1 AND bucket_start < ?2
  UNION ALL
  SELECT bucket_start, route_key, route_path, lane, consumer_class, '', authentication_class,
    sample_inverse_rate, 0, sample_count
  FROM api_request_source_samples WHERE bucket_start >= ?1 AND bucket_start < ?2
  UNION ALL
  SELECT bucket_start, route_key, route_path, 'pages', 'site', delivery_path, '', 1, 1, request_count
  FROM site_data_request_stats WHERE bucket_start >= ?1 AND bucket_start < ?2
  UNION ALL
  SELECT bucket_start, route_key, route_path, 'pages', 'site', delivery_path, '', sample_inverse_rate, 0, sample_count
  FROM site_data_request_samples WHERE bucket_start >= ?1 AND bucket_start < ?2
), events AS (
  SELECT CAST(bucket_start / ?3 AS INTEGER) * ?3 AS bucket_start,
    route_key, route_path, lane, consumer_class, delivery_path, authentication_class,
    inverse_rate, legacy, SUM(observed_count) AS observed_count
  FROM raw_events
  GROUP BY CAST(bucket_start / ?3 AS INTEGER), route_key, route_path, lane, consumer_class,
    delivery_path, authentication_class, inverse_rate, legacy
)
SELECT 'total' AS dimension, '' AS dimension_key, '' AS route_path, consumer_class,
  inverse_rate, legacy, SUM(observed_count) AS observed_count
FROM events WHERE lane IN ('pages', 'public-api') GROUP BY consumer_class, inverse_rate, legacy
UNION ALL
SELECT 'route', route_key, route_path, consumer_class, inverse_rate, legacy, SUM(observed_count)
FROM events WHERE lane IN ('pages', 'public-api') GROUP BY route_key, route_path, consumer_class, inverse_rate, legacy
UNION ALL
SELECT 'bucket', CAST(CAST(bucket_start / ?3 AS INTEGER) * ?3 AS TEXT), '', consumer_class,
  inverse_rate, legacy, SUM(observed_count)
FROM events WHERE lane IN ('pages', 'public-api')
GROUP BY CAST(bucket_start / ?3 AS INTEGER), consumer_class, inverse_rate, legacy
UNION ALL
SELECT 'lane', lane, '', consumer_class, inverse_rate, legacy, SUM(observed_count)
FROM events WHERE lane IN ('public-api', 'site-api') GROUP BY lane, consumer_class, inverse_rate, legacy
UNION ALL
SELECT 'delivery', CASE WHEN lane = 'public-api' THEN 'public-api-site' ELSE delivery_path END,
  '', consumer_class, inverse_rate, legacy, SUM(observed_count)
FROM events WHERE lane = 'pages' OR (lane = 'public-api' AND consumer_class = 'site')
GROUP BY CASE WHEN lane = 'public-api' THEN 'public-api-site' ELSE delivery_path END, consumer_class, inverse_rate, legacy
UNION ALL
SELECT 'legacy-public', '', '', consumer_class, inverse_rate, legacy, SUM(observed_count)
FROM events WHERE lane = 'public-api' AND legacy = 1 GROUP BY consumer_class, inverse_rate, legacy
UNION ALL
SELECT 'unkeyed', '', '', consumer_class, inverse_rate, legacy, SUM(observed_count)
FROM events WHERE lane = 'public-api' AND legacy = 0 AND authentication_class = 'unkeyed'
GROUP BY consumer_class, inverse_rate, legacy`;

export function handleRequestSourceStats({ db, trustedAdmin, request }: AdminRouteContext): Promise<Response> {
  return runAdminRoute({ endpoint: "request-source-stats", request, trustedAdmin }, async () => {
    const now = Math.floor(Date.now() / 1000);
    const url = new URL(request?.url ?? "https://ops-api.pharos.watch/api/request-source-stats");
    if (url.searchParams.get("measurementVersion") !== String(REQUEST_SOURCE_MEASUREMENT_VERSION)) {
      return jsonResponse({ error: "Reload the admin UI to opt into measurementVersion=2", reason: "attribution-measurement-version-required" }, { status: 400, noStore: true });
    }
    const parsed = parseQueryParams(url.searchParams, {
      hours: { type: "int", default: 24, min: 1, max: 24 * 35 },
      bucketSec: { type: "int", default: 3600, min: 60, max: 86400, name: "bucketSec" },
      routeLimit: { type: "int", default: 20, min: 1, max: 100, name: "routeLimit" },
      apiKeyLimit: { type: "int", default: 25, min: 1, max: 100, name: "apiKeyLimit" },
    });
    if (parsed instanceof Response) return parsed;
    const { hours, bucketSec, routeLimit, apiKeyLimit } = parsed;
    const from = now - hours * 3600;
    const [sourceRows, keySummary, keyRows] = await Promise.all([
      db.prepare(SOURCE_EVENTS_SQL).bind(from, now, bucketSec).all<SourceAggregateRow>(),
      db.prepare(`SELECT COALESCE(SUM(request_count), 0) AS keyed_requests,
        COALESCE(SUM(request_count - source_v2_request_count), 0) AS legacy_keyed_requests,
        COALESCE(SUM(CASE WHEN source_v2_request_count < 0 OR source_v2_request_count > request_count
          OR request_count < 0 THEN 1 ELSE 0 END), 0) AS invalid_markers,
        COUNT(DISTINCT api_key_id) AS total_keys
        FROM api_key_request_stats WHERE bucket_start >= ? AND bucket_start < ?`)
        .bind(from, now).first<SourceKeySummaryRow>(),
      db.prepare(`SELECT stats.api_key_id, keys.name,
        ('ph_live_' || keys.key_prefix || '_********') AS masked_token,
        keys.traffic_class, keys.is_active, keys.expires_at, keys.rate_limit_per_minute, stats.request_count
        FROM (
          SELECT api_key_id, SUM(request_count) AS request_count FROM api_key_request_stats
          WHERE bucket_start >= ? AND bucket_start < ? GROUP BY api_key_id
          ORDER BY SUM(request_count) DESC, api_key_id ASC LIMIT ?
        ) AS stats INNER JOIN api_keys AS keys ON keys.id = stats.api_key_id
        ORDER BY stats.request_count DESC, stats.api_key_id ASC`)
        .bind(from, now, apiKeyLimit).all<SourceKeyRow>(),
    ]);
    if (!sourceRows.success || !keyRows.success || keySummary == null) {
      throw new Error("Request attribution read failed");
    }
    return jsonResponse(buildApiRequestAttributionResponse({
      generatedAt: now, from, to: now, bucketSizeSec: bucketSec, routeLimit, apiKeyLimit,
      rows: sourceRows.results, keySummary, keyRows: keyRows.results,
    }), { noStore: true });
  });
}
