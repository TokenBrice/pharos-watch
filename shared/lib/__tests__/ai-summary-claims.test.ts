import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { resolveAiSummaryClaims, validateAiSummaryClaimTokens } from "../ai-summary-claims";
import type { AiSummaryClaimToken } from "../../types/editorial";

const gradeToken: AiSummaryClaimToken = {
  token: "grade",
  placeholder: "{{grade}}",
  source: "report-card.grade",
  factsAsOf: "2026-09-01",
};

describe("AI summary claim tokens", () => {
  it("resolves registered current values and formats supply", () => {
    expect(resolveAiSummaryClaims(
      "Grade {{grade}}, score {{score}}, supply {{supplyUsd}}.",
      [
        gradeToken,
        { token: "score", placeholder: "{{score}}", source: "report-card.score", factsAsOf: "2026-09-01" },
        {
          token: "supplyUsd",
          placeholder: "{{supplyUsd}}",
          source: "stablecoin.circulating-usd",
          factsAsOf: "2026-09-02",
        },
      ],
      {
        "report-card.grade": "B+",
        "report-card.score": 76.4,
        "stablecoin.circulating-usd": 12_340_000,
      },
    )).toEqual({
      text: "Grade B+, score 76, supply $12.3M.",
      factsAsOf: ["2026-09-01", "2026-09-02"],
      issues: [],
    });
  });

  it("fails unresolved and malicious values closed without interpreting markup", () => {
    expect(resolveAiSummaryClaims("Grade {{grade}}.", [gradeToken], {
      "report-card.grade": "<img src=x onerror=alert(1)>",
    }).text).toBe("Grade N/A.");
    expect(resolveAiSummaryClaims("Grade {{grade}}.", [gradeToken]).text).toBe("Grade N/A.");
  });

  it("enforces a one-to-one registered token and placeholder schema", () => {
    expect(validateAiSummaryClaimTokens("{{grade}} and {{grade}} plus {{score}}", [gradeToken])).toEqual([
      { code: "placeholder-count", token: "grade" },
      { code: "unregistered-placeholder", token: "{{score}}" },
    ]);
    expect(validateAiSummaryClaimTokens("{{grade}}", [{
      ...gradeToken,
      source: "stablecoin.circulating-usd",
    } as unknown as AiSummaryClaimToken])).toEqual([
      { code: "wrong-registration", token: "grade" },
      { code: "unregistered-placeholder", token: "{{grade}}" },
    ]);
  });

  it("keeps every data-file claim token in one-to-one schema parity", () => {
    const summaries = JSON.parse(readFileSync(resolve("data/ai-summaries.json"), "utf8")) as Record<
      string,
      { text: string; claimTokens?: AiSummaryClaimToken[] }
    >;

    for (const [id, summary] of Object.entries(summaries)) {
      expect(validateAiSummaryClaimTokens(summary.text, summary.claimTokens), id).toEqual([]);
    }
  });
});
