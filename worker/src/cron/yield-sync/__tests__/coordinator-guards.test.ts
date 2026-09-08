import { describe, expect, it } from "vitest";

import {
  detectYieldQualityMixRegression,
  guardPublishedYieldCoverage,
  summarizeYieldPublicationQualityMix,
} from "../coordinator-guards";
import type { PreviousYieldPublicationSnapshot } from "../publication";

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

function previousSnapshot(
  rankings: readonly ReturnType<typeof ranking>[],
  status: PreviousYieldPublicationSnapshot["status"] = "ok",
): PreviousYieldPublicationSnapshot {
  return {
    status,
    rankings,
    malformed: status !== "missing" && status !== "ok",
  };
}

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

  it.each([
    {
      label: "major quality substitution",
      previous: directRankings(10),
      current: [...directRankings(5), ...modeledRankings(5)],
      expectedMetadata: {
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
      },
    },
    {
      label: "conservative quality floor",
      previous: directRankings(10),
      current: [...directRankings(6), ...modeledRankings(4)],
      expectedMetadata: null,
    },
  ])("keeps $label snapshot metadata stable", async ({ previous, current, expectedMetadata }) => {
    const guarded = await guardPublishedYieldCoverage({
      previousYieldPublicationSnapshot: previousSnapshot(previous),
      previewRankingsPayload: { rankings: current },
      yieldCoinIdSet: new Set(),
      opportunityCoinIdSet: new Set(),
    });

    if (expectedMetadata == null) {
      expect(guarded.result).toBeNull();
    } else {
      expect(guarded.result?.status).toBe("degraded");
      expect(JSON.parse(guarded.result?.metadata ?? "{}")).toEqual(expectedMetadata);
    }
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

describe("Yield publication coverage guard snapshots", () => {
  it.each([
    { label: "opportunity-only collapse", yieldCount: 11, opportunityCount: 6, reason: "published-lending-opportunity-coverage-regression" },
    { label: "yield precedence when both collapse", yieldCount: 6, opportunityCount: 6, reason: "published-yield-coverage-regression" },
    { label: "rounded cohort threshold accepted", yieldCount: 7, opportunityCount: 7, reason: null },
  ])("guards $label with total coverage preserved", async ({ yieldCount, opportunityCount, reason }) => {
    const previous = [...directRankings(11, "yield"), ...directRankings(11, "opportunity")];
    const current = [
      ...directRankings(yieldCount, "yield"),
      ...directRankings(opportunityCount, "opportunity"),
      ...directRankings(22 - yieldCount - opportunityCount, "other"),
    ];
    const guarded = await guardPublishedYieldCoverage({
      previousYieldPublicationSnapshot: previousSnapshot(previous),
      previewRankingsPayload: { rankings: current },
      yieldCoinIdSet: new Set(directRankings(11, "yield").map(({ id }) => id)),
      opportunityCoinIdSet: new Set(directRankings(11, "opportunity").map(({ id }) => id)),
    });
    if (reason === null) {
      expect(guarded.result).toBeNull();
    } else {
      expect(guarded.result?.status).toBe("degraded");
      expect(JSON.parse(guarded.result?.metadata ?? "{}")).toMatchObject({
        reason, previousPublishedRankingCount: 22, currentPublishedRankingCount: 22,
        currentPublishedYieldBearingCount: yieldCount, currentPublishedOpportunityCount: opportunityCount,
      });
    }
  });

  it.each([4, 5])("requires the proportional substitution floor (increase %s)", async (increase) => {
    const guarded = await guardPublishedYieldCoverage({
      previousYieldPublicationSnapshot: previousSnapshot([...directRankings(25), ...modeledRankings(2)]),
      previewRankingsPayload: { rankings: [
        ...directRankings(14), ...modeledRankings(2 + increase), ...discoveredRankings(11 - increase),
      ] },
      yieldCoinIdSet: new Set(),
      opportunityCoinIdSet: new Set(),
    });
    if (increase === 4) {
      expect(guarded.result).toBeNull();
    } else {
      expect(guarded.result?.status).toBe("degraded");
      expect(JSON.parse(guarded.result?.metadata ?? "{}")).toMatchObject({
        reason: "published-source-quality-mix-regression", minimumFallbackModeledIncrease: 5,
        publishedFallbackModeledCountDelta: 5, minimumDirectCuratedCount: 15,
      });
    }
  });

  it.each([
    {
      label: "missing",
      snapshot: previousSnapshot([], "missing"),
    },
    {
      label: "malformed JSON",
      snapshot: previousSnapshot([], "malformed-json"),
    },
    {
      label: "empty",
      snapshot: previousSnapshot([]),
    },
    {
      label: "small",
      snapshot: previousSnapshot(directRankings(4)),
    },
  ])("keeps the $label baseline non-blocking", async ({ snapshot }) => {
    const guarded = await guardPublishedYieldCoverage({
      previousYieldPublicationSnapshot: snapshot,
      previewRankingsPayload: { rankings: [] },
      yieldCoinIdSet: new Set(),
      opportunityCoinIdSet: new Set(),
    });

    expect(guarded.result).toBeNull();
    expect(guarded.previousPublishedYieldBearingCount).toBe(0);
    expect(guarded.previousPublishedOpportunityCount).toBe(0);
    expect(guarded.previousPublishedRankingCount).toBe(snapshot.status === "ok" ? snapshot.rankings.length : 0);
  });

  it.each([
    {
      label: "severe total shrink",
      previous: directRankings(10, "previous"),
      current: directRankings(3, "current"),
      yieldCoinIdSet: new Set<string>(),
      opportunityCoinIdSet: new Set<string>(),
      expectedMetadata: {
        reason: "published-total-coverage-regression",
        previousPublishedYieldBearingCount: 0,
        currentPublishedYieldBearingCount: 0,
        previousPublishedOpportunityCount: 0,
        currentPublishedOpportunityCount: 0,
        previousPublishedRankingCount: 10,
        currentPublishedRankingCount: 3,
        publishedRankingCountDelta: -7,
      },
    },
    {
      label: "yield-bearing cohort regression",
      previous: directRankings(10, "yield"),
      current: directRankings(5, "yield"),
      yieldCoinIdSet: new Set(directRankings(10, "yield").map((row) => row.id)),
      opportunityCoinIdSet: new Set<string>(),
      expectedMetadata: {
        reason: "published-yield-coverage-regression",
        previousPublishedYieldBearingCount: 10,
        currentPublishedYieldBearingCount: 5,
        previousPublishedOpportunityCount: 0,
        currentPublishedOpportunityCount: 0,
        previousPublishedRankingCount: 10,
        currentPublishedRankingCount: 5,
        publishedRankingCountDelta: -5,
      },
    },
  ])("keeps $label metadata stable", async ({ previous, current, yieldCoinIdSet, opportunityCoinIdSet, expectedMetadata }) => {
    const guarded = await guardPublishedYieldCoverage({
      previousYieldPublicationSnapshot: previousSnapshot(previous),
      previewRankingsPayload: { rankings: current },
      yieldCoinIdSet,
      opportunityCoinIdSet,
    });

    expect(guarded.result?.status).toBe("degraded");
    expect(JSON.parse(guarded.result?.metadata ?? "{}")).toEqual(expectedMetadata);
  });
});
