import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { adaptFdusdTransparency } from "../fdusd-transparency";

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const SAMPLE_HTML = readFileSync(join(FIXTURES_DIR, "fdusd-transparency.html"), "utf8");

describe("adaptFdusdTransparency", () => {
  it("maps the transparency badges into Pharos reserve slices", () => {
    const result = adaptFdusdTransparency(SAMPLE_HTML);
    expect(result.slices).toEqual([
      { name: "U.S. Treasury Bills", pct: 74.5, risk: "very-low" },
      { name: "Cash", pct: 17.5, risk: "very-low" },
      { name: "Bank Deposits", pct: 6, risk: "very-low" },
      { name: "Overnight Reverse Repos", pct: 2, risk: "very-low" },
    ]);
    expect(result.metadata).toMatchObject({
      sliceCount: 4,
      asOf: "Feb 28, 2026",
      sourceTimestamp: Date.UTC(2026, 1, 28) / 1000,
      freshnessMode: "verified",
    });
  });

  it("throws when the page no longer exposes any reserve badges", () => {
    expect(() => adaptFdusdTransparency("<html></html>")).toThrow("layout-changed");
  });
});
