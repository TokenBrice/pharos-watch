import { describe, expect, it } from "vitest";
import { ESLint } from "eslint";
import { buildMapSummary, projectSafetyMapCoin, radiusForMcap, summarizeMapCoins } from "../maintenance/build-safety-score-map";
import { parseDigestSafetyMapSummary } from "@shared/types/digest-safety-map-contract";
import { DigestSafetyMapSummarySchema } from "@shared/types/digest";

const supplyCases: Array<Record<string, number> | undefined> = [undefined, {}, { peggedUSD: 0 }];

describe("supply publication contracts", () => {
  it.each(supplyCases)("retains an unknown mega-cap without claiming full-cohort supply (%j)", (circulating) => {
    const graded = Array.from({ length: 20 }, (_, index) => projectSafetyMapCoin(
      { id: `coin-${index}`, grade: "A", score: 90 },
      index === 19 && circulating === undefined ? undefined : { symbol: `C${index}`, circulating: index === 19 ? circulating : { peggedUSD: 100 } },
    ));
    const tiers = summarizeMapCoins(graded);
    const summary = buildMapSummary({ date: "2026-10-10", asOfSec: 1791590400, methodologyVersion: "9.0",
      gradedCount: 20, notRatedCount: 0, totalMcap: 1900, graded, tiers, floorMcapByTier: { a: 1, other: 1 } });
    const observed = circulating !== undefined && "peggedUSD" in circulating;
    expect(graded[19].mcap).toBe(observed ? 0 : null);
    expect(radiusForMcap("F", graded[19].mcap, 1, 5)).toBe(5);
    expect(summary.totalMcapUsd).toBe(1900);
    expect(summary.supplyCoverage).toMatchObject({ complete: observed, observedCount: observed ? 20 : 19,
      unavailableCount: observed ? 0 : 1, shareBasis: "known-mapped-supply" });
    expect(summary.supplyCoverage.unavailableById).toEqual(observed ? {} : { "coin-19": circulating === undefined ? "missing-list-row" : "absent" });
    expect(parseDigestSafetyMapSummary(summary, "canonical")?.supplyCoverage).toEqual(summary.supplyCoverage);
    expect(DigestSafetyMapSummarySchema.parse(summary).supplyCoverage).toEqual(summary.supplyCoverage);
  });

  it("bans deleted helpers in imports, aliases, calls and namespace reads across every source root", async () => {
    const eslint = new ESLint({ cache: false, cwd: process.cwd(), overrideConfigFile: "eslint.config.mjs" });
    for (const root of ["src/lib", "shared/lib", "worker/src/cron", "scripts/lib", "functions"]) {
      for (const source of [
        'import { getCirculatingRaw as read } from "@shared/lib/supply"; read({});',
        'import * as supply from "@shared/lib/supply"; supply.sumPegBuckets({});',
        'import * as supply from "@shared/lib/supply"; supply["getPrevDayRaw"]({});',
        'const getPrevWeekRaw = () => 0; getPrevWeekRaw();',
      ]) {
        const [result] = await eslint.lintText(source, { filePath: `${root}/__supply-probe.ts` });
        expect(result.messages.some((message) => message.ruleId === "pharos/no-zero-coercing-supply-helpers")).toBe(true);
      }
      const [allowed] = await eslint.lintText('import { getCirculatingRawOrNull } from "@shared/lib/supply"; getCirculatingRawOrNull({});', { filePath: `${root}/__supply-probe.ts` });
      expect(allowed.messages.some((message) => message.ruleId === "pharos/no-zero-coercing-supply-helpers")).toBe(false);
    }
  });
});
