import { describe, it, expect } from "vitest";
import { adaptCircleTransparency } from "../circle-transparency";

const USDC_HTML = `
<canvas id="usdc_chartjs_canvas"
  data-usdc-us-treasuries="47.08"
  data-usdc-months="19.87"
  data-usdc-cash="11.35"
  data-usdc-in-circulation="0.64">
</canvas>
`;

const EURC_HTML = `
<canvas id="eurocoin_chartjs_canvas"
  data-eurocoin-cash="386.76"
  data-eurocoin-tokens="4.66">
</canvas>
`;

describe("adaptCircleTransparency", () => {
  it("extracts USDC reserve slices from HTML", () => {
    const result = adaptCircleTransparency(USDC_HTML, "usdc");
    expect(result.slices.length).toBe(4);
    const total = result.slices.reduce((sum, s) => sum + s.pct, 0);
    expect(total).toBe(100);
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

  it("throws when no matching canvas found", () => {
    expect(() => adaptCircleTransparency("<html></html>", "usdc")).toThrow();
  });
});
