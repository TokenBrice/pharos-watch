import { describe, expect, it } from "vitest";
import { type DailySocialSnapshot, DailySocialTopicSchema } from "@shared/lib/daily-social";
import { main, renderDailySocialSvg } from "../build-daily-social";

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
  it.each(DailySocialTopicSchema.options)("renders a self-contained %s edition", (topic) => {
    const svg = renderDailySocialSvg({ ...snapshot, topic });
    expect(svg).toContain('width="1600" height="1000"');
    expect(svg).toContain("data:font/woff2;base64,");
    expect(svg).not.toMatch(/href="https?:/);
    expect(svg).toContain("$50.00M");
    expect(svg).toContain("$10.00M");
    expect(svg).toContain("2026-09-10 EDITION");
  });

  it("uses a shared linear scale for growth columns", () => {
    const svg = renderDailySocialSvg(snapshot);
    expect(svg).toMatch(/data-value="50000000"[^>]+height="270"/);
    expect(svg).toMatch(/data-value="10000000"[^>]+height="54"/);
  });

  it("positions negative and positive share changes on opposite sides of zero", () => {
    const svg = renderDailySocialSvg({ ...snapshot, topic: "market-share", unit: "percentage-points",
      rows: [{ ...snapshot.rows[0], value: -2 }, { ...snapshot.rows[1], value: 1 }],
    });
    expect(svg).toMatch(/data-value="-2" x="1060"[^>]+width="230"/);
    expect(svg).toMatch(/data-value="1" x="1290"[^>]+width="115"/);
  });

  it("uses a fixed 0–100 Safety Score axis", () => {
    const svg = renderDailySocialSvg({ ...snapshot, topic: "safety", unit: "score",
      rows: [{ ...snapshot.rows[0], value: 80 }],
    });
    expect(svg).toContain('data-value="80" cx="1052"');
    expect(svg).toContain("SCORE / 0–100 SCALE");
  });

  it("supports a quiet single-row edition with zero observations", () => {
    const svg = renderDailySocialSvg({ ...snapshot, topic: "stability", unit: "count",
      rows: [{ id: "calm", name: "No observed episodes", value: 0, context: "Seven-day tracked coverage" }],
    });
    expect(svg).toContain("NO OBSERVED EPISODES");
    expect(svg).not.toMatch(/="(?:NaN|Infinity)"/);
  });

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

  it("makes the safety grade larger than its supporting numeric score", () => {
    const svg = renderDailySocialSvg({ ...snapshot, topic: "safety", unit: "score",
      safetyAsOf: snapshot.asOf, safetyPublicationId: "test-publication",
      rows: [{ ...snapshot.rows[0], value: 80, safetyGrade: "B+" }],
    });
    expect(svg).toMatch(/font-size="58"[^>]+>B\+<\/text>/);
    expect(svg).toMatch(/font-size="24"[^>]+>80\/100<\/text>/);
    expect(svg).toContain('data-value="80" cx="1052"');
  });

  it("encodes stability counts with a shared scale and keeps old episodes explicit", () => {
    const svg = renderDailySocialSvg({ ...snapshot, topic: "stability", unit: "count",
      rows: [
        { id: "started", name: "New incidents", value: 2, context: "Began in the last seven days" },
        { id: "recovered", name: "Recoveries", value: 4, context: "Recovered in the last seven days" },
        { id: "ongoing", name: "Still open", value: 20, context: "All currently open incidents, including older episodes" },
      ],
    });
    expect(svg).toMatch(/data-value="2"[^>]+width="62"/);
    expect(svg).toMatch(/data-value="4"[^>]+width="124"/);
    expect(svg).toMatch(/data-value="20"[^>]+width="620"/);
    expect(svg).toContain("OPEN AT CAPTURE · INCLUDING OLDER EPISODES");
    expect(svg).not.toContain("<ellipse");
  });

  it("escapes untrusted display text and rejects invalid inputs", () => {
    expect(renderDailySocialSvg({ ...snapshot, title: "A<&" })).toContain("A&lt;&amp;");
    expect(() => renderDailySocialSvg({ ...snapshot, rows: [] })).toThrow();
    expect(() => renderDailySocialSvg({ ...snapshot, rows: [snapshot.rows[0], snapshot.rows[0]] })).toThrow();
  });

  it("rejects unknown and missing CLI options before filesystem effects", async () => {
    await expect(main(["--unknown"])).rejects.toThrow();
    await expect(main([])).rejects.toThrow("--input is required");
    await expect(main(["--input", "missing.json", "--out", "poster.svg"])).rejects.toThrow("--out must end in .png");
  });
});
