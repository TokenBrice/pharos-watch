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
});
