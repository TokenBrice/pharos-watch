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

  it("maps the reserves_split breakdown into reserve slices", () => {
    const slices = adaptAccountableTypeBreakdown(
      {
        res: "ok",
        data: {
          collateralization: 1.00007,
          ts: "1773337492853",
          reserves: {
            reserves_split: [
              { name: "Copper", value: 28_058_537.09 },
              { name: "Fireblocks", value: 9_964_626 },
              { name: "Insurance Fund", value: 656_796.7 },
              { name: "Insurance Fund Usage", value: 20_000 },
              { name: "Binance", value: 1_181.38 },
              { name: "Ethereum Chain", value: 7.96 },
            ],
          },
        },
      },
      {
        bucket: "reserves_split",
        riskMap: {
          Copper: "medium",
          Fireblocks: "medium",
          "Insurance Fund": "low",
          "Insurance Fund Usage": "very-high",
          Binance: "high",
        },
      },
    );

    expect(slices).toEqual([
      { name: "Copper", pct: 72.5, risk: "medium" },
      { name: "Fireblocks", pct: 25.7, risk: "medium" },
      { name: "Insurance Fund", pct: 1.7, risk: "low" },
      { name: "Insurance Fund Usage", pct: 0.1, risk: "very-high" },
    ]);
  });
});
