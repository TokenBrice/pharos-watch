import { describe, expect, it } from "vitest";
import { adaptAccountableTypeBreakdown } from "../accountable";

describe("adaptAccountableTypeBreakdown", () => {
  it("maps the type breakdown into reserve slices", () => {
    const slices = adaptAccountableTypeBreakdown(
      {
        res: "ok",
        data: {
          collateralization: 1.0595,
          ts: "1773304804848",
          reserves: {
            type: {
              "Liquid Bonds": 8_971_650.68,
              "Short Term Cash": 4_398_374.55,
            },
          },
        },
      },
      {
        bucket: "type",
        riskMap: {
          "Liquid Bonds": "high",
          "Short Term Cash": "very-low",
        },
      },
    );

    expect(slices).toEqual([
      { name: "Liquid Bonds", pct: 67.1, risk: "high" },
      { name: "Short Term Cash", pct: 32.9, risk: "very-low" },
    ]);
  });
});
