import { describe, it, expect } from "vitest";
import { compareDepegAttention } from "@/lib/depeg-sort";
import type { DepegTrackerRow } from "@/lib/depeg-sort";
import { makePendingIncident } from "@/components/__tests__/depeg.test-support";

function mockRow(opts: {
  activeDepeg: boolean;
  band: string;
  absDev: number | null;
}, extra: Partial<DepegTrackerRow> & { id?: string } = {}): DepegTrackerRow {
  return {
    coin: {
      id: extra.id ?? "coin-a",
      pegCurrency: "USD",
      activeDepeg: opts.activeDepeg,
      currentDeviationBps: opts.absDev,
    } as DepegTrackerRow["coin"],
    dews: { band: opts.band, score: 0, signals: {} } as DepegTrackerRow["dews"],
    ...extra,
  };
}

describe("depeg tracker attention sort", () => {
  it("ranks active depegs above everything else", () => {
    const active = mockRow({ activeDepeg: true, band: "CALM", absDev: 10 });
    const danger = mockRow({ activeDepeg: false, band: "DANGER", absDev: 999 });
    expect(compareDepegAttention(active, danger)).toBeLessThan(0);
  });

  it("ranks DANGER above WARNING when neither is active", () => {
    const danger = mockRow({ activeDepeg: false, band: "DANGER", absDev: 0 });
    const warning = mockRow({ activeDepeg: false, band: "WARNING", absDev: 0 });
    expect(compareDepegAttention(danger, warning)).toBeLessThan(0);
  });

  it("ranks pending confirmation between active incidents and ordinary danger", () => {
    const active = mockRow({ activeDepeg: true, band: "CALM", absDev: 10 });
    const pending = mockRow({ activeDepeg: false, band: "CALM", absDev: 20 });
    pending.pendingIncident = makePendingIncident({ direction: "above" });
    const danger = mockRow({ activeDepeg: false, band: "DANGER", absDev: 999 });
    expect(compareDepegAttention(active, pending)).toBeLessThan(0);
    expect(compareDepegAttention(pending, danger)).toBeLessThan(0);
  });

  it("orders active materiality (-50.4 vs -49.9), horizon, and null-last dev", () => {
    const r = (id: string, absDev: number | null, ev?: DepegTrackerRow["openIncidentEvidence"], tier?: DepegTrackerRow["openIncidentTier"], band = "CALM") =>
      mockRow({ activeDepeg: true, band, absDev }, { id, openIncidentEvidence: ev, openIncidentTier: tier });
    expect([r("n", -49.9, "unconfirmed", "recent", "DANGER"), r("o", -9e3, "outside", "long_running", "DANGER"), r("u", null, "unconfirmed", "recent"), r("e", -50.4, "unconfirmed", "recent"), r("s", -600, "outside", "escalating")]
      .sort(compareDepegAttention).map((x) => x.coin.id)).toEqual(["s", "e", "u", "o", "n"]);
  });
});
