import { describe, expect, it } from "vitest";
import { BLUECHIP_SLUG_MAP } from "@shared/lib/bluechip-slugs";
import { CACHE_FRESHNESS_LANES } from "@shared/lib/api-freshness";
import { mockD1 } from "@shared/test-utils/mock-d1";
import type { BluechipRating } from "@shared/types/market";
import { includeActiveTrackedIds } from "../shared/exclude-frozen";
import {
  DAILY_LANE_COMPLETION_GRACE_SEC,
  buildPricingOperatorConditions,
  pricingOperatorRuleIds,
} from "../operator-watch-pricing";

const NOW = Date.UTC(2026, 7, 22, 12, 0, 0) / 1000;
const SLOT_START = Date.UTC(2026, 7, 22, 8, 0, 0) / 1000;

const EXPECTED_BLUECHIP_IDS = includeActiveTrackedIds(
  Object.entries(BLUECHIP_SLUG_MAP),
  ([, pharosId]) => pharosId,
).map(([, pharosId]) => pharosId);

function rating(slug: string, lastObservedAt: number): BluechipRating {
  return {
    grade: "A",
    slug,
    lastObservedAt,
    observationState: "current",
    observationReason: null,
    collateralization: null,
    smartContractAudit: null,
    dateOfRating: null,
    dateLastChange: null,
    smidge: {
      stability: null,
      management: null,
      implementation: null,
      decentralization: null,
      governance: null,
      externals: null,
    },
  };
}

function bluechipRatings(overrides: Record<string, Partial<BluechipRating>> = {}) {
  const ratings: Record<string, BluechipRating> = {};
  for (const [slug, pharosId] of Object.entries(BLUECHIP_SLUG_MAP)) {
    if (!EXPECTED_BLUECHIP_IDS.includes(pharosId)) continue;
    ratings[pharosId] = rating(slug, NOW - 3600);
  }
  for (const [pharosId, patch] of Object.entries(overrides)) {
    ratings[pharosId] = { ...ratings[pharosId], ...patch } as BluechipRating;
  }
  return ratings;
}

function bluechipDb(ratings: Record<string, BluechipRating> | null) {
  return mockD1([{
    match: "FROM cache WHERE key = ?",
    rows: ratings == null
      ? []
      : [{ key: "bluechip-ratings", value: JSON.stringify(ratings), updated_at: NOW - 3600 }],
  }]);
}

function conditionsFor(
  caches: Parameters<typeof buildPricingOperatorConditions>[1]["caches"],
  ratings: Record<string, BluechipRating> | null = bluechipRatings(),
) {
  return buildPricingOperatorConditions(bluechipDb(ratings), { caches, nowSec: NOW });
}

describe("pricing operator conditions", () => {
  it("stays quiet for a healthy FX cache and completed daily lanes", async () => {
    const conditions = await conditionsFor({
      [CACHE_FRESHNESS_LANES.fxRates.cacheKey]: { publishedAt: NOW - 60, mode: "live", sourceStatus: "fresh", consecutiveFallbackRuns: 0 },
      [CACHE_FRESHNESS_LANES.usdsStatus.cacheKey]: { publishedAt: SLOT_START + 60 },
      [CACHE_FRESHNESS_LANES.bluechipRatings.cacheKey]: { publishedAt: SLOT_START + 5 * 60 },
    });
    expect(conditions.every((condition) => !condition.active)).toBe(true);
    expect(conditions.map((condition) => condition.id)).toEqual(expect.arrayContaining([
      "source-stale",
      "cached-fallback",
      "sync-usds-status-slot",
      "sync-bluechip-slot",
      "bluechip-ratings-coverage",
    ]));
    expect(pricingOperatorRuleIds(conditions)).toEqual([]);
  });

  it("raises the FX source and cached-fallback conditions with the producer detail", async () => {
    const conditions = await conditionsFor({
      [CACHE_FRESHNESS_LANES.fxRates.cacheKey]: {
        publishedAt: NOW - 60,
        mode: "cached-fallback",
        sourceStatus: "stale",
        consecutiveFallbackRuns: 3,
        warning: "peggedEUR business-daily reference is 2 publishes behind (latest 2026-08-18, expected 2026-08-21)",
      },
    });
    const fx = conditions.filter((condition) => condition.section === "fx-rates");
    expect(fx).toEqual([
      expect.objectContaining({
        id: "source-stale",
        active: true,
        label: expect.stringContaining("peggedEUR business-daily reference is 2 publishes behind"),
      }),
      expect.objectContaining({
        id: "cached-fallback",
        active: true,
        label: expect.stringContaining("3 consecutive runs"),
      }),
    ]);
    expect(pricingOperatorRuleIds(conditions)).toEqual(
      expect.arrayContaining(["fx-source-stale", "fx-cached-fallback"]),
    );
  });

  it("only alerts a stale source, not a degraded one", async () => {
    const conditions = await conditionsFor({
      [CACHE_FRESHNESS_LANES.fxRates.cacheKey]: {
        publishedAt: NOW - 60,
        mode: "live",
        sourceStatus: "degraded",
        consecutiveFallbackRuns: 0,
        warning: "peggedCHF intraday reference is 8h old",
      },
    });
    expect(conditions.filter((condition) => condition.section === "fx-rates").map((condition) => condition.active))
      .toEqual([false, false]);
  });

  it("raises a daily lane that has not published since its slot, after the grace period", async () => {
    const missed = await conditionsFor({
      [CACHE_FRESHNESS_LANES.usdsStatus.cacheKey]: { publishedAt: SLOT_START - 86_400 + 60 },
      [CACHE_FRESHNESS_LANES.bluechipRatings.cacheKey]: { publishedAt: SLOT_START + 300 },
    });
    const usds = missed.find((condition) => condition.id === "sync-usds-status-slot");
    expect(usds).toMatchObject({ section: "daily-lane", active: true, unknown: false });
    expect(usds?.label).toContain("sync-usds-status");
    expect(pricingOperatorRuleIds(missed)).toContain("daily-lane-completion");

    const early = await buildPricingOperatorConditions(bluechipDb(bluechipRatings()), {
      caches: { [CACHE_FRESHNESS_LANES.usdsStatus.cacheKey]: { publishedAt: SLOT_START - 86_400 + 60 } },
      nowSec: SLOT_START + DAILY_LANE_COMPLETION_GRACE_SEC,
    });
    expect(early.find((condition) => condition.id === "sync-usds-status-slot")?.active).toBe(false);
  });

  it("does not page for a missing publication clock", async () => {
    const conditions = await conditionsFor({
      [CACHE_FRESHNESS_LANES.usdsStatus.cacheKey]: { publishedAt: null },
    });
    expect(conditions.find((condition) => condition.id === "sync-usds-status-slot")).toMatchObject({
      active: false,
      unknown: true,
    });
  });

  it("raises bluechip coverage gaps at the shared 48-hour observation budget", async () => {
    const [staleId, freshId] = EXPECTED_BLUECHIP_IDS;
    const conditions = await conditionsFor(
      { [CACHE_FRESHNESS_LANES.bluechipRatings.cacheKey]: { publishedAt: NOW - 3_600 } },
      bluechipRatings({
        [staleId]: { observationState: "retained", observationReason: "http-404", lastObservedAt: NOW - 3 * 86_400 },
      }),
    );
    const coverage = conditions.find((condition) => condition.id === "bluechip-ratings-coverage");
    expect(coverage).toMatchObject({ section: "daily-lane", active: true, unknown: false });
    expect(coverage?.label).toContain(`${staleId}:http-404`);
    expect(coverage?.label).not.toContain(freshId);
    expect(pricingOperatorRuleIds(conditions)).toContain("bluechip-coverage");
  });

  it("keeps a missing or unusable bluechip cache unknown instead of claiming it failed", async () => {
    for (const ratings of [null, {}]) {
      const conditions = await conditionsFor({}, ratings);
      expect(conditions.find((condition) => condition.id === "bluechip-ratings-coverage")).toMatchObject({
        active: false,
        unknown: true,
      });
      expect(pricingOperatorRuleIds(conditions)).not.toContain("bluechip-coverage");
    }
  });
});
