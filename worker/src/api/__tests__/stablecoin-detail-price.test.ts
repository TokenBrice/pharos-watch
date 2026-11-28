import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockD1 } from "@shared/test-utils/mock-d1";
import { API_FRESHNESS_MAX_AGE_SEC } from "@shared/lib/api-freshness";
import { overlayCanonicalDetail } from "../stablecoin-detail/price";
import { projectStablecoinLiveSummary } from "@shared/lib/stablecoin-live-summary";
import { StablecoinDetailResponseSchema } from "@shared/types/supply";
import { handleStablecoinDetail, resetStablecoinDetailStateForTests } from "../stablecoin-detail";
import { routeStablecoinDetail } from "../stablecoin-detail/router";
import { handleStablecoinLiveSummary } from "../stablecoin-live-summary";
import { publishDetailCacheGeneration } from "../../lib/detail-cache-generation";
import { makeExecutionContext as makeCtx } from "../../test-helpers/__shared/auth";

vi.mock("../stablecoin-detail/router", () => ({ routeStablecoinDetail: vi.fn() }));
vi.mock("../../lib/detail-cache-generation", () => ({
  claimDetailCacheGeneration: vi.fn().mockResolvedValue({ generation: 1 }),
  publishDetailCacheGeneration: vi.fn().mockResolvedValue({ written: true }),
}));

const NOW = 1_800_000_000;
const tokens = [{ date: NOW - 86_400, totalCirculatingUSD: { peggedUSD: 123.456 }, totalCirculating: { peggedUSD: 121.001 }, circulating: { peggedUSD: 120.5 } }];
const detailBody = JSON.stringify({ tokens, providerField: "preserved" });

function canonicalCoin(overrides: Record<string, unknown> = {}) {
  return {
    id: "usdt-tether", name: "Tether", symbol: "USDT", pegType: "peggedUSD", pegMechanism: "fiat-backed",
    price: 0.997, priceSource: "coingecko+defillama-list", priceConfidence: "high",
    priceUpdatedAt: NOW - 70, priceObservedAt: NOW - 90, priceObservedAtMode: "upstream",
    priceSyncedAt: NOW - 60, consensusSources: ["coingecko", "defillama-list"], agreeSources: ["coingecko"],
    circulating: {}, chainCirculating: {}, chains: ["Ethereum"],
    ...overrides,
  };
}

function makeDb(overrides: Record<string, unknown> = {}, updatedAt = NOW - 60, detailAge?: number) {
  return mockD1([
    { match: "cache", matchBinds: ["stablecoins"], rows: [], first: {
      value: JSON.stringify({ peggedAssets: [canonicalCoin(overrides)] }), updated_at: updatedAt,
    } },
    { match: "cache", rows: [], first: detailAge == null ? null : { value: detailBody, updated_at: NOW - detailAge } },
  ]);
}

function makeResponse(body = detailBody) {
  return new Response(body, { headers: { "Content-Type": "application/json", "Cache-Control": "public, s-maxage=300, max-age=10" } });
}
const ov = (db: D1Database, id = "usdt-tether", res = makeResponse()) => overlayCanonicalDetail(db, id, res);
const ovJson = async (db: D1Database, id = "usdt-tether", res = makeResponse()) => (await ov(db, id, res)).json() as Promise<Record<string, unknown>>;
const resOf = (o: unknown) => makeResponse(JSON.stringify(o));
const eurcNative = { supplySource: "onchain-circulating-supply", supplyObservedAt: NOW - 60 };
const proj = (body: unknown, id = "", now = NOW) => projectStablecoinLiveSummary(StablecoinDetailResponseSchema.parse(body), id, now);

beforeEach(() => {
  vi.spyOn(Date, "now").mockReturnValue(NOW * 1000);
  resetStablecoinDetailStateForTests();
  vi.mocked(routeStablecoinDetail).mockReset();
  vi.mocked(publishDetailCacheGeneration).mockClear();
});
afterEach(() => vi.restoreAllMocks());

describe("missing detail price enrichment", () => {
  it.each([undefined, null, 0])("distinguishes an omitted canonical USD quantity from %s through overlay and summary", async (native) => {
    const detail = StablecoinDetailResponseSchema.parse(await ovJson(makeDb({ circulating: { peggedUSD: native === 0 ? 0 : 1001 }, price: 1.001, circulatingNative: native }),
      "usdt-tether", resOf({ tokens, currentCirculatingNative: 5 })));
    expect(detail.currentCirculatingNative).toBe(native);
    const projected = projectStablecoinLiveSummary(detail).nativeSupply.current;
    if (native === undefined) expect(projected).toBeCloseTo(1000);
    else expect(projected).toBe(native);
  });

  it.each([200_000, 0, null, undefined])("overlays the dated PAXG baseline (%s) through the compact and legacy fields", async (dated) => {
    const amount = (circulatingUsd: number) => ({ day: { observedAt: NOW - 86_400, circulatingUsd, circulatingNative: null } });
    const map = dated === undefined ? undefined : dated === null ? {} : amount(dated);
    const detail = StablecoinDetailResponseSchema.parse(await ovJson(makeDb({ id: "paxg-pax-gold", pegType: "peggedGOLD", circulating: { peggedGOLD: 210_000 }, circulatingPrevDay: { peggedGOLD: 195_000 }, supplyChangeBaselines: map }),
      "paxg-pax-gold", resOf({ tokens, supplyChangeBaselines: amount(123) })));
    expect(detail.currentCirculatingPrevDayUSD).toEqual(dated === null ? {} : { peggedGOLD: dated ?? 195_000 });
    expect(detail.currentCirculatingNative).toBeUndefined();
    expect(projectStablecoinLiveSummary(detail).nativeSupply.current).toBeCloseTo(210_000 / 0.997);
    expect(detail.supplyChangeBaselines).toEqual(map);
    expect(projectStablecoinLiveSummary(detail).supplyChangeBaselines).toEqual(map);
  });

  it("uses canonical non-USD week and month buckets when dated windows are omitted", async () => {
    const history = [7, 30].map((days) => ({ date: NOW - days * 86_400 - 60, totalCirculatingUSD: { peggedEUR: 110 } }));
    const summary = proj(await ovJson(makeDb({ id: "eurc-circle", pegType: "peggedEUR", circulating: { peggedEUR: 110 }, ...eurcNative, circulatingPrevWeek: { peggedEUR: 100 }, supplyChangeBaselines: { day: null } }),
      "eurc-circle", resOf({ tokens: history })), "eurc-circle");
    expect([summary.circulatingPrevWeek, summary.circulatingPrevMonth]).toEqual([{ peggedEUR: 100 }, {}]);
  });

  it("keeps preferred withheld supply unavailable through detail and summary without a published reason", async () => {
    const history = [0, 1, 7, 30].map((days) => ({ date: NOW - days * 86_400, totalCirculatingUSD: { peggedUSD: 900_000 }, totalCirculating: { peggedUSD: 800_000 } }));
    const body = await ovJson(makeDb({ id: "usyc-hashnote", circulating: {}, supplySource: "onchain-supply-withheld", price: 1.12 }),
      "usyc-hashnote", resOf({
        tokens: history, currentCirculatingUSD: { peggedUSD: 900_000 }, currentCirculatingPrevDayUSD: { peggedUSD: 890_000 },
        currentSupplyObservedAt: NOW - 60, currentSupplyRestored: true,
      }));
    expect(body.currentCirculatingUSD).toEqual({});
    expect(body.currentCirculatingPrevDayUSD).toBeUndefined();
    expect(body.currentSupplyObservedAt).toBeUndefined();
    expect(body.currentSupplyRestored).toBeUndefined();
    expect(body.currentSupplyUnavailableReason).toBeUndefined();
    expect(body.tokens).toEqual(history);
    const summary = proj(body);
    expect(summary.circulating).toEqual({});
    expect(summary.circulatingPrevDay).toEqual({});
    expect(summary.circulatingPrevWeek).toEqual({});
    expect(summary.circulatingPrevMonth).toEqual({});
    expect(summary).toMatchObject({ price: 1.12, supplyObservedAt: null, nativeSupply: { current: null, prevWeek: null, prevMonth: null } });
  });

  it("preserves the economic-float refusal through detail and summary despite positive provider overlays/history", async () => {
    const body = await ovJson(makeDb({ id: "sfrax-frax", circulating: {}, supplySource: "onchain-supply-withheld", supplyUnavailableReason: "economic-float-unreconciled" }),
      "sfrax-frax", resOf({
        tokens, currentCirculatingUSD: { peggedUSD: 64_000_000 }, currentCirculatingPrevDayUSD: { peggedUSD: 63_000_000 },
        currentSupplyObservedAt: NOW - 60, currentSupplyRestored: true,
      }));
    expect(body.currentSupplyUnavailableReason).toBe("economic-float-unreconciled");
    expect(body.currentCirculatingUSD).toBeUndefined();
    expect(body.currentCirculatingPrevDayUSD).toBeUndefined();
    expect(body.currentSupplyObservedAt).toBeUndefined();
    expect(body).not.toHaveProperty("currentSupplyRestored");
    expect(body.tokens).toEqual(tokens);
    const summary = proj(body);
    expect(summary.circulating).toEqual({});
    expect(summary.nativeSupply.current).toBeNull();
    expect(summary.supplyObservedAt).toBeNull();
  });

  it("publishes admitted current list supply without rewriting the older native history", async () => {
    const nativeHistory = [{ date: NOW - 86_400, totalCirculating: { peggedUSD: 454_459_687.73 } }];
    const body = await ovJson(makeDb({ circulating: { peggedUSD: 477_309_888.38 }, circulatingPrevDay: {} }),
      "usdt-tether", resOf({ tokens: nativeHistory, price: null }));
    expect(body.currentCirculatingUSD).toEqual({ peggedUSD: 477_309_888.38 });
    expect(body.currentCirculatingPrevDayUSD).toEqual({});
    expect(body.currentSupplyObservedAt).toBe(NOW - 60);
    expect(body.tokens).toEqual(nativeHistory);
    expect(body.price).toBe(0.997);
  });

  it.each([true, false])("carries only canonical supply restoration provenance (%s)", async (restored) => {
    const observedAt = NOW - 3 * 86_400;
    const body = await ovJson(makeDb({ circulating: { peggedUSD: 100 }, supplyObservedAt: observedAt, supplyRestored: restored }),
      "usdt-tether", resOf({ tokens, currentSupplyRestored: !restored }));
    expect(body.currentSupplyRestored).toBe(restored);
    expect(body.currentSupplyObservedAt).toBe(observedAt);
    expect(body.tokens).toEqual(tokens);
  });

  it("does not accept a provider restoration marker without an admitted canonical overlay", async () => {
    expect(await ovJson(makeDb({ price: null }), "usdt-tether", resOf({ tokens, currentSupplyRestored: true }))).toEqual({ tokens });
  });

  it("publishes observed zero supply independently of withheld price", async () => {
    const body = await ovJson(makeDb({ circulating: { peggedUSD: 0 }, price: null }));
    expect(body.currentCirculatingUSD).toEqual({ peggedUSD: 0 });
    expect(body.price).toBeUndefined();
  });

  it("overlays current supply and price over a provider quote and bounds stale reuse", async () => {
    const result = await ov(makeDb({ circulating: { peggedUSD: 477_309_888.38 }, supplyObservedAt: NOW - 7000 }, NOW - 6000),
      "usdt-tether", resOf({ tokens, price: 0.98 }));
    const body = await result.json() as Record<string, unknown>;
    expect(body.currentCirculatingUSD).toEqual({ peggedUSD: 477_309_888.38 });
    expect(body.currentSupplyObservedAt).toBe(NOW - 7000);
    expect(body.price).toBe(0.997);
    expect(body.tokens).toEqual(tokens);
    expect(result.headers.get("Cache-Control")).toBe("no-store");
    expect(result.headers.get("Warning")).toContain("Response is stale");
  });

  it.each([undefined, 0.98])("forwards a nominal reference beside provider price %s without inventing an observation", async (price) => {
    const nominalPriceReference = { price: 1, source: "protocol-par", mode: "nominal_reference" };
    expect(await ovJson(makeDb({ price: 1, priceSource: "protocol-par", priceObservedAtMode: "nominal_reference", nominalPriceReference }),
      "usdt-tether", resOf({ tokens, providerField: "preserved", price }))).toEqual({ tokens, providerField: "preserved", price, nominalPriceReference });
  });

  it.each([
    [undefined, {}], [null, {}], [0, {}], [-1, {}], ["1", {}], [1.0132, { priceConfidence: "low" }],
    [1.0132, { priceSource: "cached", priceConfidence: "fallback" }],
  ])("replaces provider price %s with the published %j quote without changing history or supply", async (price, overrides) => {
    const response = resOf({ tokens, price, nominalPriceReference: { price: 42 } });
    const result = await ov(makeDb(overrides), "usdt-tether", response);
    expect(result.status).toBe(200);
    expect(result.headers.get("Cache-Control")).toBe(response.headers.get("Cache-Control"));
    expect(await result.json()).toEqual({
      tokens, price: 0.997, priceSource: "coingecko+defillama-list", priceConfidence: "high",
      priceUpdatedAt: NOW - 70, priceObservedAt: NOW - 90, priceObservedAtMode: "upstream",
      priceSyncedAt: NOW - 60, consensusSources: ["coingecko", "defillama-list"], agreeSources: ["coingecko"], ...overrides,
    });
  });

  it("carries the canonical parent derivation only with the overlaid canonical quote (K-207)", async () => {
    const priceDerivation = {
      inheritedFrom: "pathusd-bridge", parentSource: "coingecko", parentConfidence: "single-source",
      parentObservedAt: NOW - 90, parentObservedAtMode: "upstream", parentReplaySafe: true, navMethod: "convertToAssets",
    };
    const overlaidBody = StablecoinDetailResponseSchema.parse(await ovJson(makeDb({ priceSource: "coingecko", priceConfidence: "single-source", priceDerivation })));
    expect(overlaidBody).toMatchObject({ price: 0.997, priceSource: "coingecko", priceDerivation });
    expect(projectStablecoinLiveSummary(overlaidBody).priceDerivation).toEqual(priceDerivation);
    expect(await ovJson(makeDb({ price: null, priceDerivation }), "usdt-tether", resOf({ tokens, price: 0.98, priceDerivation }))).toEqual({ tokens, price: 0.98 });
  });

  it("drops derivation from a live summary whose price is not an observation", () => {
    const summary = projectStablecoinLiveSummary({
      tokens, price: 1, priceSource: "protocol-par", priceObservedAtMode: "nominal_reference",
      priceDerivation: { inheritedFrom: "x", parentSource: null, parentConfidence: null, parentObservedAt: null, parentObservedAtMode: null, parentReplaySafe: false },
    });
    expect(summary).not.toHaveProperty("priceDerivation");
  });

  it.each([
    { price: null }, { price: 0 }, { price: -1 }, { price: "1" }, { frozen: true }, { id: "usdc-circle" },
  ])("leaves the original response unchanged for unusable canonical data %j", async (overrides) => {
    const response = makeResponse();
    expect(await ov(makeDb(overrides), "usdt-tether", response)).toBe(response);
    expect(await response.text()).toBe(detailBody);
  });

  it.each([NOW + 1, Number.NaN])("rejects future/invalid publication %s", async (updatedAt) => {
    const response = makeResponse();
    expect(await ov(makeDb({}, updatedAt), "usdt-tether", response)).toBe(response);
  });

  it.each([[undefined, NOW - 70], [null, null]] as const)(
    "accepts a fresh single-source quote and projects the observation timestamp from %s",
    async (observedAt, expected) => {
      const result = await ov(makeDb({ priceConfidence: "single-source", priceObservedAt: observedAt }));
      expect(await result.json()).toMatchObject({ price: 0.997, priceConfidence: "single-source", priceObservedAt: expected });
    },
  );

  it.each([null, "{bad-json", JSON.stringify({ peggedAssets: [] })])("fails closed for missing/corrupt/empty cache %s", async (value) => {
    const db = mockD1([{ match: "cache", rows: [], first: value == null ? null : { value, updated_at: NOW } }]);
    const response = makeResponse();
    expect(await ov(db, "usdt-tether", response)).toBe(response);
    expect(response.bodyUsed).toBe(false);
  });

  it("keeps a successful historical response when the canonical read fails", async () => {
    const db = mockD1([{ match: "cache", rows: [], throwError: new Error("unavailable") }]);
    const response = makeResponse();
    expect(await ov(db, "usdt-tether", response)).toBe(response);
    expect(await response.text()).toBe(detailBody);
  });

  it("also bounds TTL by canonical publication freshness", async () => {
    const result = await ov(makeDb({}, NOW - API_FRESHNESS_MAX_AGE_SEC.stablecoins + 4));
    expect(result.headers.get("Cache-Control")).toBe("public, s-maxage=4, max-age=4");
  });

  it.each([30, 90])("preserves the older real detail/publication clock (detail age %s)", async (age) => {
    const response = makeResponse();
    response.headers.set("X-Data-Updated-At", String(NOW - age));
    response.headers.set("X-Data-Age", "999");
    expect((await ov(makeDb(), "usdt-tether", response)).headers.get("X-Data-Updated-At")).toBe(String(NOW - Math.max(age, 60)));
  });

  it("does not invent an origin clock for a legacy response without one", async () => {
    expect((await ov(makeDb())).headers.has("X-Data-Updated-At")).toBe(false);
  });

  it.each(["", ".5", "5.", "1..2", "0x10", "1e3"])("does not repair a malformed origin header (%s)", async (sourceClock) => {
    const response = makeResponse();
    response.headers.set("X-Data-Updated-At", sourceClock);
    expect((await ov(makeDb(), "usdt-tether", response)).headers.get("X-Data-Updated-At")).toBe(sourceClock);
  });

  it("keeps a stale published quote visible while warning and disabling reuse", async () => {
    const result = await ov(makeDb({}, NOW - 6000));
    expect(await result.json()).toMatchObject({ price: 0.997 });
    expect(result.headers.get("Cache-Control")).toBe("no-store");
    expect(result.headers.get("Warning")).toContain("Response is stale");
    expect(result.headers.get("X-Data-Age")).toBe("6000");
  });

  it("preserves errors without querying or consuming them", async () => {
    const response = new Response("unavailable", { status: 503 });
    expect(await ov(mockD1([]), "usdt-tether", response)).toBe(response);
    expect(response.bodyUsed).toBe(false);
  });

  it.each(["{invalid", "null", "[]"])("preserves a successful unusable detail body %s", async (body) => {
    const result = await ov(mockD1([]), "usdt-tether", makeResponse(body));
    expect(result.status).toBe(200);
    expect(result.bodyUsed).toBe(false);
    expect(await result.text()).toBe(body);
  });

  it("removes obsolete entity length without clearing an existing stale policy", async () => {
    const response = new Response(detailBody, { headers: {
      "Content-Length": String(new TextEncoder().encode(detailBody).length),
      "Cache-Control": "no-store", Warning: '110 - "Historical detail is stale"',
    } });
    const result = await ov(makeDb(), "usdt-tether", response);
    expect(result.headers.has("Content-Length")).toBe(false);
    expect(result.headers.get("Cache-Control")).toBe("no-store");
    expect(result.headers.get("Warning")).toBe('110 - "Historical detail is stale"');
    expect(await result.json()).toMatchObject({ price: 0.997, tokens, providerField: "preserved" });
  });

  describe("expired supply-chain-dropout quarantine", () => {
    const quarantinedSince = NOW - 8 * 86_400;
    const expiredQuarantine = { circulating: {}, supplyRestored: true, supplyObservedAt: quarantinedSince, supplySource: "defillama",
      supplyChainGuard: { reason: "supply-chain-dropout", status: "unavailable", quarantinedSince, chains: [{ chainId: "xlayer", chainLabel: "X Layer",
        listCurrentUsd: 0, baselineUsd: 1_427_900_000, baselineObservedAt: quarantinedSince, baselineSource: "state", resolution: "unavailable" }] } };

    it("keeps current supply unavailable through detail and projection despite positive provider history", async () => {
      const body = await ovJson(makeDb(expiredQuarantine));
      expect(body.currentSupplyUnavailableReason).toBe("supply-chain-dropout");
      expect(body.currentCirculatingUSD).toBeUndefined();
      expect(body.tokens).toEqual(tokens);
      const summary = proj(body);
      expect(summary.circulating).toEqual({});
      expect(summary.supplyRestored).toBe(true);
      expect(summary.supplyObservedAt).toBeNull();
      expect(summary.nativeSupply.current).toBeNull();
    });

    it("names excluded chains for partial coverage and ignores provider-supplied copies", async () => {
      const partial = {
        circulating: { peggedUSD: 97_500_000 }, supplyObservedAt: NOW - 60, supplySource: "defillama",
        supplyChainGuard: { ...expiredQuarantine.supplyChainGuard, status: "chains-unavailable", partialCoverage: true, chains: [{
          chainId: "hyperevm", chainLabel: "HyperEVM", listCurrentUsd: null, baselineUsd: 3_749_116,
          baselineObservedAt: quarantinedSince, baselineSource: "state", resolution: "unavailable",
        }] },
      };
      const body = await ovJson(makeDb(partial));
      expect(body.currentSupplyExcludedChains).toEqual(["HyperEVM"]);
      expect(body.currentSupplyRestored).toBe(false);
      const summary = proj(body);
      expect(summary).toMatchObject({ circulating: { peggedUSD: 97_500_000 }, supplyExcludedChains: ["HyperEVM"] });
      expect(summary.supplyRestored).toBeUndefined();
      const forgedBody = await ovJson(makeDb({ circulating: { peggedUSD: 100 } }), "usdt-tether",
        resOf({ tokens, currentSupplyExcludedChains: ["Ethereum"], currentSupplySource: "onchain-total-supply" }));
      expect(forgedBody).not.toHaveProperty("currentSupplyExcludedChains");
      expect(forgedBody).not.toHaveProperty("currentSupplySource");
      expect(await ovJson(makeDb({ circulating: { peggedUSD: 100 }, supplySource: "onchain-circulating-supply" }),
        "usdt-tether", resOf({ tokens, currentSupplySource: "defillama" }))).toMatchObject({ currentSupplySource: "onchain-circulating-supply" });
    });

    it("keeps withheld XAUT, JLTXX and reviewed native supply unavailable in detail and live summary despite provider history", async () => {
      const expectUnavailable = (body: Record<string, unknown>, id: string) => {
        expect({ usd: body.currentCirculatingUSD, native: body.currentCirculatingNative }).toEqual({ usd: {}, native: null });
        const s = proj(body, id);
        expect({ circ: s.circulating, clock: s.supplyObservedAt, native: s.nativeSupply.current }).toEqual({ circ: {}, clock: null, native: null });
      };
      const xautTokens = [{ date: NOW - 3600, totalCirculating: { peggedGOLD: 811_000 }, totalCirculatingUSD: { peggedGOLD: 2_823_700_000 } }];
      expectUnavailable(await ovJson(makeDb({ id: "xaut-tether", pegType: "peggedGOLD", circulating: {}, supplySource: "onchain-supply-withheld", price: 3_500 }), "xaut-tether", resOf({ tokens: xautTokens })), "xaut-tether");
      const hist = JSON.stringify({ tokens: [{ date: NOW - 3600, totalCirculating: { peggedUSD: 1_234_567 }, totalCirculatingUSD: { peggedUSD: 1_234_567 } }] });
      const validJ = {
        id: "jltxx-jpmorgan", circulating: { peggedUSD: 100_000 }, circulatingNative: 100_000, valuationPriceUsd: 1, price: 1,
        supplySource: "onchain-total-supply", supplyObservedAt: NOW - 60,
        chainCirculating: { Ethereum: { chainId: "ethereum", current: 10_000 }, Solana: { chainId: "solana", current: 90_000 } },
      };
      const validTbill = {
        id: "tbill-openeden", circulating: { peggedUSD: 285_000 }, circulatingNative: 244_000, supplySource: "onchain-circulating-supply",
        supplyObservedAt: NOW - 60, price: 1.16,
        chainCirculating: {
          Ethereum: { chainId: "ethereum", current: 30_000 }, Arbitrum: { chainId: "arbitrum", current: 0 },
          Solana: { chainId: "solana", current: 0 }, "XRP Ledger": { chainId: "xrpl", current: 5_000 }, BSC: { chainId: "bsc", current: 250_000 },
        },
      };
      for (const db of [
        makeDb({ id: "jltxx-jpmorgan", circulating: {}, supplySource: "onchain-supply-withheld", price: 1 }),
        makeDb({ id: "usdt-tether", circulating: { peggedUSD: 100 } }),
        makeDb({ ...validJ, chainCirculating: { Ethereum: { chainId: "ethereum", current: 100_000 } } }),
        makeDb({ ...validJ, chainCirculating: { Ethereum: { chainId: "ethereum", current: 10_000 }, Solana: { chainId: "ethereum", current: 90_000 } } }),
        makeDb({ ...validJ, circulatingNative: 1_234_567 }),
        makeDb({ ...validJ, circulatingNative: undefined, price: 2 }),
        makeDb({ ...validJ, valuationPriceUsd: undefined }),
        makeDb({ ...validJ, circulating: { peggedMXN: 100_000 } }),
        makeDb({ ...validJ, supplyObservedAt: undefined }),
      ]) expectUnavailable(await ovJson(db, "jltxx-jpmorgan", makeResponse(hist)), "jltxx-jpmorgan");
      const okJ = proj(await ovJson(makeDb(validJ), "jltxx-jpmorgan", makeResponse(hist)), "jltxx-jpmorgan");
      expect({ circ: okJ.circulating, clock: okJ.supplyObservedAt, native: okJ.nativeSupply.current }).toEqual({ circ: { peggedUSD: 100_000 }, clock: NOW - 60, native: 100_000 });
      const dBase = { currentCirculatingUSD: { peggedUSD: 700 }, currentCirculatingNative: 700, currentSupplyValuationPriceUsd: 1, price: 1, currentSupplySource: "onchain-total-supply", currentSupplyObservedAt: NOW - 60 };
      const okDirect = proj(dBase, "jltxx-jpmorgan");
      expect({ circ: okDirect.circulating, clock: okDirect.supplyObservedAt, native: okDirect.nativeSupply.current }).toEqual({ circ: { peggedUSD: 700 }, clock: NOW - 60, native: 700 });
      for (const badDirect of [
        { ...dBase, currentCirculatingNative: 350, price: 2 },
        { ...dBase, currentSupplyValuationPriceUsd: undefined },
        { ...dBase, currentCirculatingUSD: { peggedMXN: 700 } },
        { ...dBase, currentSupplyObservedAt: NOW + 60 },
      ]) {
        const s = proj(badDirect, "jltxx-jpmorgan");
        expect({ circ: s.circulating, clock: s.supplyObservedAt, native: s.nativeSupply.current }).toEqual({ circ: {}, clock: null, native: null });
      }
      for (const id of ["jltxx-jpmorgan", "wtgxx-wisdomtree", "tbill-openeden", "cetes-etherfuse"]) {
        expectUnavailable(await ovJson(makeDb({ id: "usdt-tether", circulating: { peggedUSD: 100 } }), id, makeResponse(hist)), id);
        const direct = proj(JSON.parse(hist), id);
        expect({ circ: direct.circulating, clock: direct.supplyObservedAt, native: direct.nativeSupply.current }).toEqual({ circ: {}, clock: null, native: null });
      }
      for (const [id, row] of [
        ["tbill-openeden", { ...validTbill, supplySource: "onchain-total-supply" }],
        ["tbill-openeden", { ...validTbill, supplyObservedAt: NOW + 60 }],
        ["tbill-openeden", { ...validTbill, chainCirculating: { Ethereum: { chainId: "ethereum", current: 285_000 } } }],
        ["tbill-openeden", { ...validTbill, chainCirculating: { ...validTbill.chainCirculating, BSC: { chainId: "ethereum", current: 250_000 } } }],
        ["cetes-etherfuse", { id: "cetes-etherfuse", circulating: { peggedMXN: 4_000 }, circulatingNative: 66_000, supplySource: "onchain-total-supply", supplyObservedAt: NOW - 60, price: 0.06, chainCirculating: { Ethereum: { chainId: "ethereum", current: 4_000 } } }],
        ["cetes-etherfuse", { id: "cetes-etherfuse", circulating: { peggedMXN: 4_000 }, circulatingNative: 66_000, supplySource: "onchain-total-supply", supplyObservedAt: undefined, price: 0.06 }],
        ["wtgxx-wisdomtree", { id: "wtgxx-wisdomtree", circulating: { peggedUSD: 675_000 }, circulatingNative: 675_000, supplySource: "onchain-total-supply", supplyObservedAt: NOW - 60, price: 1, chainCirculating: { Ethereum: { chainId: "ethereum", current: 675_000 } } }],
      ] as const) expectUnavailable(await ovJson(makeDb(row), id, makeResponse(hist)), id);
      const okTbill = proj(await ovJson(makeDb(validTbill), "tbill-openeden", makeResponse(hist)), "tbill-openeden");
      expect({ circ: okTbill.circulating, native: okTbill.nativeSupply.current }).toEqual({ circ: { peggedUSD: 285_000 }, native: 244_000 });
      // Pre-cutover CADD list row (undated DefiLlama) and an unclocked native row never take the publication clock.
      const cadd = { id: "cadd-cad-digital", circulating: { peggedCAD: 9_000 }, circulatingNative: 13_000, price: 0.7 };
      for (const supplySource of ["defillama", "onchain-total-supply"]) {
        expectUnavailable(await ovJson(makeDb({ ...cadd, supplySource }), cadd.id, makeResponse(hist)), cadd.id);
        expect(proj({ ...dBase, currentCirculatingUSD: cadd.circulating, currentSupplySource: supplySource,
          currentSupplyObservedAt: supplySource === "defillama" ? NOW - 60 : undefined }, cadd.id).circulating).toEqual({});
      }
      // A valid run-second clock is not a state clock: only the pinned reader's marker admits a v7.2 enrollee (ZCHF);
      // BRLA's reader was pinned before the marker existed.
      const native = { supplySource: "onchain-total-supply", supplyObservedAt: NOW - 90 };
      const zchf = { id: "zchf-frankencoin", circulating: { peggedCHF: 9_000 }, ...native };
      for (const [row, clock] of [[{ ...cadd, ...native, supplyObservedAtKind: "pinned-state" }, NOW - 90], [zchf, null],
        [{ ...zchf, supplyObservedAtKind: "pinned-state" }, NOW - 90], [{ ...native, id: "brla-brla-digital", circulating: { peggedREAL: 9_000 } }, NOW - 90],
      ] as const) expect(proj(await ovJson(makeDb(row), row.id, makeResponse(hist)), row.id).supplyObservedAt).toBe(clock);
    });

    it("ignores a provider-supplied unavailability marker when canonical supply is observed", async () => {
      const body = await ovJson(makeDb({ circulating: { peggedUSD: 100 } }), "usdt-tether",
        resOf({ tokens, currentSupplyUnavailableReason: "supply-chain-dropout" }));
      expect(body.currentSupplyUnavailableReason).toBeUndefined();
      expect(proj(body).circulating).toEqual({ peggedUSD: 100 });
    });
  });
});

describe("detail response paths", () => {
  it.each([
    { kind: "unattributed", priorDay: { unattributed: 100_000_000 } },
    { kind: "mixed-peg", priorDay: { peggedEUR: 60_000_000, peggedUSD: 40_000_000 } },
  ])("preserves $kind EURC prior-day supply in detail and live summary", async ({ priorDay }) => {
    const id = "eurc-circle";
    const db = makeDb({
      id, pegType: "peggedEUR", ...eurcNative, circulating: { peggedUSD: 70_000_000, peggedEUR: 40_000_000 }, circulatingPrevDay: priorDay,
      supplyChangeBaselines: { day: { observedAt: NOW - 86_400, circulatingUsd: 100_000_000, circulatingNative: null } },
    }, NOW - 60, 60);
    const { ctx } = makeCtx();
    expect(StablecoinDetailResponseSchema.parse(await (await handleStablecoinDetail(db, id, ctx)).json()).currentCirculatingPrevDayUSD).toEqual(priorDay);
    expect(await (await handleStablecoinLiveSummary(db, id, ctx)).json()).toHaveProperty("circulatingPrevDay", priorDay);
  });

  it.each([false, true])("projects the actual canonical enrichment path with independent clocks and quarantine (%s)", async (quarantined) => {
    const db = makeDb({
      priceObservedAt: NOW - 120, supplyObservedAt: NOW - 600, circulating: quarantined ? {} : { peggedUSD: 200 }, supplyRestored: !quarantined,
      ...(quarantined ? { supplyChainGuard: {
        status: "unavailable", reason: "supply-chain-dropout", quarantinedSince: NOW - 8 * 86_400,
        chains: [{ chainId: "xlayer", chainLabel: "X Layer", listCurrentUsd: 0, baselineUsd: 200, baselineObservedAt: NOW - 8 * 86_400, baselineSource: "state", resolution: "unavailable" }],
      } } : {}),
    }, NOW - 60, 60);
    const { ctx } = makeCtx();
    const expected = proj(await (await handleStablecoinDetail(db, "usdt-tether", ctx)).json());
    const { _meta, ...summary } = await (await handleStablecoinLiveSummary(db, "usdt-tether", ctx)).json() as Record<string, unknown>;
    expect(summary).toEqual(JSON.parse(JSON.stringify(expected)));
    expect({ priceObservedAt: summary.priceObservedAt, supplyObservedAt: summary.supplyObservedAt, supplyRestored: summary.supplyRestored, circulating: summary.circulating })
      .toEqual({ priceObservedAt: NOW - 120, supplyObservedAt: quarantined ? null : NOW - 600, supplyRestored: true, circulating: quarantined ? {} : { peggedUSD: 200 } });
    expect(_meta).toMatchObject({ updatedAt: NOW - 60 });
    expect(routeStablecoinDetail).not.toHaveBeenCalled();
  });

  it("serves the published USDT price when its observation predates the depeg detection window", async () => {
    const db = makeDb({ price: 0.99993, priceObservedAt: NOW - 4664, priceUpdatedAt: NOW - 4664, priceSyncedAt: NOW - 761 }, NOW - 761, 60);
    const result = await handleStablecoinDetail(db, "usdt-tether", makeCtx().ctx);
    expect(await result.json()).toMatchObject({ price: 0.99993, priceObservedAt: NOW - 4664, priceSyncedAt: NOW - 761, tokens });
  });

  it.each([60, 600, undefined])("enriches fresh cache, stale cache and provider responses (age %s)", async (age) => {
    const { ctx, waits } = makeCtx();
    vi.mocked(routeStablecoinDetail).mockResolvedValue(makeResponse());
    const result = await handleStablecoinDetail(makeDb({}, NOW - 60, age), "usdt-tether", ctx);
    const body = await result.json() as { price: unknown; tokens: unknown };
    expect({ price: body.price, tokens: body.tokens }).toEqual({ price: 0.997, tokens });
    if (age !== undefined) expect(result.headers.get("X-Data-Updated-At")).toBe(String(NOW - Math.max(age, 60)));
    if (age === 600) {
      expect(result.headers.get("Cache-Control")).toBe("no-store");
      expect(result.headers.get("X-Data-Age")).toBe("600");
      expect(result.headers.get("X-Data-Freshness")).toBe("fresh");
      expect(result.headers.get("Warning")).toBeNull();
    }
    await Promise.all(waits);
  });

  it("enriches token-built fallback responses without publishing the price into detail history cache", async () => {
    const { ctx, waits } = makeCtx();
    vi.mocked(routeStablecoinDetail).mockImplementation(async (_config, helper) => helper.createFreshResponseFromTokens(tokens));
    const result = await handleStablecoinDetail(makeDb(), "usdt-tether", ctx);
    const body = await result.json() as { price: unknown; tokens: unknown };
    expect({ price: body.price, tokens: body.tokens }).toEqual({ price: 0.997, tokens });
    expect(result.headers.get("X-Data-Updated-At")).toBe(String(NOW - 60));
    await Promise.all(waits);
    expect(vi.mocked(publishDetailCacheGeneration).mock.calls[0]?.[2]).toBe(JSON.stringify({ tokens }));
  });

  it.each(["public, max-age=30", "no-store"])("releases fresh acquisitions independently of cache profile %s", async (cacheControl) => {
    const db = makeDb({}, NOW - 60, 18_000);
    const { ctx, waits } = makeCtx();
    vi.mocked(routeStablecoinDetail).mockImplementation(async (_config, helper) => {
      const response = helper.createFreshResponseFromTokens(tokens);
      response.headers.set("Cache-Control", cacheControl);
      return response;
    });
    const response = await handleStablecoinDetail(db, "usdt-tether", ctx);
    await Promise.all(waits);
    expect(response.headers.get("Cache-Control")).toBe(cacheControl);
    expect(db.getHistory().some(({ sql, binds }) => sql.startsWith("DELETE FROM cache") && binds[0] === "detail-refresh:usdt-tether")).toBe(true);
  });

  it("does not enrich retained inactive records", async () => {
    const db = makeDb({ id: "bfusd-binance" }, NOW - 60, 600);
    const { ctx } = makeCtx();
    expect(await (await handleStablecoinDetail(db, "bfusd-binance", ctx)).json()).not.toHaveProperty("price");
    expect(db.getHistory().some(({ binds }) => binds[0] === "stablecoins")).toBe(false);
    expect(routeStablecoinDetail).not.toHaveBeenCalled();
    expect(ctx.waitUntil).not.toHaveBeenCalled();
  });
});

describe("legacy Solomon detail identity", () => {
  it.each(["defillama", "coingecko"])("sanitizes cached %s alias data without changing legacy history", async (source) => {
    expect(await ovJson(makeDb({ id: "usdv-solomon", priceSource: source }), "usdv-solomon",
      resOf({ tokens, price: 0.99994, gecko_id: "solomon-usdv", geckoId: "solomon-usdv" }))).toEqual({ tokens });
  });

  it("fills a sanitized legacy cache with a fresh canonical exact-mint quote", async () => {
    const body = await ovJson(makeDb({ id: "usdv-solomon", priceSource: "jupiter", price: 0.9988,
      priceConfidence: "single-source", consensusSources: ["jupiter"], agreeSources: ["jupiter"] }), "usdv-solomon",
      resOf({ tokens, price: 0.99994, gecko_id: "solomon-usdv" }));
    expect(body).toMatchObject({ tokens, price: 0.9988, priceSource: "jupiter" });
    expect(body.gecko_id).toBeUndefined();
  });
});
