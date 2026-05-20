/**
 * 33-cell template-coverage matrix (11 LowestSubDimensionKeys × 3 profiles).
 *
 * Per plan §10 (Milestone 10) the MVP target is the 33-cell `(key × profile)`
 * matrix; contextKey-refined templates are post-MVP.
 */
import { describe, expect, it } from "vitest";
import { LOWEST_SUB_DIMENSION_KEYS, SELECTOR_PROFILES } from "../types";
import { getTemplate, TEMPLATES } from "../what-to-watch-templates";

const BANNED_PHRASES: ReadonlyArray<RegExp> = [
  /pharos recommends/i,
  /top pick/i,
  /best yield-bearing/i,
  /trusted by/i,
  /battle-tested/i,
  /probably/i,
  /\blikely\b/i,
  /reliably/i,
  /we recommend you/i,
  /strongest current reading/i,
  /deprecated rail/i,
  /cannot tolerate/i,
  /surfaced opportunities/i,
];

describe("template coverage", () => {
  it("every (key × profile) cell has a non-fallback template", () => {
    const gaps: string[] = [];
    for (const profile of SELECTOR_PROFILES) {
      for (const key of LOWEST_SUB_DIMENSION_KEYS) {
        const template = getTemplate(key, profile);
        if (template == null) {
          gaps.push(`${profile} × ${key}`);
        }
      }
    }
    expect(gaps).toEqual([]);
  });

  it("matrix size = 33 cells", () => {
    let count = 0;
    for (const profile of SELECTOR_PROFILES) {
      const row = TEMPLATES[profile];
      for (const key of LOWEST_SUB_DIMENSION_KEYS) {
        if (row[key] != null) count += 1;
      }
    }
    expect(count).toBe(33);
  });

  it("no template contains a banned phrase", () => {
    const offenders: string[] = [];
    for (const profile of SELECTOR_PROFILES) {
      for (const key of LOWEST_SUB_DIMENSION_KEYS) {
        const template = TEMPLATES[profile][key];
        for (const banned of BANNED_PHRASES) {
          if (banned.test(template.oneLineExplanation)) {
            offenders.push(`${profile}/${key}: matched ${banned.source}`);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("oneLineExplanation prose stays under 100 chars (design §2.7 + buffer)", () => {
    const tooLong: string[] = [];
    for (const profile of SELECTOR_PROFILES) {
      for (const key of LOWEST_SUB_DIMENSION_KEYS) {
        const text = TEMPLATES[profile][key].oneLineExplanation;
        if (text.length > 100) {
          tooLong.push(`${profile}/${key}: ${text.length} chars`);
        }
      }
    }
    expect(tooLong).toEqual([]);
  });
});
