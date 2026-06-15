import { describe, expect, it } from "vitest";
import { buildFlightToQualityClassification } from "../flight-to-quality-classification";
import type { ReportCardCachePayload } from "../report-card-cache";

function reportCardCache(scores: ReportCardCachePayload["scores"]): ReportCardCachePayload {
  return {
    methodologyVersion: "test",
    scores,
    updatedAt: 1,
  };
}

describe("buildFlightToQualityClassification", () => {
  it("uses report-card grade boundaries for safe and risky classifications", () => {
    const classification = buildFlightToQualityClassification(reportCardCache({
      "usdc-circle": { score: 65, grade: "B-" },
      "usdt-tether": { score: 49, grade: "D" },
      "dai-makerdao": { score: 50, grade: "C-" },
      "untracked-token": { score: 90, grade: "A+" },
    }));

    expect(classification.safeIds).toEqual(new Set(["usdc-circle"]));
    expect(classification.riskyIds).toEqual(new Set(["usdt-tether"]));
  });
});
