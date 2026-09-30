import { describe, expect, it } from "vitest";
import { buildSharedFailureDomainsModel, type SharedFailureDomainGroups } from "@/lib/shared-failure-domains-model";
import type { SupplyOf } from "@shared/lib/dependency-exposure";

const group = (key: string, memberAssetIds: string[]): SharedFailureDomainGroups[number] => ({ id: `mint-control:${key}`, kind: "mint-control", key, memberAssetIds });
const supplyById: Record<string, ReturnType<SupplyOf>> = {
  a: { usd: 100, asOf: 10, basis: "publication-circulating" },
  b: { usd: 50, asOf: 20, basis: "market-cap-proxy" },
  c: { usd: 500, asOf: null, basis: "publication-circulating" },
  zero: { usd: 0, asOf: 10, basis: "publication-circulating" },
};
const supplies: SupplyOf = id => supplyById[id] ?? null;
const build = (groups: SharedFailureDomainGroups | null) => buildSharedFailureDomainsModel({ groups, cards: [], supplyOf: supplies });

describe("buildSharedFailureDomainsModel", () => {
  it("ranks known member supply with deterministic ties, preserves partial totals, and excludes single-coin groups", () => {
    const model = build([group("small", ["a", "b"]), group("big", ["a", "c"]), group("tie-b", ["b", "a"]), group("tie-a", ["a", "b"]), group("partial", ["c", "missing"]), group("single", ["a", "a"])]);
    expect(model.rows.map(row => row.key)).toEqual(["big", "partial", "small", "tie-a", "tie-b"]);
    expect(model.rows[0]).toMatchObject({ knownUsd: 600, publicationMemberCount: 2, marketCapMemberCount: 0, supplyDateIncomplete: true });
    expect(model.rows[1]).toMatchObject({ knownUsd: 500, unavailableMemberCount: 1 });
    expect(model.rows[2]).toMatchObject({ knownUsd: 150, publicationMemberCount: 1, marketCapMemberCount: 1, oldestAsOfSec: 10 });
  });
  it("distinguishes absent publication, empty census, unavailable supply and known zero", () => {
    expect(build(null)).toEqual({ status: "not-published", rows: [] });
    expect(build([])).toEqual({ status: "published", rows: [] });
    const rows = build([group("unknown", ["missing", "absent"]), group("zero", ["zero", "missing"])]).rows;
    expect(rows.map(row => [row.key, row.knownUsd])).toEqual([["zero", 0], ["unknown", null]]);
  });
  it("resolves exact indexed caps and deployment adjustments rather than binding or first cap", () => {
    const cap = { kind: "control", limit: 42 };
    const adjustment = { scoreBefore: 80, scoreAfter: 75, adjustmentPoints: 5 };
    const groups = [{ ...group("operator", ["a", "b"]), pricedEffects: [{ assetId: "a", capIndices: [1], deploymentAdjustmentIndices: [0] }] }];
    const model = buildSharedFailureDomainsModel({ groups, cards: [{ id: "a", symbol: "AAA", caps: [{ kind: "other", limit: 90 }, cap], scoreTrace: { deploymentRisk: { adjustments: [adjustment] } } }], supplyOf: supplies });
    expect(model.rows[0].effects).toEqual([{ assetId: "a", label: "AAA", caps: [cap], adjustments: [adjustment], referencesUnresolved: false }]);
  });
  it("prefers publication-resolved effects and retains unresolved references and incomplete disclosure", () => {
    const cap = { kind: "mint", limit: 60 };
    const groups = [{ ...group("operator", ["a", "b"]), pricedEffectsIncomplete: true as const, pricedEffects: [{ assetId: "a", capIndices: [2], deploymentAdjustmentIndices: [0], resolvedCaps: [cap], resolvedAdjustments: [], referencesUnresolved: true }] }];
    const model = buildSharedFailureDomainsModel({ groups, cards: [{ id: "a", caps: [{ kind: "different-generation", limit: 10 }] }], supplyOf: supplies });
    expect(model.rows[0].pricedEffectsIncomplete).toBe(true);
    expect(model.rows[0].effects[0]).toMatchObject({ caps: [cap], adjustments: [], referencesUnresolved: true });
  });
  it("never interprets missing effect references as a priced zero", () => {
    const groups = [{ ...group("operator", ["a", "b"]), pricedEffects: [{ assetId: "a", capIndices: [7], deploymentAdjustmentIndices: [3] }] }];
    expect(build(groups).rows[0].effects[0]).toMatchObject({ caps: [], adjustments: [], referencesUnresolved: true });
    expect(build([group("none", ["a", "b"])]).rows[0].effects).toEqual([]);
  });
});
