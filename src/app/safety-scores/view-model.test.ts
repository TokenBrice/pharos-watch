import { describe, expect, it } from "vitest";
import type { ReportCard } from "@shared/types";
import {
  buildSafetyGradeCounts,
  buildSafetyHeadlineStats,
  buildSafetyInspectionBoard,
  buildSafetyMcapMap,
  buildSafetyStablecoinMap,
  buildCoreSettlementProfiles,
  filterAndSortReportCards,
  getCoreSettlementProfile,
  groupReportCardsByGrade,
} from "./view-model";

function makeCard(overrides: Partial<ReportCard> = {}): ReportCard {
  return {
    id: overrides.id ?? "usdc-circle",
    name: overrides.name ?? "USD Coin",
    symbol: overrides.symbol ?? "USDC",
    overallScore: overrides.overallScore !== undefined ? overrides.overallScore : 92,
    overallGrade: overrides.overallGrade ?? "A",
    isDefunct: overrides.isDefunct ?? false,
    dimensions: overrides.dimensions ?? {
      pegStability: { score: 95, grade: "A" },
      liquidity: { score: 90, grade: "A" },
      resilience: { score: 88, grade: "B+" },
      decentralization: { score: 70, grade: "B-" },
      dependencyRisk: { score: 62, grade: "C" },
    },
    rawInputs: overrides.rawInputs ?? {
      pegScore: 95,
      activeDepeg: false,
      activeDepegBps: null,
      depegEventCount: 0,
      lastEventAt: null,
      liquidityScore: 90,
      effectiveExitScore: 90,
      redemptionBackstopScore: 65,
      redemptionRouteFamily: "offchain-issuer",
      redemptionModelConfidence: "medium",
      redemptionUsedForLiquidity: true,
      redemptionImmediateCapacityUsd: null,
      redemptionImmediateCapacityRatio: null,
      concentrationHhi: 0.01,
      bluechipGrade: null,
      canBeBlacklisted: true,
      chainTier: "ethereum",
      deploymentModel: "native-multichain",
      collateralQuality: "rwa",
      custodyModel: "institutional-top",
      governanceTier: "centralized",
      governanceQuality: "regulated-entity",
      dependencies: [],
      navToken: false,
      collateralFromLive: true,
    },
  } as ReportCard;
}

describe("safety score view-model", () => {
  it("builds market-cap lookups from pegged asset supply buckets", () => {
    const result = buildSafetyMcapMap([
      { id: "usdc-circle", circulating: { peggedUSD: 100, peggedEUR: 5 } },
      { id: "usdt-tether", circulating: null },
    ]);

    expect(result.get("usdc-circle")).toBe(105);
    expect(result.get("usdt-tether")).toBe(0);
  });

  it("always excludes defunct cards, applies grade filters, and keeps NR rows at the bottom", () => {
    const cards = [
      makeCard({ id: "usdc-circle", overallScore: 92, overallGrade: "A" }),
      makeCard({ id: "usdt-tether", symbol: "USDT", overallScore: 80, overallGrade: "B" }),
      makeCard({ id: "fdusd", symbol: "FDUSD", overallScore: null, overallGrade: "NR" }),
      makeCard({ id: "legacy", symbol: "LEG", overallScore: 95, overallGrade: "A", isDefunct: true }),
    ];

    const sorted = filterAndSortReportCards(cards, {
      gradeFilter: "all",
      sortKey: "overall",
      mcapMap: new Map(),
    });

    expect(sorted.map((card) => card.id)).toEqual(["usdc-circle", "usdt-tether", "fdusd"]);

    const filtered = filterAndSortReportCards(cards, {
      gradeFilter: "B",
      sortKey: "overall",
      mcapMap: new Map(),
    });

    expect(filtered.map((card) => card.id)).toEqual(["usdt-tether"]);
  });

  it("can sort a dimension weakest-first while keeping unrated rows at the bottom", () => {
    const cards = [
      makeCard({
        id: "strong-liquidity",
        symbol: "SLQ",
        dimensions: {
          pegStability: { score: 95, grade: "A" },
          liquidity: { score: 88, grade: "B+" },
          resilience: { score: 88, grade: "B+" },
          decentralization: { score: 70, grade: "B-" },
          dependencyRisk: { score: 62, grade: "C" },
        },
      }),
      makeCard({
        id: "weak-liquidity",
        symbol: "WLQ",
        dimensions: {
          pegStability: { score: 95, grade: "A" },
          liquidity: { score: 32, grade: "D" },
          resilience: { score: 88, grade: "B+" },
          decentralization: { score: 70, grade: "B-" },
          dependencyRisk: { score: 62, grade: "C" },
        },
      }),
      makeCard({
        id: "unknown-liquidity",
        symbol: "ULQ",
        dimensions: {
          pegStability: { score: 95, grade: "A" },
          liquidity: { score: null, grade: "NR" },
          resilience: { score: 88, grade: "B+" },
          decentralization: { score: 70, grade: "B-" },
          dependencyRisk: { score: 62, grade: "C" },
        },
      }),
    ];

    const sorted = filterAndSortReportCards(cards, {
      gradeFilter: "all",
      sortKey: "liquidity",
      sortDirection: "asc",
      mcapMap: new Map(),
    });

    expect(sorted.map((card) => card.id)).toEqual(["weak-liquidity", "strong-liquidity", "unknown-liquidity"]);
  });

  it("builds grade counts, grouped sections, and headline stats from visible cards", () => {
    const cards = [
      makeCard({ id: "usdc-circle", overallScore: 92, overallGrade: "A" }),
      makeCard({ id: "usdt-tether", symbol: "USDT", overallScore: 82, overallGrade: "B" }),
      makeCard({ id: "frax", symbol: "FRAX", overallScore: 55, overallGrade: "C" }),
    ];
    const mcapMap = new Map([
      ["usdc-circle", 60_000_000_000],
      ["usdt-tether", 80_000_000_000],
      ["frax", 1_000_000_000],
    ]);

    expect(buildSafetyGradeCounts(cards)).toEqual({
      A: 1,
      B: 1,
      C: 1,
      D: 0,
      F: 0,
      NR: 0,
    });
    expect(groupReportCardsByGrade(cards).map((group) => group.grade)).toEqual(["A", "B", "C"]);

    const stats = buildSafetyHeadlineStats(cards, mcapMap);
    expect(stats).toEqual([
      expect.objectContaining({ label: "Ecosystem avg.", value: "76" }),
      expect.objectContaining({ label: "Supply in A/B", value: "99%" }),
      expect.objectContaining({ label: "Weakest dimension", detail: expect.stringContaining("avg") }),
    ]);
  });

  it("does not treat all-unknown dimensions as zero-score weakest dimensions", () => {
    const cards = [
      makeCard({
        dimensions: {
          pegStability: { score: 91, grade: "A-" },
          liquidity: { score: 78, grade: "B" },
          resilience: { score: 82, grade: "B+" },
          decentralization: { score: null, grade: "NR" },
          dependencyRisk: { score: 65, grade: "C+" },
        },
      }),
    ];

    const weakest = buildSafetyHeadlineStats(cards, new Map()).find((stat) => stat.label === "Weakest dimension");

    expect(weakest).toEqual(expect.objectContaining({
      value: "Dep.",
      detail: "avg 65",
    }));
  });

  it("derives core settlement profiles from objective market, peg, liquidity, dependency, and issuer-exit gates", () => {
    const core = makeCard({
      id: "usdt-tether",
      symbol: "USDT",
      overallScore: 72,
      overallGrade: "B",
      dimensions: {
        pegStability: { score: 99, grade: "A+" },
        liquidity: { score: 69, grade: "B-" },
        resilience: { score: 71, grade: "B" },
        decentralization: { score: 40, grade: "D" },
        dependencyRisk: { score: 95, grade: "A+" },
      },
    });
    const small = makeCard({
      id: "small-usd",
      symbol: "SUSD",
      overallScore: 85,
      overallGrade: "A",
    });
    const stablecoinMap = buildSafetyStablecoinMap([
      { id: "usdt-tether", circulating: { peggedUSD: 120_000_000_000 }, chains: Array.from({ length: 20 }, (_, i) => `chain-${i}`) },
      { id: "small-usd", circulating: { peggedUSD: 100_000_000 }, chains: Array.from({ length: 20 }, (_, i) => `chain-${i}`) },
    ]);

    expect(getCoreSettlementProfile(core, stablecoinMap.get("usdt-tether"))).toMatchObject({
      id: "usdt-tether",
      marketCapUsd: 120_000_000_000,
      chainCount: 20,
    });
    expect(getCoreSettlementProfile(small, stablecoinMap.get("small-usd"))).toBeNull();

    const profiles = buildCoreSettlementProfiles([core, small], stablecoinMap);
    expect([...profiles.keys()]).toEqual(["usdt-tether"]);

    const sorted = filterAndSortReportCards([small, core], {
      gradeFilter: "all",
      sortKey: "coreSettlement",
      mcapMap: new Map(),
      coreSettlementProfiles: profiles,
    });
    expect(sorted.map((card) => card.id)).toEqual(["usdt-tether", "small-usd"]);
  });

  it("builds a market-weighted inspection board and ranks dimension findings", () => {
    const cards = [
      makeCard({
        id: "large-fragile",
        symbol: "LFG",
        name: "Large Fragile",
        overallScore: 62,
        overallGrade: "C",
        dimensions: {
          pegStability: { score: 90, grade: "A" },
          liquidity: { score: 42, grade: "D" },
          resilience: { score: 80, grade: "B" },
          decentralization: { score: 55, grade: "C" },
          dependencyRisk: { score: 88, grade: "B+" },
        },
      }),
      makeCard({
        id: "small-critical",
        symbol: "SCR",
        name: "Small Critical",
        overallScore: 50,
        overallGrade: "D",
        dimensions: {
          pegStability: { score: 70, grade: "B-" },
          liquidity: { score: 20, grade: "F" },
          resilience: { score: 60, grade: "C" },
          decentralization: { score: 45, grade: "D" },
          dependencyRisk: { score: 40, grade: "D" },
        },
      }),
    ];
    const mcapMap = new Map([
      ["large-fragile", 90],
      ["small-critical", 10],
    ]);

    const model = buildSafetyInspectionBoard(cards, mcapMap);
    const liquidity = model.rows.find((row) => row.key === "liquidity");

    expect(model.inspectedCount).toBe(2);
    expect(model.totalMarketCapUsd).toBe(100);
    expect(model.findingExposureUsd).toBe(100);
    expect(model.leadFinding?.key).toBe("liquidity");
    expect(liquidity).toMatchObject({
      averageScore: 31,
      weightedScore: 40,
      findingCount: 2,
      findingExposureUsd: 100,
      unknownCount: 0,
    });
    expect(liquidity?.worstFindings.map((finding) => finding.symbol)).toEqual(["SCR", "LFG"]);
  });
});
