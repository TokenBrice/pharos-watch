import { describe, expect, it, vi } from "vitest";
import { makeStablecoin } from "@shared/test-utils/stablecoin";
import type { DexLiquidityMap, DexLiquidityHistoryPoint, DepegEvent } from "@shared/types/market";
import type { YieldRankingsResponse } from "@shared/types/yield";
import { buildMarketSocial, buildLiquiditySocial, buildStabilitySocial, buildYieldSocial, captureDailySocial } from "../lib/daily-social-capture";

const now = Date.parse("2026-09-10T12:00:00Z") / 1000;
const base = { editionDate: "2026-09-10", scheduledAt: now, capturedAt: now, asOf: now - 30 };
const asset = (id: string, current: number, previous: number) => makeStablecoin({ id, symbol: id, circulating: { peggedEUR: current }, circulatingPrevWeek: { peggedEUR: previous }, price: 2000 });
describe("daily social source arithmetic", () => {
  it("uses published USD supply without price multiplication and excludes restored/frozen/stale data", () => {
    const bad = asset("bad", 1e12, 1);
    const result = buildMarketSocial("market-growth", [asset("good", 20e6, 10e6), { ...bad, frozen: true }, { ...bad, id: "restored", supplyRestored: true }, { ...bad, id: "stale", supplyObservedAt: now - 3601 }], base);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].value).toBe(10e6);
  });
  it("uses the same denominator cohort at both share dates", () => {
    const result = buildMarketSocial("market-share", [asset("a", 30e6, 10e6), asset("b", 20e6, 10e6), asset("new", 1000e6, 0)], base);
    expect(result.rows[0].id).toBe("a");
    expect(result.rows[0].value).toBeCloseTo(10);
    expect(result.highlights[0].value).toBe("2 assets");
  });
  it("reports zero qualifying gainers truthfully", () => {
    const result = buildMarketSocial("market-growth", [asset("a", 10e6, 20e6)], base);
    expect(result.unit).toBe("count");
    expect(result.rows[0].value).toBe(0);
  });
  it("requires a dated measured liquidity baseline under the same methodology and coverage", () => {
    const row = { totalTvlUsd: 20e6, updatedAt: now - 60, trendworthy: true, hasMeasuredLiquidityEvidence: true, methodologyVersion: "3", coverageClass: "primary" };
    const map = { a: row } as unknown as DexLiquidityMap;
    const previous = { date: now - 7 * 86400, tvl: 12e6, trendworthy: true, hasMeasuredLiquidityEvidence: true, methodologyVersion: "3", coverageClass: "primary" } as DexLiquidityHistoryPoint;
    expect(buildLiquiditySocial(map, { a: [previous] }, [asset("a", 30e6, 20e6)], base).rows[0].value).toBe(8e6);
    for (const invalid of [{ ...previous, methodologyVersion: "2" }, { ...previous, date: now - 10 * 86400 }, { ...previous, trendworthy: false }]) {
      expect(() => buildLiquiditySocial(map, { a: [invalid] }, [asset("a", 30e6, 20e6)], base)).toThrow();
    }
  });
  it("separates recoveries from coverage-loss closures and includes old ongoing incidents", () => {
    const event = { id: 1, startedAt: now - 86400, endedAt: now - 60, peakDeviationBps: 150, closeReason: "recovered-primary" } as DepegEvent;
    const result = buildStabilitySocial([event, { ...event, id: 2, closeReason: "coverage-lost-supply" }, { ...event, id: 3, startedAt: now - 30 * 86400, endedAt: null }], base);
    expect(result.rows.map((row) => row.value)).toEqual([2, 1, 1]);
  });
  it("fails closed for stale and undated responses", async () => {
    vi.stubEnv("PHAROS_API_KEY", "fixture");
    for (const meta of [undefined, { updatedAt: now - 8000, status: "fresh" }, { updatedAt: now, status: "stale" }]) {
      const fetcher = vi.fn(async () => new Response(JSON.stringify({ peggedAssets: [], _meta: meta }), { headers: { "content-type": "application/json" } }));
      await expect(captureDailySocial("market-growth", base, now, fetcher)).rejects.toThrow("Stale or undated");
    }
    vi.unstubAllEnvs();
  });
  it("includes edge cache age and rejects explicit stale warnings", async () => {
    vi.stubEnv("PHAROS_API_KEY", "fixture");
    const cases: Record<string, string>[] = [{ "x-data-age": "10", age: "8000" }, { "x-data-age": "10", warning: '110 - "Response is stale"' }];
    for (const headers of cases) {
      const fetcher = vi.fn(async () => new Response(JSON.stringify({ peggedAssets: [asset("a", 20e6, 10e6)], _meta: { updatedAt: now, status: "fresh" } }), { headers }));
      await expect(captureDailySocial("market-growth", base, now, fetcher)).rejects.toThrow("Stale or undated");
    }
    vi.unstubAllEnvs();
  });
  it("requires qualified yields, sufficient depth, safety, identity and clean warnings", () => {
    const row = { id: "a", name: "Coin A", symbol: "A", currentApy: 8, safetyScore: 80, safetyGrade: "A", sourceTvlUsd: 2e6,
      yieldSource: "source", warningSignals: [], provenance: { sourceFreshness: "fresh", scoreQualified: true, usedDefaultSafety: false, anomalies: [], sourceObservedAt: now - 60,
        safetyScoreIdentity: { model: "v9", publicationGenerationId: "pub" } } };
    const data = { rankings: [row], updatedAt: now, provenance: { safetySnapshot: { kind: "ok", publishedAt: now - 100, safetyScoreIdentity: { publicationGenerationId: "pub" } } } } as unknown as YieldRankingsResponse;
    expect(buildYieldSocial(data, [asset("a", 20e6, 10e6)], base).rows[0].value).toBe(8);
    for (const patch of [{ warningSignals: ["spike"] }, { sourceTvlUsd: 999999 }, { safetyScore: 69 },
      { provenance: { ...row.provenance, usedDefaultSafety: true } }, { provenance: { ...row.provenance, sourceObservedAt: now - 8000 } },
      { provenance: { ...row.provenance, safetyScoreIdentity: { model: "v9", publicationGenerationId: "different" } } }]) {
      expect(() => buildYieldSocial({ ...data, rankings: [{ ...row, ...patch }] } as unknown as YieldRankingsResponse, [asset("a", 20e6, 10e6)], base)).toThrow();
    }
  });
  it("refuses a truncated incident archive", async () => {
    vi.stubEnv("PHAROS_API_KEY", "fixture");
    const fetcher = vi.fn(async (url: string | URL | Request) => new Response(JSON.stringify(String(url).includes("stablecoins")
      ? { peggedAssets: [asset("a", 20e6, 10e6)], _meta: { updatedAt: now, status: "fresh" } }
      : { events: [], total: 1, totalExact: true, nextCursor: null }), { headers: { "x-data-age": "0" } }));
    await expect(captureDailySocial("stability", base, now, fetcher)).rejects.toThrow("Incomplete");
    vi.unstubAllEnvs();
  });
});
