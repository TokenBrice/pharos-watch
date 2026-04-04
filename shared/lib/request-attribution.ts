import { getEndpointDefinition, matchDynamicAdminEndpoint } from "./api-endpoints";
import { PHAROS_WEB_ACCEPT_MARKER } from "./request-source-marker";
import { SITE_ORIGIN } from "./runtime-origins";
import type { ApiRequestConsumerClass } from "../types/request-source";

export const REQUEST_ATTRIBUTION_RETENTION_DAYS = 35;
export const REQUEST_ATTRIBUTION_PRUNE_INTERVAL_SEC = 3600;

const STABLECOIN_DETAIL_PATH_PATTERN = /^\/api\/stablecoin\/[^/]+$/;
const STABLECOIN_SUMMARY_PATH_PATTERN = /^\/api\/stablecoin-summary\/[^/]+$/;
const STABLECOIN_RESERVES_PATH_PATTERN = /^\/api\/stablecoin-reserves\/[^/]+$/;
const OG_IMAGE_PATH_PATTERN = /^\/api\/og\//;
const SAME_SITE_FETCH_VALUES = new Set(["same-site", "same-origin"]);

export interface ApiRequestRouteMetric {
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

export function classifyBrowserRequestConsumer(request: Request): ApiRequestConsumerClass {
  const accept = request.headers.get("Accept")?.toLowerCase() ?? "";
  const hasPharosAcceptMarker = accept.includes(PHAROS_WEB_ACCEPT_MARKER);
  const origin = safeOrigin(request.headers.get("Origin"));
  const refererOrigin = safeOrigin(request.headers.get("Referer"));
  const secFetchSite = request.headers.get("Sec-Fetch-Site")?.trim().toLowerCase() ?? "";

  if (origin === SITE_ORIGIN || refererOrigin === SITE_ORIGIN) {
    return "site";
  }

  if (hasPharosAcceptMarker && SAME_SITE_FETCH_VALUES.has(secFetchSite)) {
    return "site";
  }

  return "external";
}

export function resolveApiRequestRouteMetric(pathname: string): ApiRequestRouteMetric | null {
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
