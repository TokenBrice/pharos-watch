import { parseQueryParams, withErrorHandler, jsonResponse } from "../lib/api-utils";
import { withAdmin } from "../lib/auth";
import {
  buildPublicApiRequestSourceStatsResponse,
  mapRouteStatsRows,
  mapTimeBucketRows,
} from "../lib/request-source-attribution";

interface TotalsRow {
  web_requests: number | null;
  external_requests: number | null;
}

interface RouteRow {
  route_key: string;
  route_path: string;
  web_requests: number | null;
  external_requests: number | null;
}

interface BucketRow {
  bucket_start: number;
  web_requests: number | null;
  external_requests: number | null;
}

export const handleRequestSourceStats = withErrorHandler(
  "request-source-stats",
  async (db: D1Database, trustedAdmin?: boolean, request?: Request): Promise<Response> => {
    return withAdmin(request, async () => {
      const now = Math.floor(Date.now() / 1000);
      const url = new URL(request?.url ?? "https://ops-api.pharos.watch/api/request-source-stats");
      const parsed = parseQueryParams(url.searchParams, {
        hours: { type: "int", default: 24, min: 1, max: 24 * 35 },
        bucketSec: { type: "int", default: 3600, min: 60, max: 86400, name: "bucketSec" },
        routeLimit: { type: "int", default: 20, min: 1, max: 100, name: "routeLimit" },
      });
      if (parsed instanceof Response) return parsed;

      const { hours, bucketSec, routeLimit } = parsed;
      const to = now;
      const from = now - hours * 3600;

      const [totalsRow, routeRows, bucketRows] = await Promise.all([
        db.prepare(
          `SELECT
             SUM(CASE WHEN source = 'web' THEN request_count ELSE 0 END) AS web_requests,
             SUM(CASE WHEN source = 'external' THEN request_count ELSE 0 END) AS external_requests
           FROM api_request_source_stats
           WHERE bucket_start >= ? AND bucket_start < ?`,
        )
          .bind(from, to)
          .first<TotalsRow>(),
        db.prepare(
          `SELECT
             route_key,
             route_path,
             SUM(CASE WHEN source = 'web' THEN request_count ELSE 0 END) AS web_requests,
             SUM(CASE WHEN source = 'external' THEN request_count ELSE 0 END) AS external_requests
           FROM api_request_source_stats
           WHERE bucket_start >= ? AND bucket_start < ?
           GROUP BY route_key, route_path
           ORDER BY (COALESCE(web_requests, 0) + COALESCE(external_requests, 0)) DESC, route_key ASC
           LIMIT ?`,
        )
          .bind(from, to, routeLimit)
          .all<RouteRow>(),
        db.prepare(
          `SELECT
             CAST(bucket_start / ? AS INTEGER) * ? AS bucket_start,
             SUM(CASE WHEN source = 'web' THEN request_count ELSE 0 END) AS web_requests,
             SUM(CASE WHEN source = 'external' THEN request_count ELSE 0 END) AS external_requests
           FROM api_request_source_stats
           WHERE bucket_start >= ? AND bucket_start < ?
           GROUP BY CAST(bucket_start / ? AS INTEGER) * ?
           ORDER BY bucket_start ASC`,
        )
          .bind(bucketSec, bucketSec, from, to, bucketSec, bucketSec)
          .all<BucketRow>(),
      ]);

      const body = buildPublicApiRequestSourceStatsResponse({
        generatedAt: now,
        from,
        to,
        bucketSizeSec: bucketSec,
        routeLimit,
        totals: {
          webRequests: totalsRow?.web_requests ?? 0,
          externalRequests: totalsRow?.external_requests ?? 0,
        },
        routes: mapRouteStatsRows(routeRows.results ?? []),
        buckets: mapTimeBucketRows(bucketRows.results ?? []),
      });

      return jsonResponse(body, { "Cache-Control": "no-store" });
    }, trustedAdmin);
  },
);
