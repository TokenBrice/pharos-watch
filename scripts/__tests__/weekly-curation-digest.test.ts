import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { analyzeArchetype, analyzeAttestorTier, analyzeOneLiner } from "../maintenance/weekly-curation-digest.mjs";
import { loadPerCoinStablecoinEntries } from "../lib/stablecoin-catalog-sources";

const baseline = JSON.parse(readFileSync("scripts/lib/curation-baseline-caps.json", "utf8"));
const ratio = (total: number, missing: unknown[]) => (total === 0 ? 0 : missing.length / total);
const coin = (id: string, overrides: Record<string, unknown> = {}) => ({ id, ...overrides });
const audit = (id: string, withTier = true) =>
  coin(id, {
    proofOfReserves: {
      type: "independent-audit",
      ...(withTier ? { attestorTier: "big4" } : {}),
    },
  });
const archetypeBaseline = (topByRank: string[]) => ({ segmentLabel: "fixture", topByRank });

describe("weekly curation coverage", () => {
  it("covers the current authored catalog", () => {
    const coins = loadPerCoinStablecoinEntries().map((entry) => entry.coin);
    const attestor = analyzeAttestorTier(coins);
    const oneLiner = analyzeOneLiner(coins);
    const archetype = analyzeArchetype(coins, baseline);
    expect([attestor.total - attestor.missing.length, attestor.total]).toEqual([85, 85]);
    expect([oneLiner.total - oneLiner.missing.length, oneLiner.total]).toEqual([366, 366]);
    expect([archetype.tracked - archetype.missing.length, archetype.tracked]).toEqual([39, 39]);
    expect(archetype.unknown).toEqual([]);
  });

  it("requires oneLiners for active and pre-launch coins only", () => {
    const result = analyzeOneLiner([
      coin("z-default"),
      coin("a-pre", { status: "pre-launch", oneLiner: " \t " }),
      coin("trimmed", { oneLiner: "  useful  " }),
      coin("frozen", { status: "frozen" }),
      coin("dead", { status: "dead" }),
    ]);
    expect(result).toEqual({ total: 3, missing: ["a-pre", "z-default"] });
    expect(result.missing.length === 0).toBe(false);
  });

  it("keeps the attestor threshold strictly above 20 percent", () => {
    const exact = analyzeAttestorTier([
      ...Array.from({ length: 4 }, (_, i) => audit(`with-${i}`)),
      audit("z-missing", false),
      coin("self", { proofOfReserves: { type: "self-reported" } }),
      coin("none"),
    ]);
    const over = analyzeAttestorTier([
      ...Array.from({ length: 3 }, (_, i) => audit(`with-${i}`)),
      audit("z", false),
      audit("a", false),
    ]);

    expect([exact.total, exact.missing, ratio(exact.total, exact.missing) <= 0.2]).toEqual([5, ["z-missing"], true]);
    expect([over.missing, ratio(over.total, over.missing) > 0.2]).toEqual([["a", "z"], true]);
  });

  it("uses the fixed archetype cohort and applies exclusions before variants", () => {
    const result = analyzeArchetype(
      [
        coin("z"),
        coin("a"),
        coin("covered", { mechanismArchetype: "fiat-cash" }),
        coin("frozen-variant", { status: "frozen", variantOf: "parent" }),
        coin("variant", { variantOf: "parent" }),
        coin("outside"),
      ],
      archetypeBaseline(["z", "frozen-variant", "variant", "a", "covered", "unknown"]),
    );

    expect([result.tracked, result.missing, result.frozen, result.variants]).toEqual([3, ["a", "z"], 1, 1]);
    expect(result.unknown.length === 0).toBe(false);
  });

  it("keeps the archetype threshold strictly above 27 percent and zero ratios stable", () => {
    const ids = Array.from({ length: 100 }, (_, i) => `coin-${String(i).padStart(3, "0")}`);
    const coins = ids.map((id, i) => coin(id, i < 27 ? {} : { mechanismArchetype: "fiat-cash" }));
    const exact = analyzeArchetype(coins, archetypeBaseline(ids));
    const over = analyzeArchetype(
      coins.map((entry, i) => (i === 27 ? coin(ids[i]) : entry)),
      archetypeBaseline(ids),
    );
    const emptyArchetype = analyzeArchetype(
      [coin("f", { status: "frozen" }), coin("v", { variantOf: "p" })],
      archetypeBaseline(["f", "v"]),
    );

    expect([ratio(exact.tracked, exact.missing) <= 0.27, ratio(over.tracked, over.missing) > 0.27]).toEqual([
      true,
      true,
    ]);
    expect([
      ratio(0, analyzeAttestorTier([]).missing),
      ratio(0, analyzeOneLiner([]).missing),
      ratio(emptyArchetype.tracked, emptyArchetype.missing),
    ]).toEqual([0, 0, 0]);
  });
});
