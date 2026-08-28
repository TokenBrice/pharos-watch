import { describe, expect, it } from "vitest";

import { buildYieldPeerRailModel, getYieldPeerSafetyBand, type YieldPeerRailModel } from "@/lib/yield-peers";
import { makeYieldRanking } from "@shared/test-utils/yield-ranking-fixtures";
import type { PegCurrency, YieldRanking } from "@shared/types";

function row(id: string, pharosYieldScore: number | null, overrides: Partial<YieldRanking> = {}): YieldRanking {
  return makeYieldRanking({
    id,
    symbol: id.toUpperCase(),
    name: id,
    pharosYieldScore,
    currentApy: overrides.apy30d ?? pharosYieldScore ?? 1,
    apy7d: overrides.apy30d ?? pharosYieldScore ?? 1,
    apy30d: pharosYieldScore ?? 1,
    safetyScore: 75,
    ...overrides,
  });
}

function pegLookup(pegs: Record<string, PegCurrency>) {
  return (id: string): PegCurrency | null => pegs[id] ?? null;
}

function expectModel(model: YieldPeerRailModel | null): YieldPeerRailModel {
  expect(model).not.toBeNull();
  return model as YieldPeerRailModel;
}

describe("getYieldPeerSafetyBand", () => {
  it("maps null and finite safety scores into broad cohorts", () => {
    expect(getYieldPeerSafetyBand(null)).toBe("unknown");
    expect(getYieldPeerSafetyBand(82)).toBe("80-plus");
    expect(getYieldPeerSafetyBand(74)).toBe("70-79");
    expect(getYieldPeerSafetyBand(64)).toBe("60-69");
    expect(getYieldPeerSafetyBand(54)).toBe("50-59");
    expect(getYieldPeerSafetyBand(44)).toBe("under-50");
  });
});

describe("buildYieldPeerRailModel", () => {
  it("prefers same-peg neighbors and caps at three above and below", () => {
    const current = row("current", 70);
    const rankings = [
      row("eur-top", 99),
      row("usd-a", 95),
      row("usd-b", 90),
      row("usd-c", 80),
      current,
      row("usd-d", 60),
      row("usd-e", 50),
      row("usd-f", 40),
      row("usd-g", 30),
    ];
    const model = expectModel(
      buildYieldPeerRailModel({
        rankings,
        currentId: current.id,
        currentRow: current,
        getPegForId: pegLookup({
          current: "USD",
          "usd-a": "USD",
          "usd-b": "USD",
          "usd-c": "USD",
          "usd-d": "USD",
          "usd-e": "USD",
          "usd-f": "USD",
          "usd-g": "USD",
          "eur-top": "EUR",
        }),
      }),
    );

    expect(model.cohortKind).toBe("same-peg");
    expect(model.selectionMode).toBe("neighbors");
    expect(model.items.map((item) => item.row.id)).toEqual(["usd-a", "usd-b", "usd-c", "usd-d", "usd-e", "usd-f"]);
    expect(model.items.map((item) => item.relation)).toEqual(["above", "above", "above", "below", "below", "below"]);
  });

  it("falls back to the same yield type and safety band when no same-peg peers exist", () => {
    const current = row("current", 70, {
      yieldType: "lending-vault",
      safetyScore: 74,
    });
    const model = expectModel(
      buildYieldPeerRailModel({
        rankings: [
          row("different-type", 95, {
            yieldType: "lending-opportunity",
            safetyScore: 74,
          }),
          row("same-type-high", 80, {
            yieldType: "lending-vault",
            safetyScore: 72,
          }),
          current,
          row("same-type-low", 60, {
            yieldType: "lending-vault",
            safetyScore: 71,
          }),
          row("same-type-other-band", 50, {
            yieldType: "lending-vault",
            safetyScore: 82,
          }),
        ],
        currentId: current.id,
        currentRow: current,
        getPegForId: pegLookup({
          current: "VAR",
          "different-type": "USD",
          "same-type-high": "EUR",
          "same-type-low": "GBP",
          "same-type-other-band": "JPY",
        }),
      }),
    );

    expect(model.cohortKind).toBe("same-yield-type-safety");
    expect(model.selectionMode).toBe("neighbors");
    expect(model.items.map((item) => item.row.id)).toEqual(["same-type-high", "same-type-low"]);
  });

  it("uses a compact top fallback when the current row has no sortable PYS or rank", () => {
    const current = row("current", null, { liveRank: null, publishedRank: null });
    const model = expectModel(
      buildYieldPeerRailModel({
        rankings: [row("top-a", 90), row("top-b", 80), current, row("top-c", 70), row("top-d", 60)],
        currentId: current.id,
        currentRow: current,
        getPegForId: pegLookup({
          current: "USD",
          "top-a": "USD",
          "top-b": "USD",
          "top-c": "USD",
          "top-d": "USD",
        }),
      }),
    );

    expect(model.selectionMode).toBe("top-fallback");
    expect(model.items.map((item) => item.row.id)).toEqual(["top-a", "top-b", "top-c"]);
    expect(model.items.every((item) => item.relation === "top")).toBe(true);
  });

  it("uses live rank before PYS when every peer has an official rank", () => {
    const current = row("current", 99, { liveRank: 3 });
    const model = expectModel(
      buildYieldPeerRailModel({
        rankings: [
          row("rank-1", 10, { liveRank: 1 }),
          row("rank-2", 20, { liveRank: 2 }),
          current,
          row("rank-4", 90, { liveRank: 4 }),
        ],
        currentId: current.id,
        currentRow: current,
        getPegForId: pegLookup({
          current: "USD",
          "rank-1": "USD",
          "rank-2": "USD",
          "rank-4": "USD",
        }),
      }),
    );

    expect(model.selectionMode).toBe("neighbors");
    expect(model.items.map((item) => item.row.id)).toEqual(["rank-1", "rank-2", "rank-4"]);
    expect(model.items.map((item) => item.rank)).toEqual([1, 2, 4]);
  });
});
