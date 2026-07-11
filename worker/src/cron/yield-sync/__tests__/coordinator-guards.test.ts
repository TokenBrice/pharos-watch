import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getCache: vi.fn(),
  readPreviousYieldRankingsCount: vi.fn(),
}));

vi.mock("../../../lib/db-cache", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../lib/db-cache")>();
  return { ...actual, getCache: mocks.getCache };
});

vi.mock("../publication", () => ({
  readPreviousYieldRankingsCount: mocks.readPreviousYieldRankingsCount,
}));

import {
  detectYieldQualityMixRegression,
  guardPublishedYieldCoverage,
  summarizeYieldPublicationQualityMix,
} from "../coordinator-guards";

function ranking(
  id: string,
  dataSource: string,
  confidenceTier: "deterministic" | "curated" | "discovered" | "fallback",
) {
  return { id, dataSource, provenance: { confidenceTier } };
}

function directRankings(count: number, prefix = "direct") {
  return Array.from({ length: count }, (_, index) => ranking(`${prefix}-${index}`, "protocol-api", "curated"));
}

function modeledRankings(count: number, prefix = "modeled") {
  return Array.from({ length: count }, (_, index) => ranking(`${prefix}-${index}`, "rate-derived", "deterministic"));
}

function discoveredRankings(count: number, prefix = "discovered") {
  return Array.from({ length: count }, (_, index) => ranking(`${prefix}-${index}`, "defillama-auto", "discovered"));
}

function seedPreviousCounts(totalCount: number) {
  mocks.readPreviousYieldRankingsCount
    .mockResolvedValueOnce({ count: 0, malformed: false })
    .mockResolvedValueOnce({ count: 0, malformed: false })
    .mockResolvedValueOnce({ count: totalCount, malformed: false });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("Yield publication quality-mix guard", () => {
  it("classifies direct/curated separately from modeled and fallback rows", () => {
    expect(
      summarizeYieldPublicationQualityMix([
        ranking("onchain", "onchain", "deterministic"),
        ranking("curated", "protocol-api", "curated"),
        ranking("modeled", "rate-derived", "deterministic"),
        ranking("fallback", "price-derived", "fallback"),
        ranking("discovered", "defillama-auto", "discovered"),
      ]),
    ).toEqual({
      directCuratedCount: 2,
      fallbackModeledCount: 2,
      unclassifiedCount: 1,
      totalCount: 5,
    });
  });

  it("rejects a major quality substitution while total count stays level", async () => {
    const previousRankings = directRankings(10);
    const currentRankings = [...directRankings(5), ...modeledRankings(5)];
    seedPreviousCounts(previousRankings.length);
    mocks.getCache.mockResolvedValue({
      value: JSON.stringify({ rankings: previousRankings }),
      updatedAt: 1,
    });

    const guarded = await guardPublishedYieldCoverage({
      db: {} as D1Database,
      previewRankingsPayload: { rankings: currentRankings },
      yieldCoinIdSet: new Set(),
      opportunityCoinIdSet: new Set(),
    });

    expect(guarded.result?.status).toBe("degraded");
    const metadata = JSON.parse(guarded.result?.metadata ?? "{}") as Record<string, unknown>;
    expect(metadata).toMatchObject({
      reason: "published-source-quality-mix-regression",
      qualityMixReasons: ["direct-curated-collapse", "fallback-modeled-substitution"],
      previousPublishedDirectCuratedCount: 10,
      currentPublishedDirectCuratedCount: 5,
      publishedDirectCuratedCountDelta: -5,
      minimumDirectCuratedCount: 6,
      previousPublishedFallbackModeledCount: 0,
      currentPublishedFallbackModeledCount: 5,
      publishedFallbackModeledCountDelta: 5,
      minimumFallbackModeledIncrease: 3,
      previousPublishedRankingCount: 10,
      currentPublishedRankingCount: 10,
      publishedRankingCountDelta: 0,
    });
    expect((metadata.qualityMixReasons as unknown[]).length).toBeLessThanOrEqual(2);
  });

  it("allows the conservative 60 percent quality floor", () => {
    const previous = summarizeYieldPublicationQualityMix(directRankings(10));
    const current = summarizeYieldPublicationQualityMix([...directRankings(6), ...modeledRankings(4)]);

    expect(detectYieldQualityMixRegression(previous, current)).toBeNull();
  });

  it("does not fire when fallback/model substitution is below the material floor", () => {
    const previous = summarizeYieldPublicationQualityMix([...directRankings(10), ...modeledRankings(2)]);
    const current = summarizeYieldPublicationQualityMix([
      ...directRankings(5),
      ...modeledRankings(3),
      ...discoveredRankings(4),
    ]);

    expect(detectYieldQualityMixRegression(previous, current)).toBeNull();
  });

  it("does not guard small baselines", () => {
    const previous = summarizeYieldPublicationQualityMix(directRankings(9));
    const current = summarizeYieldPublicationQualityMix(modeledRankings(9));

    expect(detectYieldQualityMixRegression(previous, current)).toBeNull();
  });
});
