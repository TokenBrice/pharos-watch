import { describe, expect, it } from "vitest";
import { type DailySocialSnapshot, DailySocialTopicSchema } from "@shared/lib/daily-social";
import { renderDailySocialSvg } from "../build-daily-social";

const snapshot: DailySocialSnapshot = {
  schemaVersion: 1, editionDate: "2026-09-10", scheduledAt: 1789041600,
  capturedAt: 1789041600, asOf: 1789041000, topic: "market-growth",
  title: "Where stablecoins are growing", subtitle: "Seven-day market-cap growth",
  unit: "usd", rows: [5, 4, 3, 2, 1].map((n) => ({
    id: `coin-${n}`, name: `Stablecoin ${n}`, symbol: `USD${n}`, value: n * 10_000_000, context: `${n}% weekly growth`,
  })), highlights: [{ label: "Coverage", value: "Illustrative test data" }],
  source: "Pharos", methodology: "Ranked by dollars added over seven days.",
};

describe("daily social renderer", () => {

  it("leads with actual cohort shares and spells out their change", () => {
    const svg = renderDailySocialSvg({ ...snapshot, topic: "market-share", unit: "percentage-points",
      rows: [{ ...snapshot.rows[0], value: 0.07, shareBeforePct: 19.6, shareAfterPct: 19.67 }],
    });
    expect(svg).toContain("19.60% → 19.67%");
    expect(svg).toContain("+0.07 percentage points");
    expect(svg).toContain("COHORT SHARE: LAST WEEK → NOW");
    const legacy = renderDailySocialSvg({ ...snapshot, topic: "market-share", unit: "percentage-points",
      rows: [{ ...snapshot.rows[0], value: -0.07 }],
    });
    expect(legacy).toContain("-0.07 percentage points");
  });

  it.each(DailySocialTopicSchema.options.filter((topic) => topic !== "stability"))("keeps full grade suffixes in %s coin labels", (topic) => {
    const svg = renderDailySocialSvg({ ...snapshot, topic,
      safetyAsOf: snapshot.asOf, safetyPublicationId: "test-publication",
      rows: snapshot.rows.map((row) => ({ ...row, symbol: "W".repeat(20), safetyGrade: "A+" })),
    });
    expect(svg.split(`${"W".repeat(20)} (A+)`).length - 1).toBeGreaterThanOrEqual(5);
    expect(svg).toContain('lengthAdjust="spacingAndGlyphs"');
    expect(svg).toContain("(GRADE) = PHAROS SAFETY SCORE");
  });


  it("escapes untrusted display text and rejects invalid inputs", () => {
    expect(renderDailySocialSvg({ ...snapshot, title: "A<&" })).toContain("A&lt;&amp;");
    expect(() => renderDailySocialSvg({ ...snapshot, rows: [] })).toThrow();
    expect(() => renderDailySocialSvg({ ...snapshot, rows: [snapshot.rows[0], snapshot.rows[0]] })).toThrow();
  });

});
