import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { SafetyScoresTechnicalDetails } from "./safety-scores-technical-details";

const CURRENT_SUMMARY = "Current V10 technical contract";
const HISTORICAL_SUMMARY = "Historical V8.17 methodology: dimensions, formulas, thresholds, and caveats";

function disclosure(html: string, summary: string, nextSummary?: string): string {
  const start = html.indexOf(summary);
  const end = nextSummary === undefined ? html.length : html.indexOf(nextSummary);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return html.slice(start, end);
}

describe("SafetyScoresTechnicalDetails", () => {
  it("publishes current carry-forward, stale-DEX and grade-stability rules in the V10 disclosure", () => {
    const html = renderToStaticMarkup(<SafetyScoresTechnicalDetails />);
    const current = disclosure(html, CURRENT_SUMMARY, HISTORICAL_SUMMARY);
    const historical = disclosure(html, HISTORICAL_SUMMARY);

    for (const phrase of [
      "carried forward until that run",
      "derated rather than discarded",
      "Grade stability",
    ]) {
      expect(current).toContain(phrase);
      expect(historical).not.toContain(phrase);
    }
  });

  it("keeps the aggregation formula and facts grid out of the moved Grade stability block", () => {
    const html = renderToStaticMarkup(<SafetyScoresTechnicalDetails />);
    const current = disclosure(html, CURRENT_SUMMARY, HISTORICAL_SUMMARY);
    const factsIndex = current.indexOf("Pillar weights");
    const formulaIndex = current.indexOf("candidate = weakestPriced");
    const carryIndex = current.indexOf("carried forward until that run");
    const gradeIndex = current.indexOf("Grade stability");

    expect(formulaIndex).toBeGreaterThanOrEqual(0);
    expect(factsIndex).toBeGreaterThan(formulaIndex);
    // The moved prose follows the facts grid instead of interrupting it.
    expect(carryIndex).toBeGreaterThan(factsIndex);
    expect(gradeIndex).toBeGreaterThan(carryIndex);
  });
});
