import { describe, it, expect } from "vitest";
import { attentionScore } from "@/lib/depeg-sort";
import type { DepegTrackerRow } from "@/lib/depeg-sort";
import { makePendingIncident } from "@/components/__tests__/depeg.test-support";

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

  it("ranks pending confirmation between active incidents and ordinary danger", () => {
    const active = mockRow({ activeDepeg: true, band: "CALM", absDev: 10 });
    const pending = mockRow({ activeDepeg: false, band: "CALM", absDev: 20 });
    pending.pendingIncident = makePendingIncident({ direction: "above" });
    const danger = mockRow({ activeDepeg: false, band: "DANGER", absDev: 999 });
    expect(attentionScore(active)).toBeGreaterThan(attentionScore(pending));
    expect(attentionScore(pending)).toBeGreaterThan(attentionScore(danger));
  });

});
