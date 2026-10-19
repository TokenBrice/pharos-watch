import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import {
  recordApiKeyRequestAttribution,
  recordWorkerRequestAttribution,
  resetRequestAttributionStateForTests,
} from "../request-source-attribution";
import { handleRequestSourceStats } from "../../api/request-source-stats";
import { ApiRequestAttributionResponseSchema } from "@pharos/contracts/request-source";

const fixtures = createLatestSchemaFixtureTracker();
const route = { routeKey: "stablecoins", routePath: "/api/stablecoins" };
const minute = 1_700_000_040;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime((minute + 120) * 1000);
  resetRequestAttributionStateForTests();
});
afterEach(() => {
  resetRequestAttributionStateForTests();
  fixtures.closeAll();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("sampled Worker attribution writers", () => {
  it("rejects events without allocating a flush timer or preparing any SQL", async () => {
    const { db } = fixtures.open();
    const prepare = vi.spyOn(db, "prepare");
    vi.spyOn(Math, "random").mockReturnValue(1 / 64);
    await recordWorkerRequestAttribution(db, route, "public-api", "external", "unkeyed", minute);
    expect(prepare).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("inserts and updates the exact key counter and marker without drawing a source sample", async () => {
    const { db, sqlite } = fixtures.open();
    sqlite.prepare("INSERT INTO api_keys (id, key_prefix, secret_hash, name, created_at, updated_at) VALUES (7, 'prefix', 'secret', 'Partner', ?, ?)").run(minute, minute);
    const draw = vi.spyOn(Math, "random").mockReturnValue(0.9);
    const prepare = vi.spyOn(db, "prepare");
    for (const count of [1, 2]) {
      const pending = recordApiKeyRequestAttribution(db, 7, minute);
      await vi.runAllTimersAsync();
      await pending;
      expect(sqlite.prepare("SELECT request_count, source_v2_request_count FROM api_key_request_stats").get())
        .toEqual({ request_count: count, source_v2_request_count: count });
    }
    expect(draw).not.toHaveBeenCalled();
    expect(prepare.mock.calls.every(([sql]) => sql.includes("INSERT INTO api_key_request_stats"))).toBe(true);
  });

  it("keeps persisted probability strata separate on a conflicting route/minute", async () => {
    const { db, sqlite } = fixtures.open();
    sqlite.prepare("INSERT INTO api_request_source_samples VALUES (?, 'stablecoins', '/api/stablecoins', 'public-api', 'external', 'unkeyed', 32, 2)").run(minute);
    vi.spyOn(Math, "random").mockReturnValue(0);
    const pending = recordWorkerRequestAttribution(db, route, "public-api", "external", "unkeyed", minute);
    await vi.runAllTimersAsync();
    await pending;
    expect(sqlite.prepare("SELECT sample_inverse_rate, sample_count FROM api_request_source_samples ORDER BY sample_inverse_rate").all())
      .toEqual([{ sample_inverse_rate: 32, sample_count: 2 }, { sample_inverse_rate: 64, sample_count: 1 }]);
  });

  it("selects each event before merging and separates auth, lane and minute dimensions", async () => {
    const { db, sqlite } = fixtures.open();
    const draw = vi.spyOn(Math, "random").mockReturnValue(0);
    draw.mockReturnValueOnce(0).mockReturnValueOnce(1 / 64).mockReturnValueOnce(0);
    const pending = [
      recordWorkerRequestAttribution(db, route, "public-api", "external", "unkeyed", minute),
      recordWorkerRequestAttribution(db, route, "public-api", "external", "unkeyed", minute),
      recordWorkerRequestAttribution(db, route, "public-api", "external", "unkeyed", minute),
      recordWorkerRequestAttribution(db, route, "public-api", "external", "keyed", minute),
      recordWorkerRequestAttribution(db, route, "site-api", "site", "not-applicable", minute),
      recordWorkerRequestAttribution(db, route, "public-api", "external", "unkeyed", minute + 60),
    ];
    await vi.runAllTimersAsync();
    await Promise.all(pending);
    expect(draw).toHaveBeenCalledTimes(6);
    expect(sqlite.prepare(`SELECT bucket_start, lane, authentication_class, sample_inverse_rate, sample_count
      FROM api_request_source_samples ORDER BY bucket_start, lane, authentication_class`).all()).toEqual([
      { bucket_start: minute, lane: "public-api", authentication_class: "keyed", sample_inverse_rate: 64, sample_count: 1 },
      { bucket_start: minute, lane: "public-api", authentication_class: "unkeyed", sample_inverse_rate: 64, sample_count: 2 },
      { bucket_start: minute, lane: "site-api", authentication_class: "not-applicable", sample_inverse_rate: 64, sample_count: 1 },
      { bucket_start: minute + 60, lane: "public-api", authentication_class: "unkeyed", sample_inverse_rate: 64, sample_count: 1 },
    ]);
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM api_request_consumer_stats").get()).toEqual({ count: 0 });
    // A later request conflicts with the committed row rather than replacing its observed count.
    const next = recordWorkerRequestAttribution(db, route, "public-api", "external", "unkeyed", minute);
    await vi.runAllTimersAsync();
    await next;
    expect(sqlite.prepare("SELECT sample_count FROM api_request_source_samples WHERE bucket_start = ? AND authentication_class = 'unkeyed'").get(minute))
      .toEqual({ sample_count: 3 });
  });

  it("atomically marks unsampled key writes across old/new overlap and feeds the v2 reader", async () => {
    const { db, sqlite } = fixtures.open();
    sqlite.prepare("INSERT INTO api_keys (id, key_prefix, secret_hash, name, created_at, updated_at) VALUES (7, 'prefix', 'secret', 'Partner', ?, ?)").run(minute, minute);
    sqlite.prepare("INSERT INTO api_key_request_stats (api_key_id, bucket_start, request_count) VALUES (7, ?, 3)").run(minute);
    sqlite.prepare("INSERT INTO api_request_consumer_stats VALUES (?, 'stablecoins', '/api/stablecoins', 'public-api', 'external', 5)").run(minute);
    vi.spyOn(Math, "random").mockReturnValue(1 / 64);
    const pending = [
      recordWorkerRequestAttribution(db, route, "public-api", "external", "keyed", minute),
      recordApiKeyRequestAttribution(db, 7, minute),
      recordApiKeyRequestAttribution(db, 7, minute),
    ];
    await vi.runAllTimersAsync();
    await Promise.all(pending);
    expect(sqlite.prepare("SELECT request_count, source_v2_request_count FROM api_key_request_stats").get())
      .toEqual({ request_count: 5, source_v2_request_count: 2 });
    // Simulate an old-version invocation after the new upsert in the same minute.
    sqlite.prepare("UPDATE api_key_request_stats SET request_count = request_count + 1 WHERE api_key_id = 7").run();
    sqlite.prepare("UPDATE api_request_consumer_stats SET request_count = request_count + 1").run();
    vi.mocked(Math.random).mockReturnValue(0);
    const selected = recordWorkerRequestAttribution(db, route, "public-api", "external", "unkeyed", minute);
    await vi.runAllTimersAsync();
    await selected;
    const response = await handleRequestSourceStats({ db, trustedAdmin: true, request: new Request("https://ops-api.pharos.watch/api/request-source-stats?measurementVersion=2&hours=1") });
    expect(response.status).toBe(200);
    const body = ApiRequestAttributionResponseSchema.parse(await response.json());
    expect(body.keyedPublicApi).toMatchObject({ keyedRequests: 6, unkeyedRequests: 66, totalRequests: 72 });
    expect(body.apiKeys[0]).toMatchObject({ requestCount: 6 });
    expect(body.keyedPublicApi.measurement.totalRequests.kind).toBe("mixed");
  });
});
