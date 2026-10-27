import { describe, expect, it } from "vitest";
import { makeYieldProvenance, makeYieldRanking } from "@shared/test-utils/yield-ranking-fixtures";
import {
  YieldRankingSummarySchema,
  YieldRankingSummaryProvenanceSchema,
} from "@shared/types/yield-summary";
import { deriveYieldRowPresentation } from "@/lib/yield-workbench-row";
import { formatYieldSourceRiskSummary } from "@/lib/yield-source-risk";

describe("deriveYieldRowPresentation", () => {
  it.each([
    { sourceRisk: { sourceRiskScore: 42, sourceRiskPenalty: null }, material: true },
    { sourceRisk: { sourceRiskScore: 10 }, material: true },
    { sourceRisk: { sourceRiskScore: 9 }, material: false },
    { sourceRisk: { sourceRiskScore: 99, sourceRiskPenalty: 1.05 }, material: false },
    { sourceRisk: { sourceRiskScore: 2, sourceRiskPenalty: 1.06 }, material: true },
  ])("agrees with source-risk summaries in full and compact rows: $sourceRisk", ({ sourceRisk, material }) => {
    const full = makeYieldRanking({ sourceRisk });
    const summary = YieldRankingSummarySchema.strip().parse({
      ...full, alternateSourceCount: 0, altSources: [],
      provenance: YieldRankingSummaryProvenanceSchema.strip().parse(full.provenance),
    });
    for (const row of [full, summary]) {
      expect(deriveYieldRowPresentation(row).sourceRiskMaterial).toBe(material);
      expect(formatYieldSourceRiskSummary(row.sourceRisk) !== null).toBe(material);
    }
  });

  it("displays the served observation age in detailed and compact rows", () => {
    // The observation was 900 seconds old at publication; serving it 14,401
    // seconds later advances its age to 15,301 seconds in either payload.
    const full = makeYieldRanking({
      provenance: makeYieldProvenance({ sourceObservedAt: null, sourceAgeSeconds: 15301, sourceFreshness: "stale" }),
      sourceRisk: {
        sourceRiskScore: 22, sourceRiskPenalty: 1.11, sourceDepthRatio: 0.008,
        rewardShare: 0.2, sourceAgeSeconds: 15301,
        observationCount30d: 720, sourceSwitchCount30d: 1,
      },
    });
    const summary = YieldRankingSummarySchema.strip().parse({
      ...full,
      alternateSourceCount: 0,
      altSources: [],
      provenance: YieldRankingSummaryProvenanceSchema.strip().parse(full.provenance),
    });

    for (const row of [full, summary]) {
      expect(deriveYieldRowPresentation(row).freshness?.displayText).toContain("4h");
    }
  });
});
