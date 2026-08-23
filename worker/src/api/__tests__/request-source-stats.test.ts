import { readJsonResponse } from "./api-request-response.test-support";
import { describe, expect, it, vi } from "vitest";
import type { ApiRequestAttributionResponse } from "@shared/types";
import { handleRequestSourceStats } from "../request-source-stats";
import { mockD1 } from "../../test-helpers/__shared/mock-d1";

describe("handleRequestSourceStats", () => {
  it("returns aggregated total site-vs-external demand for the requested window", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    const db = mockD1([
      {
        match: "AS pages_site_requests",
        matchBinds: [1_699_913_600, 1_700_000_000, 1_699_913_600, 1_700_000_000, 1_699_913_600, 1_700_000_000],
        rows: [],
        first: {
          pages_site_requests: 500,
          public_api_site_requests: 100,
          external_requests: 400,
        },
      },
      {
        match: "ORDER BY (COALESCE(site_requests, 0) + COALESCE(external_requests, 0)) DESC",
        matchBinds: [1_699_913_600, 1_700_000_000, 1_699_913_600, 1_700_000_000, 2],
        rows: [
          {
            route_key: "stablecoins",
            route_path: "/api/stablecoins",
            site_requests: 420,
            external_requests: 40,
          },
          {
            route_key: "stablecoin-detail",
            route_path: "/api/stablecoin/:id",
            site_requests: 180,
            external_requests: 160,
          },
        ],
      },
      {
        match: "GROUP BY bucket_start",
        matchBinds: [3600, 3600, 1_699_913_600, 1_700_000_000, 3600, 3600, 3600, 3600, 1_699_913_600, 1_700_000_000, 3600, 3600],
        rows: [
          { bucket_start: 1_699_996_400, site_requests: 500, external_requests: 300 },
          { bucket_start: 1_700_000_000, site_requests: 100, external_requests: 100 },
        ],
      },
      {
        match: "ORDER BY CASE lane",
        matchBinds: [1_699_913_600, 1_700_000_000],
        rows: [
          { lane: "public-api", site_requests: 100, external_requests: 400 },
          { lane: "site-api", site_requests: 130, external_requests: 0 },
        ],
      },
      {
        match: "AS total_pages_site_requests",
        matchBinds: [1_699_913_600, 1_700_000_000],
        rows: [],
        first: {
          total_pages_site_requests: 500,
          pages_cache_hits: 350,
          pages_upstream_fetches: 130,
          pages_upstream_timeouts: 15,
          pages_upstream_errors: 5,
        },
      },
      {
        match: "AS keyed_requests",
        matchBinds: [1_699_913_600, 1_700_000_000],
        rows: [],
        first: {
          keyed_requests: 220,
          total_keys: 3,
        },
      },
      {
        match: "FROM api_key_request_stats",
        matchBinds: [1_699_913_600, 1_700_000_000, 25],
        rows: [
          {
            api_key_id: 7,
            name: "Partner A",
            masked_token: "ph_live_0123456789abcdef_********",
            traffic_class: "external",
            is_active: 1,
            expires_at: 1_700_100_000,
            rate_limit_per_minute: 180,
            request_count: 150,
          },
          {
            api_key_id: 9,
            name: "Site Automation",
            masked_token: "ph_live_fedcba9876543210_********",
            traffic_class: "site",
            is_active: 0,
            expires_at: null,
            rate_limit_per_minute: 120,
            request_count: 50,
          },
        ],
      },
    ], { requireMatch: true });

    const request = new Request("https://ops-api.pharos.watch/api/request-source-stats?hours=24&bucketSec=3600&routeLimit=2");
    const response = await handleRequestSourceStats({ db, trustedAdmin: true, request });
    const body = await readJsonResponse(response, 200) as ApiRequestAttributionResponse;

    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(body.totals).toEqual({
      siteRequests: 600,
      externalRequests: 400,
      totalRequests: 1000,
      siteSharePct: 60,
      externalSharePct: 40,
    });
    expect(body.siteDelivery).toEqual({
      totalSiteRequests: 600,
      pagesCacheHits: 350,
      pagesUpstreamFetches: 130,
      pagesUpstreamTimeouts: 15,
      pagesUpstreamErrors: 5,
      publicApiSiteRequests: 100,
    });
    expect(body.lanes).toEqual([
      {
        lane: "public-api",
        siteRequests: 100,
        externalRequests: 400,
        totalRequests: 500,
        siteSharePct: 20,
        externalSharePct: 80,
      },
      {
        lane: "site-api",
        siteRequests: 130,
        externalRequests: 0,
        totalRequests: 130,
        siteSharePct: 100,
        externalSharePct: 0,
      },
    ]);
    expect(body.routes).toEqual([
      {
        routeKey: "stablecoins",
        routePath: "/api/stablecoins",
        siteRequests: 420,
        externalRequests: 40,
        totalRequests: 460,
        siteSharePct: 91.3,
        externalSharePct: 8.7,
      },
      {
        routeKey: "stablecoin-detail",
        routePath: "/api/stablecoin/:id",
        siteRequests: 180,
        externalRequests: 160,
        totalRequests: 340,
        siteSharePct: 52.94,
        externalSharePct: 47.06,
      },
    ]);
    expect(body.buckets).toEqual([
      {
        bucketStart: 1_699_996_400,
        siteRequests: 500,
        externalRequests: 300,
        totalRequests: 800,
        siteSharePct: 62.5,
        externalSharePct: 37.5,
      },
      {
        bucketStart: 1_700_000_000,
        siteRequests: 100,
        externalRequests: 100,
        totalRequests: 200,
        siteSharePct: 50,
        externalSharePct: 50,
      },
    ]);
    expect(body.keyedPublicApi).toEqual({
      keyedRequests: 220,
      unkeyedRequests: 280,
      totalRequests: 500,
      keyedSharePct: 44,
      unkeyedSharePct: 56,
      totalKeys: 3,
      returnedKeys: 2,
      omittedKeys: 1,
      omittedRequests: 20,
      truncated: true,
    });
    expect(body.apiKeys).toEqual([
      {
        apiKeyId: 7,
        name: "Partner A",
        maskedToken: "ph_live_0123456789abcdef_********",
        trafficClass: "external",
        isActive: true,
        expiresAt: 1_700_100_000,
        rateLimitPerMinute: 180,
        requestCount: 150,
        shareOfKeyedRequestsPct: 68.18,
        shareOfTotalPublicApiRequestsPct: 30,
      },
      {
        apiKeyId: 9,
        name: "Site Automation",
        maskedToken: "ph_live_fedcba9876543210_********",
        trafficClass: "site",
        isActive: false,
        expiresAt: null,
        rateLimitPerMinute: 120,
        requestCount: 50,
        shareOfKeyedRequestsPct: 22.73,
        shareOfTotalPublicApiRequestsPct: 10,
      },
    ]);
    expect(body.scope).toEqual({
      countsTotalSiteDemand: true,
      countsWorkerLoad: true,
      includesPagesProxyCacheHits: true,
    });
    expect(body.window).toEqual({
      from: 1_699_913_600,
      to: 1_700_000_000,
      durationSec: 86_400,
      bucketSizeSec: 3600,
      routeLimit: 2,
      apiKeyLimit: 25,
      retentionDays: 35,
    });
  });
});
