import { describe, expect, it } from "vitest";
import {
  API_REQUEST_SOURCE_STATS_RETENTION_DAYS,
  buildPublicApiRequestSourceSplit,
  classifyPublicApiRequestSource,
  mapRouteStatsRows,
  mapTimeBucketRows,
  resolvePublicApiRouteMetric,
} from "../request-source-attribution";
import { PHAROS_WEB_ACCEPT_MARKER } from "@shared/lib/request-source-marker";

describe("request-source-attribution", () => {
  it("classifies Pharos browser requests by Origin as web", () => {
    const request = new Request("https://api.pharos.watch/api/stablecoins", {
      headers: { Origin: "https://pharos.watch" },
    });

    expect(classifyPublicApiRequestSource(request)).toBe("web");
  });

  it("classifies Pharos browser requests by Referer as web", () => {
    const request = new Request("https://api.pharos.watch/api/stablecoins", {
      headers: { Referer: "https://pharos.watch/chains/ethereum/" },
    });

    expect(classifyPublicApiRequestSource(request)).toBe("web");
  });

  it("classifies same-site marker requests as web", () => {
    const request = new Request("https://api.pharos.watch/api/stablecoins", {
      headers: {
        Accept: `application/json, ${PHAROS_WEB_ACCEPT_MARKER}`,
        "Sec-Fetch-Site": "same-site",
      },
    });

    expect(classifyPublicApiRequestSource(request)).toBe("web");
  });

  it("treats non-Pharos requests as external", () => {
    const request = new Request("https://api.pharos.watch/api/stablecoins", {
      headers: {
        Origin: "https://example.com",
        Accept: `application/json, ${PHAROS_WEB_ACCEPT_MARKER}`,
        "Sec-Fetch-Site": "cross-site",
      },
    });

    expect(classifyPublicApiRequestSource(request)).toBe("external");
  });

  it("normalizes dynamic public routes to bounded metric keys", () => {
    expect(resolvePublicApiRouteMetric("/api/stablecoin/usdt-tether")).toEqual({
      routeKey: "stablecoin-detail",
      routePath: "/api/stablecoin/:id",
    });
    expect(resolvePublicApiRouteMetric("/api/stablecoin-summary/usdc-circle")).toEqual({
      routeKey: "stablecoin-summary",
      routePath: "/api/stablecoin-summary/:id",
    });
    expect(resolvePublicApiRouteMetric("/api/stablecoin-reserves/iusd-infinifi")).toEqual({
      routeKey: "stablecoin-reserves",
      routePath: "/api/stablecoin-reserves/:id",
    });
    expect(resolvePublicApiRouteMetric("/api/og/stablecoin/usdt-tether")).toEqual({
      routeKey: "og-image",
      routePath: "/api/og/*",
    });
  });

  it("skips admin and webhook routes from public attribution", () => {
    expect(resolvePublicApiRouteMetric("/api/status")).toBeNull();
    expect(resolvePublicApiRouteMetric("/api/request-source-stats")).toBeNull();
    expect(resolvePublicApiRouteMetric("/api/telegram-webhook")).toBeNull();
    expect(resolvePublicApiRouteMetric("/api/discovery-candidates/42/dismiss")).toBeNull();
  });

  it("falls back to an unknown public bucket for unmatched public paths", () => {
    expect(resolvePublicApiRouteMetric("/api/not-real")).toEqual({
      routeKey: "unknown-public-api",
      routePath: "/api/*",
    });
  });

  it("builds percentage splits and maps response rows", () => {
    expect(buildPublicApiRequestSourceSplit(30, 70)).toEqual({
      webRequests: 30,
      externalRequests: 70,
      totalRequests: 100,
      webSharePct: 30,
      externalSharePct: 70,
    });

    expect(mapRouteStatsRows([
      {
        route_key: "stablecoins",
        route_path: "/api/stablecoins",
        web_requests: 25,
        external_requests: 75,
      },
    ])).toEqual([
      {
        routeKey: "stablecoins",
        routePath: "/api/stablecoins",
        webRequests: 25,
        externalRequests: 75,
        totalRequests: 100,
        webSharePct: 25,
        externalSharePct: 75,
      },
    ]);

    expect(mapTimeBucketRows([
      { bucket_start: 1_700_000_000, web_requests: 12, external_requests: 8 },
    ])).toEqual([
      {
        bucketStart: 1_700_000_000,
        webRequests: 12,
        externalRequests: 8,
        totalRequests: 20,
        webSharePct: 60,
        externalSharePct: 40,
      },
    ]);

    expect(API_REQUEST_SOURCE_STATS_RETENTION_DAYS).toBe(35);
  });
});
