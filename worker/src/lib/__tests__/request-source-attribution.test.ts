import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  REQUEST_ATTRIBUTION_PRUNE_INTERVAL_SEC,
  REQUEST_ATTRIBUTION_RETENTION_DAYS,
  classifyBrowserRequestConsumer,
  isEnvFlagEnabled,
  resolveApiRequestRouteMetric,
} from "@shared/lib/request-attribution";
import { findDynamicEndpointDescriptor } from "@shared/lib/api-endpoints";
import { mockD1 } from "@shared/test-utils/mock-d1";
import { PHAROS_WEB_ACCEPT_MARKER } from "@shared/lib/request-source-marker";
import {
  API_REQUEST_SOURCE_STATS_RETENTION_DAYS,
  buildApiRequestAttributionKeyedPublicApiSummary,
  buildApiRequestAttributionSplit,
  isApiKeyRequestAttributionDisabled,
  isRequestSourceAttributionDisabled,
  mapApiKeyStatsRows,
  recordApiKeyRequestAttribution,
  mapLaneStatsRows,
  mapRouteStatsRows,
  mapTimeBucketRows,
  recordWorkerRequestAttribution,
  resetRequestAttributionStateForTests,
} from "../request-source-attribution";

describe("request-source-attribution", () => {
  const enabledFlagValues = ["1", "true", "yes", "on", " TRUE ", "YeS", " ON "];
  const disabledFlagValues: unknown[] = ["0", "false", "no", "off", "", " ", "enabled", true, 1, null, undefined];

  beforeEach(() => {
    resetRequestAttributionStateForTests();
    vi.restoreAllMocks();
  });

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

  it("keeps dynamic descriptor attribution metadata aligned with request attribution output", () => {
    expect(findDynamicEndpointDescriptor("/api/stablecoin/usdt-tether")?.requestAttribution).toEqual(
      resolveApiRequestRouteMetric("/api/stablecoin/usdt-tether"),
    );
    expect(findDynamicEndpointDescriptor("/api/stablecoin-summary/usdc-circle")?.requestAttribution).toEqual(
      resolveApiRequestRouteMetric("/api/stablecoin-summary/usdc-circle"),
    );
    expect(findDynamicEndpointDescriptor("/api/stablecoin-reserves/iusd-infinifi")?.requestAttribution).toEqual(
      resolveApiRequestRouteMetric("/api/stablecoin-reserves/iusd-infinifi"),
    );
    expect(findDynamicEndpointDescriptor("/api/og/stablecoin/usdt-tether")?.requestAttribution).toEqual(
      resolveApiRequestRouteMetric("/api/og/stablecoin/usdt-tether"),
    );
    expect(findDynamicEndpointDescriptor("/api/api-keys/7/update")?.requestAttribution).toBeNull();
  });

  it("skips admin and webhook routes from attribution", () => {
    expect(resolveApiRequestRouteMetric("/api/status")).toBeNull();
    expect(resolveApiRequestRouteMetric("/api/request-source-stats")).toBeNull();
    expect(resolveApiRequestRouteMetric("/api/telegram-webhook")).toBeNull();
    expect(resolveApiRequestRouteMetric("/api/api-keys/7/update")).toBeNull();
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

    expect(buildApiRequestAttributionKeyedPublicApiSummary(30, 100, 4, 3, 24)).toEqual({
      keyedRequests: 30,
      unkeyedRequests: 70,
      totalRequests: 100,
      keyedSharePct: 30,
      unkeyedSharePct: 70,
      totalKeys: 4,
      returnedKeys: 3,
      omittedKeys: 1,
      omittedRequests: 6,
      truncated: true,
    });

    expect(mapApiKeyStatsRows([
      {
        api_key_id: 7,
        name: "Partner",
        masked_token: "ph_live_0123456789abcdef_********",
        traffic_class: "external",
        is_active: 1,
        expires_at: 1_700_100_000,
        rate_limit_per_minute: 120,
        request_count: 25,
      },
    ], 50, 200)).toEqual([
      {
        apiKeyId: 7,
        name: "Partner",
        maskedToken: "ph_live_0123456789abcdef_********",
        trafficClass: "external",
        isActive: true,
        expiresAt: 1_700_100_000,
        rateLimitPerMinute: 120,
        requestCount: 25,
        shareOfKeyedRequestsPct: 50,
        shareOfTotalPublicApiRequestsPct: 12.5,
      },
    ]);

    expect(API_REQUEST_SOURCE_STATS_RETENTION_DAYS).toBe(REQUEST_ATTRIBUTION_RETENTION_DAYS);
  });

  it("preserves the shared environment flag truth table", () => {
    for (const value of enabledFlagValues) {
      expect(isEnvFlagEnabled({ TEST_FLAG: value }, "TEST_FLAG")).toBe(true);
    }

    for (const value of disabledFlagValues) {
      expect(isEnvFlagEnabled({ TEST_FLAG: value }, "TEST_FLAG")).toBe(false);
    }

    expect(isEnvFlagEnabled({}, "TEST_FLAG")).toBe(false);
    expect(isEnvFlagEnabled(null, "TEST_FLAG")).toBe(false);
    expect(isEnvFlagEnabled(undefined, "TEST_FLAG")).toBe(false);
  });

  it("uses the shared flag parser for both attribution kill switches", () => {
    for (const value of enabledFlagValues) {
      expect(isRequestSourceAttributionDisabled({ REQUEST_SOURCE_ATTRIBUTION_DISABLED: value })).toBe(true);
      expect(isApiKeyRequestAttributionDisabled({ API_KEY_REQUEST_ATTRIBUTION_DISABLED: value })).toBe(true);
    }

    for (const value of disabledFlagValues) {
      expect(isRequestSourceAttributionDisabled({ REQUEST_SOURCE_ATTRIBUTION_DISABLED: value })).toBe(false);
      expect(isApiKeyRequestAttributionDisabled({ API_KEY_REQUEST_ATTRIBUTION_DISABLED: value })).toBe(false);
    }

    expect(isRequestSourceAttributionDisabled({})).toBe(false);
    expect(isApiKeyRequestAttributionDisabled({})).toBe(false);
  });

  it("batches same-minute stats rows and schedules prune only once per prune bucket", async () => {
    const db = mockD1([
      {
        match: "INSERT INTO api_request_consumer_stats",
        rows: [],
        runMeta: { changes: 1 },
      },
      {
        match: "DELETE FROM api_request_consumer_stats",
        rows: [],
        runMeta: { changes: 3 },
      },
      {
        match: "DELETE FROM api_key_request_stats",
        rows: [],
        runMeta: { changes: 0 },
      },
    ], { requireMatch: true });

    await Promise.all([
      recordWorkerRequestAttribution(
        db,
        { routeKey: "stablecoins", routePath: "/api/stablecoins" },
        "public-api",
        "site",
        1_710_000_000,
      ),
      recordWorkerRequestAttribution(
        db,
        { routeKey: "stablecoins", routePath: "/api/stablecoins" },
        "public-api",
        "site",
        1_710_000_030,
      ),
    ]);

    const history = db.getHistory();
    const insertStatements = history.filter((entry) => entry.sql.includes("INSERT INTO api_request_consumer_stats"));
    const pruneStatements = history.filter((entry) => entry.sql.includes("DELETE FROM api_request_consumer_stats"));
    const apiKeyPruneStatements = history.filter((entry) => entry.sql.includes("DELETE FROM api_key_request_stats"));

    expect(insertStatements).toHaveLength(1);
    expect(insertStatements[0]?.binds.slice(1)).toEqual(["stablecoins", "/api/stablecoins", "public-api", "site", 2]);
    expect(pruneStatements).toHaveLength(1);
    expect(apiKeyPruneStatements).toHaveLength(1);
  });

  it("logs prune failures and resets pending prune state for the next prune window", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const db = mockD1([
      {
        match: "INSERT INTO api_request_consumer_stats",
        rows: [],
        runMeta: { changes: 1 },
      },
      {
        match: "DELETE FROM api_request_consumer_stats",
        rows: [],
        throwError: new Error("prune failed"),
      },
      {
        match: "DELETE FROM api_key_request_stats",
        rows: [],
        runMeta: { changes: 0 },
      },
    ], { requireMatch: true });

    const baseNowSec = 1_710_000_000;

    await recordWorkerRequestAttribution(
      db,
      { routeKey: "stablecoins", routePath: "/api/stablecoins" },
      "public-api",
      "external",
      baseNowSec,
    );
    await recordWorkerRequestAttribution(
      db,
      { routeKey: "stablecoins", routePath: "/api/stablecoins" },
      "public-api",
      "external",
      baseNowSec + REQUEST_ATTRIBUTION_PRUNE_INTERVAL_SEC,
    );

    const pruneStatements = db.getHistory().filter((entry) => entry.sql.includes("DELETE FROM api_request_consumer_stats"));

    expect(pruneStatements).toHaveLength(2);
    expect(warnSpy).toHaveBeenCalledTimes(2);
    expect(warnSpy.mock.calls[0]?.[0]).toBe("[request-attribution] worker prune failed:");
  });

  it("records per-key request stats and shares the same prune cadence", async () => {
    const db = mockD1([
      {
        match: "INSERT INTO api_key_request_stats",
        rows: [],
        runMeta: { changes: 1 },
      },
      {
        match: "DELETE FROM api_request_consumer_stats",
        rows: [],
        runMeta: { changes: 0 },
      },
      {
        match: "DELETE FROM api_key_request_stats",
        rows: [],
        runMeta: { changes: 1 },
      },
    ], { requireMatch: true });

    await recordApiKeyRequestAttribution(db, 7, 1_710_000_000);
    await recordApiKeyRequestAttribution(db, 7, 1_710_000_030);

    const history = db.getHistory();
    const insertStatements = history.filter((entry) => entry.sql.includes("INSERT INTO api_key_request_stats"));
    const pruneStatements = history.filter((entry) => entry.sql.includes("DELETE FROM api_key_request_stats"));

    expect(insertStatements).toHaveLength(2);
    expect(insertStatements[0]?.binds).toEqual([7, 1_710_000_000 - (1_710_000_000 % 60), 1]);
    expect(pruneStatements).toHaveLength(1);
  });

  it("buffers concurrent per-key request stats into one upsert per key and minute", async () => {
    const db = mockD1([
      {
        match: "INSERT INTO api_key_request_stats",
        rows: [],
        runMeta: { changes: 1 },
      },
      {
        match: "DELETE FROM api_request_consumer_stats",
        rows: [],
        runMeta: { changes: 0 },
      },
      {
        match: "DELETE FROM api_key_request_stats",
        rows: [],
        runMeta: { changes: 1 },
      },
    ], { requireMatch: true });

    await Promise.all([
      recordApiKeyRequestAttribution(db, 7, 1_710_000_000),
      recordApiKeyRequestAttribution(db, 7, 1_710_000_010),
      recordApiKeyRequestAttribution(db, 7, 1_710_000_020),
    ]);

    const insertStatements = db.getHistory()
      .filter((entry) => entry.sql.includes("INSERT INTO api_key_request_stats"));
    expect(insertStatements).toHaveLength(1);
    expect(insertStatements[0]?.binds).toEqual([7, 1_710_000_000 - (1_710_000_000 % 60), 3]);
  });
});
