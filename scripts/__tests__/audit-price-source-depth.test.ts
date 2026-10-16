import { describe, expect, it } from "vitest";
import activeStablecoinsFixture from "./fixtures/audit-price-source-depth/active-stablecoins.json";
import pegSummaryFixture from "./fixtures/audit-price-source-depth/peg-summary.json";
import stablecoinsFixture from "./fixtures/audit-price-source-depth/stablecoins.json";

import {
  buildPriceSourceDepthAudit,
  type AuditStablecoinMeta,
} from "../maintenance/audit-price-source-depth";

describe("audit-price-source-depth", () => {
  it("reduces missing, null, empty, 1, 2, 3, and 5+ source rows", () => {
    const audit = buildPriceSourceDepthAudit({
      activeStablecoins: activeStablecoinsFixture as AuditStablecoinMeta[],
      pegSummary: pegSummaryFixture,
      stablecoins: stablecoinsFixture,
      generatedAt: "2026-05-12T00:00:00.000Z",
      mode: "input",
    });

    expect(audit.activeCount).toBe(7);
    expect(audit.sourceDepthDistribution).toEqual({
      "0": 3,
      "1": 1,
      "2": 1,
      "3": 1,
      "4": 0,
      "5+": 1,
    });
    expect(audit.agreeDepthDistribution).toEqual({
      "0": 3,
      "1": 1,
      "2": 1,
      "3": 1,
      "4": 0,
      "5+": 1,
    });
    expect(audit.authoritativeAgreeDepthDistribution).toEqual({
      "0": 4,
      "1": 1,
      "2": 1,
      "3": 0,
      "4": 1,
      "5+": 0,
    });
    expect(audit.mcapWeightedReach.sourceAtLeast3MarketCapUsd).toBe(800);
    expect(audit.mcapWeightedReach.totalMarketCapUsd).toBe(1280);
    expect(audit.cohorts.exact2.map((row) => row.coinId)).toEqual(["two-source"]);
    expect(audit.cohorts.exact1.map((row) => row.coinId)).toEqual(["one-source"]);
    expect(audit.cohorts.zeroOrMissing.map((row) => row.coinId)).toEqual([
      "missing-property",
      "null-sources",
      "empty-sources",
    ]);
    expect(audit.cohorts.fallbackOnly.map((row) => row.coinId)).toEqual(["null-sources"]);
    expect(audit.sourceFrequency.unknownSources).toEqual(["unknown-feed"]);
    expect(audit.warnings).toContain("Unknown source key 'unknown-feed' counted as non-authoritative.");
  });
});
