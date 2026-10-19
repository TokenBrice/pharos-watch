import { readJsonResponse } from "../../test-helpers/__shared/auth";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiRequestAttributionResponseSchema } from "@pharos/contracts/request-source";
import { handleRequestSourceStats } from "../request-source-stats";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";

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
  const request = new Request("https://ops-api.pharos.watch/api/request-source-stats?measurementVersion=2&hours=1&bucketSec=3600&routeLimit=2&apiKeyLimit=2");
  const response = await handleRequestSourceStats({ db, trustedAdmin: true, request });
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  return ApiRequestAttributionResponseSchema.parse(await readJsonResponse(response, 200));
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
    const keyStats = sqlite.prepare("INSERT INTO api_key_request_stats (api_key_id, bucket_start, request_count) VALUES (?, ?, ?)");
    for (const id of [3, 1, 2]) {
      key.run(id, `prefix${id}`, `secret${id}`, `Partner ${id}`, FROM, FROM);
      keyStats.run(id, FROM, 10);
    }
    keyStats.run(1, FROM - 1, 1000);
    keyStats.run(1, NOW, 1000);

    const body = await readStats(db);
    expect(body.totals).toMatchObject({ siteRequests: 40, externalRequests: 60, totalRequests: 100, siteSharePct: 40, externalSharePct: 60 });
    expect(body.totals.measurement.totalRequests).toMatchObject({ kind: "observed", recordedCount: 100, observedSampleCount: 0, standardError: 0 });
    expect(body.siteDelivery).toMatchObject({ totalSiteRequests: 40, pagesCacheHits: 20, pagesUpstreamFetches: 10, pagesUpstreamTimeouts: 0, pagesUpstreamErrors: 0, publicApiSiteRequests: 10 });
    expect(body.routes).toMatchObject([
      { routeKey: "a", routePath: "/a", siteRequests: 30, externalRequests: 10, totalRequests: 40, siteSharePct: 75, externalSharePct: 25 },
      { routeKey: "b", routePath: "/b", siteRequests: 10, externalRequests: 30, totalRequests: 40, siteSharePct: 25, externalSharePct: 75 },
    ]);
    expect(body.buckets).toMatchObject([
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
    expect(body.keyedPublicApi).toMatchObject({ keyedRequests: 30, unkeyedRequests: 40, totalRequests: 70, keyedSharePct: 42.86, unkeyedSharePct: 57.14, totalKeys: 3, returnedKeys: 2, omittedKeys: 1, omittedRequests: 10, truncated: true });
    expect(body.window).toMatchObject({ from: FROM, to: NOW, durationSec: 3600, bucketSizeSec: 3600, routeLimit: 2, apiKeyLimit: 2 });
    expect(sqlite.prepare("SELECT DISTINCT source_v2_request_count FROM api_key_request_stats").all()).toEqual([{ source_v2_request_count: 0 }]);
    expect(body.scope).toEqual({ countsTotalSiteDemand: true, countsWorkerLoad: true, includesPagesProxyCacheHits: true });
  });

  it("requires an explicit measurement version without reading the database", async () => {
    const { db } = fixtures.open();
    const prepare = vi.spyOn(db, "prepare");
    for (const query of ["", "?measurementVersion=1", "?measurementVersion=3", "?measurementVersion=02"]) {
      const response = await handleRequestSourceStats({ db, trustedAdmin: true, request: new Request(`https://ops-api.pharos.watch/api/request-source-stats${query}`) });
      expect(response.status).toBe(400);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      expect(await response.json()).toMatchObject({ reason: "attribution-measurement-version-required" });
    }
    expect(prepare).not.toHaveBeenCalled();
  });

  it("adds same-minute legacy and weighted samples without counting site-api demand twice", async () => {
    const { sqlite, db } = fixtures.open();
    sqlite.exec(`
      INSERT INTO api_request_consumer_stats VALUES (${FROM}, 'a', '/a', 'public-api', 'external', 100);
      INSERT INTO api_request_source_samples VALUES (${FROM}, 'a', '/a', 'public-api', 'external', 'unkeyed', 64, 30);
      INSERT INTO api_request_source_samples VALUES (${FROM}, 'a', '/a', 'public-api', 'external', 'keyed', 32, 2);
      INSERT INTO api_request_source_samples VALUES (${FROM}, 'internal', '/internal', 'site-api', 'site', 'not-applicable', 64, 50);
      INSERT INTO site_data_request_samples VALUES (${FROM}, 'a', '/a', 'pages-upstream-fetch', 'site-api', 64, 30);
      INSERT INTO site_data_request_samples VALUES (${FROM}, 'a', '/a', 'pages-upstream-timeout', 'site-api', 1, 2);
      INSERT INTO site_data_request_samples VALUES (${NOW}, 'excluded', '/excluded', 'pages-upstream-fetch', 'site-api', 64, 1000);
      INSERT INTO api_keys (id, key_prefix, secret_hash, name, created_at, updated_at) VALUES (1, 'prefix', 'secret', 'Partner', ${FROM}, ${FROM});
      INSERT INTO api_key_request_stats (api_key_id, bucket_start, request_count, source_v2_request_count) VALUES (1, ${FROM}, 90, 70);
    `);
    const body = await readStats(db);
    expect(body.totals).toMatchObject({ siteRequests: 1922, externalRequests: 2084, totalRequests: 4006 });
    expect(body.totals.measurement.totalRequests).toMatchObject({
      kind: "mixed", recordedCount: 100, observedSampleCount: 64, reason: null,
      probabilityStrata: [{ inverseRate: 1, observedSampleCount: 2 }, { inverseRate: 32, observedSampleCount: 2 }, { inverseRate: 64, observedSampleCount: 60 }],
    });
    expect(body.totals.measurement.totalRequests.standardError).toBeCloseTo(Math.sqrt(60 * 64 * 63 + 2 * 32 * 31));
    expect(body.siteDelivery.measurement.pagesUpstreamTimeouts).toMatchObject({ kind: "observed", observedSampleCount: 2, standardError: 0 });
    expect(body.lanes[1].totalRequests).toBe(3200);
    expect(body.routes.map((route) => route.routeKey)).not.toContain("internal");
    expect(body.keyedPublicApi).toMatchObject({ keyedRequests: 90, unkeyedRequests: 2000, totalRequests: 2090 });
    expect(body.keyedPublicApi.measurement.keyedRequests.kind).toBe("observed");
    expect(body.keyedPublicApi.measurement.totalRequests.kind).toBe("mixed");
    expect(body.apiKeys[0].shareOfTotalPublicApiRequestsPct).toBe(4.31);
    expect(body.lanes[0].totalRequests).toBe(2084);
  });

  it("publishes low-sample precision and honest empty observation states", async () => {
    const { sqlite, db } = fixtures.open();
    const empty = await readStats(db);
    expect(empty.totals.totalRequests).toBe(0);
    expect(empty.totals.measurement.totalRequests).toMatchObject({ kind: "estimated", reason: "low-sample", coverage: "unknown", standardError: null });
    sqlite.exec(`INSERT INTO site_data_request_samples VALUES (${FROM}, 'rare', '/rare', 'pages-upstream-fetch', 'site-api', 64, 1)`);
    const body = await readStats(db);
    expect(body.totals.measurement.totalRequests).toMatchObject({ kind: "estimated", reason: "low-sample", observedSampleCount: 1, standardError: null });
    expect(body.totals.externalRequests).toBe(0);
    expect(body.totals.measurement.externalRequests).toMatchObject({ kind: "estimated", reason: "low-sample", coverage: "unknown" });
    expect(body.siteDelivery.measurement.pagesUpstreamTimeouts.kind).toBe("observed");
  });

  it.each([
    [10, 11, "invalid-key-regime"], [10, -1, "invalid-key-regime"], [10, 0, "legacy-keyed-exceeds-source"],
  ])("quarantines an inconsistent keyed denominator (%s/%s), not unrelated demand", async (count, marker, reason) => {
    const { sqlite, db } = fixtures.open();
    sqlite.exec(`
      INSERT INTO api_request_consumer_stats VALUES (${FROM}, 'a', '/a', 'public-api', 'external', 5);
      INSERT INTO api_keys (id, key_prefix, secret_hash, name, created_at, updated_at) VALUES (1, 'prefix', 'secret', 'Partner', ${FROM}, ${FROM});
      INSERT INTO api_key_request_stats (api_key_id, bucket_start, request_count, source_v2_request_count) VALUES (1, ${FROM}, ${count}, ${marker});
    `);
    const body = await readStats(db);
    expect(body.totals.totalRequests).toBe(5);
    expect(body.keyedPublicApi).toMatchObject({ keyedRequests: count, unkeyedRequests: null, totalRequests: null, keyedSharePct: null });
    expect(body.keyedPublicApi.measurement.totalRequests).toMatchObject({ kind: "unavailable", reason, standardError: null });
    expect(body.apiKeys[0]).toMatchObject({ requestCount: count, shareOfKeyedRequestsPct: 100, shareOfTotalPublicApiRequestsPct: null });
  });

  it("keeps totals independent of route/key limits and supports non-hour rollups", async () => {
    const { sqlite, db } = fixtures.open();
    for (let index = 0; index < 4; index++) {
      sqlite.exec(`INSERT INTO site_data_request_samples VALUES (${FROM + index * 60}, 'r${index}', '/r${index}', 'pages-upstream-fetch', 'site-api', 64, 1)`);
    }
    const response = await handleRequestSourceStats({ db, trustedAdmin: true, request: new Request("https://ops-api.pharos.watch/api/request-source-stats?measurementVersion=2&hours=1&bucketSec=90&routeLimit=1&apiKeyLimit=1") });
    const body = ApiRequestAttributionResponseSchema.parse(await readJsonResponse(response, 200));
    expect(body.routes).toHaveLength(1);
    expect(body.totals.totalRequests).toBe(256);
    expect(body.buckets.reduce((sum, row) => sum + row.totalRequests, 0)).toBe(256);
    expect(body.buckets.every((row) => row.bucketStart % 90 === 0)).toBe(true);
  });

  it("uses the key regime marker to label zero selected source observations", async () => {
    const { sqlite, db } = fixtures.open();
    sqlite.exec(`
      INSERT INTO api_request_consumer_stats VALUES (${FROM}, 'a', '/a', 'public-api', 'external', 5);
      INSERT INTO api_keys (id, key_prefix, secret_hash, name, created_at, updated_at) VALUES (1, 'prefix', 'secret', 'Partner', ${FROM}, ${FROM});
      INSERT INTO api_key_request_stats (api_key_id, bucket_start, request_count, source_v2_request_count) VALUES (1, ${FROM}, 10, 10);
    `);
    const body = await readStats(db);
    expect(body.totals.measurement.totalRequests).toMatchObject({ kind: "mixed", reason: "low-sample", standardError: null });
    expect(body.keyedPublicApi.measurement.totalRequests).toMatchObject({ kind: "mixed", reason: "low-sample" });
    expect(body.keyedPublicApi.measurement.keyedRequests.kind).toBe("observed");
  });

  it("keeps certainty failures observed while an otherwise unobserved sampled regime stays low-sample", async () => {
    const { sqlite, db } = fixtures.open();
    sqlite.exec(`INSERT INTO site_data_request_samples VALUES (${FROM}, 'failure', '/failure', 'pages-upstream-error', 'site-api', 1, 2)`);
    const body = await readStats(db);
    expect(body.totals.measurement.totalRequests).toMatchObject({ kind: "estimated", reason: "low-sample", standardError: null });
    expect(body.siteDelivery.measurement.pagesUpstreamErrors).toMatchObject({
      kind: "observed", observedSampleCount: 2, standardError: 0, probabilityStrata: [{ inverseRate: 1, observedSampleCount: 2 }],
    });
  });

  it("uses only time-leading primary-key indexes across a representative retained sample corpus", () => {
    const { sqlite } = fixtures.open();
    const worker = sqlite.prepare("INSERT INTO api_request_source_samples VALUES (?, ?, ?, 'public-api', 'external', 'unkeyed', 64, 1)");
    const pages = sqlite.prepare("INSERT INTO site_data_request_samples VALUES (?, ?, ?, 'pages-upstream-fetch', 'site-api', 64, 1)");
    sqlite.exec("BEGIN");
    for (let hour = 0; hour < 35 * 24; hour++) {
      for (let route = 0; route < 20; route++) {
        const bucket = NOW - (hour + 1) * 3600;
        worker.run(bucket, `r${route}`, `/r${route}`);
        pages.run(bucket, `r${route}`, `/r${route}`);
      }
    }
    sqlite.exec("COMMIT");
    for (const table of ["api_request_source_samples", "site_data_request_samples"]) {
      const indexes = sqlite.prepare(`PRAGMA index_list(${table})`).all();
      expect(indexes).toHaveLength(1);
      expect(indexes[0].origin).toBe("pk");
      const plan = sqlite.prepare(`EXPLAIN QUERY PLAN SELECT SUM(sample_count * sample_inverse_rate) FROM ${table} WHERE bucket_start >= ? AND bucket_start < ?`).all(FROM, NOW);
      expect(plan.some((row) => String(row.detail).includes("SEARCH") && String(row.detail).includes("bucket_start"))).toBe(true);
    }
  });

  it("fails reads instead of manufacturing a populated zero response and retains admin auth", async () => {
    const { db } = fixtures.open();
    const request = new Request("https://ops-api.pharos.watch/api/request-source-stats?measurementVersion=2");
    expect((await handleRequestSourceStats({ db, trustedAdmin: false, request })).status).toBe(401);
    vi.spyOn(db, "prepare").mockImplementation(() => { throw new Error("database unavailable"); });
    const response = await handleRequestSourceStats({ db, trustedAdmin: true, request });
    expect(response.status).toBe(500);
    expect(await response.json()).not.toHaveProperty("totals");
  });

});
