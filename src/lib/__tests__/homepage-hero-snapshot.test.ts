import { describe, expect, it } from "vitest";
import { CLIENT_CORE_AGGREGATE_ACTIVE_IDS } from "@shared/lib/stablecoins/aggregate-client-registry";
import {
  HOMEPAGE_HERO_MAX_FALLBACK_AGE_MS,
  buildLiveHomepageHeroSnapshot,
  selectHomepageHeroSnapshot,
  type HomepageHeroSnapshot,
} from "@/lib/homepage-hero-snapshot";
import { makeStablecoin } from "@shared/test-utils/stablecoin";

function snapshot(asOfISO: string, totalUsd: number): HomepageHeroSnapshot {
  return {
    asOfISO,
    totalUsd,
    nonUsdUsd: 0,
    nonUsdShare: 0,
    supplyUnavailableCount: 0,
    supplyObservedCount: CLIENT_CORE_AGGREGATE_ACTIVE_IDS.size,
    supplyExpectedCount: CLIENT_CORE_AGGREGATE_ACTIVE_IDS.size,
    supplyMissingCount: 0,
    cohort: {
      ts: Date.parse(asOfISO),
      usdt: totalUsd,
      usdc: 0,
      sky: 0,
      others: 0,
      nonUsd: 0,
      total: totalUsd,
    },
  };
}

describe("selectHomepageHeroSnapshot", () => {
  const nowMs = Date.parse("2026-08-22T12:00:00.000Z");
  const fallbackSnapshot = snapshot("2026-08-22T00:00:00.000Z", 100);

  it("prefers live data over a fresh static fallback", () => {
    const liveSnapshot = snapshot("2026-08-22T11:45:00.000Z", 200);

    expect(selectHomepageHeroSnapshot({ liveSnapshot, fallbackSnapshot, nowMs })).toEqual({
      status: "available",
      source: "live",
      snapshot: liveSnapshot,
    });
  });

  it("keeps a fresh static fallback so the UI can show its as-of date", () => {
    expect(selectHomepageHeroSnapshot({ liveSnapshot: null, fallbackSnapshot, nowMs })).toEqual({
      status: "available",
      source: "fallback",
      snapshot: fallbackSnapshot,
    });
  });

  it("returns unavailable when the static fallback has expired", () => {
    const expiredFallback = snapshot(
      new Date(nowMs - HOMEPAGE_HERO_MAX_FALLBACK_AGE_MS - 1).toISOString(),
      100,
    );

    expect(selectHomepageHeroSnapshot({
      liveSnapshot: null,
      fallbackSnapshot: expiredFallback,
      nowMs,
    })).toEqual({
      status: "unavailable",
      source: "unavailable",
      snapshot: null,
    });
  });

  it("accepts a fallback at the exact maximum age", () => {
    const boundary = snapshot(new Date(nowMs - HOMEPAGE_HERO_MAX_FALLBACK_AGE_MS).toISOString(), 100);
    expect(selectHomepageHeroSnapshot({ liveSnapshot: null, fallbackSnapshot: boundary, nowMs })).toEqual({
      status: "available", source: "fallback", snapshot: boundary,
    });
  });

  it.each([new Date(nowMs + 1).toISOString(), null, "invalid"])(
    "rejects an unusable fallback timestamp %s",
    (asOfISO) => {
      expect(selectHomepageHeroSnapshot({
        liveSnapshot: null,
        fallbackSnapshot: { ...fallbackSnapshot, asOfISO },
        nowMs,
      })).toEqual({ status: "unavailable", source: "unavailable", snapshot: null });
    },
  );
  it("retains an old successful generation without selecting it as live", () => {
    const liveSnapshot = snapshot("2020-01-01T00:00:00Z", 200);
    expect(selectHomepageHeroSnapshot({ liveSnapshot, fallbackSnapshot, nowMs })).toEqual({
      status: "available", source: "retained", snapshot: liveSnapshot,
    });
  });

  it("retains figures without inventing an as-of date when producer time is absent", () => {
    const liveSnapshot = buildLiveHomepageHeroSnapshot({
      peggedAssets: [makeStablecoin({ id: "usdt-tether", circulating: { peggedUSD: 200 } })],
    });
    expect(liveSnapshot.asOfISO).toBeNull();
    expect(liveSnapshot.cohort.ts).toBe(0);
    expect(liveSnapshot.totalUsd).toBe(200);
    expect(selectHomepageHeroSnapshot({ liveSnapshot, fallbackSnapshot, nowMs })).toEqual({
      status: "available", source: "retained", snapshot: liveSnapshot,
    });
  });
});

describe("buildLiveHomepageHeroSnapshot supply availability", () => {
  const asset = (id: string, circulating: Record<string, number> | undefined, pegType = "peggedUSD") =>
    makeStablecoin({ id, pegType, circulating });

  it("excludes unavailable supply from sums, counts it, and never reports its cohort as $0", () => {
    const result = buildLiveHomepageHeroSnapshot({
      peggedAssets: [
        asset("usdt-tether", {}),
        asset("usdc-circle", { peggedUSD: 60 }),
        asset("usds-sky", { peggedUSD: 30 }),
        asset("dai-makerdao", { peggedUSD: 0 }),
      ],
    });

    expect(result.supplyUnavailableCount).toBe(1);
    expect(result.totalUsd).toBe(90);
    expect(result.cohort.usdt).toBeNull();
    expect(result.cohort.usdc).toBe(60);
    // Explicit zero DAI is observed, so the Sky cohort stays known.
    expect(result.cohort.sky).toBe(30);
  });

  it("leaves a cohort unavailable when a core member is absent from the payload", () => {
    const result = buildLiveHomepageHeroSnapshot({
      peggedAssets: [
        asset("usdt-tether", { peggedUSD: 100 }),
        asset("usdc-circle", { peggedUSD: 60 }),
        asset("usds-sky", { peggedUSD: 30 }),
      ],
    });

    expect(result.supplyUnavailableCount).toBe(0);
    expect(result.cohort.usdt).toBe(100);
    expect(result.cohort.sky).toBeNull();
    expect(result.supplyMissingCount).toBe(CLIENT_CORE_AGGREGATE_ACTIVE_IDS.size - 3);
    expect(result.cohort.others).toBeNull();
  });

  it.each([{ peggedAssets: [] }, { peggedAssets: [asset("usdt-tether", {})] }])("never selects a no-observation live snapshot as a $0 market", ({ peggedAssets }) => {
    const result = buildLiveHomepageHeroSnapshot({ peggedAssets });
    expect(result.totalUsd).toBeNull();
    expect(result.nonUsdUsd).toBeNull();
    expect(result.cohort.total).toBeNull();
    const nowMs = Date.parse("2026-08-22T12:00:00Z");
    const fallback = snapshot("2026-08-22T00:00:00Z", 100);
    expect(selectHomepageHeroSnapshot({ liveSnapshot: result, fallbackSnapshot: fallback, nowMs }).source).toBe("fallback");
    expect(selectHomepageHeroSnapshot({ liveSnapshot: result, fallbackSnapshot: { ...fallback, totalUsd: null }, nowMs }).status).toBe("unavailable");
  });

  it("preserves a fully observed zero market and unavailable non-USD subgroup", () => {
    const zeros = buildLiveHomepageHeroSnapshot({
      peggedAssets: [...CLIENT_CORE_AGGREGATE_ACTIVE_IDS].map((id) => asset(id, { peggedUSD: 0 })),
    }, Date.parse("2026-08-22T11:45:00Z") / 1000);
    expect(zeros.totalUsd).toBe(0);
    expect(zeros.supplyObservedCount).toBe(zeros.supplyExpectedCount);
    expect(selectHomepageHeroSnapshot({
      liveSnapshot: zeros, fallbackSnapshot: snapshot("2026-08-22T00:00:00Z", 100),
      nowMs: Date.parse("2026-08-22T12:00:00Z"),
    }).source).toBe("live");
    const partial = buildLiveHomepageHeroSnapshot({
      peggedAssets: [asset("usdc-circle", { peggedUSD: 100 }), asset("eurc-circle", {}, "peggedEUR")],
    });
    expect(partial.nonUsdUsd).toBeNull();
    expect(partial.nonUsdShare).toBeNull();
  });

  it("counts omitted non-named core assets in aggregate completeness", () => {
    const rows = [...CLIENT_CORE_AGGREGATE_ACTIVE_IDS].map((id) => asset(id, { peggedUSD: 1 }));
    const full = buildLiveHomepageHeroSnapshot({ peggedAssets: rows });
    expect(full.supplyMissingCount).toBe(0);
    const partial = buildLiveHomepageHeroSnapshot({ peggedAssets: rows.filter((row) => row.id !== "eurc-circle") });
    expect(partial.supplyUnavailableCount).toBe(0);
    expect(partial.supplyMissingCount).toBe(1);
    expect(partial.supplyObservedCount).toBe(partial.supplyExpectedCount - 1);
    expect(partial.cohort.others).toBeNull();
    expect(partial.nonUsdShare).toBeNull();
  });
  it("leaves a wholly omitted non-USD population unavailable, with complete zero controls", () => {
    const rows = [...CLIENT_CORE_AGGREGATE_ACTIVE_IDS].map((id) =>
      asset(id, { peggedUSD: 0 }, id === "eurc-circle" ? "peggedEUR" : "peggedUSD"));
    const complete = buildLiveHomepageHeroSnapshot({ peggedAssets: rows });
    expect(complete.supplyMissingCount).toBe(0);
    expect(complete.nonUsdUsd).toBe(0);
    const omitted = buildLiveHomepageHeroSnapshot({ peggedAssets: rows.filter((row) => row.pegType === "peggedUSD") });
    expect(omitted.supplyMissingCount).toBe(1);
    expect(omitted.supplyObservedCount).toBe(omitted.supplyExpectedCount - 1);
    expect(omitted.nonUsdUsd).toBeNull();
    expect(omitted.nonUsdShare).toBeNull();
    expect(omitted.cohort.nonUsd).toBeNull();
  });
});
