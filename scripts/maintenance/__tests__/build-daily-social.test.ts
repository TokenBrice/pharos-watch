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
    expect(svg).toMatch(/data-value="-2" x="830"[^>]+width="230"/);
    expect(svg).toMatch(/data-value="1" x="1060"[^>]+width="115"/);
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
    expect(svg).toContain("No observed episodes");
    expect(svg).not.toMatch(/="(?:NaN|Infinity)"/);
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
