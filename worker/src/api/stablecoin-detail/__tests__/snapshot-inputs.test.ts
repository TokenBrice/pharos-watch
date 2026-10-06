import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockD1 } from "@shared/test-utils/mock-d1";
import { API_PATHS } from "@shared/lib/api-endpoints/paths";
import { resolveSiteDataProxyPath } from "@shared/lib/site-data-lane";
import { DETAIL_SNAPSHOT_INPUT_BATCH_SIZE, DetailSnapshotInputsResponseSchema } from "@shared/types/detail-snapshot-inputs";
import { handleDetailSnapshotInputs } from "../snapshot-inputs";
import { evaluateAccessGate } from "../../../handlers/http/gates";
import { createWorkerEnv } from "../../../test-helpers/__shared/worker-env";
import { PUBLIC_STATIC_ROUTES } from "../../../routes/public-routes";

const NOW = 1_800_000_000;
const DAY = 86_400;
const detail = {
  price: null,
  tokens: [
    { date: NOW - 31 * DAY, totalCirculatingUSD: { peggedUSD: 70 }, totalCirculating: { peggedUSD: 71 } },
    { date: NOW - 8 * DAY, totalCirculatingUSD: { peggedUSD: 80 }, totalCirculating: { peggedUSD: 81 } },
    { date: NOW - DAY, totalCirculatingUSD: { peggedUSD: 90 }, totalCirculating: { peggedUSD: 91 } },
  ],
  research: "never transferred",
};

function makeDb(options: { detailBody?: string; age?: number; marker?: boolean; publication?: boolean } = {}) {
  const canonical = {
    id: "usdt-tether", name: "Tether", symbol: "USDT", pegType: "peggedUSD", pegMechanism: "fiat-backed",
    price: 0.997, priceSource: "coingecko", priceConfidence: "high", priceUpdatedAt: NOW - 70,
    priceObservedAt: NOW - 90, priceObservedAtMode: "upstream", priceSyncedAt: NOW - 60,
    circulating: { peggedUSD: 100 }, circulatingPrevDay: { peggedUSD: 99 },
    chainCirculating: {}, chains: ["Ethereum"], consensusSources: ["coingecko"], agreeSources: ["coingecko"],
  };
  return mockD1([
    { match: "cache", matchBinds: ["stablecoins"], rows: [], first: options.publication === false ? null : {
      value: JSON.stringify({ peggedAssets: [canonical] }), updated_at: NOW - 60,
    } },
    { match: "cache", matchBinds: ["snapshot-supply:last-write"], rows: [], first: options.marker === false ? null : {
      value: JSON.stringify({ snapshotDate: NOW - DAY }), updated_at: NOW - 120,
    } },
    { match: "cache", matchBinds: ["detail:usdt-tether"], rows: [], first: {
      value: options.detailBody ?? JSON.stringify(detail), updated_at: NOW - (options.age ?? 30),
    } },
    { match: "supply_history", rows: [{ snapshot_date: NOW - DAY, circulating_usd: 90, price: 1 }] },
    { match: "cache", rows: [], first: null },
  ]);
}

beforeEach(() => {
  vi.spyOn(Date, "now").mockReturnValue(NOW * 1000);
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Providers forbidden in bulk route"); }));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("cache-only detail snapshot inputs", () => {
  it("projects cache history, enriches from one publication, and preserves each source clock", async () => {
    const db = makeDb();
    const response = await handleDetailSnapshotInputs(db, new URL(API_PATHS.stablecoinDetailSnapshotInputs(["usdt-tether", "usdc-circle"]), "https://site-api.pharos.watch"));
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const body = DetailSnapshotInputsResponseSchema.parse(await response.json());
    expect(body.entries[0]).toMatchObject({
      id: "usdt-tether", status: "available",
      liveSummary: { price: 0.997, circulating: { peggedUSD: 100 }, circulatingPrevDay: { peggedUSD: 99 },
        circulatingPrevWeek: { peggedUSD: 80 }, circulatingPrevMonth: { peggedUSD: 70 },
        nativeSupply: { current: 91, prevWeek: 81, prevMonth: 71 } },
      supplyHistory: [{ date: NOW - DAY, circulatingUsd: 90, price: 1 }],
      updatedAt: { liveSummary: (NOW - 60) * 1000, supplyHistory: (NOW - 120) * 1000 },
      sources: { detailCacheUpdatedAt: NOW - 30, publicationUpdatedAt: NOW - 60, supplySnapshotUpdatedAt: NOW - 120, supplySnapshotDate: NOW - DAY },
      freshness: { liveSummary: { status: "fresh", maxAgeSec: 300 } },
    });
    expect(body.entries[0]).not.toHaveProperty("tokens");
    expect(body.entries[0]).not.toHaveProperty("research");
    expect(body.entries[1]).toMatchObject({ id: "usdc-circle", status: "unavailable", reason: "detail-cache-missing" });
    expect(db.getHistory().filter((query) => query.binds[0] === "stablecoins")).toHaveLength(1);
    expect(db.getHistory().filter((query) => query.binds[0] === "snapshot-supply:last-write")).toHaveLength(1);
    expect(db.getHistory().find((query) => query.sql.includes("FROM supply_history"))?.binds).toEqual(["usdt-tether", NOW - 90 * DAY, NOW - DAY]);
    expect(db.getHistory().every((query) => !/INSERT|UPDATE|DELETE/.test(query.sql))).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("retains absolute source clocks when cache reads cross HTTP second boundaries", async () => {
    let tick = 0;
    vi.mocked(Date.now).mockImplementation(() => (NOW + tick++) * 1000);
    const response = await handleDetailSnapshotInputs(makeDb(),
      new URL(API_PATHS.stablecoinDetailSnapshotInputs(["usdt-tether"]), "https://site-api.pharos.watch"));
    expect(await response.json()).toMatchObject({ entries: [{
      status: "available",
      updatedAt: { liveSummary: (NOW - 60) * 1000, supplyHistory: (NOW - 120) * 1000 },
    }] });
  });

  it.each([
    [{ age: DAY }, "detail-cache-too-old"],
    [{ age: -1 }, "detail-cache-invalid-clock"],
    [{ detailBody: "not-json" }, "invalid-cache-input"],
    [{ marker: false }, "supply-marker-missing"],
    [{ publication: false }, "publication-unavailable"],
  ])("reports unavailable cache inputs rather than materializing: %o", async (options, reason) => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const response = await handleDetailSnapshotInputs(makeDb(options), new URL(API_PATHS.stablecoinDetailSnapshotInputs(["usdt-tether"]), "https://site-api.pharos.watch"));
    expect(await response.json()).toMatchObject({ entries: [{ id: "usdt-tether", status: "unavailable", reason }] });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("serves the same stale cache window without scheduling refresh and preserves body provenance", async () => {
    const response = await handleDetailSnapshotInputs(makeDb({ age: 600, detailBody: JSON.stringify({ ...detail, _meta: { updatedAt: NOW - 900 } }) }),
      new URL(API_PATHS.stablecoinDetailSnapshotInputs(["usdt-tether"]), "https://site-api.pharos.watch"));
    expect(await response.json()).toMatchObject({ entries: [{ status: "available", updatedAt: { liveSummary: (NOW - 900) * 1000 }, freshness: { liveSummary: { status: "stale", maxAgeSec: 300 } } }] });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("quarantines oversized projected inputs and accounts for unknown ids", async () => {
    const response = await handleDetailSnapshotInputs(makeDb({ detailBody: JSON.stringify({ ...detail, price: 1, priceSource: "coingecko", consensusSources: ["x".repeat(140_000)] }) }),
      new URL(API_PATHS.stablecoinDetailSnapshotInputs(["usdt-tether", "unknown-coin"]), "https://site-api.pharos.watch"));
    expect(await response.json()).toMatchObject({ entries: [
      { id: "usdt-tether", status: "unavailable", reason: "entry-too-large" },
      { id: "unknown-coin", status: "unavailable", reason: "unknown-id" },
    ] });
  });

  it.each(["", "?ids=", "?ids=usdt-tether,usdt-tether", "?ids=USDT", "?ids=usdt-tether&ids=usdc-circle",
    `?ids=${Array.from({ length: DETAIL_SNAPSHOT_INPUT_BATCH_SIZE + 1 }, (_, i) => `coin-${i}`).join(",")}`,
  ])("rejects malformed or excessive batches before D1 reads: %s", async (query) => {
    const db = makeDb();
    const response = await handleDetailSnapshotInputs(db, new URL(`/api/stablecoin-detail-snapshot-inputs${query}`, "https://site-api.pharos.watch"));
    expect(response.status).toBe(400);
    expect(await response.json()).toHaveProperty("error");
    expect(db.getHistory()).toHaveLength(0);
  });

  it("accepts the batch limit with one explicit entry per id", async () => {
    const ids = Array.from({ length: DETAIL_SNAPSHOT_INPUT_BATCH_SIZE }, (_, i) => `unknown-${i}`);
    const response = await handleDetailSnapshotInputs(makeDb(), new URL(API_PATHS.stablecoinDetailSnapshotInputs(ids), "https://site-api.pharos.watch"));
    const body = DetailSnapshotInputsResponseSchema.parse(await response.json());
    expect(body.entries.map((entry) => entry.id)).toEqual(ids);
  });

  it("denies the Pages path while preserving credentialed internal builds", async () => {
    const path = API_PATHS.stablecoinDetailSnapshotInputs(["usdt-tether"]);
    expect(resolveSiteDataProxyPath(path)).toBeNull();
    expect(PUBLIC_STATIC_ROUTES.some((route) => route.endpoint.key === "stablecoin-detail-snapshot-inputs")).toBe(true);
    const env = createWorkerEnv({ SITE_API_SHARED_SECRET: "site-secret" });
    for (const credential of [undefined, "wrong-secret", "site-secret"]) {
      const request = new Request(`https://site-api.pharos.watch${path}`, { headers: credential ? { "X-Pharos-Site-Proxy-Secret": credential } : {} });
      const result = await evaluateAccessGate(request, new URL(request.url), env);
      if (credential === "site-secret") {
        expect(result.response).toBeNull();
        expect(result.isSiteProxy).toBe(true);
      } else {
        expect(result.response?.status).toBe(401);
      }
    }
    for (const key of [undefined, "otherwise-valid-key"]) {
      const publicRequest = new Request(`https://api.pharos.watch${path}`, { headers: key ? { "X-API-Key": key } : {} });
      expect((await evaluateAccessGate(publicRequest, new URL(publicRequest.url), env)).response?.status).toBe(404);
    }
    const preview = new Request(`https://pharos-api.example.workers.dev${path}`, {
      headers: { "X-Pharos-Site-Proxy-Secret": "site-secret" },
    });
    expect((await evaluateAccessGate(preview, new URL(preview.url), env)).response).toBeNull();
    const post = new Request(`https://site-api.pharos.watch${path}`, { method: "POST", headers: { "X-Pharos-Site-Proxy-Secret": "site-secret" } });
    expect((await evaluateAccessGate(post, new URL(post.url), env)).response?.status).toBe(405);
  });
});
