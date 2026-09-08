import { readJsonResponse } from "../../test-helpers/__shared/auth";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiRequestAttributionResponse } from "@shared/types";
import { handleRequestSourceStats } from "../request-source-stats";
import { createLatestSchemaFixtureTracker } from "../../test-helpers/latest-schema-sqlite";

const fixtures = createLatestSchemaFixtureTracker();
const NOW = 1_700_000_000;
const FROM = NOW - 3600;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW * 1000);
});
afterEach(() => {
  try {
    fixtures.closeAll();
  } finally {
    vi.useRealTimers();
  }
});

async function readStats(db: D1Database) {
  const request = new Request("https://ops-api.pharos.watch/api/request-source-stats?hours=1&bucketSec=3600&routeLimit=2&apiKeyLimit=2");
  const response = await handleRequestSourceStats({ db, trustedAdmin: true, request });
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  return await readJsonResponse(response, 200) as ApiRequestAttributionResponse;
}

describe("handleRequestSourceStats", () => {
  it("executes window boundaries, lane unions, ordering and masked key joins", async () => {
    const { sqlite, db } = fixtures.open();
    const pages = sqlite.prepare("INSERT INTO site_data_request_stats (bucket_start, route_key, route_path, delivery_path, request_count) VALUES (?, ?, ?, ?, ?)");
    pages.run(FROM - 1, "excluded-before", "/before", "pages-cache-hit", 1000);
    pages.run(FROM, "a", "/a", "pages-cache-hit", 20);
    pages.run(NOW - 1, "b", "/b", "pages-upstream-fetch", 10);
    pages.run(NOW, "excluded-after", "/after", "pages-cache-hit", 1000);
    const consumers = sqlite.prepare("INSERT INTO api_request_consumer_stats VALUES (?, ?, ?, ?, ?, ?)");
    consumers.run(FROM - 1, "excluded-before", "/before", "public-api", "external", 1000);
    consumers.run(FROM, "a", "/a", "public-api", "site", 10);
    consumers.run(FROM, "a", "/a", "public-api", "external", 10);
    consumers.run(NOW - 1, "b", "/b", "public-api", "external", 30);
    consumers.run(NOW - 1, "c", "/c", "public-api", "external", 20);
    consumers.run(NOW - 1, "a", "/a", "site-api", "site", 900);
    consumers.run(NOW, "excluded-after", "/after", "public-api", "external", 1000);
    const key = sqlite.prepare("INSERT INTO api_keys (id, key_prefix, secret_hash, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)");
    const keyStats = sqlite.prepare("INSERT INTO api_key_request_stats VALUES (?, ?, ?)");
    for (const id of [3, 1, 2]) {
      key.run(id, `prefix${id}`, `secret${id}`, `Partner ${id}`, FROM, FROM);
      keyStats.run(id, FROM, 10);
    }
    keyStats.run(1, FROM - 1, 1000);
    keyStats.run(1, NOW, 1000);

    const body = await readStats(db);
    expect(body.totals).toEqual({ siteRequests: 40, externalRequests: 60, totalRequests: 100, siteSharePct: 40, externalSharePct: 60 });
    expect(body.siteDelivery).toEqual({ totalSiteRequests: 40, pagesCacheHits: 20, pagesUpstreamFetches: 10, pagesUpstreamTimeouts: 0, pagesUpstreamErrors: 0, publicApiSiteRequests: 10 });
    expect(body.routes).toEqual([
      { routeKey: "a", routePath: "/a", siteRequests: 30, externalRequests: 10, totalRequests: 40, siteSharePct: 75, externalSharePct: 25 },
      { routeKey: "b", routePath: "/b", siteRequests: 10, externalRequests: 30, totalRequests: 40, siteSharePct: 25, externalSharePct: 75 },
    ]);
    expect(body.buckets).toEqual([
      { bucketStart: 1_699_995_600, siteRequests: 30, externalRequests: 10, totalRequests: 40, siteSharePct: 75, externalSharePct: 25 },
      { bucketStart: 1_699_999_200, siteRequests: 10, externalRequests: 50, totalRequests: 60, siteSharePct: 16.67, externalSharePct: 83.33 },
    ]);
    expect(body.lanes.map(({ lane, totalRequests }) => ({ lane, totalRequests }))).toEqual([
      { lane: "public-api", totalRequests: 70 }, { lane: "site-api", totalRequests: 900 },
    ]);
    expect(body.apiKeys.map(({ apiKeyId, name, maskedToken, requestCount }) => ({ apiKeyId, name, maskedToken, requestCount }))).toEqual([
      { apiKeyId: 1, name: "Partner 1", maskedToken: "ph_live_prefix1_********", requestCount: 10 },
      { apiKeyId: 2, name: "Partner 2", maskedToken: "ph_live_prefix2_********", requestCount: 10 },
    ]);
    expect(body.keyedPublicApi).toEqual({ keyedRequests: 30, unkeyedRequests: 40, totalRequests: 70, keyedSharePct: 42.86, unkeyedSharePct: 57.14, totalKeys: 3, returnedKeys: 2, omittedKeys: 1, omittedRequests: 10, truncated: true });
    expect(body.window).toMatchObject({ from: FROM, to: NOW, durationSec: 3600, bucketSizeSec: 3600, routeLimit: 2, apiKeyLimit: 2 });
    expect(body.scope).toEqual({ countsTotalSiteDemand: true, countsWorkerLoad: true, includesPagesProxyCacheHits: true });
  });

  it("returns finite zero percentages and empty series without demand", async () => {
    const { db } = fixtures.open();
    const body = await readStats(db);
    expect(body.totals).toEqual({ siteRequests: 0, externalRequests: 0, totalRequests: 0, siteSharePct: 0, externalSharePct: 0 });
    expect(body.keyedPublicApi).toEqual({ keyedRequests: 0, unkeyedRequests: 0, totalRequests: 0, keyedSharePct: 0, unkeyedSharePct: 0, totalKeys: 0, returnedKeys: 0, omittedKeys: 0, omittedRequests: 0, truncated: false });
    expect(body.routes).toEqual([]);
    expect(body.buckets).toEqual([]);
    expect(body.lanes).toEqual([]);
    expect(body.apiKeys).toEqual([]);
  });
});
