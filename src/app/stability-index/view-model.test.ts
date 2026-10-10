import { describe, expect, it, vi } from "vitest";
import type * as PsiHistoryEvents from "@/lib/psi-history-events";
import {
  buildPsiComponentData,
  buildPsiBeamDimmers,
  buildPsiContributorRows,
  buildPsiEventTimelineRows,
  buildPsiHistoryStats,
} from "./view-model";

vi.mock("@/lib/psi-history-events", async (importOriginal) => {
  const actual = await importOriginal<typeof PsiHistoryEvents>();
  return {
    ...actual,
    PSI_EVENTS: [
      ...actual.PSI_EVENTS,
      { label: "Year boundary", date: Date.UTC(2020, 11, 31), dateEnd: Date.UTC(2021, 0, 1), links: [] },
      { label: "Single UTC day", date: Date.UTC(2021, 0, 1), links: [] },
    ],
  };
});

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

  it("preserves unavailable daily components and missing days as chart gaps rather than zero", () => {
    const result = buildPsiComponentData(
      [
        { date: 3, components: { severity: null, breadth: 0, trend: null } },
        { date: 2, components: null },
        { date: 1, components: { severity: 4, breadth: 2, stressBreadth: 1, trend: 0 } },
      ],
      { computedAt: 4, components: { severity: 2, breadth: 0, stressBreadth: 0, trend: 1 } },
    );

    expect(result[1]).toEqual({ ts: 2000, severity: null, breadth: null, stressBreadth: null, trend: null });
    expect(result[2]).toEqual({ ts: 3000, severity: null, breadth: 0, stressBreadth: null, trend: null });
    const lanes = buildPsiBeamDimmers(result);
    expect(lanes.find((lane) => lane.key === "severity")?.delta).toBeNull();
    expect(lanes.find((lane) => lane.key === "breadth")).toMatchObject({ value: 0, delta: 0, pressurePct: 0 });
  });

  it("does not display unavailable fallback components as calm pressure or improving momentum", () => {
    const lanes = buildPsiBeamDimmers([
      { severity: 4, breadth: 2, stressBreadth: 1, trend: -2 },
      { severity: null, breadth: null, stressBreadth: null, trend: null },
    ]);

    for (const lane of lanes) {
      expect(lane).toMatchObject({ value: null, delta: null, pressurePct: null, role: "unavailable" });
    }
  });

  it("builds formatted history stats and ranks contributors by total impact", () => {
    const stats = buildPsiHistoryStats([
      { date: 1_700_000_000, score: 84, band: "STEADY" },
      { date: 1_699_913_600, score: 76, band: "TREMOR" },
      { date: 1_699_827_200, score: 71, band: "TREMOR" },
    ], 1_700_000_000);
    expect(stats).toHaveLength(3);
    expect(stats[0]).toMatchObject({ label: "30d High", value: "84.0", band: "STEADY" });
    expect(stats[1]).toMatchObject({ label: "30d Low", value: "71.0", band: "TREMOR" });

    const contributors = buildPsiContributorRows([
      { id: "usdc-circle", symbol: "USDC", bps: -120, mcapUsd: 60_000_000_000, ageDays: 2, factor: 1 },
      { id: "frax", symbol: "FRAX", bps: -250, mcapUsd: 3_000_000_000, ageDays: 5, factor: 1 },
    ], 63_000_000_000);
    expect(contributors[0]?.symbol).toBe("USDC");
    expect(contributors[0]?.total).toBeGreaterThan(contributors[1]?.total ?? 0);
  });

  it("keeps 30d statistics inside source-anchored UTC days despite gaps", () => {
    const day = Date.parse("2026-10-10T00:00:00Z") / 1000;
    const stats = buildPsiHistoryStats([
      { date: day, score: 90, band: "CALM" },
      { date: day - 4 * 86400, score: 100, band: "CALM" },
      { date: day - 29 * 86400, score: 80, band: "STEADY" },
      { date: day - 30 * 86400, score: 20, band: "CRISIS" },
      { date: day + 86400, score: 0, band: "CRISIS" },
    ], day + 12 * 3600);
    expect(stats.map((stat) => stat.value)).toEqual(["100.0", "80.0", "90.0"]);
    expect(stats.every((stat) => stat.sub === "3/30 observed days")).toBe(true);
    expect(buildPsiHistoryStats([{ date: day - 30 * 86400, score: 20, band: "CRISIS" }], day)).toEqual([]);
    expect(buildPsiHistoryStats([{ date: day, score: 90, band: "CALM" }], null)).toEqual([]);
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

  it.each(["UTC", "America/Los_Angeles", "Asia/Tokyo"])(
    "formats authored UTC event dates identically in %s including year boundaries",
    (timeZone) => {
      vi.stubEnv("TZ", timeZone);
      try {
        const rows = buildPsiEventTimelineRows([]);
        expect(rows.find((row) => row.label === "COVID Crash")?.dateStr).toBe("Mar 12 – Mar 16, 2020");
        expect(rows.find((row) => row.label === "Year boundary")?.dateStr).toBe("Dec 31, 2020 – Jan 1, 2021");
        expect(rows.find((row) => row.label === "Single UTC day")?.dateStr).toBe("Jan 1, 2021");
      } finally {
        vi.unstubAllEnvs();
      }
    },
  );

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
