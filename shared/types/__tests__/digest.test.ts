import { describe, expect, it } from "vitest";
import { DigestSnapshotResponseSchema } from "../digest";

describe("DigestSnapshotResponseSchema", () => {
  it("parses legacy partial digest input data without asserting a full digest input", () => {
    const parsed = DigestSnapshotResponseSchema.parse({
      date: "2026-07-02",
      inputData: {
        topDepegs: [{ symbol: "USDX", bps: -120, mcapUsd: 1_000_000 }],
        safetyScores: {
          mentionedCoins: [{ symbol: "USDX" }],
          medianGrade: "B",
          aboveBCount: 1,
          fCount: 0,
        },
      },
      prevInputData: {
        totalMcapUsd: 10_000_000,
      },
      depegEvents: [],
      blacklistEvents: [],
    });

    expect(parsed.inputData?.totalMcapUsd).toBeUndefined();
    expect(parsed.inputData?.safetyScores?.mentionedCoins[0]).toEqual({ symbol: "USDX" });
  });

  it.each([
    ["legacy zero", 0],
    ["omitted", undefined],
    ["unavailable", null],
  ])("accepts %s seven-day change in current and previous daily and weekly inputs", (_name, mcap7dDelta) => {
    const input = { totalMcapUsd: 10_000_000, ...(mcap7dDelta === undefined ? {} : { mcap7dDelta }) };
    for (const date of ["2026-10-24", "2026-10-24-weekly"]) {
      const parsed = DigestSnapshotResponseSchema.parse({
        date, inputData: input, prevInputData: input, depegEvents: [], blacklistEvents: [],
      });
      expect(parsed.inputData?.mcap7dDelta).toBe(mcap7dDelta);
      expect(parsed.prevInputData?.mcap7dDelta).toBe(mcap7dDelta);
    }
  });

  it("still rejects a non-numeric seven-day change", () => {
    expect(() => DigestSnapshotResponseSchema.parse({
      date: "2026-10-24", inputData: { totalMcapUsd: 1, mcap7dDelta: "0" }, depegEvents: [], blacklistEvents: [],
    })).toThrow();
  });

  it("preserves a fully identified V9 safety section without legacy dimensions", () => {
    const identity = {
      model: "v9" as const,
      schemaVersion: 1 as const,
      methodologyVersion: "9.0",
      policyId: "safety-score-v9",
      policyDigest: "a".repeat(64),
      evaluationBuildDigest: "b".repeat(64),
      baseInputGenerationId: `report-cards-input:v1:${"c".repeat(64)}`,
      publicationGenerationId: "report-cards:v9:1",
    };
    const pillar = {
      score: 88,
      evidenceLevel: "strong",
      freshness: "current",
      reasons: [{ code: "bounded-mechanism-review", message: "Reviewed" }],
    };
    const parsed = DigestSnapshotResponseSchema.parse({
      date: "2026-07-23",
      inputData: {
        safetyContext: {
          status: "available",
          expectedModel: "v9",
          identity,
          publishedAt: 1_785_000_000,
          reason: null,
        },
        safetyScores: {
          model: "v9",
          mentionedCoins: [{
            symbol: "USDT",
            grade: "A",
            score: 88,
            pillars: { backing: pillar, exit: pillar, control: pillar },
            reasonCodes: ["bounded-mechanism-review"],
            caps: [],
            bindingCap: null,
          }],
          gradeDistribution: { A: 1 },
          provenance: { ...identity, publishedAt: 1_785_000_000 },
        },
      },
      prevInputData: null,
      depegEvents: [],
      blacklistEvents: [],
    });

    expect(parsed.inputData?.safetyScores).toMatchObject({
      model: "v9",
      mentionedCoins: [{ symbol: "USDT", pillars: { backing: { score: 88 } } }],
    });
  });
});
