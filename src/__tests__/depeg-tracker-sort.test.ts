import { describe, it, expect } from "vitest";
import { attentionScore } from "@/lib/depeg-sort";
import type { DepegTrackerRow } from "@/lib/depeg-sort";

/** Helper to build a minimal DepegTrackerRow for testing */
function mockRow(opts: {
  activeDepeg: boolean;
  band: string;
  absDev: number;
}): DepegTrackerRow {
  return {
    coin: {
      activeDepeg: opts.activeDepeg,
      currentDeviationBps: opts.absDev,
    } as DepegTrackerRow["coin"],
    dews: { band: opts.band, score: 0, signals: {} } as DepegTrackerRow["dews"],
  };
}

describe("depeg tracker attention sort", () => {
  it("ranks active depegs above everything else", () => {
    const active = mockRow({ activeDepeg: true, band: "CALM", absDev: 10 });
    const danger = mockRow({ activeDepeg: false, band: "DANGER", absDev: 999 });
    expect(attentionScore(active)).toBeGreaterThan(attentionScore(danger));
  });

  it("ranks DANGER above WARNING when neither is active", () => {
    const danger = mockRow({ activeDepeg: false, band: "DANGER", absDev: 0 });
    const warning = mockRow({ activeDepeg: false, band: "WARNING", absDev: 0 });
    expect(attentionScore(danger)).toBeGreaterThan(attentionScore(warning));
  });

  it("uses deviation as tiebreaker within same band", () => {
    const high = mockRow({ activeDepeg: false, band: "ALERT", absDev: 300 });
    const low = mockRow({ activeDepeg: false, band: "ALERT", absDev: 100 });
    expect(attentionScore(high)).toBeGreaterThan(attentionScore(low));
  });

  it("CALM coins with zero deviation score lowest", () => {
    const calm = mockRow({ activeDepeg: false, band: "CALM", absDev: 0 });
    expect(attentionScore(calm)).toBe(0);
  });
});
