import { describe, expect, it } from "vitest";
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
  });
});
