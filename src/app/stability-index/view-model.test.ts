import { describe, expect, it } from "vitest";
import {
  buildPsiComponentData,
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
});
