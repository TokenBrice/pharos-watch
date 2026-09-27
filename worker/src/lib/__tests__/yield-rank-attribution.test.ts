import { describe, expect, it } from "vitest";
import { makeYieldRanking } from "@shared/test-utils/yield-ranking-fixtures";
import { buildYieldRankChangeAttribution } from "../yield-rank-attribution";

const priorMove = { previousRank: 15, rankDelta: 12, primaryDriver: "apy" as const };

describe("publication rank attribution", () => {
  it("clears old movement when the next publication measures unchanged rank", () => {
    const row = makeYieldRanking({ publishedRank: 3, liveRank: 3, rankChangeAttribution: priorMove });
    expect(buildYieldRankChangeAttribution({
      originalRow: row, hydratedRow: row, previousRank: 3,
      safetyChanged: false, methodologyChanged: false, comparison: "publication",
    })).toBeNull();
  });

  it("attributes a move once and preserves it during unchanged hydration only", () => {
    const originalRow = makeYieldRanking({ publishedRank: 3, pharosYieldScore: 30 });
    const hydratedRow = makeYieldRanking({ publishedRank: 1, liveRank: 1, pharosYieldScore: 40 });
    const attribution = buildYieldRankChangeAttribution({
      originalRow, hydratedRow, previousRank: 3,
      safetyChanged: false, methodologyChanged: false, comparison: "publication",
    });
    expect(attribution).toMatchObject({ previousRank: 3, rankDelta: 2, pysDelta: 10 });
    const published = { ...hydratedRow, rankChangeAttribution: attribution };
    expect(buildYieldRankChangeAttribution({
      originalRow: published, hydratedRow: published, previousRank: 1,
      safetyChanged: false, methodologyChanged: false,
    })).toEqual(attribution);
    expect(buildYieldRankChangeAttribution({
      originalRow: published,
      hydratedRow: { ...published, liveRank: 2, pharosYieldScore: 35 },
      previousRank: 1, safetyChanged: true, methodologyChanged: false,
    })).toMatchObject({ previousRank: 3, rankDelta: 1, previousPys: 30, pysDelta: 5 });
    expect(buildYieldRankChangeAttribution({
      originalRow: published, hydratedRow: published, previousRank: 1,
      safetyChanged: false, methodologyChanged: false, comparison: "publication",
    })).toBeNull();
    expect(buildYieldRankChangeAttribution({
      originalRow: published, hydratedRow: published, previousRank: null,
      safetyChanged: false, methodologyChanged: false,
    })).toBeNull();
  });

  it("does not attribute an unchanged source penalty, but measures a changed multiplier", () => {
    const originalRow = makeYieldRanking({ publishedRank: 2, sourceRisk: { sourceRiskPenalty: 1.2 } });
    const hydratedRow = makeYieldRanking({ liveRank: 1, sourceRisk: { sourceRiskPenalty: 1.2 } });
    const params = { originalRow, hydratedRow, previousRank: 2, safetyChanged: false, methodologyChanged: false };
    const unchanged = buildYieldRankChangeAttribution(params);
    expect(unchanged?.primaryDriver).not.toBe("source-risk");
    expect(unchanged?.driverContributions?.sourceRisk).toBeNull();
    const changed = buildYieldRankChangeAttribution({
      ...params, hydratedRow: { ...hydratedRow, sourceRisk: { sourceRiskPenalty: 1.1 } },
    });
    expect(changed?.primaryDriver).toBe("source-risk");
    expect(changed?.driverContributions?.sourceRisk).toBe(-0.1);
  });
});
