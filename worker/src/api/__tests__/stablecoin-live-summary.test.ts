import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { API_PATHS, getPublicApiAccess, getSiteDataAccess } from "@shared/lib/api-endpoints";
import { projectStablecoinLiveSummary } from "@shared/lib/stablecoin-live-summary";
import { StablecoinDetailResponseSchema, type StablecoinDetailResponse } from "@shared/types/market";
import { StablecoinLiveSummarySchema } from "@shared/types/stablecoin-live-summary";
import { mockD1 } from "@shared/test-utils/mock-d1";
import { resolveRoute } from "../../router";
import { handleStablecoinDetail } from "../stablecoin-detail";
import { handleStablecoinLiveSummary } from "../stablecoin-live-summary";

vi.mock("../stablecoin-detail", () => ({ handleStablecoinDetail: vi.fn() }));

const NOW = 1_800_000_000;
const DAY = 86_400;
const db = mockD1([]);
const ctx = { waitUntil: vi.fn() } as unknown as ExecutionContext;
const history = [0, 1, 7, 30].map((days) => ({
  date: NOW - days * DAY,
  totalCirculatingUSD: { peggedUSD: 200 - days },
  totalCirculating: { peggedUSD: 100 - days },
}));
const fixtures: { name: string; detail: StablecoinDetailResponse }[] = [
  { name: "NAV", detail: { price: 1.12, priceSource: "protocol-redeem", priceObservedAt: NOW - 120,
    currentCirculatingUSD: { peggedUSD: 224 }, currentSupplyObservedAt: NOW - 600, tokens: history } },
  { name: "non-dollar native supply", detail: { price: 1.18, priceSource: "coingecko",
    priceUpdatedAt: NOW - 120, tokens: history.map((row) => ({ ...row, totalCirculatingUSD: undefined,
      totalCirculating: { peggedEUR: row.totalCirculating.peggedUSD } })) } },
  { name: "commodity", detail: { price: 4_000, priceSource: "coingecko", priceConfidence: "high",
    priceObservedAt: NOW - 90, priceUpdatedAt: NOW - 60, priceSyncedAt: NOW - 30,
    tokens: history.map((row) => ({ ...row, totalCirculatingUSD: { peggedGOLD: row.totalCirculatingUSD.peggedUSD * 4_000 },
      totalCirculating: { peggedGOLD: row.totalCirculating.peggedUSD } })) } },
  { name: "quarantined supply", detail: { price: 1, priceSource: "coingecko", tokens: history,
    currentSupplyUnavailableReason: "supply-chain-dropout", currentCirculatingUSD: {} } },
  { name: "restored supply", detail: { price: 2, priceSource: "coingecko", tokens: history,
    currentCirculatingUSD: { peggedUSD: 400 }, currentSupplyObservedAt: NOW, currentSupplyRestored: true } },
  { name: "missing clocks", detail: { price: null, currentCirculatingUSD: { peggedUSD: 0 } } },
  { name: "nominal reference", detail: { price: 1, priceSource: "protocol-par", priceObservedAtMode: "nominal_reference",
    nominalPriceReference: { price: 1, source: "protocol-par", mode: "nominal_reference" }, tokens: history } },
];

beforeEach(() => {
  vi.spyOn(Date, "now").mockReturnValue(NOW * 1000);
  vi.mocked(handleStablecoinDetail).mockReset();
});
afterEach(() => vi.restoreAllMocks());

function detailResponse(detail: StablecoinDetailResponse, headers: Record<string, string> = {}) {
  return Response.json(detail, { headers: {
    "Cache-Control": "public, max-age=10, s-maxage=240",
    "X-Data-Updated-At": String(NOW - 60), "X-Data-Age": "60", ...headers,
  } });
}

describe("site-only stablecoin live summary", () => {
  it.each(fixtures)("matches the shared client projector for $name without history transport", async ({ detail }) => {
    const full = detailResponse(detail);
    full.headers.set("Content-Length", "190575");
    vi.mocked(handleStablecoinDetail).mockResolvedValue(full);
    const response = await handleStablecoinLiveSummary(db, "usdt-tether", ctx, "provider-key");
    const text = await response.text();
    const { _meta, ...summary } = JSON.parse(text);
    expect(summary).toEqual(JSON.parse(JSON.stringify(projectStablecoinLiveSummary(StablecoinDetailResponseSchema.parse(detail)))));
    expect(StablecoinLiveSummarySchema.safeParse(summary).success).toBe(true);
    expect(summary).not.toHaveProperty("tokens");
    expect(new TextEncoder().encode(text).length).toBeLessThan(2_048);
    expect(_meta).toMatchObject({ updatedAt: NOW - 60, ageSeconds: 60, status: "fresh",
      freshBudgetSec: 4_800, degradedBudgetSec: 7_200 });
    expect(response.headers.get("X-Data-Updated-At")).toBe(String(NOW - 60));
    expect(response.headers.get("Cache-Control")).toBe("public, max-age=10, s-maxage=240");
    expect(response.headers.get("Content-Length")).toBeNull();
    expect(handleStablecoinDetail).toHaveBeenCalledExactlyOnceWith(db, "usdt-tether", ctx, "provider-key");
  });

  it.each([-1, NaN, Infinity, Number.MAX_VALUE])("withholds malformed selected checkpoints (%s), without older-row rescue", (value) => {
    const buckets = { peggedUSD: value, peggedEUR: value };
    const tokens = [0, 1, 7, 30].flatMap((days) => [
      { date: NOW - days * DAY - 1, totalCirculatingUSD: { peggedUSD: 50 }, totalCirculating: { peggedUSD: 25 } },
      { date: NOW - days * DAY, totalCirculatingUSD: buckets, totalCirculating: buckets },
    ]);
    const summary = projectStablecoinLiveSummary({ price: 2, priceSource: "coingecko", tokens });
    expect([summary.circulating, summary.circulatingPrevDay, summary.circulatingPrevWeek, summary.circulatingPrevMonth])
      .toEqual([{}, {}, {}, {}]);
    expect(summary).toMatchObject({
      circulating: {}, circulatingPrevDay: {}, circulatingPrevWeek: {}, circulatingPrevMonth: {},
      nativeSupply: { current: null, prevWeek: null, prevMonth: null },
    });
    const canonical = projectStablecoinLiveSummary({
      price: 2, priceSource: "coingecko", tokens,
      currentCirculatingUSD: { peggedUSD: 100 }, currentSupplyObservedAt: NOW,
      currentCirculatingPrevDayUSD: buckets,
    });
    expect([canonical.circulatingPrevDay, canonical.circulatingPrevWeek, canonical.circulatingPrevMonth]).toEqual([{}, {}, {}]);
    expect(canonical).toMatchObject({
      circulating: { peggedUSD: 100 }, circulatingPrevDay: {}, circulatingPrevWeek: {}, circulatingPrevMonth: {},
      nativeSupply: { current: 50, prevWeek: null, prevMonth: null },
    });
  });

  it("preserves measured zero at every selected checkpoint, including legacy previous-day supply", () => {
    const tokens = [0, 1, 7, 30].map((days) => ({
      date: NOW - days * DAY, totalCirculatingUSD: { peggedUSD: 0 }, totalCirculating: { peggedUSD: 0 },
    }));
    const expected = {
      circulating: { peggedUSD: 0 }, circulatingPrevDay: { peggedUSD: 0 },
      circulatingPrevWeek: { peggedUSD: 0 }, circulatingPrevMonth: { peggedUSD: 0 },
      nativeSupply: { current: 0, prevWeek: 0, prevMonth: 0 },
    };
    expect(projectStablecoinLiveSummary({ tokens })).toMatchObject(expected);
    expect(projectStablecoinLiveSummary({
      tokens, price: 2, priceSource: "coingecko", currentCirculatingUSD: { peggedUSD: 0 },
      currentSupplyObservedAt: NOW, currentCirculatingPrevDayUSD: { peggedUSD: 0 },
    })).toMatchObject(expected);
  });

  it("rejects negative and non-finite USD/native output checkpoints while admitting zero and unavailable values", () => {
    const summary = projectStablecoinLiveSummary({});
    for (const value of [-1, NaN, Infinity, -Infinity]) {
      for (const field of ["circulating", "circulatingPrevDay", "circulatingPrevWeek", "circulatingPrevMonth"]) {
        expect(StablecoinLiveSummarySchema.safeParse({ ...summary, [field]: { peggedUSD: value } }).success).toBe(false);
      }
      for (const field of ["current", "prevWeek", "prevMonth"]) {
        expect(StablecoinLiveSummarySchema.safeParse({
          ...summary, nativeSupply: { ...summary.nativeSupply, [field]: value },
        }).success).toBe(false);
      }
    }
    expect(StablecoinLiveSummarySchema.safeParse(summary).success).toBe(true);
    expect(StablecoinLiveSummarySchema.safeParse({
      ...summary, circulating: { peggedUSD: 0 }, circulatingPrevDay: { peggedUSD: 0 },
      circulatingPrevWeek: { peggedUSD: 0 }, circulatingPrevMonth: { peggedUSD: 0 },
      nativeSupply: { current: 0, prevWeek: 0, prevMonth: 0 },
    }).success).toBe(true);
  });

  it("serves unavailable historical USD supply instead of negative live-summary values", async () => {
    vi.mocked(handleStablecoinDetail).mockResolvedValue(detailResponse({
      currentCirculatingUSD: { peggedUSD: 100 }, currentSupplyObservedAt: NOW,
      currentCirculatingPrevDayUSD: { peggedUSD: -1 },
      tokens: [{ date: NOW - 7 * DAY, totalCirculatingUSD: { peggedUSD: -1 } }],
    }));
    const response = await handleStablecoinLiveSummary(db, "usdt-tether", ctx);
    expect(response.status).toBe(200);
    const summary = await response.json() as Record<string, unknown>;
    expect(summary.circulating).toEqual({ peggedUSD: 100 });
    expect([summary.circulatingPrevDay, summary.circulatingPrevWeek, summary.circulatingPrevMonth]).toEqual([{}, {}, {}]);
  });

  it("preserves settled failed-refresh warnings even for a recently produced generation", async () => {
    vi.mocked(handleStablecoinDetail).mockResolvedValue(detailResponse({}, {
      "Cache-Control": "no-store", "X-Data-Freshness": "stale", Warning: '110 - "Detail refresh failed"',
    }));
    const response = await handleStablecoinLiveSummary(db, "usdt-tether", ctx);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toMatchObject({ _meta: { updatedAt: NOW - 60, status: "stale",
      warning: '110 - "Detail refresh failed"' } });
  });

  it.each([null, "bad-clock", "0"])("does not manufacture a producer timestamp from %s", async (clock) => {
    const full = detailResponse({});
    if (clock === null) full.headers.delete("X-Data-Updated-At");
    else full.headers.set("X-Data-Updated-At", clock);
    vi.mocked(handleStablecoinDetail).mockResolvedValue(full);
    const response = await handleStablecoinLiveSummary(db, "usdt-tether", ctx);
    expect(await response.json()).toMatchObject({ _meta: { updatedAt: null, ageSeconds: null, status: "unknown",
      reason: "producer-timestamp-unavailable" } });
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("retains body producer provenance ahead of newer HTTP clocks", async () => {
    const originalMeta = { updatedAt: NOW - 8_000, ageSeconds: 8_000, status: "stale",
      assessedAt: NOW, freshBudgetSec: 4_800, degradedBudgetSec: 7_200 };
    vi.mocked(handleStablecoinDetail).mockResolvedValue(detailResponse({ _meta: originalMeta }, { "Cache-Control": "no-store" }));
    const response = await handleStablecoinLiveSummary(db, "usdt-tether", ctx);
    expect(await response.json()).toMatchObject({ _meta: originalMeta });
  });

  it("passes through inactive/missing/provider failures, never a successful empty summary", async () => {
    const unavailable = Response.json({ error: "Detail unavailable" }, { status: 404 });
    vi.mocked(handleStablecoinDetail).mockResolvedValue(unavailable);
    expect(await handleStablecoinLiveSummary(db, "bfusd-binance", ctx)).toBe(unavailable);
  });

  it("fails closed on invalid detail data", async () => {
    vi.mocked(handleStablecoinDetail).mockResolvedValue(Response.json({ price: "invalid" }));
    const response = await handleStablecoinLiveSummary(db, "usdt-tether", ctx);
    expect(response.status).toBe(502);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("fails closed on malformed detail JSON", async () => {
    vi.mocked(handleStablecoinDetail).mockResolvedValue(new Response("{"));
    const response = await handleStablecoinLiveSummary(db, "usdt-tether", ctx);
    expect(response.status).toBe(502);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("registers only the credentialed website read, with canonical path and GET gating", () => {
    const path = API_PATHS.stablecoinLiveSummary("usdt-tether");
    expect(getPublicApiAccess(path)).toBe("site-only");
    expect(getSiteDataAccess(path)).toBe("allowed");
    const resolved = resolveRoute(new URL(`https://site-api.pharos.watch${path}`), "GET");
    expect(resolved?.routeMatch).toMatchObject({ methods: ["GET"], dependencies: ["coingeckoApiKey"] });
    expect(resolveRoute(new URL(`https://site-api.pharos.watch${path}`), "POST")?.methodValidation).toMatchObject({ allowedMethods: ["GET"] });
  });
});
