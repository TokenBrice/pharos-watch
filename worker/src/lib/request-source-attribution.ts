import { getEndpointDefinition, matchDynamicAdminEndpoint } from "@shared/lib/api-endpoints";
import { PHAROS_WEB_ACCEPT_MARKER } from "@shared/lib/request-source-marker";
import { SITE_ORIGIN } from "@shared/lib/runtime-origins";
import type {
  PublicApiRequestSource,
  PublicApiRequestSourceSplit,
  PublicApiRequestSourceStatsResponse,
  PublicApiRequestSourceRouteStat,
  PublicApiRequestSourceTimeBucket,
} from "@shared/types";

export const API_REQUEST_SOURCE_STATS_RETENTION_DAYS = 35;
const API_REQUEST_SOURCE_STATS_RETENTION_SEC = API_REQUEST_SOURCE_STATS_RETENTION_DAYS * 24 * 60 * 60;
const API_REQUEST_SOURCE_PRUNE_INTERVAL_SEC = 3600;
const STABLECOIN_DETAIL_PATH_PATTERN = /^\/api\/stablecoin\/[^/]+$/;
const STABLECOIN_SUMMARY_PATH_PATTERN = /^\/api\/stablecoin-summary\/[^/]+$/;
const STABLECOIN_RESERVES_PATH_PATTERN = /^\/api\/stablecoin-reserves\/[^/]+$/;
const OG_IMAGE_PATH_PATTERN = /^\/api\/og\//;
const SAME_SITE_FETCH_VALUES = new Set(["same-site", "same-origin"]);

let lastApiRequestSourcePruneBucket: number | null = null;
let pendingApiRequestSourcePrune: Promise<void> | null = null;

export interface PublicApiRequestRouteMetric {
  routeKey: string;
  routePath: string;
}

function safeOrigin(value: string | null): string | null {
  if (!value) return null;
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

export function classifyPublicApiRequestSource(request: Request): PublicApiRequestSource {
  const accept = request.headers.get("Accept")?.toLowerCase() ?? "";
  const hasPharosAcceptMarker = accept.includes(PHAROS_WEB_ACCEPT_MARKER);
  const origin = safeOrigin(request.headers.get("Origin"));
  const refererOrigin = safeOrigin(request.headers.get("Referer"));
  const secFetchSite = request.headers.get("Sec-Fetch-Site")?.trim().toLowerCase() ?? "";

  if (origin === SITE_ORIGIN || refererOrigin === SITE_ORIGIN) {
    return "web";
  }

  if (hasPharosAcceptMarker && SAME_SITE_FETCH_VALUES.has(secFetchSite)) {
    return "web";
  }

  return "external";
}

export function resolvePublicApiRouteMetric(pathname: string): PublicApiRequestRouteMetric | null {
  if (!pathname.startsWith("/api/")) return null;
  if (pathname === "/api/telegram-webhook") return null;
  if (matchDynamicAdminEndpoint(pathname)) return null;

  if (STABLECOIN_SUMMARY_PATH_PATTERN.test(pathname)) {
    return {
      routeKey: "stablecoin-summary",
      routePath: "/api/stablecoin-summary/:id",
    };
  }

  if (STABLECOIN_RESERVES_PATH_PATTERN.test(pathname)) {
    return {
      routeKey: "stablecoin-reserves",
      routePath: "/api/stablecoin-reserves/:id",
    };
  }

  if (STABLECOIN_DETAIL_PATH_PATTERN.test(pathname)) {
    return {
      routeKey: "stablecoin-detail",
      routePath: "/api/stablecoin/:id",
    };
  }

  if (OG_IMAGE_PATH_PATTERN.test(pathname)) {
    return {
      routeKey: "og-image",
      routePath: "/api/og/*",
    };
  }

  const endpoint = getEndpointDefinition(pathname);
  if (endpoint?.adminRequired) {
    return null;
  }

  if (!endpoint) {
    return {
      routeKey: "unknown-public-api",
      routePath: "/api/*",
    };
  }

  return {
    routeKey: endpoint.key,
    routePath: endpoint.path,
  };
}

export async function recordPublicApiRequestSource(
  db: D1Database,
  route: PublicApiRequestRouteMetric,
  source: PublicApiRequestSource,
  nowSec = Math.floor(Date.now() / 1000),
): Promise<void> {
  const bucketStart = nowSec - (nowSec % 60);
  await db.prepare(
    `INSERT INTO api_request_source_stats (bucket_start, route_key, route_path, source, request_count)
     VALUES (?, ?, ?, ?, 1)
     ON CONFLICT(bucket_start, route_key, source)
     DO UPDATE SET
       request_count = request_count + 1,
       route_path = excluded.route_path`,
  )
    .bind(bucketStart, route.routeKey, route.routePath, source)
    .run();

  const pruneBucket = nowSec - (nowSec % API_REQUEST_SOURCE_PRUNE_INTERVAL_SEC);
  if (lastApiRequestSourcePruneBucket !== pruneBucket && !pendingApiRequestSourcePrune) {
    lastApiRequestSourcePruneBucket = pruneBucket;
    const prunePromise = db
      .prepare("DELETE FROM api_request_source_stats WHERE bucket_start < ?")
      .bind(nowSec - API_REQUEST_SOURCE_STATS_RETENTION_SEC)
      .run()
      .then(() => {})
      .catch((error) => {
        console.warn("[request-source] prune failed:", error);
      })
      .finally(() => {
        if (pendingApiRequestSourcePrune === prunePromise) {
          pendingApiRequestSourcePrune = null;
        }
      });
    pendingApiRequestSourcePrune = prunePromise;
  }

  if (pendingApiRequestSourcePrune) {
    await pendingApiRequestSourcePrune;
  }
}

function roundPct(value: number): number {
  return Number(value.toFixed(2));
}

export function buildPublicApiRequestSourceSplit(
  webRequests: number,
  externalRequests: number,
): PublicApiRequestSourceSplit {
  const totalRequests = webRequests + externalRequests;
  const webSharePct = totalRequests > 0 ? roundPct((webRequests / totalRequests) * 100) : 0;
  const externalSharePct = totalRequests > 0 ? roundPct((externalRequests / totalRequests) * 100) : 0;

  return {
    webRequests,
    externalRequests,
    totalRequests,
    webSharePct,
    externalSharePct,
  };
}

function toCount(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function mapRouteStatsRows(
  rows: Array<{ route_key: string; route_path: string; web_requests: number | null; external_requests: number | null }>,
): PublicApiRequestSourceRouteStat[] {
  return rows.map((row) => ({
    routeKey: row.route_key,
    routePath: row.route_path,
    ...buildPublicApiRequestSourceSplit(toCount(row.web_requests), toCount(row.external_requests)),
  }));
}

export function mapTimeBucketRows(
  rows: Array<{ bucket_start: number; web_requests: number | null; external_requests: number | null }>,
): PublicApiRequestSourceTimeBucket[] {
  return rows.map((row) => ({
    bucketStart: row.bucket_start,
    ...buildPublicApiRequestSourceSplit(toCount(row.web_requests), toCount(row.external_requests)),
  }));
}

export function buildPublicApiRequestSourceStatsResponse(config: {
  generatedAt: number;
  from: number;
  to: number;
  bucketSizeSec: number;
  routeLimit: number;
  totals: { webRequests: number; externalRequests: number };
  routes: PublicApiRequestSourceRouteStat[];
  buckets: PublicApiRequestSourceTimeBucket[];
}): PublicApiRequestSourceStatsResponse {
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
    totals: buildPublicApiRequestSourceSplit(config.totals.webRequests, config.totals.externalRequests),
    routes: config.routes,
    buckets: config.buckets,
  };
}
