import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMockD1Preset, findD1HistoryEntry, type MockD1Database } from "@shared/test-utils/mock-d1";
import { mockFetch } from "@shared/test-utils/mock-fetch";
import { makeUnreportedBluechipRating } from "@shared/test-utils/bluechip.test-support";
import { recordOutcomeSafe, shouldAttemptFetch } from "../../lib/circuit-breaker";
import { handleBluechipRatings, parseBluechipRatingsCache, readBluechipRatingsCache } from "../../lib/bluechip-cache";
import { BLUECHIP_SLUG_MAP } from "@shared/lib/bluechip-slugs";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import type { BluechipRating, BluechipSmidge } from "@shared/types/bluechip";
import { BLUECHIP_OBSERVATION_MAX_AGE_SEC as MAX_AGE, isBluechipRatingCurrent } from "@shared/lib/bluechip-freshness";
import type * as FetchRetry from "../../lib/fetch-retry";

type ApiCoin = { grade: BluechipRating["grade"]; collateralization?: number | null; smart_contract_audit?: boolean | null; date_of_rating?: string | null; date_last_change?: string | null } & Partial<Record<keyof BluechipSmidge, { translations?: Array<{ summary?: string }> } | null>>;
const bcRes = (ov: Partial<ApiCoin> = {}): { data: ApiCoin[] } => ({ data: [{ grade: "A", collateralization: 95, smart_contract_audit: true, date_of_rating: "2026-03-01", date_last_change: "2026-02-15", ...ov }] });
const fixtures = createLatestSchemaFixtureTracker();

vi.mock("@shared/lib/bluechip-slugs", () => ({ BLUECHIP_SLUG_MAP: { tether: "usdt-tether", usdc: "usdc-circle" } }));
vi.mock("../../lib/fetch-retry", async (orig) => {
  const o = await orig<typeof FetchRetry>();
  return { ...o, fetchTextWithRetry: vi.fn((u: string, i?: RequestInit, _r?: number, opt?: Parameters<typeof o.fetchTextWithRetry>[3]) => o.fetchTextWithRetry(u, i, 0, { ...opt, returnFinalResponse: true })) };
});
vi.mock("../../lib/circuit-breaker", async (orig) => ({ ...await orig<typeof import("../../lib/circuit-breaker")>(), shouldAttemptFetch: vi.fn(async () => true), recordOutcomeSafe: vi.fn(async () => undefined) }));

import { syncBluechip } from "../sync-bluechip";

const js = JSON.stringify, jp = JSON.parse, nowS = () => Math.floor(Date.now() / 1000);
const mockD1 = createMockD1Preset([{ match: "SELECT value, updated_at FROM cache WHERE key = ?", rows: [], first: null }, { match: "INSERT INTO cache", rows: [] }]);
const getIns = (db: MockD1Database) => findD1HistoryEntry(db, "INSERT INTO cache", [0, "bluechip-ratings"]);
const cachedOf = (db: MockD1Database) => jp(String(getIns(db)?.binds[1])) as Record<string, Record<string, unknown>>;
const emptySmidge = { stability: null, management: null, implementation: null, decentralization: null, governance: null, externals: null };
const cacheDb = (val: unknown, age = 30_000) => mockD1([{ match: "SELECT value, updated_at FROM cache WHERE key = ?", matchBinds: ["bluechip-ratings"], rows: [], first: { value: js(val), updated_at: nowS() - age } }]);
const selCache = (sqlite: ReturnType<typeof fixtures.open>["sqlite"]) => sqlite.prepare("SELECT value, updated_at FROM cache WHERE key = 'bluechip-ratings'").get() as { value: string; updated_at: number } | undefined;

describe("syncBluechip", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date("2026-03-06T12:00:00Z")); vi.mocked(shouldAttemptFetch).mockResolvedValue(true); });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); fixtures.closeAll(); delete BLUECHIP_SLUG_MAP.dai; delete BLUECHIP_SLUG_MAP.usds; });

  it("records typed body overflow per slug without publishing partial data as current", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { headers: { "Content-Length": String(16 * 1024 * 1024 + 1) } })));
    const r = await syncBluechip(mockD1());
    expect(r.status).toBe("degraded");
    expect(jp(r.metadata!).failedSlugs).toEqual([{ slug: "tether", reason: "resource-budget-exceeded" }, { slug: "usdc", reason: "resource-budget-exceeded" }]);
  });

  it("cancels a stalled slug body and publishes siblings from subsequent batches", async () => {
    BLUECHIP_SLUG_MAP.dai = "dai-makerdao"; BLUECHIP_SLUG_MAP.usds = "usds-sky";
    const cancel = vi.fn();
    const fetch = vi.fn(async (url: string) => url.endsWith("/tether")
      ? new Response(new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new TextEncoder().encode('{"data":[')); }, cancel }))
      : new Response(js(bcRes()), { headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetch);
    const { db, sqlite } = fixtures.open(), p = syncBluechip(db);
    await vi.runAllTimersAsync();
    const r = await p;
    expect(cancel).toHaveBeenCalledOnce();
    expect(fetch.mock.calls.map(([u]) => u.split("/").slice(-1)[0])).toEqual(["tether", "usdc", "dai", "usds"]);
    expect(r).toMatchObject({ status: "ok", itemCount: 3 });
    expect(jp(r.metadata!).failedSlugs).toEqual([{ slug: "tether", reason: "no-response" }]);
    const ratings = jp(selCache(sqlite)!.value);
    expect(Object.keys(ratings).sort()).toEqual(["dai-makerdao", "usdc-circle", "usds-sky"]);
    expect(ratings["usdc-circle"].observationState).toBe("current");
  });

  it("retains valid cached ratings when one record is invalid", () => {
    const valid = makeUnreportedBluechipRating(), raw = js({ valid, invalid: null });
    expect(parseBluechipRatingsCache(raw, "sync-bluechip:test-cache")).toEqual({ valid });
    expect(readBluechipRatingsCache(raw, "sync-bluechip:test-cache")).toEqual({ ratings: { valid }, droppedIds: ["invalid"] });
  });

  it("writes transformed bluechip ratings to cache on happy path", async () => {
    mockFetch([
      { match: "/coin-data/tether", body: bcRes({ stability: { translations: [{ summary: "<p>stable</p>" }] } }) },
      { match: "/coin-data/usdc", body: bcRes({ grade: "B", collateralization: 88, date_last_change: null, management: { translations: [{ summary: "<p>managed</p>" }] } }) },
    ]);
    const db = mockD1(), r = await syncBluechip(db), meta = jp(r.metadata ?? "{}");
    expect(r).toMatchObject({ status: "ok", itemCount: 2 }); expect(meta.ratingsFetched).toBe(2); expect(meta.failedSlugs).toBeUndefined();
    expect(getIns(db as MockD1Database)).toBeDefined();
    expect(cachedOf(db as MockD1Database)).toMatchObject({ "usdt-tether": { grade: "A", slug: "tether", smidge: { stability: "stable" } }, "usdc-circle": { grade: "B", slug: "usdc" } });
  });

  it("publishes null when Bluechip omits optional rating fields", async () => {
    const miss = bcRes(); delete miss.data[0]!.collateralization; delete miss.data[0]!.smart_contract_audit; delete miss.data[0]!.date_of_rating;
    mockFetch([{ match: "/coin-data/tether", body: miss }, { match: "/coin-data/usdc", body: bcRes() }]);
    const db = mockD1();
    expect((await syncBluechip(db)).status).toBe("ok");
    expect(cachedOf(db as MockD1Database)["usdt-tether"]).toMatchObject({ collateralization: null, smartContractAudit: null, dateOfRating: null });
  });

  it("isolates an invalid Bluechip record within a response", async () => {
    mockFetch([{ match: "/coin-data/tether", body: { data: [{ grade: "not-a-grade" }, bcRes({ grade: "B" }).data[0]] } }, { match: "/coin-data/usdc", body: bcRes() }]);
    const db = mockD1();
    expect((await syncBluechip(db)).status).toBe("ok");
    expect(cachedOf(db as MockD1Database)).toMatchObject({ "usdt-tether": { grade: "B" }, "usdc-circle": { grade: "A" } });
  });

  it("accepts null category blocks from the Bluechip payload", async () => {
    mockFetch([
      { match: "/coin-data/tether", body: bcRes({ implementation: null, externals: null }) },
      { match: "/coin-data/usdc", body: bcRes({ grade: "B+", collateralization: 100, date_of_rating: "2026-03-24", date_last_change: null, implementation: null, externals: null, management: { translations: [{ summary: "<p>managed</p>" }] } }) },
    ]);
    const db = mockD1();
    expect(await syncBluechip(db)).toMatchObject({ status: "ok", itemCount: 2 });
    expect(cachedOf(db as MockD1Database)["usdc-circle"]).toMatchObject({ grade: "B+", smidge: { implementation: null, externals: null } });
  });

  it("accepts null date_of_rating values from the Bluechip payload", async () => {
    mockFetch([{ match: "/coin-data/tether", body: bcRes({ date_of_rating: null }) }, { match: "/coin-data/usdc", body: bcRes({ grade: "B+", collateralization: 100, date_of_rating: null, date_last_change: null }) }]);
    const db = mockD1();
    expect(await syncBluechip(db)).toMatchObject({ status: "ok", itemCount: 2 });
    expect(cachedOf(db as MockD1Database)).toMatchObject({ "usdt-tether": { dateOfRating: null }, "usdc-circle": { dateOfRating: null } });
  });

  it("returns degraded when bluechip API requests fail", async () => {
    const tRes = new Response(js({ error: "down" }), { status: 500 }), uRes = new Response(js({ error: "down" }), { status: 500 });
    mockFetch([{ match: () => true, respond: (req) => req.url.includes("/coin-data/tether") ? tRes : uRes }]);
    const db = mockD1(), r = await syncBluechip(db);
    expect(r).toMatchObject({ status: "degraded", itemCount: 0 });
    const m = jp(r.metadata ?? "{}");
    expect(m.reason).toBe("upstream-no-ratings"); expect(m.failedSlugs).toEqual([{ slug: "tether", reason: "http-500" }, { slug: "usdc", reason: "http-500" }]);
    expect(getIns(db as MockD1Database)).toBeUndefined(); expect([tRes.bodyUsed, uRes.bodyUsed]).toEqual([true, true]);
  });

  it("merges fresh ratings into the existing cache when only a subset of slugs succeeds", async () => {
    mockFetch([{ match: "/coin-data/tether", body: bcRes() }, { match: "/coin-data/usdc", body: { error: "down" }, status: 500 }]);
    const db = cacheDb({ "usdc-circle": { grade: "B", slug: "usdc", collateralization: 88, smartContractAudit: true, dateOfRating: "2026-02-20", dateLastChange: null, smidge: { ...emptySmidge, management: "managed" } } });
    const r = await syncBluechip(db);
    expect(r.status).toBe("ok");
    const m = jp(r.metadata ?? "{}");
    expect(m.quality).toEqual({ reason: "partial-cache-merge" }); expect(m.failedSlugs).toEqual([{ slug: "usdc", reason: "http-500" }]);
    expect(m).toMatchObject({ ratingsFetched: 1, ratingsPublished: 2, fallbackMode: "partial-cache-merge" });
    expect(recordOutcomeSafe).toHaveBeenCalledWith(db, "bluechip-api", true);
    expect(cachedOf(db as MockD1Database)).toMatchObject({ "usdt-tether": { grade: "A" }, "usdc-circle": { grade: "B" } });
  });

  it("ignores malformed existing cache entries when partial coverage is published", async () => {
    mockFetch([{ match: "/coin-data/tether", body: bcRes() }, { match: "/coin-data/usdc", body: { error: "down" }, status: 500 }]);
    const db = cacheDb({ "usdc-circle": { grade: "B" } }), r = await syncBluechip(db);
    expect(r.status).toBe("ok");
    const m = jp(r.metadata ?? "{}");
    expect(m.quality).toEqual({ reason: "partial-cache-merge" }); expect(m).toMatchObject({ ratingsFetched: 1, ratingsPublished: 1, retainedFromCache: 0 });
    expect(cachedOf(db as MockD1Database)).toEqual({ "usdt-tether": expect.objectContaining({ grade: "A" }) });
  });

  it("records json parse failures per slug without losing partial coverage", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockFetch([{ match: "/coin-data/tether", body: "<html>bad gateway</html>", status: 200, headers: { "content-type": "text/html" } }, { match: "/coin-data/usdc", body: bcRes({ grade: "B", collateralization: 88, date_last_change: null }) }]);
    const db = cacheDb({ "usdt-tether": { grade: "A", slug: "tether", collateralization: 95, smartContractAudit: true, dateOfRating: "2026-02-20", dateLastChange: null, smidge: emptySmidge } });
    const r = await syncBluechip(db);
    expect(r.status).toBe("ok");
    const m = jp(r.metadata ?? "{}");
    expect(m.quality).toEqual({ reason: "partial-cache-merge" }); expect(m.failedSlugs).toEqual([{ slug: "tether", reason: "json-parse-failed" }]); expect(m.invalidPayloads).toBe(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("[bluechip] Failed to parse JSON for tether:"));
  });

  it("returns degraded on invalid response shape", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    mockFetch([{ match: "/coin-data/tether", body: { data: [{ collateralization: 99 }] } }, { match: "/coin-data/usdc", body: { data: [] } }]);
    const db = mockD1(), r = await syncBluechip(db);
    expect(r).toMatchObject({ status: "degraded", itemCount: 0 });
    const m = jp(r.metadata ?? "{}");
    expect(m.reason).toBe("upstream-no-ratings"); expect(m.failedSlugs).toEqual([{ slug: "tether", reason: "no-grade" }, { slug: "usdc", reason: "empty-data" }]);
    expect(getIns(db as MockD1Database)).toBeUndefined();
  });

  it.each([6 * 3600 - 1, 6 * 3600])("enforces the freshness cutoff at age %s seconds", async (age) => {
    const { db, sqlite } = fixtures.open(), val = js({ sentinel: "existing" }), updAt = nowS() - age;
    sqlite.prepare("INSERT INTO cache(key, value, updated_at) VALUES (?, ?, ?)").run("bluechip-ratings", val, updAt);
    const fetch = mockFetch([{ match: () => true, body: { data: [{ grade: "A" }] } }]);
    const r = await syncBluechip(db);
    if (age < 6 * 3600) {
      expect(r.itemCount).toBe(0); expect(jp(r.metadata ?? "{}")).toMatchObject({ reason: "cache-fresh" }); expect(fetch).not.toHaveBeenCalled();
      expect(selCache(sqlite)).toEqual({ value: val, updated_at: updAt });
    } else {
      expect(r.itemCount).toBe(2); expect(fetch).toHaveBeenCalledTimes(2);
      const row = selCache(sqlite)!; expect(jp(row.value)).toMatchObject({ "usdt-tether": { grade: "A" }, "usdc-circle": { grade: "A" } }); expect(row.updated_at).toBe(nowS());
    }
  });

  it("refreshes instead of trusting a future-dated cache clock", async () => {
    const { db, sqlite } = fixtures.open();
    sqlite.prepare("INSERT INTO cache(key, value, updated_at) VALUES (?, ?, ?)").run("bluechip-ratings", "{}", nowS() + 86_400);
    const fetch = mockFetch([{ match: () => true, body: { data: [{ grade: "A" }] } }]);
    expect(jp((await syncBluechip(db)).metadata ?? "{}")).not.toMatchObject({ reason: "cache-fresh" });
    expect(fetch).toHaveBeenCalledTimes(2); expect(selCache(sqlite)?.updated_at).toBe(nowS());
  });

  it("preserves cache without HTTP when the circuit is open", async () => {
    const { db, sqlite } = fixtures.open();
    sqlite.prepare("INSERT INTO cache(key, value, updated_at) VALUES (?, ?, ?)").run("bluechip-ratings", "{}", 1);
    vi.mocked(shouldAttemptFetch).mockResolvedValueOnce(false);
    const fetch = mockFetch([{ match: () => true, body: { data: [] } }]);
    expect(await syncBluechip(db)).toMatchObject({ status: "degraded", itemCount: 0 });
    expect(fetch).not.toHaveBeenCalled(); expect(selCache(sqlite)).toEqual({ value: "{}", updated_at: 1 });
  });

  it("preserves a concurrent newer publication after fetching ratings", async () => {
    const { db, sqlite } = fixtures.open(), newerAt = nowS() + 1;
    mockFetch([{ match: () => true, respond: () => { sqlite.prepare("INSERT OR REPLACE INTO cache(key, value, updated_at) VALUES (?, ?, ?)").run("bluechip-ratings", '{"winner":true}', newerAt); return Response.json({ data: [{ grade: "A" }] }); } }]);
    const r = await syncBluechip(db);
    expect(r).toMatchObject({ itemCount: 0, status: "skipped_neutral" });
    expect(jp(r.metadata ?? "{}")).toMatchObject({ reason: "cache-write-skipped-newer", cacheWriteMode: "skipped-newer", ratingsFetched: 2, ratingsPublished: 0, casSkipped: true });
    expect(selCache(sqlite)).toEqual({ value: '{"winner":true}', updated_at: newerAt });
  });

  it("bounds consecutive failed observations without borrowing a successful sibling's clock", async () => {
    const { db, sqlite } = fixtures.open(), start = nowS();
    const readR = () => parseBluechipRatingsCache(String(selCache(sqlite)?.value), "test");
    mockFetch([{ match: () => true, body: bcRes() }]); await syncBluechip(db);
    expect(readR()["usdc-circle"].lastObservedAt).toBe(start);
    for (const [off, status, body, reason] of [[86400, 500, {}, "http-500"], [MAX_AGE, 404, {}, "http-404"], [MAX_AGE + 86400, 200, { data: [{}] }, "no-grade"]] as const) {
      vi.setSystemTime((start + off) * 1000);
      mockFetch([{ match: "/coin-data/tether", body: bcRes() }, { match: "/coin-data/usdc", status, body }]);
      expect((await syncBluechip(db)).status).toBe("ok");
      const r = readR();
      expect(r["usdt-tether"].lastObservedAt).toBe(start + off);
      expect(r["usdc-circle"]).toMatchObject({ lastObservedAt: start, observationReason: reason, observationState: off > MAX_AGE ? "stale" : "retained" });
      expect(isBluechipRatingCurrent(r["usdc-circle"], start + off)).toBe(status === 500);
    }
    vi.setSystemTime((start + 4 * 86400) * 1000); mockFetch([{ match: () => true, body: bcRes({ grade: "B" }) }]); await syncBluechip(db);
    expect(readR()["usdc-circle"]).toMatchObject({ grade: "B", lastObservedAt: start + 4 * 86400, observationState: "current", observationReason: null });
    vi.setSystemTime((start + 7 * 86400) * 1000);
    expect(((await (await handleBluechipRatings(db)).json()) as Record<string, unknown>)["usdc-circle"]).toMatchObject({ lastObservedAt: start + 4 * 86400, observationState: "stale" });
  });

  it("records all-failed unresolved attempts without advancing the publication clock", async () => {
    const { db, sqlite } = fixtures.open(), obsAt = nowS() - 86400;
    const rating = { ...makeUnreportedBluechipRating(), slug: "usdc", lastObservedAt: obsAt, observationState: "current", observationReason: null };
    sqlite.prepare("INSERT INTO cache(key, value, updated_at) VALUES (?, ?, ?)").run("bluechip-ratings", js({ "usdc-circle": rating }), obsAt);
    mockFetch([{ match: () => true, status: 404, body: {} }]);
    expect((await syncBluechip(db)).status).toBe("degraded");
    const row = selCache(sqlite)!;
    expect(row.updated_at).toBe(obsAt); expect(jp(row.value)["usdc-circle"]).toMatchObject({ lastObservedAt: obsAt, observationState: "retained", observationReason: "http-404" });
  });

  it("cancels during the inter-batch wait without fetching the fourth slug or publishing", async () => {
    BLUECHIP_SLUG_MAP.dai = "dai-makerdao"; BLUECHIP_SLUG_MAP.usds = "usds-sky";
    const { db, sqlite } = fixtures.open(), ctrl = new AbortController();
    const fetch = mockFetch([{ match: () => true, body: { data: [{ grade: "A" }] } }]);
    const p = syncBluechip(db, ctrl.signal), rej = expect(p).rejects.toThrow();
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(fetch.mock.calls.map(([u]) => String(u).split("/").slice(-1)[0])).toEqual(["tether", "usdc", "dai"]);
      ctrl.abort(new Error("cancel between batches")); await rej;
      expect(fetch).toHaveBeenCalledTimes(3); expect(sqlite.prepare("SELECT * FROM cache WHERE key = 'bluechip-ratings'").all()).toEqual([]);
    } finally { ctrl.abort(); await p.catch(() => {}); }
  });
});
