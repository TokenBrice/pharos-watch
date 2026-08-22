import { describe, expect, it } from "vitest";
import {
  HOMEPAGE_HERO_MAX_FALLBACK_AGE_MS,
  selectHomepageHeroSnapshot,
  type HomepageHeroSnapshot,
} from "@/lib/homepage-hero-snapshot";

function snapshot(asOfISO: string, totalUsd: number): HomepageHeroSnapshot {
  return {
    asOfISO,
    totalUsd,
    nonUsdUsd: 0,
    nonUsdShare: 0,
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
});
