import { describe, expect, it } from "vitest";
import {
  REQUEST_ATTRIBUTION_RETENTION_DAYS,
  classifyBrowserRequestConsumer,
  resolveApiRequestRouteMetric,
} from "@shared/lib/request-attribution";
import { PHAROS_WEB_ACCEPT_MARKER } from "@shared/lib/request-source-marker";
import {
  API_REQUEST_SOURCE_STATS_RETENTION_DAYS,
  buildApiRequestAttributionSplit,
  mapLaneStatsRows,
  mapRouteStatsRows,
  mapTimeBucketRows,
} from "../request-source-attribution";

describe("request-source-attribution", () => {
  it("classifies Pharos browser requests by Origin as site", () => {
    const request = new Request("https://api.pharos.watch/api/stablecoins", {
      headers: { Origin: "https://pharos.watch" },
    });

    expect(classifyBrowserRequestConsumer(request)).toBe("site");
  });

  it("classifies Pharos browser requests by Referer as site", () => {
    const request = new Request("https://api.pharos.watch/api/stablecoins", {
      headers: { Referer: "https://pharos.watch/chains/ethereum/" },
    });

    expect(classifyBrowserRequestConsumer(request)).toBe("site");
  });

  it("classifies same-site marker requests as site", () => {
    const request = new Request("https://api.pharos.watch/api/stablecoins", {
      headers: {
        Accept: `application/json, ${PHAROS_WEB_ACCEPT_MARKER}`,
        "Sec-Fetch-Site": "same-site",
      },
    });

    expect(classifyBrowserRequestConsumer(request)).toBe("site");
  });

  it("treats non-Pharos requests as external", () => {
    const request = new Request("https://api.pharos.watch/api/stablecoins", {
      headers: {
        Origin: "https://example.com",
        Accept: `application/json, ${PHAROS_WEB_ACCEPT_MARKER}`,
        "Sec-Fetch-Site": "cross-site",
      },
    });

    expect(classifyBrowserRequestConsumer(request)).toBe("external");
  });

  it("normalizes dynamic public routes to bounded metric keys", () => {
    expect(resolveApiRequestRouteMetric("/api/stablecoin/usdt-tether")).toEqual({
      routeKey: "stablecoin-detail",
      routePath: "/api/stablecoin/:id",
    });
    expect(resolveApiRequestRouteMetric("/api/stablecoin-summary/usdc-circle")).toEqual({
      routeKey: "stablecoin-summary",
      routePath: "/api/stablecoin-summary/:id",
    });
    expect(resolveApiRequestRouteMetric("/api/stablecoin-reserves/iusd-infinifi")).toEqual({
      routeKey: "stablecoin-reserves",
      routePath: "/api/stablecoin-reserves/:id",
    });
    expect(resolveApiRequestRouteMetric("/api/og/stablecoin/usdt-tether")).toEqual({
      routeKey: "og-image",
      routePath: "/api/og/*",
    });
  });

  it("skips admin and webhook routes from attribution", () => {
    expect(resolveApiRequestRouteMetric("/api/status")).toBeNull();
    expect(resolveApiRequestRouteMetric("/api/request-source-stats")).toBeNull();
    expect(resolveApiRequestRouteMetric("/api/telegram-webhook")).toBeNull();
    expect(resolveApiRequestRouteMetric("/api/discovery-candidates/42/dismiss")).toBeNull();
  });

  it("falls back to an unknown public bucket for unmatched public paths", () => {
    expect(resolveApiRequestRouteMetric("/api/not-real")).toEqual({
      routeKey: "unknown-public-api",
      routePath: "/api/*",
    });
  });

  it("builds percentage splits and maps response rows", () => {
    expect(buildApiRequestAttributionSplit(30, 70)).toEqual({
      siteRequests: 30,
      externalRequests: 70,
      totalRequests: 100,
      siteSharePct: 30,
      externalSharePct: 70,
    });

    expect(mapRouteStatsRows([
      {
        route_key: "stablecoins",
        route_path: "/api/stablecoins",
        site_requests: 25,
        external_requests: 75,
      },
    ])).toEqual([
      {
        routeKey: "stablecoins",
        routePath: "/api/stablecoins",
        siteRequests: 25,
        externalRequests: 75,
        totalRequests: 100,
        siteSharePct: 25,
        externalSharePct: 75,
      },
    ]);

    expect(mapTimeBucketRows([
      { bucket_start: 1_700_000_000, site_requests: 12, external_requests: 8 },
    ])).toEqual([
      {
        bucketStart: 1_700_000_000,
        siteRequests: 12,
        externalRequests: 8,
        totalRequests: 20,
        siteSharePct: 60,
        externalSharePct: 40,
      },
    ]);

    expect(mapLaneStatsRows([
      { lane: "public-api", site_requests: 9, external_requests: 21 },
      { lane: "site-api", site_requests: 18, external_requests: 0 },
    ])).toEqual([
      {
        lane: "public-api",
        siteRequests: 9,
        externalRequests: 21,
        totalRequests: 30,
        siteSharePct: 30,
        externalSharePct: 70,
      },
      {
        lane: "site-api",
        siteRequests: 18,
        externalRequests: 0,
        totalRequests: 18,
        siteSharePct: 100,
        externalSharePct: 0,
      },
    ]);

    expect(API_REQUEST_SOURCE_STATS_RETENTION_DAYS).toBe(REQUEST_ATTRIBUTION_RETENTION_DAYS);
  });
});
