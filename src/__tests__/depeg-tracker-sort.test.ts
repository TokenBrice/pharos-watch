import { describe, it, expect } from "vitest";

// Extract the sort logic for testability
// We test via the exported types and replicate the sort function

const BAND_ORDER: Record<string, number> = {
  CALM: 0, WATCH: 1, ALERT: 2, WARNING: 3, DANGER: 4,
};

interface MockRow {
  activeDepeg: boolean;
  band: string;
  absDev: number;
}

function attentionScore(row: MockRow): number {
  let score = row.activeDepeg ? 1_000_000 : 0;
  score += (BAND_ORDER[row.band] ?? 0) * 10_000;
  score += row.absDev;
  return score;
}

describe("depeg tracker attention sort", () => {
  it("ranks active depegs above everything else", () => {
    const active: MockRow = { activeDepeg: true, band: "CALM", absDev: 10 };
    const danger: MockRow = { activeDepeg: false, band: "DANGER", absDev: 999 };
    expect(attentionScore(active)).toBeGreaterThan(attentionScore(danger));
  });

  it("ranks DANGER above WARNING when neither is active", () => {
    const danger: MockRow = { activeDepeg: false, band: "DANGER", absDev: 0 };
    const warning: MockRow = { activeDepeg: false, band: "WARNING", absDev: 0 };
    expect(attentionScore(danger)).toBeGreaterThan(attentionScore(warning));
  });

  it("uses deviation as tiebreaker within same band", () => {
    const high: MockRow = { activeDepeg: false, band: "ALERT", absDev: 300 };
    const low: MockRow = { activeDepeg: false, band: "ALERT", absDev: 100 };
    expect(attentionScore(high)).toBeGreaterThan(attentionScore(low));
  });

  it("CALM coins with zero deviation score lowest", () => {
    const calm: MockRow = { activeDepeg: false, band: "CALM", absDev: 0 };
    expect(attentionScore(calm)).toBe(0);
  });
});
