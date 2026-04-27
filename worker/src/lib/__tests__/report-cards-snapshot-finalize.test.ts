import { describe, expect, it } from "vitest";
import { DEAD_STABLECOINS } from "@shared/lib/dead-stablecoins";
import { FROZEN_STABLECOINS } from "@shared/lib/stablecoins";
import { buildDefunctReportCards } from "../report-cards-snapshot-finalize";

describe("buildDefunctReportCards", () => {
  it("emits all-F defunct cards for every dead and frozen stablecoin", () => {
    const cards = buildDefunctReportCards();
    expect(Array.isArray(cards)).toBe(true);
    expect(cards.length).toBe(DEAD_STABLECOINS.length + FROZEN_STABLECOINS.length);
    expect(cards.every((c) => c.isDefunct === true)).toBe(true);
    expect(cards.every((c) => c.overallGrade === "F")).toBe(true);
    expect(cards.every((c) => c.overallScore === 0)).toBe(true);

    const ids = new Set(cards.map((c) => c.id));
    for (const dead of DEAD_STABLECOINS) {
      expect(ids.has(dead.id)).toBe(true);
    }
    for (const frozen of FROZEN_STABLECOINS) {
      expect(ids.has(frozen.id)).toBe(true);
    }
  });
});
