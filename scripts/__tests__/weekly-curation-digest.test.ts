import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { analyzeArchetype, analyzeAttestorTier, analyzeOneLiner } from "../maintenance/weekly-curation-digest.mjs";
import { loadPerCoinStablecoinEntries } from "../lib/stablecoin-catalog-sources";
import { renderDigest } from "./weekly-curation-digest.test-support";

const baseline = JSON.parse(readFileSync("scripts/lib/curation-baseline-caps.json", "utf8"));
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
    expect(attestor.missing).toEqual([]);
    expect(oneLiner.missing).toEqual([]);
    expect(archetype.missing).toEqual([]);
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
  });

  it("requires attestor tiers only for independent audits", () => {
    expect(analyzeAttestorTier([
      audit("covered"),
      audit("z-missing", false),
      audit("a-missing", false),
      coin("self", { proofOfReserves: { type: "self-reported" } }),
      coin("none"),
    ])).toEqual({ total: 3, missing: ["a-missing", "z-missing"] });
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
    expect(result.unknown).toEqual(["unknown"]);
  });

  it("reports stale and missing active summaries at the 180-day boundary", () => {
    const report = renderDigest({
      coins: ["fresh", "stale", "undated", "invalid", "missing"].map((id) => coin(id)).concat([
        coin("prelaunch", { status: "pre-launch" }),
      ]),
      summaries: {
        fresh: { text: "Current", updatedAt: "2026-01-02" },
        stale: { text: "Old", updatedAt: "2026-01-01" },
        undated: { text: "No date" },
        invalid: { text: "Invalid date", updatedAt: "invalid" },
      },
    });
    const summary = report.split("## AI summary staleness")[1].split("## Annotation queue health")[0];
    expect(summary).toMatch(/active summaries: 3\. Missing: 1\./);
    expect(summary).toContain("Missing entries: missing");
    expect(summary).toMatch(/- stale .*2026-01-01 \(181d\)/);
    expect(summary).toMatch(/- undated .*\(n\/a\)/);
    expect(summary).toMatch(/- invalid .*\(n\/a\)/);
    expect(summary).not.toMatch(/fresh|prelaunch/);
  });

  it.each([
    { rows: 30, date: "2026-05-02", warnings: [] },
    { rows: 31, date: "2026-05-02", warnings: ["queue length 31 exceeds 30-row threshold"] },
    { rows: 30, date: "2026-05-01", warnings: ["oldest row is 61 days old (>60d)"] },
  ])("reports queue warnings for $rows rows dated $date", ({ rows, date, warnings }) => {
    const report = renderDigest({
      queue: `## ${date}\n${Array.from({ length: rows }, (_, i) => `- coin-${i} | event`).join("\n")}`,
    });
    expect(report).toContain(`Rows pending review: ${rows}`);
    expect(report.split("\n").filter((line) => line.startsWith("WARN: ")))
      .toEqual(warnings.map((warning) => `WARN: ${warning}`));
  });

  it("renders empty cohorts with finite percentages and reports absent queue input", () => {
    const report = renderDigest();
    expect(report).toContain("0/0 active/pre-launch");
    expect(report).toContain("0/0 have an archetype (0.0%)");
    expect(report).toContain("attestorTier: 0/0 (0.0%)");
    expect(report).not.toMatch(/NaN|Infinity|WARN:/);
    expect(report).toContain("Queue file `agents/annotation-candidates.md` not present");
  });
});
