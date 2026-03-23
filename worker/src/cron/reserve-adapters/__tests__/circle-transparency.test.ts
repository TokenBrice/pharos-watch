import { describe, it, expect } from "vitest";
import { adaptCircleTransparency } from "../circle-transparency";

const USDC_HTML = `
<canvas id="usdc_chartjs_canvas"
  data-usdc-us-treasuries="47.08"
  data-usdc-months="19.87"
  data-usdc-cash="11.35"
  data-usdc-in-circulation="21.70">
</canvas>
`;

const USDC_AMOUNT_HTML = `
<span data-coin="usdc" data-point="79.13" id="usdc-in-circulation"></span>
<canvas id="usdc_chartjs_canvas"
  data-usdc-in-circulation="0.63"
  data-usdc-cash="11.77"
  data-usdc-us-treasuries="45.3"
  data-usdc-months="21.66">
</canvas>
`;

const EURC_HTML = `
<canvas id="eurocoin_chartjs_canvas"
  data-eurocoin-cash="80.34"
  data-eurocoin-tokens="19.66">
</canvas>
`;

const EURC_AMOUNT_HTML = `
<span data-coin="euro" id="euro-in-circulation" data-point="370.7"></span>
<canvas id="eurocoin_chartjs_canvas"
  data-eurocoin-tokens="4.82"
  data-eurocoin-cash="373.63">
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

  it("throws when no matching canvas found", () => {
    expect(() => adaptCircleTransparency("<html></html>", "usdc")).toThrow("layout-changed");
  });
});
