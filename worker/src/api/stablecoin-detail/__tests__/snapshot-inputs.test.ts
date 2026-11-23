import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockD1 } from "@shared/test-utils/mock-d1";
import { API_PATHS } from "@shared/lib/api-endpoints/paths";
import { resolveSiteDataProxyPath } from "@shared/lib/site-data-lane";
import { DETAIL_SNAPSHOT_INPUT_MAX_BATCH_SIZE as MAX_BATCH, DetailSnapshotInputsResponseSchema as Schema } from "@shared/types/detail-snapshot-inputs";
import { projectStablecoinLiveSummary } from "@shared/lib/stablecoin-live-summary";
import { StablecoinDetailResponseSchema } from "@shared/types/supply";
import { handleDetailSnapshotInputs } from "../snapshot-inputs";
import { handleStablecoinDetail } from "../../stablecoin-detail";
import { evaluateAccessGate } from "../../../handlers/http/gates";
import { createWorkerEnv } from "../../../test-helpers/__shared/worker-env";
import { PUBLIC_STATIC_ROUTES } from "../../../routes/public-routes";
import * as supplyHistoryRows from "../../../lib/supply-history-rows";
import * as detailPrice from "../price";
import { createFreshCacheHitHeaders, createFreshCacheHitResponse } from "../shared";

const NOW = 1_800_000_000, DAY = 86_400, HCLK = NOW - DAY + 90, SITE = "https://site-api.pharos.watch";
const FROZEN = "usr-resolv", D1_ID = "skymoneyusdtsavings-sky", SOL_V2 = "usdv-solomon-v2";
const detail = {
  price: null,
  tokens: [
    { date: NOW - 31 * DAY, totalCirculatingUSD: { peggedUSD: 70 }, totalCirculating: { peggedUSD: 71 } },
    { date: NOW - 8 * DAY, totalCirculatingUSD: { peggedUSD: 80 }, totalCirculating: { peggedUSD: 81 } },
    { date: NOW - DAY, totalCirculatingUSD: { peggedUSD: 90 }, totalCirculating: { peggedUSD: 91 } },
  ],
  research: "never transferred",
};
const PROV = JSON.stringify({ supplySource: "defillama", supplyObservedAt: HCLK, supplyChainGuard: null });
const bulk = (db: D1Database, ids: string[]) => handleDetailSnapshotInputs(db, new URL(API_PATHS.stablecoinDetailSnapshotInputs(ids), SITE));
const bulkJson = async (db: D1Database, ids: string[]) => (await bulk(db, ids)).json();
const makeCoin = (id: string, extra: object = {}) => ({
  id, name: id, symbol: "USD", pegType: "peggedUSD", pegMechanism: "fiat-backed",
  price: 0.997, priceSource: "coingecko", priceConfidence: "high", priceUpdatedAt: NOW - 70,
  priceObservedAt: NOW - 90, priceObservedAtMode: "upstream", priceSyncedAt: NOW - 60,
  circulating: { peggedUSD: 100 }, circulatingPrevDay: { peggedUSD: 99 },
  circulatingPrevWeek: { peggedUSD: 95 }, circulatingPrevMonth: { peggedUSD: 90 },
  chainCirculating: {}, chains: ["Ethereum"], consensusSources: ["coingecko"], agreeSources: ["coingecko"], ...extra,
});
const makeDb = (o: {
  detailBody?: string; detailId?: string; age?: number; marker?: boolean; publication?: boolean;
  healthyUsdc?: boolean; canonical?: object; extraCoins?: object[];
  historyRows?: Record<string, unknown>[]; fallbackRows?: Record<string, unknown>[];
} = {}) => {
  const coins = [makeCoin("usdt-tether", { name: "Tether", symbol: "USDT", ...o.canonical }), ...(o.extraCoins ?? [])];
  const historyRows = o.historyRows ?? [
    { stablecoin_id: o.detailId ?? "usdt-tether", snapshot_date: NOW - DAY, circulating_usd: 90, price: 1, supply_provenance: PROV },
    ...(o.healthyUsdc ? [{ stablecoin_id: "usdc-circle", snapshot_date: NOW - DAY, circulating_usd: 90, price: 1, supply_provenance: PROV }] : []),
  ];
  return mockD1([
    { match: "cache", matchBinds: ["stablecoins"], rows: [], first: o.publication === false ? null : { value: JSON.stringify({ peggedAssets: coins }), updated_at: NOW - 60 } },
    { match: "cache", matchBinds: ["snapshot-supply:last-write"], rows: [], first: o.marker === false ? null : { value: JSON.stringify({ snapshotDate: NOW - DAY }), updated_at: NOW - 120 } },
    { match: "cache", matchBinds: [`detail:${o.detailId ?? "usdt-tether"}`], rows: [], first: { value: o.detailBody ?? JSON.stringify(detail), updated_at: NOW - (o.age ?? 30) } },
    { match: "cache", matchBinds: ["detail:usdc-circle"], rows: [], first: o.healthyUsdc ? { value: JSON.stringify({ price: 1 }), updated_at: NOW - 30 } : null },
    { match: "json_each", rows: historyRows },
    { match: "supply_history", rows: o.fallbackRows ?? [] },
    { match: "cache", rows: [], first: null },
  ]);
};

beforeEach(() => {
  vi.spyOn(Date, "now").mockReturnValue(NOW * 1000);
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Providers forbidden in bulk route"); }));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("cache-only detail snapshot inputs", () => {
  it("projects cache history, batches supply_history, enriches from one publication, and preserves clocks", async () => {
    const db = makeDb({ canonical: { circulatingNative: 98 }, healthyUsdc: true });
    const res = await bulk(db, ["usdt-tether", "usdc-circle", "dai-makerdao"]);
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const body = Schema.parse(await res.json());
    expect(body.entries[0]).toMatchObject({
      id: "usdt-tether", status: "available",
      liveSummary: { price: 0.997, circulating: { peggedUSD: 100 }, circulatingPrevDay: { peggedUSD: 99 },
        circulatingPrevWeek: { peggedUSD: 80 }, circulatingPrevMonth: { peggedUSD: 70 },
        nativeSupply: { current: 98, prevWeek: 81, prevMonth: 71 } },
      supplyHistory: [{ date: NOW - DAY, circulatingUsd: 90, price: 1 }],
      updatedAt: { liveSummary: (NOW - 60) * 1000, supplyHistory: HCLK * 1000 },
      sources: { detailCacheUpdatedAt: NOW - 30, publicationUpdatedAt: NOW - 60, supplySnapshotUpdatedAt: NOW - 120, supplySnapshotDate: NOW - DAY },
      freshness: { liveSummary: { status: "fresh", maxAgeSec: 300 } },
    });
    expect(body.entries[0]).not.toHaveProperty("tokens");
    expect(body.entries[0]).not.toHaveProperty("research");
    expect(body.entries[1]).toMatchObject({ id: "usdc-circle", status: "available" });
    expect(body.entries[2]).toMatchObject({ id: "dai-makerdao", status: "unavailable", reason: "detail-cache-missing" });
    expect(db.getHistory().filter((q) => q.binds[0] === "stablecoins")).toHaveLength(1);
    expect(db.getHistory().filter((q) => q.binds[0] === "snapshot-supply:last-write")).toHaveLength(1);
    const sh = db.getHistory().filter((q) => q.sql.includes("FROM supply_history"));
    expect(sh).toHaveLength(1);
    expect(sh[0]!.binds).toEqual([JSON.stringify(["usdt-tether", "usdc-circle", "dai-makerdao"]), NOW - 90 * DAY, NOW - DAY]);
    expect(db.getHistory().every((q) => !/INSERT|UPDATE|DELETE/.test(q.sql))).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("keeps malformed selected cached checkpoints unavailable and observed zero intact", async () => {
    const tokens = [
      { date: NOW - 60 - 7 * DAY - 1, totalCirculatingUSD: { peggedUSD: 80 }, totalCirculating: { peggedUSD: 81 } },
      { date: NOW - 60 - 7 * DAY, totalCirculatingUSD: { peggedUSD: -1 }, totalCirculating: { peggedUSD: -1 } },
      { date: NOW - 60 - 30 * DAY, totalCirculatingUSD: { peggedUSD: 0 }, totalCirculating: { peggedUSD: 0 } },
    ];
    const body = Schema.parse(await bulkJson(makeDb({ detailBody: JSON.stringify({ ...detail, tokens }), canonical: { circulatingNative: 98 } }), ["usdt-tether"]));
    expect(body).toMatchObject({ entries: [{ id: "usdt-tether", status: "available", liveSummary: {
      circulating: { peggedUSD: 100 }, circulatingPrevDay: { peggedUSD: 99 }, circulatingPrevWeek: {}, circulatingPrevMonth: { peggedUSD: 0 },
      nativeSupply: { current: 98, prevWeek: null, prevMonth: 0 } } }] });
    const entry = body.entries[0];
    if (entry.status !== "available") throw new Error("Expected available");
    expect(entry.liveSummary.circulatingPrevWeek).toEqual({});
    expect(fetch).not.toHaveBeenCalled();
  });

  it("retains absolute source clocks across HTTP second boundaries", async () => {
    let tick = 0;
    vi.mocked(Date.now).mockImplementation(() => (NOW + tick++) * 1000);
    expect(await bulkJson(makeDb(), ["usdt-tether"])).toMatchObject({ entries: [{
      status: "available", updatedAt: { liveSummary: (NOW - 60) * 1000, supplyHistory: HCLK * 1000 },
    }] });
  });

  it.each(["liveSummary", "supplyHistory"] as const)("isolates unproven %s clock without weakening available entries", async (lane) => {
    if (lane === "liveSummary") {
      vi.spyOn(detailPrice, "overlayCanonicalDetailObject").mockResolvedValueOnce({
        ok: true, status: 200, statusText: "", headers: new Headers(), detail: { price: 1 }, mutated: true,
      });
    } else {
      vi.spyOn(supplyHistoryRows, "resolveSupplyHistoryUpdatedAtMs").mockReturnValueOnce(null);
    }
    const body = Schema.parse(await bulkJson(makeDb({ healthyUsdc: true }), ["usdt-tether", "usdc-circle"]));
    expect(body.entries[0]).toMatchObject({ id: "usdt-tether", status: "unavailable", reason: "source-clock-unavailable" });
    expect(body.entries[0]).not.toHaveProperty("freshness");
    expect(body.entries[0]).not.toHaveProperty("updatedAt");
    expect(body.entries[1]).toMatchObject({ id: "usdc-circle", status: "available", updatedAt: { liveSummary: (NOW - 30) * 1000, supplyHistory: HCLK * 1000 } });
    expect(Schema.safeParse({ version: 1, entries: [{ ...body.entries[1], updatedAt: { liveSummary: null, supplyHistory: null } }] }).success).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    [{ age: DAY }, "detail-cache-too-old"], [{ age: -1 }, "detail-cache-invalid-clock"],
    [{ detailBody: "not-json" }, "invalid-cache-input"], [{ marker: false }, "supply-marker-missing"],
    [{ publication: false }, "publication-unavailable"],
  ])("reports unavailable cache inputs: %o", async (options, reason) => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(await bulkJson(makeDb(options), ["usdt-tether"])).toMatchObject({ entries: [{ id: "usdt-tether", status: "unavailable", reason }] });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects pre-cutover VNXAU cache without calling providers", async () => {
    expect(await bulkJson(makeDb({ detailId: "vnxau-vnx" }), ["vnxau-vnx"])).toMatchObject({ entries: [{ id: "vnxau-vnx", status: "unavailable", reason: "invalid-cache-input" }] });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("serves stale cache window without scheduling refresh and preserves body provenance", async () => {
    expect(await bulkJson(makeDb({ age: 600, detailBody: JSON.stringify({ ...detail, _meta: { updatedAt: NOW - 900 } }) }), ["usdt-tether"]))
      .toMatchObject({ entries: [{ status: "available", updatedAt: { liveSummary: (NOW - 900) * 1000 }, freshness: { liveSummary: { status: "stale", maxAgeSec: 300 } } }] });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("quarantines oversized projected inputs and accounts for unknown ids", async () => {
    expect(await bulkJson(makeDb({ canonical: { consensusSources: ["x".repeat(140_000)] } }), ["usdt-tether", "unknown-coin"])).toMatchObject({
      entries: [{ id: "usdt-tether", status: "unavailable", reason: "entry-too-large" }, { id: "unknown-coin", status: "unavailable", reason: "unknown-id" }],
    });
  });

  it("inlines frozen detail-cache-missing coins as history-only (including empty 90d history) and fails closed on missing clock or marker", async () => {
    const db = makeDb({ historyRows: [{ stablecoin_id: FROZEN, snapshot_date: NOW - DAY, circulating_usd: 50, price: 0.2, supply_provenance: PROV }] });
    expect(Schema.parse(await bulkJson(db, [FROZEN])).entries[0]).toMatchObject({
      id: FROZEN, status: "history-only", reason: "detail-cache-missing",
      supplyHistory: [{ date: NOW - DAY, circulatingUsd: 50, price: 0.2 }],
      updatedAt: { supplyHistory: HCLK * 1000 }, freshness: { supplyHistory: { status: "fresh", maxAgeSec: 86_400 } },
    });
    const empty = Schema.parse(await bulkJson(makeDb({ historyRows: [] }), [FROZEN])).entries[0];
    expect(empty).toMatchObject({
      id: FROZEN, status: "history-only", reason: "detail-cache-missing", supplyHistory: [],
      freshness: { supplyHistory: { status: "unknown", reason: "empty-supply-history", maxAgeSec: 86_400 } },
    });
    // toMatchObject treats {} as "any object"; the clockless lane must carry no clock at all.
    expect(empty.status === "history-only" && empty.updatedAt).toEqual({});
    vi.spyOn(supplyHistoryRows, "resolveSupplyHistoryUpdatedAtMs").mockReturnValueOnce(null);
    expect(Schema.parse(await bulkJson(db, [FROZEN])).entries[0]).toMatchObject({
      id: FROZEN, status: "unavailable", reason: "source-clock-unavailable",
    });
    expect(await bulkJson(makeDb({ marker: false }), [FROZEN])).toMatchObject({ entries: [{ id: FROZEN, status: "unavailable", reason: "supply-marker-missing" }] });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("inlines D1-only coingecko active coins with per-coin parity and fails closed without publication", async () => {
    const fb = [{ snapshot_date: NOW - DAY, circulating_usd: 90, circulating_native: 90, price: 1, price_observed_at: NOW - DAY, valuation_price_usd: null, valuation_observed_at_sec: null, supply_provenance: PROV }];
    const historyRows = [D1_ID, SOL_V2].map((id) => ({ stablecoin_id: id, snapshot_date: NOW - DAY, circulating_usd: 90, price: 1, supply_provenance: PROV }));
    const extraCoins = [makeCoin(D1_ID, { circulatingNative: 100 }), makeCoin(SOL_V2, { circulatingNative: 100 })];
    const ctx = { waitUntil: vi.fn() } as unknown as ExecutionContext;
    for (const [id, fallbackRows] of [[D1_ID, fb], [SOL_V2, []]] as const) {
      const db = makeDb({ extraCoins, historyRows, fallbackRows: [...fallbackRows] });
      const body = Schema.parse(await bulkJson(db, [id]));
      const perCoin = await handleStablecoinDetail(db, id, ctx);
      expect(perCoin.status).toBe(200);
      expect(body.entries[0]).toMatchObject({
        id, status: "available", liveSummary: projectStablecoinLiveSummary(StablecoinDetailResponseSchema.parse(await perCoin.json()), id),
        sources: { detailCacheUpdatedAt: null, publicationUpdatedAt: NOW - 60 },
      });
    }
    expect(await bulkJson(makeDb({ publication: false, extraCoins, historyRows }), [D1_ID])).toMatchObject({ entries: [{ id: D1_ID, status: "unavailable", reason: "detail-cache-missing" }] });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("matches overlayCanonicalDetailObject output and headers to overlayCanonicalDetail", async () => {
    const db = makeDb({ canonical: { circulatingNative: 98 } }), raw = JSON.stringify(detail);
    const resp = await detailPrice.overlayCanonicalDetail(db, "usdt-tether", createFreshCacheHitResponse(raw, 30, NOW - 30));
    const obj = await detailPrice.overlayCanonicalDetailObject(db, "usdt-tether", { detail: JSON.parse(raw), status: 200, headers: createFreshCacheHitHeaders(30, NOW - 30) });
    expect(JSON.parse(JSON.stringify(obj.detail))).toEqual(await resp.json());
    expect(obj.headers.get("X-Data-Updated-At")).toBe(resp.headers.get("X-Data-Updated-At"));
    expect(obj.headers.get("Cache-Control")).toBe(resp.headers.get("Cache-Control"));
  });

  it.each(["", "?ids=", "?ids=usdt-tether,usdt-tether", "?ids=USDT", "?ids=usdt-tether&ids=usdc-circle",
    `?ids=${Array.from({ length: MAX_BATCH + 1 }, (_, i) => `coin-${i}`).join(",")}`,
  ])("rejects malformed or excessive batches before D1 reads: %s", async (query) => {
    const db = makeDb();
    const res = await handleDetailSnapshotInputs(db, new URL(`/api/stablecoin-detail-snapshot-inputs${query}`, SITE));
    expect(res.status).toBe(400);
    expect(await res.json()).toHaveProperty("error");
    expect(db.getHistory()).toHaveLength(0);
  });

  it("accepts max batch limit (20) with one explicit entry per id", async () => {
    const ids = Array.from({ length: MAX_BATCH }, (_, i) => `unknown-${i}`);
    expect(Schema.parse(await bulkJson(makeDb(), ids)).entries.map((e) => e.id)).toEqual(ids);
  });

  it("denies the Pages path while preserving credentialed internal builds", async () => {
    const path = API_PATHS.stablecoinDetailSnapshotInputs(["usdt-tether"]);
    expect(resolveSiteDataProxyPath(path)).toBeNull();
    expect(PUBLIC_STATIC_ROUTES.some((r) => r.endpoint.key === "stablecoin-detail-snapshot-inputs")).toBe(true);
    const env = createWorkerEnv({ SITE_API_SHARED_SECRET: "site-secret" });
    for (const c of [undefined, "wrong-secret", "site-secret"]) {
      const req = new Request(`${SITE}${path}`, { headers: c ? { "X-Pharos-Site-Proxy-Secret": c } : {} });
      const r = await evaluateAccessGate(req, new URL(req.url), env);
      if (c === "site-secret") { expect(r.response).toBeNull(); expect(r.isSiteProxy).toBe(true); }
      else expect(r.response?.status).toBe(401);
    }
    for (const k of [undefined, "otherwise-valid-key"]) {
      const req = new Request(`https://api.pharos.watch${path}`, { headers: k ? { "X-API-Key": k } : {} });
      expect((await evaluateAccessGate(req, new URL(req.url), env)).response?.status).toBe(404);
    }
    const prev = new Request(`https://pharos-api.example.workers.dev${path}`, { headers: { "X-Pharos-Site-Proxy-Secret": "site-secret" } });
    expect((await evaluateAccessGate(prev, new URL(prev.url), env)).response).toBeNull();
    const post = new Request(`${SITE}${path}`, { method: "POST", headers: { "X-Pharos-Site-Proxy-Secret": "site-secret" } });
    expect((await evaluateAccessGate(post, new URL(post.url), env)).response?.status).toBe(405);
  });
});
