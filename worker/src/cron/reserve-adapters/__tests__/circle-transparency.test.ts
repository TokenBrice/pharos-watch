import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { adaptCircleTransparency } from "../circle-transparency";

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const USDC_HTML = readFileSync(join(FIXTURES_DIR, "circle-usdc.html"), "utf8");
const USDC_AMOUNT_HTML = readFileSync(join(FIXTURES_DIR, "circle-usdc-absolute.html"), "utf8");
const EURC_HTML = readFileSync(join(FIXTURES_DIR, "circle-eurc.html"), "utf8");
const EURC_AMOUNT_HTML = readFileSync(join(FIXTURES_DIR, "circle-eurc-absolute.html"), "utf8");

const AMBIGUOUS_NEAR_PERCENT_HTML = `
<span data-coin="usdc" data-point="100.8" id="usdc-in-circulation"></span>
<canvas id="usdc_chartjs_canvas"
  data-usdc-us-treasuries="47.08"
  data-usdc-months="19.87"
  data-usdc-cash="11.35"
  data-usdc-in-circulation="21.70">
</canvas>
`;

describe("adaptCircleTransparency", () => {
  it("extracts USDC reserve slices from HTML", () => {
    const result = adaptCircleTransparency(USDC_HTML, "usdc");
    expect(result.slices.length).toBe(4);
    const total = result.slices.reduce((sum, s) => sum + s.pct, 0);
    expect(total).toBe(100);
    expect(result.metadata).toMatchObject({
      freshnessMode: "unverified",
      details: {
        freshnessSource: "html-disclosure",
      },
    });
  });

  it("maps USDC slices to very-low risk", () => {
    const result = adaptCircleTransparency(USDC_HTML, "usdc");
    for (const slice of result.slices) {
      expect(slice.risk).toBe("very-low");
    }
  });

  it("extracts EURC reserve slices from HTML", () => {
    const result = adaptCircleTransparency(EURC_HTML, "eurc");
    expect(result.slices.length).toBe(2);
    const total = result.slices.reduce((sum, s) => sum + s.pct, 0);
    expect(total).toBe(100);
  });

  it("normalizes current absolute-value USDC disclosures into percentages", () => {
    const result = adaptCircleTransparency(USDC_AMOUNT_HTML, "usdc");
    expect(result.metadata?.valueMode).toBe("absolute");
    expect(result.slices).toEqual([
      { name: "<3-Month U.S. Treasuries", pct: 57.1, risk: "very-low" },
      { name: "Deposits at Systemically Important Institutions", pct: 27.3, risk: "very-low" },
      { name: "Other Bank Deposits", pct: 14.8, risk: "very-low" },
      { name: "Overnight Reverse Treasury Repo", pct: 0.8, risk: "very-low" },
    ]);
  });

  it("normalizes current absolute-value EURC disclosures into percentages", () => {
    const result = adaptCircleTransparency(EURC_AMOUNT_HTML, "eurc");
    expect(result.metadata?.valueMode).toBe("absolute");
    expect(result.slices).toEqual([
      { name: "Other Bank Deposits", pct: 98.7, risk: "very-low" },
      { name: "Deposits at Systemically Important Institutions", pct: 1.3, risk: "very-low" },
    ]);
  });

  it("prefers percentage mode when the payload already sums to roughly 100%", () => {
    const result = adaptCircleTransparency(AMBIGUOUS_NEAR_PERCENT_HTML, "usdc");
    expect(result.metadata?.valueMode).toBe("percentage");
  });

  it("throws when no matching canvas found", () => {
    expect(() => adaptCircleTransparency("<html></html>", "usdc")).toThrow("layout-changed");
  });
});
