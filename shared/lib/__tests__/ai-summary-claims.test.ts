import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { hasAvailableAiSummaryClaims, resolveAiSummaryClaims, validateAiSummaryClaimTokens } from "../ai-summary-claims";
import type { AiSummaryClaimToken } from "../../types/editorial";
import { ReportCardGradeSchema } from "../../types/report-card-grade";

const gradeToken: AiSummaryClaimToken = {
  token: "grade",
  placeholder: "{{grade}}",
  source: "report-card.grade",
  factsAsOf: "2026-09-01",
};

describe("AI summary claim tokens", () => {
  it("admits static prose and glossary markup without requiring live inputs", () => {
    expect(hasAvailableAiSummaryClaims("Unknown grade is N/A; use {{term:cdp}}CDPs{{/term}}.", undefined)).toBe(true);
  });

  it("withholds supported placeholders with absent or unregistered values", () => {
    expect(hasAvailableAiSummaryClaims("Grade {{grade}}.", [gradeToken])).toBe(false);
    expect(hasAvailableAiSummaryClaims("Grade {{grade}}.", undefined, { "report-card.grade": "D" })).toBe(false);
    expect(hasAvailableAiSummaryClaims("Grade {{grade}}.", [gradeToken], { "report-card.grade": null })).toBe(false);
  });

  it.each(ReportCardGradeSchema.options)("admits an available %s grade without interpreting it as absence", (grade) => {
    expect(hasAvailableAiSummaryClaims("Grade {{grade}}.", [gradeToken], { "report-card.grade": grade })).toBe(true);
  });

  it("requires every present live claim, including finite score and observed zero supply", () => {
    const tokens: AiSummaryClaimToken[] = [
      { token: "score", placeholder: "{{score}}", source: "report-card.score", factsAsOf: "2026-09-01" },
      { token: "supplyUsd", placeholder: "{{supplyUsd}}", source: "stablecoin.circulating-usd", factsAsOf: "2026-09-01" },
    ];
    const text = "Score {{score}}; supply {{supplyUsd}}.";
    expect(hasAvailableAiSummaryClaims(text, tokens, {
      "report-card.score": 0, "stablecoin.circulating-usd": 0,
    })).toBe(true);
    expect(hasAvailableAiSummaryClaims(text, tokens, { "report-card.score": 45 })).toBe(false);
    expect(hasAvailableAiSummaryClaims(text, tokens, {
      "report-card.score": Number.NaN, "stablecoin.circulating-usd": 0,
    })).toBe(false);
    expect(hasAvailableAiSummaryClaims(text, tokens, {
      "report-card.score": 45, "stablecoin.circulating-usd": -1,
    })).toBe(false);
  });

  it.each(ReportCardGradeSchema.options)("preserves the published %s grade, including not-rated", (grade) => {
    expect(resolveAiSummaryClaims("Grade {{grade}}.", [gradeToken], {
      "report-card.grade": grade,
    }).text).toBe(`Grade ${grade}.`);
  });

  it.each([
    ["A-", "USDT carries an A- overall grade."],
    ["F", "USDT carries an F overall grade."],
    ["B+", "USDT carries a B+ overall grade."],
  ])("uses the right article before a resolved %s grade", (grade, expected) => {
    expect(resolveAiSummaryClaims("USDT carries a {{grade}} overall grade.", [gradeToken], {
      "report-card.grade": grade,
    }).text).toBe(expected);
  });

  it.each([null, undefined, "D+", "D-"])("renders unavailable or invalid grade %s as N/A", (grade) => {
    expect(resolveAiSummaryClaims("Grade {{grade}}.", [gradeToken], {
      "report-card.grade": grade,
    }).text).toBe("Grade N/A.");
  });

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

  it("rejects shape-valid but calendar-invalid factsAsOf dates", () => {
    expect(validateAiSummaryClaimTokens("Grade {{grade}}.", [{
      ...gradeToken,
      factsAsOf: "2026-99-99",
    }])).toEqual([{ code: "invalid-facts-as-of", token: "grade" }]);
    expect(validateAiSummaryClaimTokens("Grade {{grade}}.", [{
      ...gradeToken,
      factsAsOf: "2026-02-30",
    }])).toEqual([{ code: "invalid-facts-as-of", token: "grade" }]);
    expect(validateAiSummaryClaimTokens("Grade {{grade}}.", [gradeToken])).toEqual([]);
  });

  it("renders malformed and unregistered tokens as N/A instead of raw braces", () => {
    expect(resolveAiSummaryClaims("Grade {{grade}}.", [{
      ...gradeToken,
      factsAsOf: "2026-99-99",
    }]).text).toBe("Grade N/A.");
    expect(resolveAiSummaryClaims("Grade {{grade}}.", undefined).text).toBe("Grade N/A.");
    expect(resolveAiSummaryClaims("Grade {{grade}}.", [
      { ...gradeToken, placeholder: "{{score}}" } as unknown as AiSummaryClaimToken,
    ]).text).toBe("Grade N/A.");
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

describe("AI summary editorial corrections", () => {
  const summaries = JSON.parse(readFileSync(resolve("data/ai-summaries.json"), "utf8")) as Record<
    string,
    { text: string; updatedAt: string; authoredBy: string; reviewedBy?: string }
  >;

  it("qualifies USDF's unadmitted quote instead of asserting that no market exists", () => {
    const usdf = summaries["usdf-flipcash"];
    expect(usdf.text).not.toMatch(/no DEX pair|no Jupiter market|platform demonstration/);
    expect(usdf.text).toContain("neither is an admitted price source");
    expect(usdf.text).toContain("launched but awaiting data while the quote's source is unresolved");
    expect(usdf).toMatchObject({ authoredBy: "ai", updatedAt: "2026-10-27" });
    expect(usdf.reviewedBy).toBeUndefined();
  });

  it("drops RedCoin's superseded no-disclosure claims", () => {
    const redcoin = summaries["hkd-hsbc"].text;
    expect(redcoin).not.toMatch(/names no blockchain|no reserve report/);
    expect(redcoin).toContain("not independent verification of public-chain supply");
  });
});
