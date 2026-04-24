import { describe, expect, it } from "vitest";
import {
  buildPsiComponentData,
  buildPsiBeamDimmers,
  buildPsiContributorRows,
  buildPsiEventTimelineRows,
  buildPsiHistoryStats,
} from "./view-model";

describe("stability index view-model", () => {
  it("builds component series by combining historical points with the current sample", () => {
    const result = buildPsiComponentData(
      [
        { date: 1_700_000_000, components: { severity: 10, breadth: 5, stressBreadth: 2, trend: 4 } },
        { date: 1_700_086_400, components: { severity: 11, breadth: 6, stressBreadth: 3, trend: 5 } },
      ],
      { computedAt: 1_700_172_800, components: { severity: 12, breadth: 7, stressBreadth: 4, trend: 6 } },
    );

    expect(result).toEqual([
      { ts: 1_700_086_400_000, severity: 11, breadth: 6, stressBreadth: 3, trend: 5 },
      { ts: 1_700_000_000_000, severity: 10, breadth: 5, stressBreadth: 2, trend: 4 },
      { ts: 1_700_172_800_000, severity: 12, breadth: 7, stressBreadth: 4, trend: 6 },
    ]);
  });

  it("builds formatted history stats and ranks contributors by total impact", () => {
    const stats = buildPsiHistoryStats([
      { date: 1_700_000_000, score: 84, band: "STEADY" },
      { date: 1_699_913_600, score: 76, band: "TREMOR" },
      { date: 1_699_827_200, score: 71, band: "TREMOR" },
    ]);
    expect(stats[0]).toMatchObject({ label: "30d High", value: "84.0", band: "STEADY" });
    expect(stats[3]).toMatchObject({ label: "ATL", value: "71.0", band: "TREMOR" });

    const contributors = buildPsiContributorRows([
      { id: "usdc-circle", symbol: "USDC", bps: -120, mcapUsd: 60_000_000_000, ageDays: 2, factor: 1 },
      { id: "frax", symbol: "FRAX", bps: -250, mcapUsd: 3_000_000_000, ageDays: 5, factor: 1 },
    ], 63_000_000_000);
    expect(contributors[0]?.symbol).toBe("USDC");
    expect(contributors[0]?.total).toBeGreaterThan(contributors[1]?.total ?? 0);
  });

  it("assigns event timeline PSI bands from the worst nearby score", () => {
    const rows = buildPsiEventTimelineRows([
      { ts: Date.parse("2023-03-12T00:00:00Z"), score: 58 },
      { ts: Date.parse("2023-03-13T00:00:00Z"), score: 35 },
      { ts: Date.parse("2023-03-14T00:00:00Z"), score: 62 },
    ]);

    const svb = rows.find((row) => row.label.includes("SVB Weekend"));
    expect(svb).toMatchObject({
      psi: 35,
      psiBand: "CRISIS",
    });
  });

  it("builds PSI beam dimmer lanes from current component values and prior-sample deltas", () => {
    const lanes = buildPsiBeamDimmers([
      { ts: 1, severity: 8, breadth: 3, stressBreadth: 1, trend: 2 },
      { ts: 2, severity: 12, breadth: 4.5, stressBreadth: 2, trend: -1.5 },
    ]);

    expect(lanes).toEqual([
      {
        key: "severity",
        label: "Severity",
        value: 12,
        delta: 4,
        pressurePct: expect.closeTo(17.647, 2),
        max: 68,
        role: "penalty",
        detail: "Current depeg depth penalty",
      },
      {
        key: "breadth",
        label: "Breadth",
        value: 4.5,
        delta: 1.5,
        pressurePct: expect.closeTo(26.471, 2),
        max: 17,
        role: "penalty",
        detail: "Current active depeg spread",
      },
      {
        key: "stressBreadth",
        label: "Stress breadth",
        value: 2,
        delta: 1,
        pressurePct: 40,
        max: 5,
        role: "penalty",
        detail: "Current DEWS warning-band pressure",
      },
      {
        key: "trend",
        label: "Trend",
        value: -1.5,
        delta: -3.5,
        pressurePct: 30,
        max: 5,
        role: "drag",
        detail: "7-day market-cap momentum",
      },
    ]);
  });

  it("treats positive PSI trend as support rather than pressure", () => {
    const lanes = buildPsiBeamDimmers([
      { ts: 1, severity: 0, breadth: 0, stressBreadth: 0, trend: 3 },
    ]);

    expect(lanes.find((lane) => lane.key === "trend")).toMatchObject({
      value: 3,
      delta: null,
      pressurePct: 0,
      role: "support",
    });
  });
});
